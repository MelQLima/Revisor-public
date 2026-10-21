import type { PullRequest, RepoRef } from '../../domain/pull-request.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { ReviewEvent } from '../../infrastructure/logging/logger.js';
import type {
  GitHubClient,
  SubmitReviewRequest,
  SubmitReviewResult,
} from './github-client.js';
import type { ReviewFixture } from './fixture.js';

/**
 * A GitHubClient backed by an in-memory fixture. Used for offline reviews and
 * tests. `submitReview` never posts anywhere — it logs what *would* be posted,
 * which is exactly what we want when iterating on prompts and pipeline logic.
 */
export class FixtureGitHubClient implements GitHubClient {
  readonly name = 'fixture-github';

  constructor(
    private readonly fixture: ReviewFixture,
    private readonly logger: Logger,
  ) {}

  async getPullRequest(_repo: RepoRef, _pullNumber: number): Promise<PullRequest> {
    return this.fixture.pullRequest;
  }

  async getFileContent(_repo: RepoRef, path: string, _ref: string): Promise<string | null> {
    return this.fixture.files[path] ?? null;
  }

  async submitReview(request: SubmitReviewRequest): Promise<SubmitReviewResult> {
    this.logger.info(
      {
        event: ReviewEvent.GithubCommentCreated,
        dryRun: true,
        verdict: request.verdict,
        comments: request.comments?.length ?? 0,
      },
      'Dry-run: review not posted to GitHub (fixture client)',
    );
    return { posted: false };
  }
}
