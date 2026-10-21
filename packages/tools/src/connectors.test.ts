import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@triple-r/shared-types';
import { createBigQueryFake } from './bigquery/index.js';
import { createSlackFake } from './slack/index.js';

const ctx: ToolContext = { agent: 'resolver', correlationId: 'c' };
const tool = (tools: { name: string }[], name: string) => tools.find((t) => t.name === name)!;

describe('bigquery fake connector', () => {
  it('returns ok with matching rows', async () => {
    const { tools } = createBigQueryFake();
    const r = await tool(tools, 'bq_search_payments').execute({ paymentId: '123' }, ctx);
    expect(r.outcome).toBe('ok');
    expect(r.source).toBe('bigquery:payments');
  });

  it('returns no_data when nothing matches', async () => {
    const { tools } = createBigQueryFake();
    const r = await tool(tools, 'bq_search_payments').execute({ paymentId: 'zzz' }, ctx);
    expect(r.outcome).toBe('no_data');
  });

  it('returns unavailable when the warehouse is down (≠ no_data)', async () => {
    const { tools } = createBigQueryFake({ available: false });
    const r = await tool(tools, 'bq_search_payments').execute({}, ctx);
    expect(r.outcome).toBe('unavailable');
  });

  it('flags contradictory data (same id, conflicting status)', async () => {
    const { tools } = createBigQueryFake({
      rows: [
        { paymentId: '9', status: 'approved', amountBRL: 1, createdAt: 'x', reconciled: true },
        { paymentId: '9', status: 'cancelled', amountBRL: 1, createdAt: 'y', reconciled: false },
      ],
    });
    const r = await tool(tools, 'bq_search_payments').execute({ paymentId: '9' }, ctx);
    expect(r.outcome).toBe('contradictory');
    expect(r.message).toContain('9');
  });

  it('rejects invalid args via the schema', () => {
    const { tools } = createBigQueryFake();
    expect(() => tool(tools, 'bq_search_payments').inputSchema.parse({ status: 'bogus' })).toThrow();
  });
});

describe('slack fake connector', () => {
  it('search returns matches', async () => {
    const { tools } = createSlackFake();
    const r = await tool(tools, 'slack_search_messages').execute({ query: 'reconciliation' }, ctx);
    expect(r.outcome).toBe('ok');
  });

  it('send is a write tool with an effect preview', async () => {
    const { tools } = createSlackFake();
    const send = tool(tools, 'slack_send_message');
    expect(send.mode).toBe('write');
    expect(send.describeEffect?.({ channel: '#ops', text: 'hi' })).toContain('#ops');
  });

  it('send records the message when executed directly', async () => {
    const { tools, sent } = createSlackFake();
    await tool(tools, 'slack_send_message').execute({ channel: '#ops', text: 'hi' }, ctx);
    expect(sent).toHaveLength(1);
  });
});
