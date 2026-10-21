import type { AuditEvent, AuditSink, ToolResult } from '@triple-r/shared-types';

/**
 * Idempotency store for write retries (§13). Keyed by the caller's idempotency
 * key; a hit replays the prior result instead of executing again. In-memory for
 * now; a durable store (Redis/Postgres) drops in behind the same interface.
 */
export interface IdempotencyStore {
  get(key: string): Promise<ToolResult | undefined>;
  set(key: string, result: ToolResult): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, ToolResult>();
  async get(key: string): Promise<ToolResult | undefined> {
    return this.seen.get(key);
  }
  async set(key: string, result: ToolResult): Promise<void> {
    this.seen.set(key, result);
  }
}

/** In-memory audit sink for tests and local runs. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
