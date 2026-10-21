import type { AgentId } from './agent.js';
import type { ToolDomain, ToolMode, ToolOutcome } from './tool.js';

/**
 * Audit contracts (§14). Every tool invocation Reinforcement (or any agent) makes
 * is recorded at the INFRASTRUCTURE layer by the gateway — never derived from the
 * LLM's own narration. Sensitive argument values are redacted before storage.
 */

export interface AuditEvent {
  id: string;
  timestamp: string; // ISO 8601
  correlationId: string;
  agent: AgentId;
  /** Initiating user id, when acting on a user's behalf. */
  user?: string;
  tool: string;
  domain: ToolDomain;
  mode: ToolMode;
  /** Redacted arguments — never raw secrets. */
  args: unknown;
  outcome: ToolOutcome;
  success: boolean;
  durationMs: number;
  idempotencyKey?: string;
  /** The authorization decision that gated this call. */
  authorization: { allowed: boolean; reason: string };
  /** Error message when the tool failed (already redacted). */
  error?: string;
}

/** Where audit events go. In-memory for tests; a DB/append-only log in production. */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}
