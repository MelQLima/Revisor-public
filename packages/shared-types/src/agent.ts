/** The three Triple R agents. Shared so authorization/audit can name them. */
export type AgentId = 'reviewer' | 'resolver' | 'reinforcement';

/**
 * A user on whose behalf an agent acts. The authorization layer may narrow tool
 * access per-user (§9); the audit trail records who initiated an action (§14).
 * Kept minimal on purpose — a stable id + optional display, never credentials.
 */
export interface UserRef {
  id: string;
  displayName?: string;
  roles?: string[];
}
