import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PullRequestSchema } from '../domain/pull-request.js';
import { ContextCategorySchema } from '../domain/context-evolution.js';
import type { ContextStore } from '../domain/context-store.js';

/**
 * Fixture format for offline context-evolution runs + tests. A fixture fully
 * describes a merged/reverted PR and, optionally, pre-existing context to seed
 * (so a revert can be demonstrated self-contained).
 */
export const ContextFixtureSchema = z.object({
  description: z.string().optional(),
  pullRequest: PullRequestSchema,
  /** Context entries to seed as prior CREATE versions before processing. */
  seedContext: z
    .array(
      z.object({
        topic: z.string(),
        category: ContextCategorySchema,
        content: z.string(),
        summary: z.string(),
        prNumber: z.number().int().positive(),
        prTitle: z.string(),
        repository: z.string().optional(),
      }),
    )
    .default([]),
});
export type ContextFixture = z.infer<typeof ContextFixtureSchema>;

export async function loadContextFixture(path: string): Promise<ContextFixture> {
  return ContextFixtureSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** Seed a store with a fixture's prior context (as ACTIVE CREATE versions). */
export async function seedContextStore(store: ContextStore, fixture: ContextFixture): Promise<void> {
  const repo = `${fixture.pullRequest.repo.owner}/${fixture.pullRequest.repo.name}`;
  for (const s of fixture.seedContext) {
    await store.createVersion({
      topic: s.topic,
      category: s.category,
      content: s.content,
      summary: s.summary,
      changeType: 'CREATE',
      confidence: 1,
      evidence: [{ source: 'PR', reference: `#${s.prNumber}` }],
      source: { number: s.prNumber, repository: s.repository ?? repo, title: s.prTitle },
      affectedDomains: [],
      reason: 'seeded prior context',
    });
  }
}
