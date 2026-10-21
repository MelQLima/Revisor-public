import { z } from 'zod';
import { PullRequestSchema } from './pull-request.js';
import { ContextResultSchema } from './context.js';

/**
 * Context Evolution domain model.
 *
 * When a PR is merged (or reverted), the system may learn durable knowledge
 * that future reviewers should know. That knowledge is captured as versioned,
 * provenance-carrying `ContextEntry` records, proposed via `ContextChangeProposal`.
 *
 * Design bias: HIGH PRECISION. Most merges must produce NO_CHANGE.
 */

/** How a proposal changes context. */
export const ContextChangeTypeSchema = z.enum(['CREATE', 'UPDATE', 'DEPRECATE', 'NO_CHANGE']);
export type ContextChangeType = z.infer<typeof ContextChangeTypeSchema>;

/** Category so reviewers can retrieve selectively (business vs technical vs …). */
export const ContextCategorySchema = z.enum([
  'BUSINESS_RULE',
  'DOMAIN_BEHAVIOR',
  'ARCHITECTURE',
  'INTEGRATION',
  'SECURITY',
  'PERFORMANCE',
  'EDGE_CASE',
  'HISTORICAL',
]);
export type ContextCategory = z.infer<typeof ContextCategorySchema>;

/** Evidence backing a context change — repository content is evidence, not truth by fiat. */
export const ContextEvidenceSourceSchema = z.enum([
  'PR',
  'FILE',
  'TEST',
  'COMMIT',
  'DIFF',
  'DOC',
  'INCIDENT',
  'HISTORY',
]);
export type ContextEvidenceSource = z.infer<typeof ContextEvidenceSourceSchema>;

export const ContextEvidenceSchema = z.object({
  source: ContextEvidenceSourceSchema,
  /** e.g. "#421", "src/payment/reconciliation.ts", "tests/reconciliation.test.ts". */
  reference: z.string().min(1),
  detail: z.string().optional(),
});
export type ContextEvidence = z.infer<typeof ContextEvidenceSchema>;

export const SourcePullRequestSchema = z.object({
  number: z.number().int().positive(),
  repository: z.string(),
  title: z.string(),
  mergeCommitSha: z.string().optional(),
});
export type SourcePullRequest = z.infer<typeof SourcePullRequestSchema>;

/** The structured proposal produced by the LLM (validated before it may persist). */
export const ContextChangeProposalSchema = z.object({
  type: ContextChangeTypeSchema,
  confidence: z.number().min(0).max(1),
  topic: z.string().min(1),
  category: ContextCategorySchema,
  summary: z.string().min(1),
  /** The durable knowledge statement to store as CURRENT context (for CREATE/UPDATE). */
  proposedContent: z.string().optional(),
  evidence: z.array(ContextEvidenceSchema).default([]),
  sourcePullRequest: SourcePullRequestSchema,
  affectedDomains: z.array(z.string()).default([]),
  reason: z.string().min(1),
});
export type ContextChangeProposal = z.infer<typeof ContextChangeProposalSchema>;

// ---------------------------------------------------------------------------
// Persisted, versioned context
// ---------------------------------------------------------------------------

/** How a stored entry came to be (proposals never persist REVERT directly). */
export const ContextEntryChangeTypeSchema = z.enum(['CREATE', 'UPDATE', 'DEPRECATE', 'REVERT']);
export type ContextEntryChangeType = z.infer<typeof ContextEntryChangeTypeSchema>;

export const ContextEntryStatusSchema = z.enum([
  'ACTIVE', // the current belief
  'SUPERSEDED', // replaced by a newer ACTIVE version
  'DEPRECATED', // explicitly retired (kept for history)
  'REVERTED', // the change that introduced it was reverted (kept for history)
]);
export type ContextEntryStatus = z.infer<typeof ContextEntryStatusSchema>;

export const ContextEntrySchema = z.object({
  id: z.string(),
  topic: z.string(),
  version: z.number().int().positive(),
  category: ContextCategorySchema,
  status: ContextEntryStatusSchema,
  /** The knowledge statement. */
  content: z.string(),
  summary: z.string(),
  changeType: ContextEntryChangeTypeSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(ContextEvidenceSchema).default([]),
  source: SourcePullRequestSchema,
  affectedDomains: z.array(z.string()).default([]),
  reason: z.string(),
  previousVersion: z.number().int().positive().optional(),
  createdAt: z.string(), // ISO 8601
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/** Outcome of the threshold decision applied to a proposal. */
export const ProposalStatusSchema = z.enum(['AUTO_UPDATE', 'PENDING_REVIEW', 'REJECTED']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** A persisted proposal record (provenance + idempotency + human-approval hook). */
export const ContextProposalRecordSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: ProposalStatusSchema,
  proposal: ContextChangeProposalSchema,
  /** Set when the proposal was applied (AUTO_UPDATE or later approved). */
  appliedEntryId: z.string().optional(),
  decisionReason: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type ContextProposalRecord = z.infer<typeof ContextProposalRecordSchema>;

// ---------------------------------------------------------------------------
// Revert detection
// ---------------------------------------------------------------------------

export const RevertEvidenceSchema = z.object({
  /** The signal type, e.g. "commit-reverts-sha", "title-revert", "body-reference". */
  signal: z.string(),
  detail: z.string(),
});
export type RevertEvidence = z.infer<typeof RevertEvidenceSchema>;

export const RevertResultSchema = z.object({
  isRevert: z.boolean(),
  /** Only set when confidently determined — never fabricated. */
  originalPullRequestNumber: z.number().int().positive().optional(),
  /** The reverted commit SHA(s), when found in commit messages. */
  revertedCommitShas: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(RevertEvidenceSchema).default([]),
});
export type RevertResult = z.infer<typeof RevertResultSchema>;

// ---------------------------------------------------------------------------
// LLM input / agent output
// ---------------------------------------------------------------------------

/** Everything the context-evolution LLM sees — its only surface (trust boundary). */
export const ContextEvolutionInputSchema = z.object({
  correlationId: z.string(),
  pullRequest: PullRequestSchema,
  /** Current context entries relevant to the change (so the model can UPDATE vs CREATE). */
  existingContext: z.array(ContextEntrySchema).default([]),
  /** Retrieved business/technical documentation snippets (reference only). */
  businessContext: z.array(ContextResultSchema).default([]),
  technicalContext: z.array(ContextResultSchema).default([]),
  /** Revert signal, if any. */
  revert: RevertResultSchema.optional(),
});
export type ContextEvolutionInput = z.infer<typeof ContextEvolutionInputSchema>;

/** The service-level result of processing one merged/reverted PR. */
export interface ContextEvolutionOutcome {
  correlationId: string;
  /** True when this event was already processed (idempotent no-op). */
  idempotent: boolean;
  status: ProposalStatus;
  proposal: ContextChangeProposal;
  revert?: RevertResult;
  /** The persisted entry, when a version was created (AUTO_UPDATE / revert applied). */
  entry?: ContextEntry;
  proposalRecordId?: string;
  decisionReason: string;
}

/** Categories a Business reviewer cares about. */
export const BUSINESS_CATEGORIES: ContextCategory[] = [
  'BUSINESS_RULE',
  'DOMAIN_BEHAVIOR',
  'EDGE_CASE',
  'HISTORICAL',
];
/** Categories a Technical reviewer cares about. */
export const TECHNICAL_CATEGORIES: ContextCategory[] = [
  'ARCHITECTURE',
  'PERFORMANCE',
  'INTEGRATION',
  'SECURITY',
];
