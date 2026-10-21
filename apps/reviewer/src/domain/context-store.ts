import type {
  ContextCategory,
  ContextChangeProposal,
  ContextEntry,
  ContextEntryChangeType,
  ContextEvidence,
  ContextProposalRecord,
  ProposalStatus,
  SourcePullRequest,
} from './context-evolution.js';

/**
 * ContextStore — the write/version/provenance seam for evolving knowledge.
 *
 * The MVP implementation is a JSON file (`FileContextStore`), but nothing here
 * assumes files or Markdown: this interface is deliberately storage-agnostic so
 * it can later be backed by PostgreSQL, pgvector, Qdrant, or a graph DB without
 * touching the evolution agent, service, or review pipeline.
 */

export interface CreateContextVersionInput {
  topic: string;
  category: ContextCategory;
  content: string;
  summary: string;
  changeType: ContextEntryChangeType;
  confidence: number;
  evidence: ContextEvidence[];
  source: SourcePullRequest;
  affectedDomains: string[];
  reason: string;
}

export interface ContextStore {
  readonly name: string;

  /** The current ACTIVE entry for a topic, or null if none / retired. */
  getCurrent(topic: string): Promise<ContextEntry | null>;

  /** All versions for a topic, oldest → newest (full provenance chain). */
  getHistory(topic: string): Promise<ContextEntry[]>;

  /** Every currently-ACTIVE entry (optionally filtered by category). */
  listCurrent(categories?: ContextCategory[]): Promise<ContextEntry[]>;

  /**
   * Append a new version for a topic. Marks the previous ACTIVE version as
   * SUPERSEDED (for CREATE/UPDATE) — callers handle DEPRECATE/REVERT status via
   * `changeType`. Never destroys prior versions.
   */
  createVersion(input: CreateContextVersionInput): Promise<ContextEntry>;

  /** Record a proposal (any status). Returns the persisted record. */
  proposeChange(
    proposal: ContextChangeProposal,
    status: ProposalStatus,
    idempotencyKey: string,
    decisionReason: string,
    appliedEntryId?: string,
  ): Promise<ContextProposalRecord>;

  /** Idempotency: has this exact event already been processed? */
  findByIdempotencyKey(key: string): Promise<ContextProposalRecord | null>;

  /** Fetch a single proposal record by id. */
  getProposal(id: string): Promise<ContextProposalRecord | null>;

  /** List proposals (optionally by status) — the human-approval queue. */
  listProposals(status?: ProposalStatus): Promise<ContextProposalRecord[]>;

  /** Update a proposal's status (approve/reject a PENDING_REVIEW proposal). */
  updateProposalStatus(
    id: string,
    status: ProposalStatus,
    appliedEntryId?: string,
  ): Promise<ContextProposalRecord | null>;
}
