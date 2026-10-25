import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { ContextProvider, ContextResult } from '../domain/context.js';
import type { CodeSnippet, PullRequest, RepoRef } from '../domain/pull-request.js';
import type { ReviewInput } from '../domain/review-input.js';
import type { ReviewResult, RejectedFinding } from '../domain/review.js';
import { aggregateReview, filterFindings, type PolicyConfig } from '../domain/policy.js';
import type { GitHubClient } from '../integrations/github/github-client.js';
import type { HistoryProvider } from '../integrations/history/history-provider.js';
import type { LLMProvider } from '../integrations/llm/llm-provider.js';
import { withCorrelation, ReviewEvent, type Logger } from '../infrastructure/logging/logger.js';
import { newCorrelationId } from '../infrastructure/ids.js';
import { buildContextQuery } from '../context/query-builder.js';
import { formatReviewBody, toInlineComments } from '../review/review-formatter.js';
import { applyValidation } from './apply-validation.js';
import { collectRelevantCode } from './relevant-code.js';

const tracer = trace.getTracer('revisor');

export interface ReviewPipelineDeps {
  github: GitHubClient;
  context: ContextProvider;
  history: HistoryProvider;
  llm: LLMProvider;
  policy: PolicyConfig;
  logger: Logger;
  contextMaxResults: number;
}

export interface ReviewTarget {
  repo: RepoRef;
  pullNumber: number;
  /** Correlation id to reuse (e.g. from a webhook); generated if omitted. */
  correlationId?: string;
}

export interface ReviewOptions {
  /** Post the review to GitHub. When false, the pipeline only returns it. */
  post?: boolean;
  /** Additional relevant code (e.g. supplied by a fixture). */
  extraRelevantCode?: CodeSnippet[];
}

export interface ReviewOutcome {
  result: ReviewResult;
  body: string;
  posted: boolean;
  reviewUrl?: string;
}

/**
 * The deterministic review pipeline. Each step is explicit and logged with the
 * review's correlation id:
 *   fetch PR -> build query -> retrieve context -> analyze -> validate ->
 *   apply validation -> policy filter -> aggregate -> format -> (post).
 *
 * The pipeline depends only on interfaces, so any provider can be swapped.
 */
export class ReviewPipeline {
  constructor(private readonly deps: ReviewPipelineDeps) {}

