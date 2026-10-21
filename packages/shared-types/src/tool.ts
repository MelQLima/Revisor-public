import type { AgentId, UserRef } from './agent.js';

/**
 * The tool contract shared by every connector and enforced by the tool-gateway.
 *
 * Design rules encoded here:
 *  - Agents receive SEMANTIC tools (`search_slack_messages`), never raw API
 *    surfaces (§7). A tool exposes the smallest useful interface.
 *  - Every tool declares read vs write (§11) so the gateway can gate writes.
 *  - A connector's `execute` may ONLY report the honest data outcomes below.
 *    Gateway-only outcomes (denied / needs_confirmation / invalid_input) can
 *    never be fabricated by a connector or the LLM.
 */

/** External systems a tool belongs to. */
export type ToolDomain =
  | 'github'
  | 'slack'
  | 'datadog'
  | 'linear'
  | 'bigquery'
  | 'internal';

/** Read observes state; write may change real business state (§11). */
export type ToolMode = 'read' | 'write';

/**
 * The error taxonomy the whole platform reasons over (§24). "Could not query"
 * (`unavailable`) is deliberately distinct from "queried, found nothing"
 * (`no_data`) — collapsing them is the exact hallucination the spec forbids.
 */
export type ExecOutcome = 'ok' | 'no_data' | 'unavailable' | 'contradictory';

/** Gateway-decided outcomes that a connector can never produce itself. */
export type GatewayOutcome = 'denied' | 'needs_confirmation' | 'invalid_input';

export type ToolOutcome = ExecOutcome | GatewayOutcome;

/** What a connector's `execute` returns. Meta (name/domain/mode) is stamped by the gateway. */
export interface ExecResult<Data = unknown> {
  outcome: ExecOutcome;
  /** Present only when outcome === 'ok'. */
  data?: Data;
  /** Explanation, required for non-ok outcomes so the agent can reason honestly. */
  message?: string;
  /** Where the data came from, e.g. `bigquery:payments`, so facts stay traceable (§20). */
  source?: string;
}

/** Validates & narrows raw args. Zod schemas satisfy this structurally (`.parse`). */
export interface InputValidator<Args> {
  parse(input: unknown): Args;
  /** Optional machine-readable shape for LLM tool discovery (§21). */
  readonly jsonSchema?: unknown;
}

/** Per-invocation context threaded from the agent through the gateway to the tool. */
export interface ToolContext {
  agent: AgentId;
  correlationId: string;
  /** For per-user authorization + audit attribution. */
  user?: UserRef;
  /** Explicit confirmation for a write (§12). Writes without it get needs_confirmation. */
  confirmed?: boolean;
  /** Idempotency key for write retries (§13). */
  idempotencyKey?: string;
  /** Cooperative cancellation / timeouts. */
  signal?: AbortSignal;
}

export interface Tool<Args = unknown, Data = unknown> {
  readonly name: string;
  readonly domain: ToolDomain;
  readonly mode: ToolMode;
  /** One line for the LLM tool listing. */
  readonly description: string;
  readonly inputSchema: InputValidator<Args>;
  execute(args: Args, ctx: ToolContext): Promise<ExecResult<Data>>;
  /**
   * Optional human-readable preview of a write's effect, used to compose the
   * confirmation prompt (§12) BEFORE anything executes.
   */
  describeEffect?(args: Args): string;
}

/** A tool descriptor for discovery — what an agent turns into an LLM tool list (§21). */
export interface ToolDescriptor {
  name: string;
  domain: ToolDomain;
  mode: ToolMode;
  description: string;
  jsonSchema?: unknown;
}

/** The enriched result an agent receives from the gateway. */
export interface ToolResult<Data = unknown> {
  outcome: ToolOutcome;
  success: boolean;
  toolName: string;
  domain: ToolDomain;
  mode: ToolMode;
  data?: Data;
  message?: string;
  source?: string;
  /** True when the result was replayed from a prior idempotent execution (§13). */
  replayed?: boolean;
}

export function toDescriptor(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    domain: tool.domain,
    mode: tool.mode,
    description: tool.description,
    ...(tool.inputSchema.jsonSchema !== undefined ? { jsonSchema: tool.inputSchema.jsonSchema } : {}),
  };
}
