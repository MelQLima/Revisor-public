import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@triple-r/shared-types';
import { StaticAuthorizer } from '@triple-r/auth';
import { createLogger } from '@triple-r/observability';
import { ToolGateway, ToolRegistry, InMemoryAuditSink } from '@triple-r/tool-gateway';
import { createBigQueryFake } from './bigquery/index.js';
import { createSlackFake } from './slack/index.js';

/**
 * End-to-end: real gateway + real authorizer + the fake connectors. Proves the
 * whole tool stack composes and enforces the spec's guarantees together.
 */
const silent = createLogger({ level: 'silent' });

function wire() {
  const bq = createBigQueryFake();
  const slack = createSlackFake();
  const registry = new ToolRegistry();
  for (const t of bq.tools) registry.register(t, ['resolver', 'reinforcement']);
  // slack search to both; slack send only to reinforcement
  registry.register(slack.tools[0]!, ['resolver', 'reinforcement']);
  registry.register(slack.tools[1]!, ['reinforcement']);
  const audit = new InMemoryAuditSink();
  const gateway = new ToolGateway({ registry, authorizer: new StaticAuthorizer(), logger: silent, audit });
  return { gateway, audit, slackSent: slack.sent };
}

describe('tool stack integration', () => {
  it('resolver can investigate (read) but cannot post (write)', async () => {
    const { gateway } = wire();
    const ctx: ToolContext = { agent: 'resolver', correlationId: 'i1' };

    const found = await gateway.invoke('bq_search_payments', { paymentId: '123' }, ctx);
    expect(found.outcome).toBe('ok');

    const blocked = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'x' }, ctx);
    expect(blocked.outcome).toBe('denied'); // not enabled for resolver
  });

  it('reinforcement posts only after confirmation, exactly once under a retry', async () => {
    const { gateway, slackSent, audit } = wire();
    const base: ToolContext = { agent: 'reinforcement', correlationId: 'i2', idempotencyKey: 'op-1' };

    const preview = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'resolved' }, base);
    expect(preview.outcome).toBe('needs_confirmation');
    expect(slackSent).toHaveLength(0);

    const confirmed = { ...base, confirmed: true };
    const first = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'resolved' }, confirmed);
    const retry = await gateway.invoke('slack_send_message', { channel: '#ops', text: 'resolved' }, confirmed);
    expect(first.outcome).toBe('ok');
    expect(retry.replayed).toBe(true);
    expect(slackSent).toHaveLength(1);

    // audit captured the whole story, at the infra layer.
    const outcomes = audit.events.map((e) => e.outcome);
    expect(outcomes).toEqual(['needs_confirmation', 'ok', 'ok']);
    expect(audit.events.every((e) => e.agent === 'reinforcement')).toBe(true);
  });
});