  /**
   * Review one PR. Wrapped in a root OpenTelemetry span so the analysis and
   * validation passes (and their HTTP calls) show up as one trace per review.
   */
  async review(target: ReviewTarget, options: ReviewOptions = {}): Promise<ReviewOutcome> {
    const correlationId = target.correlationId ?? newCorrelationId();
    return tracer.startActiveSpan(
      'review.pull_request',
      {
        attributes: {
          'revisor.correlation_id': correlationId,
          'vcs.repository.name': `${target.repo.owner}/${target.repo.name}`,
          'vcs.pull_request.number': target.pullNumber,
        },
      },
      async (span) => {
        try {
          const outcome = await this.runReview({ ...target, correlationId }, options);
          span.setAttributes({
            'revisor.review.verdict': outcome.result.verdict,
            'revisor.review.findings': outcome.result.findings.length,
            'revisor.review.rejected': outcome.result.rejected.length,
            'revisor.review.posted': outcome.posted,
          });
          return outcome;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async runReview(target: ReviewTarget, options: ReviewOptions): Promise<ReviewOutcome> {
    const correlationId = target.correlationId ?? newCorrelationId();
    const log = withCorrelation(this.deps.logger, correlationId);
    log.info(
      { event: ReviewEvent.ReviewStarted, repo: `${target.repo.owner}/${target.repo.name}`, pr: target.pullNumber },
      'Review started',
    );

    try {
      // 1-3. Fetch PR + diff (diff is embedded in changedFiles[].patch).
      const pullRequest = await this.deps.github.getPullRequest(target.repo, target.pullNumber);

      // 4. Identify changed concepts.
      const query = buildContextQuery(pullRequest);

      // 5. Retrieve context (business / technical / history) + relevant code.
      const { businessContext, technicalContext, historyContext } = await this.retrieveContext(
        query,
        pullRequest,
      );
      const relevantCode = [
        ...(options.extraRelevantCode ?? []),
        ...(await collectRelevantCode(this.deps.github, pullRequest)),
      ];
      log.info(
        {
          event: ReviewEvent.ContextRetrieved,
          business: businessContext.length,
          technical: technicalContext.length,
          history: historyContext.length,
          relevantCode: relevantCode.length,
        },
        'Context retrieved',
      );

      const input: ReviewInput = {
        correlationId,
        pullRequest,
        relevantCode,
        businessContext,
        technicalContext,
        historyContext,
      };

      // 6-8. Analysis pass -> candidate findings.
      const candidate = await this.deps.llm.generateReview(input);
      for (const f of candidate.findings) {
        log.debug({ event: ReviewEvent.FindingGenerated, id: f.id, severity: f.severity }, f.title);
      }

      // 9-10. Validation pass -> keep/drop decisions.
      const validation = await this.deps.llm.validateFindings({
        correlationId,
        pullRequest,
        candidateFindings: candidate.findings,
        businessContext,
        technicalContext,
        historyContext,
        relevantCode,
      });
      const afterValidation = applyValidation(candidate.findings, validation);

      // 10 (cont). Deterministic policy filter on the survivors.
      const afterPolicy = filterFindings(afterValidation.kept, this.deps.policy);
      const rejected: RejectedFinding[] = [...afterValidation.rejected, ...afterPolicy.rejected];
      for (const r of rejected) {
        log.info({ event: ReviewEvent.FindingRejected, id: r.finding.id, reason: r.reason }, r.finding.title);
      }

      // 11. Aggregate final review.
      const aggregated = aggregateReview(candidate, afterPolicy, this.deps.policy);
      const result: ReviewResult = {
        correlationId,
        summary: candidate.summary,
        verdict: aggregated.verdict,
        findings: aggregated.findings,
        positives: aggregated.positives,
        rejected,
        stats: {
          changedFiles: pullRequest.changedFiles.length,
          contextResults: businessContext.length + technicalContext.length + historyContext.length,
          businessRulesConsulted: businessContext.length,
          historyReferences: historyContext.length,
          candidateFindings: candidate.findings.length,
          rejectedFindings: rejected.length,
        },
      };
      const body = formatReviewBody(result);
      log.info(
        {
          event: ReviewEvent.ReviewCompleted,
          verdict: result.verdict,
          findings: result.findings.length,
          rejected: rejected.length,
        },
        'Review completed',
      );

      // 12. Post to GitHub (optional).
      let posted = false;
      let reviewUrl: string | undefined;
      if (options.post) {
        const submitted = await this.deps.github.submitReview({
          repo: target.repo,
          pullNumber: target.pullNumber,
          commitSha: pullRequest.headSha,
          verdict: result.verdict,
          body,
          comments: toInlineComments(result),
        });
        posted = submitted.posted;
        reviewUrl = submitted.url;
      }

      return { result, body, posted, ...(reviewUrl ? { reviewUrl } : {}) };
    } catch (err) {
      log.error({ event: ReviewEvent.ReviewFailed, err: (err as Error).message }, 'Review failed');
      throw err;
    }
  }

  private async retrieveContext(
    query: string,
    _pullRequest: PullRequest,
  ): Promise<{
    businessContext: ContextResult[];
    technicalContext: ContextResult[];
    historyContext: ContextResult[];
  }> {
    const limit = this.deps.contextMaxResults;
    const [business, architecture, guideline, history] = await Promise.all([
      this.deps.context.search(query, { kinds: ['business'], limit }),
      this.deps.context.search(query, { kinds: ['architecture'], limit }),
      this.deps.context.search(query, { kinds: ['guideline'], limit: 4 }),
      this.deps.history.findRelevantHistory(_pullRequest),
    ]);

    return {
      businessContext: business,
      technicalContext: [...architecture, ...guideline],
      historyContext: history,
    };
  }
}
