import { z } from 'zod';
import type { ExecResult, Tool } from '@triple-r/shared-types';
import { zodInput } from '../input.js';

/**
 * Fake BigQuery connector over the payments domain — an in-memory stand-in for
 * the real warehouse, wired behind the SAME `Tool` contract a real client would
 * implement. Read-only. Demonstrates the full honest outcome taxonomy (§24):
 * ok / no_data / unavailable / contradictory.
 */

export interface PaymentRow {
  paymentId: string;
  status: 'pending' | 'approved' | 'refunded' | 'cancelled';
  amountBRL: number;
  createdAt: string;
  reconciled: boolean;
}

export interface BigQueryFakeOptions {
  rows?: PaymentRow[];
  /** Simulate the warehouse being unreachable. */
  available?: boolean;
}

const SEED: PaymentRow[] = [
  { paymentId: '123', status: 'pending', amountBRL: 450.0, createdAt: '2026-08-10T12:00:00Z', reconciled: false },
  { paymentId: '124', status: 'approved', amountBRL: 300.5, createdAt: '2026-08-11T09:30:00Z', reconciled: true },
  { paymentId: '125', status: 'refunded', amountBRL: 120.0, createdAt: '2026-08-12T15:45:00Z', reconciled: true },
];

const SearchArgs = z.object({
  paymentId: z.string().min(1).optional(),
  status: z.enum(['pending', 'approved', 'refunded', 'cancelled']).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
type SearchArgs = z.infer<typeof SearchArgs>;

const SEARCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    paymentId: { type: 'string', description: 'exact payment id' },
    status: { type: 'string', enum: ['pending', 'approved', 'refunded', 'cancelled'] },
    limit: { type: 'number' },
  },
} as const;

export function createBigQueryFake(opts: BigQueryFakeOptions = {}): { tools: Tool[] } {
  const rows = opts.rows ?? SEED;
  const available = opts.available ?? true;

  const searchPayments: Tool<SearchArgs, { rows: PaymentRow[] }> = {
    name: 'bq_search_payments',
    domain: 'bigquery',
    mode: 'read',
    description: 'Search the payments warehouse by payment id and/or status.',
    inputSchema: zodInput(SearchArgs, SEARCH_JSON_SCHEMA),
    async execute(args): Promise<ExecResult<{ rows: PaymentRow[] }>> {
      if (!available) {
        return { outcome: 'unavailable', message: 'BigQuery could not be queried (warehouse unreachable)', source: 'bigquery:payments' };
      }
      let matches = rows;
      if (args.paymentId) matches = matches.filter((r) => r.paymentId === args.paymentId);
      if (args.status) matches = matches.filter((r) => r.status === args.status);

      // Data-integrity check: the same payment appearing with conflicting status
      // is contradictory evidence, not a clean result — surface it as such (§24).
      const byId = new Map<string, Set<string>>();
      for (const r of matches) {
        const set = byId.get(r.paymentId) ?? new Set<string>();
        set.add(r.status);
        byId.set(r.paymentId, set);
      }
      const conflicted = [...byId.entries()].filter(([, s]) => s.size > 1).map(([id]) => id);
      if (conflicted.length > 0) {
        return {
          outcome: 'contradictory',
          message: `Payment(s) ${conflicted.join(', ')} have conflicting statuses in the warehouse`,
          source: 'bigquery:payments',
        };
      }

      if (matches.length === 0) {
        return { outcome: 'no_data', message: 'No matching payments', source: 'bigquery:payments' };
      }
      const limited = args.limit ? matches.slice(0, args.limit) : matches;
      return { outcome: 'ok', data: { rows: limited }, source: 'bigquery:payments' };
    },
  };

  return { tools: [searchPayments as Tool] };
}
