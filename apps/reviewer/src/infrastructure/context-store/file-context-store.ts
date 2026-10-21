import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  ContextCategory,
  ContextChangeProposal,
  ContextEntry,
  ContextProposalRecord,
  ProposalStatus,
} from '../../domain/context-evolution.js';
import { ContextEntrySchema, ContextProposalRecordSchema } from '../../domain/context-evolution.js';
import type { ContextStore, CreateContextVersionInput } from '../../domain/context-store.js';

const StoreFileSchema = z.object({
  entries: z.array(ContextEntrySchema).default([]),
  proposals: z.array(ContextProposalRecordSchema).default([]),
});
type StoreFile = z.infer<typeof StoreFileSchema>;

/**
 * JSON-file ContextStore. Simple, dependency-free, and behind the ContextStore
 * interface — so it can be swapped for PostgreSQL/pgvector/Qdrant later without
 * touching the evolution agent, service, or reviewer.
 *
 * Not Markdown-based (deliberately): entries are structured records, ready for
 * a relational or vector backend.
 */
export class FileContextStore implements ContextStore {
  readonly name = 'file-context-store';
  private data: StoreFile | null = null;

  constructor(
    private readonly filePath: string,
    /** Injectable clock for deterministic tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<StoreFile> {
    if (this.data) return this.data;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = StoreFileSchema.parse(JSON.parse(raw));
    } catch {
      this.data = { entries: [], proposals: [] };
    }
    return this.data;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async getCurrent(topic: string): Promise<ContextEntry | null> {
    const data = await this.load();
    const active = data.entries
      .filter((e) => e.topic === topic && e.status === 'ACTIVE')
      .sort((a, b) => b.version - a.version);
    return active[0] ?? null;
  }

  async getHistory(topic: string): Promise<ContextEntry[]> {
    const data = await this.load();
    return data.entries.filter((e) => e.topic === topic).sort((a, b) => a.version - b.version);
  }

  async listCurrent(categories?: ContextCategory[]): Promise<ContextEntry[]> {
    const data = await this.load();
    return data.entries.filter(
      (e) => e.status === 'ACTIVE' && (!categories || categories.includes(e.category)),
    );
  }

  async createVersion(input: CreateContextVersionInput): Promise<ContextEntry> {
    const data = await this.load();
    const history = data.entries.filter((e) => e.topic === input.topic);
    const nextVersion = history.reduce((max, e) => Math.max(max, e.version), 0) + 1;
    const prevActive = history.find((e) => e.status === 'ACTIVE');

    // Retire the previous ACTIVE version according to the change type.
    if (prevActive) {
      prevActive.status =
        input.changeType === 'REVERT'
          ? 'REVERTED'
          : input.changeType === 'DEPRECATE'
            ? 'DEPRECATED'
            : 'SUPERSEDED';
    }

    // The new version is ACTIVE when it carries a current statement; a
    // content-less DEPRECATE/REVERT retires the topic (no current knowledge).
    const hasContent = Boolean(input.content && input.content.trim());
    const newStatus: ContextEntry['status'] =
      input.changeType === 'REVERT'
        ? hasContent
          ? 'ACTIVE'
          : 'REVERTED'
        : input.changeType === 'DEPRECATE'
          ? hasContent
            ? 'ACTIVE'
            : 'DEPRECATED'
          : 'ACTIVE';

    const entry: ContextEntry = {
      id: randomUUID(),
      topic: input.topic,
      version: nextVersion,
      category: input.category,
      status: newStatus,
      content: input.content,
      summary: input.summary,
      changeType: input.changeType,
      confidence: input.confidence,
      evidence: input.evidence,
      source: input.source,
      affectedDomains: input.affectedDomains,
      reason: input.reason,
      ...(prevActive ? { previousVersion: prevActive.version } : {}),
      createdAt: this.now().toISOString(),
    };
    data.entries.push(entry);
    await this.save();
    return entry;
  }

  async proposeChange(
    proposal: ContextChangeProposal,
    status: ProposalStatus,
    idempotencyKey: string,
    decisionReason: string,
    appliedEntryId?: string,
  ): Promise<ContextProposalRecord> {
    const data = await this.load();
    const nowIso = this.now().toISOString();
    const record: ContextProposalRecord = {
      id: randomUUID(),
      idempotencyKey,
      status,
      proposal,
      ...(appliedEntryId ? { appliedEntryId } : {}),
      decisionReason,
      createdAt: nowIso,
      ...(status !== 'PENDING_REVIEW' ? { decidedAt: nowIso } : {}),
    };
    data.proposals.push(record);
    await this.save();
    return record;
  }

  async findByIdempotencyKey(key: string): Promise<ContextProposalRecord | null> {
    const data = await this.load();
    return data.proposals.find((p) => p.idempotencyKey === key) ?? null;
  }

  async getProposal(id: string): Promise<ContextProposalRecord | null> {
    const data = await this.load();
    return data.proposals.find((p) => p.id === id) ?? null;
  }

  async listProposals(status?: ProposalStatus): Promise<ContextProposalRecord[]> {
    const data = await this.load();
    return data.proposals.filter((p) => !status || p.status === status);
  }

  async updateProposalStatus(
    id: string,
    status: ProposalStatus,
    appliedEntryId?: string,
  ): Promise<ContextProposalRecord | null> {
    const data = await this.load();
    const record = data.proposals.find((p) => p.id === id);
    if (!record) return null;
    record.status = status;
    record.decidedAt = this.now().toISOString();
    if (appliedEntryId) record.appliedEntryId = appliedEntryId;
    await this.save();
    return record;
  }
}
