import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CodeSnippetSchema, PullRequestSchema } from '../../domain/pull-request.js';

/**
 * Fixture format for offline reviews (`npm run review -- ./fixtures/x.json`)
 * and integration tests. A fixture fully describes a PR plus, optionally,
 * pre-fetched relevant code and file contents so no network is needed.
 */
export const ReviewFixtureSchema = z.object({
  /** Free-form label describing what this fixture demonstrates. */
  description: z.string().optional(),
  pullRequest: PullRequestSchema,
  /** Optional pre-selected relevant code snippets. */
  relevantCode: z.array(CodeSnippetSchema).default([]),
  /** Optional map of "path" -> file content at HEAD, for getFileContent. */
  files: z.record(z.string(), z.string()).default({}),
  /** Optional expectations used by tests (not consumed by the pipeline). */
  expect: z
    .object({
      verdict: z.enum(['approve', 'comment', 'request_changes']).optional(),
      minFindings: z.number().int().nonnegative().optional(),
      maxFindings: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type ReviewFixture = z.infer<typeof ReviewFixtureSchema>;

export async function loadFixture(path: string): Promise<ReviewFixture> {
  const raw = await readFile(path, 'utf8');
  const json = JSON.parse(raw);
  return ReviewFixtureSchema.parse(json);
}
