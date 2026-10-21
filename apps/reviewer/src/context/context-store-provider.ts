import type {
  ContextKind,
  ContextProvider,
  ContextResult,
  ContextSearchOptions,
} from '../domain/context.js';
import type { ContextCategory } from '../domain/context-evolution.js';
import type { ContextStore } from '../domain/context-store.js';
import { tokenize } from './tokenize.js';

/**
 * Adapts the evolving ContextStore into the read-only `ContextProvider` used by
 * the reviewer — so knowledge learned from merged PRs is retrieved in future
 * reviews. Keyword-scored for now; a vector-backed store would rank here later.
 */

const CATEGORY_KIND: Record<ContextCategory, ContextKind> = {
  BUSINESS_RULE: 'business',
  DOMAIN_BEHAVIOR: 'business',
  EDGE_CASE: 'business',
  HISTORICAL: 'history',
  ARCHITECTURE: 'architecture',
  PERFORMANCE: 'architecture',
  INTEGRATION: 'architecture',
  SECURITY: 'architecture',
};

export class ContextStoreContextProvider implements ContextProvider {
  readonly name = 'context-store-provider';

  constructor(private readonly store: ContextStore) {}

  async search(query: string, options: ContextSearchOptions = {}): Promise<ContextResult[]> {
    const queryTerms = new Set(tokenize(query));
    if (queryTerms.size === 0) return [];

    const current = await this.store.listCurrent();
    const scored = current
      .map((e) => {
        const kind = CATEGORY_KIND[e.category];
        const terms = tokenize(`${e.topic} ${e.summary} ${e.content}`);
        const overlap = terms.filter((t) => queryTerms.has(t)).length;
        return { entry: e, kind, overlap, denom: terms.length || 1 };
      })
      .filter((s) => s.overlap > 0 && (!options.kinds || options.kinds.includes(s.kind)));

    if (scored.length === 0) return [];
    const max = Math.max(...scored.map((s) => s.overlap / s.denom));
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0;

    return scored
      .map((s) => ({
        id: `context-store://${s.entry.topic}#v${s.entry.version}`,
        kind: s.kind,
        source: `context-store:${s.entry.topic} (PR #${s.entry.source.number})`,
        title: s.entry.summary,
        content: s.entry.content,
        score: Number((s.overlap / s.denom / max).toFixed(4)),
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Merges several ContextProviders (e.g. docs + evolved store) into one. Exposes
 * `load()` so it can transparently replace a DocumentContextProvider in wiring.
 */
export class CompositeContextProvider implements ContextProvider {
  readonly name = 'composite-context';

  constructor(private readonly providers: ContextProvider[]) {}

  async load(): Promise<void> {
    await Promise.all(
      this.providers.map((p) => {
        const maybe = p as ContextProvider & { load?: () => Promise<void> };
        return typeof maybe.load === 'function' ? maybe.load() : Promise.resolve();
      }),
    );
  }

  async search(query: string, options?: ContextSearchOptions): Promise<ContextResult[]> {
    const results = await Promise.all(this.providers.map((p) => p.search(query, options)));
    const byId = new Map<string, ContextResult>();
    for (const r of results.flat()) {
      const existing = byId.get(r.id);
      if (!existing || r.score > existing.score) byId.set(r.id, r);
    }
    const merged = [...byId.values()].sort((a, b) => b.score - a.score);
    return options?.limit ? merged.slice(0, options.limit) : merged;
  }
}
