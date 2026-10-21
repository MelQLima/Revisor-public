import type { AgentId, UserRef } from './agent.js';
import type { ToolDomain, ToolMode } from './tool.js';

/**
 * Authorization contracts (§9). Tools are explicitly granted to agents; no agent
 * may use a tool it was not granted. The model supports per-agent now and
 * per-user later (the request carries an optional user).
 */

/** A single capability: "may perform <mode> on <domain>". */
export interface Permission {
  domain: ToolDomain;
  mode: ToolMode;
}

export interface AuthorizationRequest {
  agent: AgentId;
  domain: ToolDomain;
  mode: ToolMode;
  toolName: string;
  user?: UserRef;
}

export interface AuthorizationDecision {
  allowed: boolean;
  /** Always populated — recorded verbatim in the audit trail. */
  reason: string;
}

export interface Authorizer {
  authorize(req: AuthorizationRequest): AuthorizationDecision;
}
