import type {
  CandidateReview,
  ReviewFinding,
  ReviewVerdict,
  RejectedFinding,
} from './review.js';

/**
 * Deterministic review policy — pure functions, no I/O.
 *
 * These encode the non-negotiable rules from the review policy so they are
 * enforced in code (not left to the LLM's discretion):
 *   - business findings require evidence
 *   - low-confidence findings are dropped
 *   - only high-confidence BLOCKER/IMPORTANT findings can block
 *   - a small number of strong findings beats many weak ones
 */

export interface PolicyConfig {
  /** Findings below this confidence are dropped entirely. */
  minConfidence: number;
  /** BLOCKER/IMPORTANT below this confidence are downgraded (non-blocking). */
  blockingConfidence: number;
  /** Cap on how many findings we surface, to avoid overwhelming developers. */
  maxFindings: number;
  /** When true, never emit `request_changes` (comment-only mode). */
  dryRun: boolean;
}

export const DEFAULT_POLICY: PolicyConfig = {
  minConfidence: 0.55,
  blockingConfidence: 0.8,
  maxFindings: 15,
  dryRun: false,
};

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
  BLOCKER: 0,
  IMPORTANT: 1,
  SUGGESTION: 2,
};

export interface FilterOutcome {
  kept: ReviewFinding[];
  rejected: RejectedFinding[];
}

/**
 * Apply the deterministic policy filter to a set of candidate findings.
 * Runs AFTER the LLM validation pass — belt and suspenders.
 */
export function filterFindings(
  findings: ReviewFinding[],
  policy: PolicyConfig,
): FilterOutcome {
  const kept: ReviewFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const raw of findings) {
    // A contested (escalated) high-criticality finding MUST reach a human — it
    // is exempt from the confidence-based drops AND the blocking-downgrade below
    // (it keeps its severity). It still requires evidence, which every escalated
    // candidate already carries.
    if (raw.contested) {
      kept.push(raw);
      continue;
    }

    const finding = normalizeFinding(raw, policy);

    if (finding.certainty === 'insufficient-evidence') {
      rejected.push({ finding, reason: 'certainty=insufficient-evidence' });
      continue;
    }
    if (finding.confidence < policy.minConfidence) {
      rejected.push({
        finding,
        reason: `confidence ${finding.confidence.toFixed(2)} < min ${policy.minConfidence}`,
      });
      continue;
    }
    // Rule 4: every business finding must have evidence.
    if (finding.category === 'business' && finding.evidence.length === 0) {
      rejected.push({ finding, reason: 'business finding without evidence' });
      continue;
    }
    // A BLOCKER with no evidence at all is not actionable — never trust it.
    if (finding.severity === 'BLOCKER' && finding.evidence.length === 0) {
      rejected.push({ finding, reason: 'BLOCKER without evidence' });
      continue;
    }
    kept.push(finding);
  }

  kept.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.confidence - a.confidence,
  );

  // Rule 7/8: don't overwhelm — keep the strongest N.
  const overflow = kept.splice(policy.maxFindings);
  for (const finding of overflow) {
    rejected.push({ finding, reason: 'exceeds maxFindings cap' });
  }

  return { kept, rejected };
}

/**
 * Downgrade findings that are not confident enough to block, so that a
 * BLOCKER only "blocks" when we're genuinely confident (Rule 10).
 */
function normalizeFinding(finding: ReviewFinding, policy: PolicyConfig): ReviewFinding {
  if (
    (finding.severity === 'BLOCKER' || finding.severity === 'IMPORTANT') &&
    finding.confidence < policy.blockingConfidence
  ) {
    return { ...finding, severity: 'SUGGESTION' };
  }
  return finding;
}

/**
 * Derive the overall verdict from the surviving findings.
 * Only a confident BLOCKER can request changes (and never in dry-run).
 */
export function decideVerdict(
  findings: ReviewFinding[],
  policy: PolicyConfig,
): ReviewVerdict {
  const hasBlocker = findings.some(
    (f) => f.severity === 'BLOCKER' && f.confidence >= policy.blockingConfidence,
  );
  if (hasBlocker && !policy.dryRun) return 'request_changes';
  if (findings.length > 0) return 'comment';
  return 'approve';
}

/**
 * Assemble the final review from validated findings + positives.
 * Pure — the caller supplies stats and correlation id.
 */
export function aggregateReview(
  candidate: Pick<CandidateReview, 'summary' | 'positives'>,
  outcome: FilterOutcome,
  policy: PolicyConfig,
): {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  positives: string[];
  rejected: RejectedFinding[];
} {
  return {
    verdict: decideVerdict(outcome.kept, policy),
    findings: outcome.kept,
    positives: candidate.positives,
    rejected: outcome.rejected,
  };
}
