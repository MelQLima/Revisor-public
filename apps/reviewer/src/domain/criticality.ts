import type { ReviewFinding } from './review.js';

/**
 * Business-rule criticality (1–6) — the blast radius if the rule is changed,
 * bypassed, or reviewed WRONG. The second-stage validator must be able to gauge
 * criticality from a finding alone, with no I/O. Direction matters more than technology:
 * moving money out (6) ≫ receiving a payment (3).
 *
 *   6  BUSINESS-CRITICAL  outbound + irreversible + financial (refund, cash-out,
 *                         credit release) AND the money invariants (FIN-*).
 *   5  CRITICAL           outbound command / near-final money decision.
 *   4  HIGH               internal decision that materially affects money/state.
 *   3  MODERATE           inbound / read.
 *   1–2 LOW/TRIVIAL       internal, cosmetic, logging.
 *
 * The mapping deliberately errs HIGH for money domains: per the asymmetric-error
 * policy, over-escalating a money finding is far cheaper than silently approving
 * a real violation.
 */
export type Criticality = 1 | 2 | 3 | 4 | 5 | 6;

/** At or above this weight, a finding may never be silently dropped by the
 * validator — an attempted drop is escalated to a human instead. */
export const HIGH_CRITICALITY: Criticality = 5;

/** Rule-id prefixes → weight, drawn from criticality.md's direction weighting. */
const PREFIX_WEIGHT: Array<{ re: RegExp; weight: Criticality }> = [
  // Money leaving the company + the money-representation invariants: irreversible.
  { re: /\b(FIN|REFUND|CASHOUT)-/i, weight: 6 },
  // Outbound commands / near-final money decisions.
  { re: /\b(CREDIT|PAYMENT|CANCEL|ALLOC|BID)-/i, weight: 5 },
];

/** Any text on the finding that could carry a rule reference. */
function ruleText(finding: ReviewFinding): string {
  return [finding.businessRule ?? '', finding.title, finding.problem, ...finding.evidence.map((e) => e.source)].join(
    ' ',
  );
}

/**
 * Estimate a finding's criticality with no external lookup. Prefers an explicit
 * `businessRule`, then any rule reference embedded in the finding text, then a
 * category/severity fallback.
 */
export function findingCriticality(finding: ReviewFinding): Criticality {
  const text = ruleText(finding);
  for (const { re, weight } of PREFIX_WEIGHT) {
    if (re.test(text)) return weight;
  }

  if (finding.category === 'business') return 3;
  // Technical findings: never business-critical, scaled by severity.
  if (finding.severity === 'BLOCKER') return 3;
  if (finding.severity === 'IMPORTANT') return 2;
  return 1;
}

/** True when a finding is critical enough to demand escalation over silent drop. */
export function isHighCriticality(finding: ReviewFinding): boolean {
  return findingCriticality(finding) >= HIGH_CRITICALITY;
}
