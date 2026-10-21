import { z } from 'zod';

/**
 * Domain model for a Pull Request under review.
 *
 * This is a *technology-agnostic* representation. GitHub-specific payloads are
 * mapped into these shapes by the github integration adapter, so the review
 * pipeline never depends on Octokit types directly.
 */

export const RepoRefSchema = z.object({
  owner: z.string(),
  name: z.string(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const ChangedFileStatusSchema = z.enum([
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);
export type ChangedFileStatus = z.infer<typeof ChangedFileStatusSchema>;

export const ChangedFileSchema = z.object({
  filename: z.string(),
  status: ChangedFileStatusSchema,
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  /** Unified-diff hunk for this file. Absent for binary/large files. */
  patch: z.string().optional(),
  previousFilename: z.string().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const CommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  author: z.string().optional(),
});
export type Commit = z.infer<typeof CommitSchema>;

export const PullRequestSchema = z.object({
  repo: RepoRefSchema,
  number: z.number().int().positive(),
  title: z.string(),
  /** PR description — treated as UNTRUSTED input (possible prompt injection). */
  body: z.string().default(''),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  url: z.string().url().optional(),
  draft: z.boolean().default(false),
  /** Whether the PR has been merged (set on `closed` webhook events). */
  merged: z.boolean().optional(),
  /** The merge commit SHA, when merged — used for revert detection + idempotency. */
  mergeCommitSha: z.string().optional(),
  changedFiles: z.array(ChangedFileSchema).default([]),
  commits: z.array(CommitSchema).default([]),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/**
 * A snippet of source pulled from the repository at HEAD (or a related ref)
 * used as "relevant code" context — e.g. the definition of a symbol the diff
 * touches, or an adjacent validation the reviewer should be aware of.
 */
export const CodeSnippetSchema = z.object({
  filename: z.string(),
  content: z.string(),
  startLine: z.number().int().positive().optional(),
  reason: z.string().optional(),
});
export type CodeSnippet = z.infer<typeof CodeSnippetSchema>;
