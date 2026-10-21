import { z } from 'zod';

/**
 * Minimal, defensively-parsed schema for the parts of the GitHub
 * `pull_request` webhook we actually use. We validate untrusted input rather
 * than trusting the shape GitHub (or an attacker) sends.
 */
export const PullRequestWebhookSchema = z.object({
  action: z.string(),
  number: z.number().int().positive().optional(),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      draft: z.boolean().optional(),
      merged: z.boolean().optional(),
      // GitHub sends `null` (not just absent) until the merge commit is computed.
      merge_commit_sha: z.string().nullish(),
    })
    .optional(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
    full_name: z.string().optional(),
  }),
});
export type PullRequestWebhook = z.infer<typeof PullRequestWebhookSchema>;

/** Actions that should trigger a review. */
export const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

/** True when a webhook represents a merged PR (triggers context evolution). */
export function isMergedEvent(payload: PullRequestWebhook): boolean {
  return payload.action === 'closed' && payload.pull_request?.merged === true;
}
