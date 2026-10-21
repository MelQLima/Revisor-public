import { z } from 'zod';

/**
 * The core review vocabulary.
 *
 * `ReviewFinding` is the unit of output. Every serious finding must carry
 * evidence; the pipeline actively filters out unsupported, low-confidence
 * claims before they ever reach a developer (see review-policy).
 */

export const ReviewSeveritySchema = z.enum(['BLOCKER', 'IMPORTANT', 'SUGGESTION']);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

/**
 * Epistemic status of a finding — kept explicit so the reviewer never presents
 * speculation as fact. Maps loosely onto confidence bands but is asserted by
 * the model so we can cross-check it against the numeric confidence.
 */
export const FindingCertaintySchema = z.enum([
  'confirmed', // evidence directly demonstrates the issue
  'likely', // strong evidence, small gap
  'potential', // plausible but conditional / unproven
  'insufficient-evidence', // cannot substantiate; should usually be dropped
]);
export type FindingCertainty = z.infer<typeof FindingCertaintySchema>;

export const ReviewCategorySchema = z.enum(['business', 'technical']);
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

/** A piece of evidence backing a finding, pointing at a concrete source. */
export const EvidenceSchema = z.object({
  /** e.g. `docs/ai/domain/payments.md`, `src/person.service.ts:42`, `commit abc123`. */
  source: z.string(),
  /** Short quote or paraphrase of what the source establishes. */
  detail: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string(),
  category: ReviewCategorySchema,
  severity: ReviewSeveritySchema,
  certainty: FindingCertaintySchema,
  /** Model-asserted confidence in [0..1]. */
  confidence: z.number().min(0).max(1),

  title: z.string().min(1),

  file: z.string().optional(),
  line: z.number().int().positive().optional(),

  /** What is wrong (the claim). */
  problem: z.string().min(1),

  /** Concrete support. Business findings MUST have >= 1 evidence item. */
  evidence: z.array(EvidenceSchema).default([]),

  /** The specific business rule reference, when applicable. */
  businessRule: z.string().optional(),

  /** Concrete consequence if unaddressed. */
  impact: z.string().min(1),

  /** Actionable fix. */
  recommendation: z.string().min(1),

  /**
   * Set when the validation pass tried to weaken/drop a high-criticality finding
   * without concrete contradictory evidence. The finding is RETAINED and flagged
   * for a human instead of being silently approved (asymmetric-error policy).
   */
  contested: z
    .object({
      reason: z.string(),
      criticality: z.number().int().min(1).max(6),
    })
    .optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** Findings emitted by the analysis pass, before validation/filtering. */
export const CandidateReviewSchema = z.object({
  summary: z.string().default(''),
  findings: z.array(ReviewFindingSchema).default([]),
  positives: z.array(z.string()).default([]),
});
export type CandidateReview = z.infer<typeof CandidateReviewSchema>;

export const ReviewVerdictSchema = z.enum(['approve', 'comment', 'request_changes']);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** Why a candidate finding was dropped — kept for observability. */
export const RejectedFindingSchema = z.object({
  finding: ReviewFindingSchema,
  reason: z.string(),
});
export type RejectedFinding = z.infer<typeof RejectedFindingSchema>;

export const ReviewStatsSchema = z.object({
  changedFiles: z.number().int().nonnegative(),
  contextResults: z.number().int().nonnegative(),
  businessRulesConsulted: z.number().int().nonnegative(),
  historyReferences: z.number().int().nonnegative(),
  candidateFindings: z.number().int().nonnegative(),
  rejectedFindings: z.number().int().nonnegative(),
});
export type ReviewStats = z.infer<typeof ReviewStatsSchema>;

/** Final, validated, filtered review ready to be posted. */
export const ReviewResultSchema = z.object({
  correlationId: z.string(),
  summary: z.string(),
  verdict: ReviewVerdictSchema,
  findings: z.array(ReviewFindingSchema),
  positives: z.array(z.string()),
  rejected: z.array(RejectedFindingSchema).default([]),
  stats: ReviewStatsSchema,
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
