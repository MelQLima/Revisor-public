import { z } from 'zod';

/**
 * Context abstraction.
 *
 * A ContextProvider retrieves knowledge relevant to a review query. The MVP
 * ships a document-based provider (keyword scoring over `docs/ai`), but the
 * interface is intentionally storage-agnostic so it can later be backed by
 * pgvector, Qdrant, Pinecone, or a hybrid semantic+keyword index WITHOUT
 * touching the review pipeline.
 */

export const ContextKindSchema = z.enum([
  'business', // domain rules, invariants, financial rules
  'architecture', // ADRs, architectural constraints
  'guideline', // review guidelines / policy
  'code', // source code snippets
  'history', // git history, prior PRs, incidents
  'other',
]);
export type ContextKind = z.infer<typeof ContextKindSchema>;

export const ContextResultSchema = z.object({
  /** Stable identifier, usually the source path (+ anchor). */
  id: z.string(),
  kind: ContextKindSchema,
  /** Human-readable source reference, e.g. `docs/ai/domain/payments.md#invariants`. */
  source: z.string(),
  title: z.string(),
  content: z.string(),
  /** Relevance score in [0..1]; higher is more relevant. */
  score: z.number().min(0).max(1),
});
export type ContextResult = z.infer<typeof ContextResultSchema>;

export interface ContextSearchOptions {
  /** Max results to return. */
  limit?: number;
  /** Restrict to specific kinds of context. */
  kinds?: ContextKind[];
  /** Minimum score to include. */
  minScore?: number;
}

export interface ContextProvider {
  readonly name: string;
  /**
   * Return context relevant to `query`, ranked by descending score.
   * Implementations MUST NOT throw on "no results" — return an empty array.
   */
  search(query: string, options?: ContextSearchOptions): Promise<ContextResult[]>;
}
