import { describe, expect, it } from 'vitest';
import type { ContextProvider, ContextResult } from '../src/domain/context.js';
import {
  CompositeContextProvider,
  ContextStoreContextProvider,
} from '../src/context/context-store-provider.js';
import { tmpContextStore } from './helpers.js';

async function seededStore() {
  const store = await tmpContextStore();
  await store.createVersion({
    topic: 'external-identifier-reconciliation',
    category: 'BUSINESS_RULE',
    content: 'External payment identifiers may be used as a reconciliation key.',
    summary: 'External identifiers for reconciliation.',
    changeType: 'CREATE',
    confidence: 1,
    evidence: [{ source: 'PR', reference: '#421' }],
    source: { number: 421, repository: 'acme/core', title: 'PR 421' },
    affectedDomains: ['payments'],
    reason: 'introduced',
  });
  return store;
}

describe('ContextStoreContextProvider', () => {
  it('surfaces current entries as ContextResults with a mapped kind', async () => {
    const provider = new ContextStoreContextProvider(await seededStore());
    const results = await provider.search('payment reconciliation external identifier');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.kind).toBe('business'); // BUSINESS_RULE -> business
    expect(results[0]?.source).toMatch(/context-store/);
    expect(results[0]?.content).toMatch(/External payment identifiers/);
  });

  it('respects the kinds filter', async () => {
    const provider = new ContextStoreContextProvider(await seededStore());
    expect(await provider.search('payment reconciliation', { kinds: ['architecture'] })).toHaveLength(0);
    expect((await provider.search('payment reconciliation', { kinds: ['business'] })).length).toBeGreaterThan(0);
  });

  it('returns [] for an unrelated query', async () => {
    const provider = new ContextStoreContextProvider(await seededStore());
    expect(await provider.search('quantum chromodynamics telescope')).toEqual([]);
  });
});

describe('CompositeContextProvider', () => {
  it('merges results from multiple providers', async () => {
    const docLike: ContextProvider = {
      name: 'doc',
      async search(): Promise<ContextResult[]> {
        return [
          { id: 'doc#1', kind: 'business', source: 'docs/ai/x.md', title: 'doc', content: 'doc rule', score: 0.9 },
        ];
      },
    };
    const composite = new CompositeContextProvider([docLike, new ContextStoreContextProvider(await seededStore())]);
    const results = await composite.search('payment reconciliation external identifier');
    const sources = results.map((r) => r.source);
    expect(sources.some((s) => s.includes('docs/ai'))).toBe(true);
    expect(sources.some((s) => s.includes('context-store'))).toBe(true);
  });
});
