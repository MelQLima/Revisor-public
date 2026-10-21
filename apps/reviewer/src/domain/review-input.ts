import type { ContextResult } from './context.js';
import type { CodeSnippet, PullRequest } from './pull-request.js';
import type { ReviewFinding } from './review.js';

/**
 * Everything the reviewer needs to analyze a PR, assembled by the pipeline.
 * This is the ONLY surface the LLM providers see — they never reach back into
 * GitHub or the filesystem, which keeps the trust boundary clean.
 */
export interface ReviewInput {
  correlationId: string;
  pullRequest: PullRequest;
  /** Relevant source pulled from HEAD (definitions, adjacent validations). */
  relevantCode: CodeSnippet[];
  /** Business/domain/architecture context retrieved for this PR. */
  businessContext: ContextResult[];
  technicalContext: ContextResult[];
  /** Repository history signals (prior PRs, blame notes, incidents). */
  historyContext: ContextResult[];
}

/** Input to the second (validation) LLM pass. */
export interface ValidationInput {
  correlationId: string;
  pullRequest: PullRequest;
  candidateFindings: ReviewFinding[];
  /** The same context the analysis pass saw, so the validator can check claims. */
  businessContext: ContextResult[];
  technicalContext: ContextResult[];
  historyContext: ContextResult[];
  relevantCode: CodeSnippet[];
}

/** The validator's epistemic verdict on a candidate finding (Pass 2 spec §2). */
export type ValidationStatus = 'CONFIRMED' | 'CONTRADICTED' | 'UNCERTAIN';

export interface ValidationDecision {
  findingId: string;
  /**
   * CONFIRMED  — evidence supports the finding (KEEP).
   * CONTRADICTED — concrete evidence disproves it (candidate for REJECT).
   * UNCERTAIN  — insufficient evidence either way (KEEP; never reject).
   *
   * Optional for legacy/internal callers (stub/heuristic providers) that only
   * set `keep`; model output always carries an explicit status.
   */
  status?: ValidationStatus;
  /** True only when Pass 2 found evidence that DIRECTLY contradicts the finding. */
  contradictionFound?: boolean;
  /** The concrete contradictory evidence. Empty ⇒ no valid contradiction exists. */
  contradictingEvidence?: string;
  /**
   * Legacy advisory keep flag. The EFFECTIVE keep/drop decision is computed
   * deterministically in `applyValidation` from `status` + `contradictionFound`
   * + `contradictingEvidence` (a rejection is honored only with a real
   * contradiction), so a self-contradicting "reject" can never drop a finding.
   */
  keep?: boolean;
  /** Validator's (possibly revised) confidence in [0..1]. */
  adjustedConfidence: number;
  /** Validator's (possibly revised) certainty. */
  adjustedCertainty: ReviewFinding['certainty'];
  reason: string;
}

export interface ValidationResult {
  decisions: ValidationDecision[];
}
