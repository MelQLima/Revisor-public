import { randomUUID } from 'node:crypto';

/**
 * Short, human-scannable correlation id for one unit of agent work.
 * The prefix names the agent/flow (default `rev` for reviewer history).
 */
export function newCorrelationId(prefix = 'rev'): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
