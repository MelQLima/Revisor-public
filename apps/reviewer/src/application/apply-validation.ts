import type { ValidationDecision, ValidationResult } from '../domain/review-input.js';
import type { ReviewFinding } from '../domain/review.js';
import type { RejectedFinding } from '../domain/review.js';
import { findingCriticality, isHighCriticality } from '../domain/criticality.js';

/**
 * Merge the validation (Pass 2) decisions back onto the candidate findings,
 * enforcing the adversarial-validator contract deterministically — the safety
 * gate lives in CODE, not just in the prompt the model may ignore.
 *
 * Two invariants (Pass 2 spec §6/§7/§8/§15/§16):
 *
 *  1. A finding is REJECTED only when the validator supplies a real
 *     contradiction — status=CONTRADICTED with concrete `contradictingEvidence`.
 *     CONFIRMED, UNCERTAIN, or a "reject" whose reasoning actually CONFIRMS the
 *     violation (no contradicting evidence) all KEEP the finding.
 *
 *  2. A HIGH-criticality finding (money/refund/credit/payment invariants) is
 *     NEVER silently dropped by the model. Even a well-formed contradiction only
 *     ESCALATES it to a human (kept + `contested`), and the validator cannot bury
 *     it by lowering its confidence/certainty. Missing decision ⇒ keep, not drop.
 */
export function applyValidation(
  candidates: ReviewFinding[],
  validation: ValidationResult,
): { kept: ReviewFinding[]; rejected: RejectedFinding[] } {
  const byId = new Map(validation.decisions.map((d) => [d.findingId, d]));
  const kept: ReviewFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const finding of candidates) {
    const decision = byId.get(finding.id);
    const highCrit = isHighCriticality(finding);

    if (!decision) {
      // Fail-safe toward KEEPING money findings: a missing decision must never
      // silently approve a high-criticality violation.
      if (highCrit) {
        kept.push(escalate(finding, 'validator returned no decision for a high-criticality finding'));
      } else {
        rejected.push({ finding, reason: 'no validation decision returned for finding' });
      }
      continue;
    }

    if (!isHonoredRejection(decision)) {
      // KEEP. The validator affirmed it, was uncertain, or produced a
      // "rejection" without a real contradiction (§15/§16) — all keep.
      kept.push(applyAdjustments(finding, decision, highCrit));
      continue;
    }

    // The validator presents a well-formed contradiction.
    if (highCrit) {
      // §8: a Weight-5/6 finding is never dropped on model judgement alone.
      kept.push(escalate(finding, `validator claims contradiction: ${decision.contradictingEvidence || decision.reason}`));
      continue;
    }
    rejected.push({ finding, reason: `validator dropped (CONTRADICTED): ${decision.reason}` });
  }

  return { kept, rejected };
}

/**
 * A rejection is honored ONLY with a concrete, structurally-present contradiction
 * (§4/§6). Legacy internal callers (stub/heuristic) that set only `keep=false`
 * and no `status` are trusted and honored.
 */
function isHonoredRejection(d: ValidationDecision): boolean {
  const structuredContradiction =
    d.status === 'CONTRADICTED' &&
    d.contradictionFound === true &&
    (d.contradictingEvidence ?? '').trim() !== '';
  const legacyReject = d.status === undefined && d.keep === false;
  return structuredContradiction || legacyReject;
}

const CERTAINTY_RANK: Record<ReviewFinding['certainty'], number> = {
  confirmed: 3,
  likely: 2,
  potential: 1,
  'insufficient-evidence': 0,
};

/** Apply the validator's confidence/certainty adjustment. */
function applyAdjustments(
  finding: ReviewFinding,
  decision: ValidationDecision,
  highCrit: boolean,
): ReviewFinding {
  if (highCrit) {
    // The validator may not WEAKEN a high-criticality finding below what the
    // analysis pass asserted — that would let it bury the finding under the
    // policy confidence floor. Take the stronger of the two.
    return {
      ...finding,
      confidence: Math.max(finding.confidence, decision.adjustedConfidence),
      certainty:
        CERTAINTY_RANK[decision.adjustedCertainty] > CERTAINTY_RANK[finding.certainty]
          ? decision.adjustedCertainty
          : finding.certainty,
    };
  }
  return { ...finding, confidence: decision.adjustedConfidence, certainty: decision.adjustedCertainty };
}

/** Retain a high-criticality finding at full strength and flag it for a human. */
function escalate(finding: ReviewFinding, reason: string): ReviewFinding {
  return { ...finding, contested: { reason, criticality: findingCriticality(finding) } };
}
