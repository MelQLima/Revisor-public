import type { AgentId, Permission } from '@triple-r/shared-types';

/** A grant matrix maps each agent to the capabilities it holds. */
export type GrantMatrix = Record<AgentId, Permission[]>;

/**
 * Default Triple R grants. This encodes the spec's example (§9) as a STARTING
 * point — it is data, passed into the authorizer, so deployments override it
 * without touching enforcement logic. A `write` grant implies `read` on the same
 * domain (see the authorizer), so it is not restated here.
 *
 *   Reviewer       — analytical only: GitHub read.
 *   Resolver       — investigative, read-only across systems.
 *   Reinforcement  — operational: read everywhere, write where it acts.
 */
export const DEFAULT_GRANTS: GrantMatrix = {
  reviewer: [{ domain: 'github', mode: 'read' }],
  resolver: [
    { domain: 'github', mode: 'read' },
    { domain: 'slack', mode: 'read' },
    { domain: 'datadog', mode: 'read' },
    { domain: 'linear', mode: 'read' },
    { domain: 'bigquery', mode: 'read' },
  ],
  reinforcement: [
    { domain: 'github', mode: 'read' },
    { domain: 'datadog', mode: 'read' },
    { domain: 'bigquery', mode: 'read' },
    { domain: 'slack', mode: 'write' },
    { domain: 'linear', mode: 'write' },
    { domain: 'internal', mode: 'write' },
  ],
};
