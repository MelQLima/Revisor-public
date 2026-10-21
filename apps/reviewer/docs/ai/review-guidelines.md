# Review Guidelines (policy)

These guidelines are enforced both in the prompt and in code (`domain/policy.ts`).

1. **Only report actionable issues.** No busywork comments.
2. **No style/formatting nits as bugs.** Linters/formatters own style.
3. **Never invent business rules.** Only rules present in `docs/ai` count.
4. **Every business finding cites evidence** — a `docs/ai` path, a source file,
   or a commit. No evidence ⇒ not a business finding.
5. **Prefer repository evidence over assumptions.** Quote the source.
6. **If context is insufficient, say so** and lower confidence.
7. **Don't overwhelm developers.** A few strong findings beat many weak ones.
8. **A small number of high-confidence findings is best.**
9. **Never expose secrets/tokens/credentials.**
10. **Don't auto-request changes on low-confidence findings.** Only a BLOCKER
    with confidence ≥ the configured blocking threshold requests changes.

## Confidence bands

| Band                    | Confidence | Meaning                                   |
| ----------------------- | ---------- | ----------------------------------------- |
| confirmed               | 0.85–1.0   | Evidence directly demonstrates the issue. |
| likely                  | 0.7–0.85   | Strong evidence, small gap.               |
| potential               | 0.5–0.7    | Conditional; guard not found either way.  |
| insufficient-evidence   | < 0.5      | Do not report as a finding.               |

## Severity

- **BLOCKER** — a correctness/financial/security defect that must be fixed.
- **IMPORTANT** — a real problem that should be addressed but may not block.
- **SUGGESTION** — a worthwhile improvement; never blocks.
