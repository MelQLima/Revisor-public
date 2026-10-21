# AI Review Context (`docs/ai`)

This directory is the **knowledge base** the AI reviewer treats as ground truth.
Anything documented here can influence a review; anything **not** here the
reviewer must not assert as a business rule (see
[review-guidelines.md](./review-guidelines.md), Rule 3).

The retriever (`DocumentContextProvider`) indexes every `.md` file here, chunked
by heading, and returns the most relevant sections for a given PR. Cite these
files by path in a review, e.g. `docs/ai/domain/payments.md#identity-invariant`.

## What to document

| Category                | Where                          |
| ----------------------- | ------------------------------ |
| Product/business intent | `business-context.md`          |
| Architecture & ADRs     | `architecture.md`              |
| Review policy specifics | `review-guidelines.md`         |
| Domain rules per area   | `domain/<area>.md`             |
| Evidence-anchored rule registry (optional) | `business-rules/**` |

> An optional `business-rules/` tree can hold a deeper, per-rule layer (evidence,
> risk, confidence, conflicts, unknowns). It is retrieved as `business` context —
> `inferKind()` maps any `business-rule` path to the `business` kind.

For each domain area, document:

- **Business rules** — what must always/never happen, in plain language.
- **Domain entities** — the nouns and their meaning.
- **Invariants** — conditions that must hold before/after an operation.
- **State transitions** — the legal state machine (and illegal transitions).
- **Financial rules** — how money may and may not move.
- **Integration behavior** — contracts other systems rely on.
- **Architectural constraints** — decisions that must not be silently broken.
- **Known edge cases** — the sharp corners.
- **Historical incidents** — what broke before, and the guard added to prevent it.
- **Important decisions** — why the code is the way it is.

## How to write a rule so the reviewer can use it

Give each rule a stable heading and state the invariant explicitly:

```md
### Identity invariant

A payment MUST be associated to a person only after the person's identity has
been validated (CPF match). Email alone is NOT a sufficient identifier because
emails can be shared across accounts.
```

> The domain docs in this public edition describe a **fictional example domain**
> (Acme Wallet). Replace them with your own product's rules; the reviewer relies
> on these paths as evidence anchors.
