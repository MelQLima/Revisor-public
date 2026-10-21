import { Octokit } from '@octokit/rest';
import {
  type ChangedFile,
  type ChangedFileStatus,
  type PullRequest,
  type RepoRef,
} from '../../domain/pull-request.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { ReviewEvent } from '../../infrastructure/logging/logger.js';
import type {
  GitHubClient,
  SubmitReviewRequest,
  SubmitReviewResult,
} from './github-client.js';

export interface OctokitGitHubOptions {
  token: string;
  logger: Logger;
  /** When true, never actually POST a review — just log it. */
  dryRun?: boolean;
  /** Injectable for tests. */
  octokit?: Octokit;
}

const STATUS_MAP: Record<string, ChangedFileStatus> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  unchanged: 'unchanged',
};

const VERDICT_EVENT = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
} as const;

/** True for GitHub's "can not approve/request changes on your own pull request" 422. */
function isSelfReviewError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /own pull request/i.test(message);
}

/**
 * Real GitHub adapter over the REST API. Uses least-privilege token auth and
 * confines all Octokit usage to this file. Never logs the token.
 */
export class OctokitGitHubClient implements GitHubClient {
  readonly name = 'octokit-github';
  private readonly octokit: Octokit;

  constructor(private readonly options: OctokitGitHubOptions) {
    this.octokit = options.octokit ?? new Octokit({ auth: options.token });
  }

  async getPullRequest(repo: RepoRef, pullNumber: number): Promise<PullRequest> {
    const { owner, name: repoName } = repo;
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: pullNumber,
    });

    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner,
      repo: repoName,
      pull_number: pullNumber,
      per_page: 100,
    });

    const commits = await this.octokit.paginate(this.octokit.pulls.listCommits, {
      owner,
      repo: repoName,
      pull_number: pullNumber,
      per_page: 100,
    });

    const changedFiles: ChangedFile[] = files.map((f) => ({
      filename: f.filename,
      status: STATUS_MAP[f.status] ?? 'modified',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      ...(f.patch ? { patch: f.patch } : {}),
      ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
    }));

    return {
      repo,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      author: pr.user?.login ?? 'unknown',
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      ...(pr.html_url ? { url: pr.html_url } : {}),
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
      changedFiles,
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        ...(c.author?.login ? { author: c.author.login } : {}),
      })),
    };
  }

  async getFileContent(repo: RepoRef, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: repo.owner,
        repo: repo.name,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      this.options.logger.debug({ path, err: (err as Error).message }, 'getFileContent failed');
      return null;
    }
  }

  async submitReview(request: SubmitReviewRequest): Promise<SubmitReviewResult> {
    const log = this.options.logger;
    if (this.options.dryRun) {
      log.info(
        { event: ReviewEvent.GithubCommentCreated, dryRun: true, verdict: request.verdict },
        'Dry-run: review not posted',
      );
      return { posted: false };
    }

    const event = VERDICT_EVENT[request.verdict];
    const base = {
      owner: request.repo.owner,
      repo: request.repo.name,
      pull_number: request.pullNumber,
      commit_id: request.commitSha,
      body: request.body,
      event,
    };

    const inline =
      request.comments?.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })) ??
      [];

    try {
      return await this.postReview(inline.length > 0 ? { ...base, comments: inline } : base, log);
    } catch (err) {
      // Inline comments fail if a line isn't part of the diff — retry body-only.
      if (inline.length > 0 && !isSelfReviewError(err)) {
        log.warn({ err: (err as Error).message }, 'Inline comments rejected; retrying body-only');
        return this.postReview(base, log, { suffix: ' (body-only)' });
      }
      // GitHub refuses APPROVE/REQUEST_CHANGES when the token's identity is the
      // PR author (common in local/self-authored testing) — fall back to a
      // plain COMMENT so the findings still get posted instead of dropped.
      if (isSelfReviewError(err) && event !== 'COMMENT') {
        log.warn(
          { err: (err as Error).message },
          `Cannot ${event} own pull request; falling back to COMMENT`,
        );
        const fallback = { ...base, event: 'COMMENT' as const };
        return this.postReview(
          inline.length > 0 ? { ...fallback, comments: inline } : fallback,
          log,
          { suffix: ' (as COMMENT — self-authored PR)' },
        );
      }
      throw err;
    }
  }

  private async postReview(
    params: Parameters<Octokit['pulls']['createReview']>[0],
    log: Logger,
    opts: { suffix?: string } = {},
  ): Promise<SubmitReviewResult> {
    const { data } = await this.octokit.pulls.createReview(params);
    log.info(
      { event: ReviewEvent.GithubCommentCreated, reviewId: data.id },
      `Review posted to GitHub${opts.suffix ?? ''}`,
    );
    return { posted: true, reviewId: data.id, ...(data.html_url ? { url: data.html_url } : {}) };
  }
}
