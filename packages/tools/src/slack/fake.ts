import { z } from 'zod';
import type { ExecResult, Tool } from '@triple-r/shared-types';
import { zodInput } from '../input.js';

/**
 * Fake Slack connector — a read tool (search) and a write tool (send). The write
 * tool declares `mode: 'write'` and a `describeEffect`, so the gateway blocks it
 * for confirmation before anything is posted (§11/§12). Sent messages are kept
 * in memory so tests can assert exactly-once execution under idempotency.
 */

export interface SlackMessage {
  channel: string;
  user: string;
  text: string;
  ts: string;
}

export interface SlackFakeOptions {
  history?: SlackMessage[];
  available?: boolean;
  /** Injectable id so tests are deterministic. */
  nextTs?: () => string;
}

const SEED: SlackMessage[] = [
  { channel: '#payments-ops', user: 'ana', text: 'payment 123 stuck in pending since morning', ts: '1000.1' },
  { channel: '#payments-ops', user: 'bruno', text: 'reconciliation job looked delayed today', ts: '1000.2' },
  { channel: '#incidents', user: 'carla', text: 'payment webhook latency spike', ts: '1001.1' },
];

const SearchArgs = z.object({
  query: z.string().min(1),
  channel: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});
type SearchArgs = z.infer<typeof SearchArgs>;

const SendArgs = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
});
type SendArgs = z.infer<typeof SendArgs>;

export function createSlackFake(opts: SlackFakeOptions = {}): {
  tools: Tool[];
  sent: SlackMessage[];
} {
  const history = opts.history ?? SEED;
  const available = opts.available ?? true;
  const sent: SlackMessage[] = [];
  let counter = 0;
  const nextTs = opts.nextTs ?? (() => `${2000 + ++counter}.0`);

  const searchMessages: Tool<SearchArgs, { messages: SlackMessage[] }> = {
    name: 'slack_search_messages',
    domain: 'slack',
    mode: 'read',
    description: 'Search Slack message history by text, optionally within a channel.',
    inputSchema: zodInput(SearchArgs, {
      type: 'object',
      properties: { query: { type: 'string' }, channel: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    }),
    async execute(args): Promise<ExecResult<{ messages: SlackMessage[] }>> {
      if (!available) {
        return { outcome: 'unavailable', message: 'Slack API unreachable', source: 'slack:search' };
      }
      const q = args.query.toLowerCase();
      let matches = history.filter((m) => m.text.toLowerCase().includes(q));
      if (args.channel) matches = matches.filter((m) => m.channel === args.channel);
      if (matches.length === 0) return { outcome: 'no_data', message: 'No matching messages', source: 'slack:search' };
      return { outcome: 'ok', data: { messages: args.limit ? matches.slice(0, args.limit) : matches }, source: 'slack:search' };
    },
  };

  const sendMessage: Tool<SendArgs, { ts: string; channel: string }> = {
    name: 'slack_send_message',
    domain: 'slack',
    mode: 'write',
    description: 'Post a message to a Slack channel.',
    inputSchema: zodInput(SendArgs, {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
      required: ['channel', 'text'],
    }),
    describeEffect: (args) => `post to ${args.channel}: "${args.text}"`,
    async execute(args): Promise<ExecResult<{ ts: string; channel: string }>> {
      if (!available) {
        return { outcome: 'unavailable', message: 'Slack API unreachable', source: 'slack:send' };
      }
      const ts = nextTs();
      sent.push({ channel: args.channel, user: 'reinforcement', text: args.text, ts });
      return { outcome: 'ok', data: { ts, channel: args.channel }, source: 'slack:send' };
    },
  };

  return { tools: [searchMessages as Tool, sendMessage as Tool], sent };
}
