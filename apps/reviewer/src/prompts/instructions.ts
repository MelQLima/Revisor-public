/**
 * Reviewer instruction fragments. Business and technical instructions are
 * separated so each dimension can be tuned independently.
 */

export const BUSINESS_REVIEW_INSTRUCTIONS = `BUSINESS / DOMAIN REVIEW — this is the product's core differentiator.

Evaluate whether the change is technically valid but nonetheless violates the
BUSINESS rules, domain constraints, or architectural decisions documented in the
provided context. Specifically look for violations of:
- business invariants and domain rules
- state transitions (an operation performed from an illegal state)
- financial consistency (money moving in a way a rule forbids)
- entity relationships and identity (associating records without required validation)
- authorization rules
- integration contracts (breaking an expectation another system relies on)
- documented edge cases and historical behavior

For every business finding:
- Name the exact business rule and cite the doc that states it (e.g. docs/ai/domain/payments.md).
- Explain the invariant the change breaks and the state in which it breaks.
- If the rule is not present in the provided context, DO NOT assert it — instead
  note that the change *may* need business review and mark certainty accordingly.`;

export const TECHNICAL_REVIEW_INSTRUCTIONS = `TECHNICAL REVIEW.

Evaluate correctness and engineering risk:
- correctness / logic errors and regressions
- error handling and failure modes
- concurrency, transactions, and database behavior (including SQL)
- performance and obvious inefficiencies that matter
- security (injection, authz, unsafe handling of untrusted input, leaked secrets)
- API contracts and type safety
- maintainability where it is a genuine engineering concern
- test coverage: is an important test missing for the behavior changed?

Do NOT emit generic style comments or subjective preferences. If the change looks
correct and well-tested, prefer a positive observation over a manufactured finding.`;

export const CONFIDENCE_GUIDANCE = `CONFIDENCE & CERTAINTY CALIBRATION:
- confirmed  (0.85–1.0): evidence directly demonstrates the issue.
- likely     (0.7–0.85): strong evidence, a small unproven gap remains.
- potential  (0.5–0.7): plausible and conditional; you could not find a guard
                        that excludes the bad state, but you also could not prove it occurs.
- insufficient-evidence (< 0.5): you cannot substantiate the claim — do not report it
                        as a finding; mention it only in the summary if useful.`;
