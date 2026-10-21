# Architecture Context & Decisions (Acme Wallet example)

> Example architectural constraints for the fictional Acme Wallet. Document your
> own ADRs here; a PR that silently breaks one should be flagged.

## Money

- Ledger amounts use a decimal type with 2 decimal places. They are not floats
  and not integer cents.
- A change that rounds a decimal through `Number`, mixes cents with decimal
  amounts, or introduces a new float money field passes types but violates the
  rule. Flag it.

## Allocation & concurrency invariants

- Allocation idempotency rests on the unique `(paymentId, installmentId)` pair
  plus "already allocated" pre-checks. Do not create allocations outside the
  sanctioned service.
- Payment webhooks are protected by a status-regression guard and a creation
  lock; duplicate or out-of-order webhooks must not overwrite a payment.

## Coding standards — a review rubric

Prefer `const`, avoid `as` / `any`, boolean names use `is`/`has` prefixes, no
magic numbers, small functions. Treat clear violations as `SUGGESTION`-level
engineering concerns, not blockers.

## How to write an ADR

```md
### ADR-000X: <title>
- Status: accepted | superseded by ADR-000Y
- Context / Decision / Consequences
```

## Reviewer's own architecture (this project)

Revisor uses clean/hexagonal layering: `domain` (pure) ← `application` (pipeline)
← `integrations` (GitHub/LLM/history) and `infrastructure` (config/logging/http).
Every external dependency sits behind an interface with a real and a fake
implementation, so retrieval (document → vector DB), the LLM vendor, and the VCS
host can each be swapped without touching the pipeline. See the project
[README](../../README.md).
