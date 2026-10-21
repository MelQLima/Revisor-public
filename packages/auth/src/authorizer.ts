import type {
  AuthorizationDecision,
  AuthorizationRequest,
  Authorizer,
  Permission,
} from '@triple-r/shared-types';
import { DEFAULT_GRANTS, type GrantMatrix } from './grants.js';

/**
 * Static, in-memory authorizer driven by a grant matrix. Deterministic and
 * dependency-free so it is trivial to test and reason about.
 *
 * Rule: an agent is allowed a (domain, mode) if it holds that exact grant, OR
 * (for a read) it holds a `write` grant on the domain — a write-capable agent
 * can always read. This is where per-user narrowing will later hook in via
 * `req.user`; today the decision is per-agent.
 */
export class StaticAuthorizer implements Authorizer {
  private readonly grants: GrantMatrix;

  constructor(grants: GrantMatrix = DEFAULT_GRANTS) {
    this.grants = grants;
  }

  authorize(req: AuthorizationRequest): AuthorizationDecision {
    const held: Permission[] = this.grants[req.agent] ?? [];
    const permits = (p: Permission): boolean =>
      p.domain === req.domain && (p.mode === req.mode || p.mode === 'write');

    if (held.some(permits)) {
      return { allowed: true, reason: `${req.agent} is granted ${req.domain}:${req.mode}` };
    }
    return {
      allowed: false,
      reason: `${req.agent} lacks ${req.domain}:${req.mode} (tool ${req.toolName})`,
    };
  }
}
