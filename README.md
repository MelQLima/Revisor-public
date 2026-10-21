# Triple R

> **Public edition.** This repository is a sanitized replica of a private
> project. The code is the same, but everything tied to the company it was
> originally built for has been removed: its proprietary business rules, internal
> repository references, and any security-sensitive details about that system.
> The `apps/reviewer/docs/ai` knowledge base now describes a **fictional example
> domain (Acme Wallet)** so the reviewer can be run and evaluated end to end.
> The git history starts fresh for the same reason.
>
> *Versão pública: réplica sanitizada de um projeto privado. As regras de
> negócio proprietárias, referências internas e detalhes sensíveis de segurança
> da empresa original foram removidos e substituídos por um domínio de exemplo
> fictício.*

An AI platform with three specialized agents over a shared business-knowledge
layer and a shared LLM gateway. Currently a single **npm-workspaces monorepo**,
structured so any part can later be split into its own repository without a
rewrite.

```
                         TRIPLE R
          ┌─────────────────┼─────────────────┐
      REVIEWER          RESOLVER        REINFORCEMENT      (apps/*)
          └─────────────────┼─────────────────┘
                   BUSINESS KNOWLEDGE                      (packages/*)
                       LLM GATEWAY  ──▶  QWEN
```

## Layout

```
apps/
  reviewer/          Business-aware AI PR reviewer (the original `revisor`).
  resolver/          (planned) ticket / issue investigation & resolution.
  reinforcement/     (planned) operational assistant, with strong action guards.
packages/
  observability/     Shared structured logging + correlation ids.
  shared-types/      Cross-cutting contracts: agents, tools, tool results, authz, audit.
  auth/              Per-agent (later per-user) tool grants + authorizer.
  tool-gateway/      The choke point: permission → confirm → idempotency → audit.
  tools/             Semantic connectors (bigquery, slack) — real seam + in-memory fake.
  …                  (planned) llm, business-knowledge, config, prompt-safety, vcs.
infrastructure/      (planned) docker, llm serving, deployment.
```

## The tool architecture (Resolver & Reinforcement depend on this)

Agents never call an external API directly. They receive **semantic tools**
(`slack_search_messages`, not raw HTTP) and invoke them through the
**tool-gateway**, which enforces, in order:

```
enablement (§21) → authorization (§9) → input validation → write-confirmation (§12)
  → idempotency (§13) → execute → audit at the infra layer (§14) → observability (§25)
```

Two invariants the code (not the prompt) guarantees:

- **`unavailable` ≠ `no_data`** (§24). A tool that couldn't be reached never
  becomes "nothing found" — the outcome taxonomy is a typed union a connector
  cannot fake, and gateway-only outcomes (`denied`, `needs_confirmation`) cannot
  be produced by a connector or the LLM.
- **Writes are gated.** A write with no explicit `confirmed` flag returns
  `needs_confirmation` with a human preview and does **not** execute; retries
  with an idempotency key replay the first result exactly once.

Every connector ships an in-memory **fake** beside its real seam, so the whole
stack runs offline in tests (mirroring the reviewer's real+fake discipline).

Domain boundaries are explicit and dependencies flow one way: **apps depend on
packages, never on each other; packages never depend on apps.**

## Develop

```bash
npm install                 # sets up all workspaces
npm test                    # runs every workspace's tests
npm run typecheck           # type-checks every workspace
npm run review -- ./apps/reviewer/fixtures/02-business-rule-violation.json
npm run dev                 # runs the reviewer webhook server
```

Per-agent detail lives in each app's own README, e.g.
[`apps/reviewer/README.md`](apps/reviewer/README.md).

## Migration status

Incremental migration from the single-package `revisor` into Triple R:

- [x] **Step 0** — npm-workspaces scaffold; reviewer moved to `apps/reviewer`.
- [x] **Step 1** — extracted `packages/observability` (logging + correlation).
- [x] **Tool foundation** — `shared-types`, `auth`, `tool-gateway`, `tools`
  (bigquery + slack fakes). Permissions, read/write, confirmation, idempotency,
  infra-level audit, and the `unavailable ≠ no_data` taxonomy — all tested offline.
- [ ] Next — `packages/llm` (gateway port + generic `complete()` seam).
- [ ] `packages/business-knowledge` (context/store + evolution + docs).
- [ ] `apps/resolver` — investigation agent (intake → plan → retrieve → tools →
  facts/observations/hypotheses/conclusions → structured resolution).
- [ ] `apps/reinforcement` — operational assistant (read tools + gated writes).
- [ ] More connectors (github read, datadog via MCP, linear, internal).

Each step keeps the full test suite green. Production packaging of source-only
shared packages (build output + export conditions, or project references) is
wired at the deployment step.
