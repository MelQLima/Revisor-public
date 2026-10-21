import type {
  ContextCategory,
  ContextChangeProposal,
  ProposalStatus,
} from './context-evolution.js';

/**
 * Deterministic context-evolution policy — pure functions, no I/O.
 *
 * The LLM proposes; this code decides. Thresholds and safeguards are enforced
 * here (not left to the model) so behavior is predictable and testable.
 */

export interface ContextPolicyConfig {
  /** confidence >= this AND not review-required → applied automatically. */
  autoUpdateThreshold: number;
  /** confidence in [proposalThreshold, autoUpdateThreshold) → PENDING_REVIEW. */
  proposalThreshold: number;
  /**
   * Categories that ALWAYS require human review, even at high confidence
   * (the "don't auto-modify high-impact business rules" safeguard). Empty by
   * default; set e.g. to BUSINESS_RULE,SECURITY to enforce approval.
   */
  reviewRequiredCategories: ContextCategory[];
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicyConfig = {
  autoUpdateThreshold: 0.9,
  proposalThreshold: 0.7,
  reviewRequiredCategories: [],
};

export interface ProposalValidation {
  valid: boolean;
  reason: string;
}

/**
 * Deterministic validation gate. A proposal that fails here must never persist
 * as a context version (it collapses to NO_CONTEXT_CHANGE). Evidence is
 * mandatory for any real change.
 */
export function validateProposal(proposal: ContextChangeProposal): ProposalValidation {
  if (proposal.type === 'NO_CHANGE') {
    return { valid: true, reason: 'no change proposed' };
  }
  if (!proposal.topic.trim()) return { valid: false, reason: 'missing topic' };
  if (!proposal.summary.trim()) return { valid: false, reason: 'missing summary' };
  if (!proposal.reason.trim()) return { valid: false, reason: 'missing reason' };
  if (proposal.confidence < 0 || proposal.confidence > 1) {
    return { valid: false, reason: 'confidence out of range' };
  }
  // Every real context change must be evidence-backed.
  if (proposal.evidence.length === 0) {
    return { valid: false, reason: 'no evidence' };
  }
  // CREATE/UPDATE must carry the actual knowledge statement to store.
  if (
    (proposal.type === 'CREATE' || proposal.type === 'UPDATE') &&
    !(proposal.proposedContent && proposal.proposedContent.trim())
  ) {
    return { valid: false, reason: 'CREATE/UPDATE without proposedContent' };
  }
  return { valid: true, reason: 'valid' };
}

export interface StatusDecision {
  status: ProposalStatus;
  reason: string;
}

/**
 * Map a validated proposal to a persistence decision using confidence bands
 * and the review-required safeguard.
 */
export function decideStatus(
  proposal: ContextChangeProposal,
  policy: ContextPolicyConfig,
): StatusDecision {
  if (proposal.type === 'NO_CHANGE') {
    return { status: 'REJECTED', reason: 'NO_CONTEXT_CHANGE' };
  }
  if (proposal.confidence < policy.proposalThreshold) {
    return {
      status: 'REJECTED',
      reason: `confidence ${proposal.confidence.toFixed(2)} < proposal threshold ${policy.proposalThreshold} → NO_CONTEXT_CHANGE`,
    };
  }
  const reviewRequired = policy.reviewRequiredCategories.includes(proposal.category);
  if (proposal.confidence >= policy.autoUpdateThreshold && !reviewRequired) {
    return { status: 'AUTO_UPDATE', reason: `confidence ${proposal.confidence.toFixed(2)} ≥ auto threshold` };
  }
  if (reviewRequired && proposal.confidence >= policy.autoUpdateThreshold) {
    return { status: 'PENDING_REVIEW', reason: `category ${proposal.category} requires human review` };
  }
  return {
    status: 'PENDING_REVIEW',
    reason: `confidence ${proposal.confidence.toFixed(2)} in [${policy.proposalThreshold}, ${policy.autoUpdateThreshold}) → proposal`,
  };
}

/**
 * Idempotency key for a merged/reverted PR event. Stable across redeliveries of
 * the same GitHub event (same repo + PR + merge commit + event type).
 */
export function idempotencyKey(input: {
  repository: string;
  pullNumber: number;
  mergeCommitSha?: string;
  eventType: string;
}): string {
  return [
    input.repository.toLowerCase(),
    input.pullNumber,
    input.mergeCommitSha ?? 'no-merge-sha',
    input.eventType,
  ].join(':');
}
