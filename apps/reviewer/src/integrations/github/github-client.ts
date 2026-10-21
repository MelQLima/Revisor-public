import type { PullRequest, RepoRef } from '../../domain/pull-request.js';
import type { ReviewFinding, ReviewVerdict } from '../../domain/review.js';

/**
 * GitHub abstraction. The MVP needs to (a) fetch a PR and its diff and
 * (b) post a review. Everything else (approve/request-changes/inline comments)
 * is expressed through `submitReview` so the pipeline stays vendor-neutral.
 */

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface SubmitReviewRequest {
  repo: RepoRef;
  pullNumber: number;
  /** The commit the review is anchored to (required for inline comments). */
  commitSha: string;
  verdict: ReviewVerdict;
  /** Top-level review body (markdown summary). */
  body: string;
  /** Inline comments; adapters that can't place them fall back to the body. */
  comments?: ReviewComment[];
}

export interface SubmitReviewResult {
  /** Whether a review was actually posted (false in dry-run). */
  posted: boolean;
  reviewId?: number;
  url?: string;
}

export interface GitHubClient {
  readonly name: string;

  /** Fetch PR metadata, changed files and commits, mapped to the domain model. */
  getPullRequest(repo: RepoRef, pullNumber: number): Promise<PullRequest>;

  /** Fetch a file's content at a ref (used to build "relevant code" context). */
  getFileContent(repo: RepoRef, path: string, ref: string): Promise<string | null>;

  /** Post the review (or no-op + log in dry-run mode). */
  submitReview(request: SubmitReviewRequest): Promise<SubmitReviewResult>;
}

/** The mapping the formatter uses to translate findings into inline comments. */
export type { ReviewFinding };
