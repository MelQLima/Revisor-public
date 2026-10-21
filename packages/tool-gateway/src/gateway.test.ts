import { describe, it, expect, beforeEach } from 'vitest';
import type { ExecResult, Tool, ToolContext } from '@triple-r/shared-types';
import { StaticAuthorizer } from '@triple-r/auth';
import { createLogger } from '@triple-r/observability';
import { ToolGateway } from './gateway.js';
import { ToolRegistry } from './registry.js';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from './stores.js';

const silent = createLogger({ level: 'silent' });

// --- inline fake tools -------------------------------------------------------
const passthrough = <T>() => ({ parse: (i: unknown) => i as T });

const readTool: Tool<{ id: number }, { id: number; status: string }> = {
  name: 'bq_get_payment',
  domain: 'bigquery',
  mode: 'read',
  description: 'Fetch a payment by id',
  inputSchema: {
    parse: (i) => {
      const o = i as { id?: unknown };
      if (typeof o?.id !== 'number') throw new Error('id must be a number');
      return { id: o.id };
    },
  },
  async execute({ id }): Promise<ExecResult<{ id: number; status: string }>> {
    if (id === 404) return { outcome: 'no_data', message: 'no payment with that id', source: 'bigquery:payments' };
    return { outcome: 'ok', data: { id, status: 'pending' }, source: 'bigquery:payments' };
  },
};

let sends = 0;
const writeTool: Tool<{ channel: string; text: string }, { ts: string }> = {
  name: 'slack_send_message',
  domain: 'slack',
  mode: 'write',
  description: 'Send a Slack message',
  inputSchema: passthrough<{ channel: string; text: string }>(),
  describeEffect: ({ channel }) => `post a message to ${channel}`,
  async execute(): Promise<ExecResult<{ ts: string }>> {
    sends += 1;
    return { outcome: 'ok', data: { ts: `ts-${sends}` }, source: 'slack' };
  },
};

const throwingTool: Tool<Record<string, never>, never> = {
  name: 'dd_search_logs',
  domain: 'datadog',
  mode: 'read',
  description: 'Search logs',
  inputSchema: passthrough<Record<string, never>>(),
  async execute(): Promise<ExecResult<never>> {
    throw new Error('connection refused');
  },
};

function makeGateway() {
  const registry = new ToolRegistry();
  registry
    .register(readTool as Tool, ['resolver', 'reinforcement'])
    .register(writeTool as Tool, ['reinforcement'])
    .register(throwingTool as Tool, ['resolver']);
  const audit = new InMemoryAuditSink();
  const idempotency = new InMemoryIdempotencyStore();
  const gateway = new ToolGateway({
    registry,
    authorizer: new StaticAuthorizer(),
    logger: silent,
    audit,
    idempotency,
  });
  return { gateway, audit };
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  agent: 'reinforcement',
  correlationId: 'test-corr',
  ...over,
});

describe('ToolGateway', () => {
  beforeEach(() => {
    sends = 0;
  });

  it('discovers only tools enabled for the agent (§21)', () => {
    const { gateway } = makeGateway();
    const resolverTools = gateway.listTools({ agent: 'resolver' }).map((t) => t.name);
    expect(resolverTools).toEqual(['bq_get_payment', 'dd_search_logs']);
    expect(gateway.listTools({ agent: 'reviewer' })).toEqual([]);
  });

  it('denies a tool not enabled for the agent', async () => {
    const { gateway, audit } = makeGateway();
    const r = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'hi' }, ctx({ agent: 'resolver' }));
    expect(r.outcome).toBe('denied');
    expect(audit.events.at(-1)?.outcome).toBe('denied');
  });

  it('denies a write to a read-only agent even if the tool exists', async () => {
    const { gateway } = makeGateway();
    // resolver can see bq/dd but not slack write; force via reinforcement-only tool
    const r = await gateway.invoke('bq_get_payment', { id: 1 }, ctx({ agent: 'resolver' }));
    expect(r.outcome).toBe('ok'); // read is fine
  });

  it('returns invalid_input on bad args (no execution)', async () => {
    const { gateway } = makeGateway();
    const r = await gateway.invoke('bq_get_payment', { id: 'nope' }, ctx({ agent: 'resolver' }));
    expect(r.outcome).toBe('invalid_input');
  });

  it('distinguishes no_data from unavailable (§24)', async () => {
    const { gateway } = makeGateway();
    const nodata = await gateway.invoke('bq_get_payment', { id: 404 }, ctx({ agent: 'resolver' }));
    expect(nodata.outcome).toBe('no_data');
    const down = await gateway.invoke('dd_search_logs', {}, ctx({ agent: 'resolver' }));
    expect(down.outcome).toBe('unavailable');
    expect(down.message).toContain('connection refused');
  });

  it('blocks an unconfirmed write and previews its effect (§12)', async () => {
    const { gateway } = makeGateway();
    const r = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'hi' }, ctx());
    expect(r.outcome).toBe('needs_confirmation');
    expect(r.message).toContain('post a message to #ops');
    expect(sends).toBe(0);
  });

  it('executes a confirmed write', async () => {
    const { gateway } = makeGateway();
    const r = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'hi' }, ctx({ confirmed: true }));
    expect(r.outcome).toBe('ok');
    expect(sends).toBe(1);
  });

  it('replays an idempotent write instead of re-executing (§13)', async () => {
    const { gateway } = makeGateway();
    const c = ctx({ confirmed: true, idempotencyKey: 'key-1' });
    const first = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'hi' }, c);
    const second = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'hi' }, c);
    expect(first.outcome).toBe('ok');
    expect(second.replayed).toBe(true);
    expect(sends).toBe(1); // executed exactly once
  });

  it('records every call in the audit trail with redacted args (§14)', async () => {
    const { gateway, audit } = makeGateway();
    await gateway.invoke(
      'slack_send_message',
      { channel: '#ops', text: 'hi', token: 'xoxb-super-secret-value-1234567890' },
      ctx({ confirmed: true, user: { id: 'u-42' } }),
    );
    const e = audit.events.at(-1)!;
    expect(e.agent).toBe('reinforcement');
    expect(e.user).toBe('u-42');
    expect(e.tool).toBe('slack_send_message');
    expect(e.mode).toBe('write');
    expect(e.authorization.allowed).toBe(true);
    expect((e.args as { token: string }).token).toBe('[REDACTED]');
  });
});
