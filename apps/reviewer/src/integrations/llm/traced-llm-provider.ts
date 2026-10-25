import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type {
  ReviewInput,
  ValidationInput,
  ValidationResult,
} from '../../domain/review-input.js';
import type { CandidateReview } from '../../domain/review.js';
import type {
  ContextChangeProposal,
  ContextEvolutionInput,
} from '../../domain/context-evolution.js';
import type { PullRequest } from '../../domain/pull-request.js';
import type { LLMProvider } from './llm-provider.js';

/**
 * Decorator that wraps any LLMProvider in OpenTelemetry spans, one per LLM pass.
 *
 * Each span carries the provider, the pass, the PR and the outcome (findings
 * produced, kept/dropped by validation, proposal type). Providers that know
 * their token usage add it to the active span via `recordTokenUsage`, so the
 * trace shows latency AND tokens per pass. Errors are recorded on the span and
 * re-thrown unchanged.
 *
 * Uses only `@opentelemetry/api`: with no SDK registered (tests, offline CLI)
 * every call is a no-op, so behaviour is identical with tracing off.
 */
const tracer = trace.getTracer('revisor');

export class TracedLLMProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly inner: LLMProvider) {
    this.name = inner.name;
  }

  generateReview(input: ReviewInput): Promise<CandidateReview> {
    return this.span('analysis', input.correlationId, input.pullRequest, async (span) => {
      const review = await this.inner.generateReview(input);
      span.setAttribute('revisor.findings.candidates', review.findings.length);
      return review;
    });
  }

  validateFindings(input: ValidationInput): Promise<ValidationResult> {
    return this.span('validation', input.correlationId, input.pullRequest, async (span) => {
      span.setAttribute('revisor.findings.candidates', input.candidateFindings.length);
      const result = await this.inner.validateFindings(input);
      const kept = result.decisions.filter((d) => d.keep !== false).length;
      span.setAttributes({
        'revisor.validation.decisions': result.decisions.length,
        'revisor.validation.kept': kept,
      });
      return result;
    });
  }

  proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal> {
    return this.span('context_evolution', input.correlationId, input.pullRequest, async (span) => {
      const proposal = await this.inner.proposeContextChange(input);
      span.setAttributes({
        'revisor.proposal.type': proposal.type,
        'revisor.proposal.confidence': proposal.confidence,
      });
      return proposal;
    });
  }

  private span<T>(
    pass: string,
    correlationId: string,
    pr: PullRequest,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const attributes: Attributes = {
      'gen_ai.system': this.inner.name,
      'revisor.pass': pass,
      'revisor.correlation_id': correlationId,
      'vcs.repository.name': `${pr.repo.owner}/${pr.repo.name}`,
      'vcs.pull_request.number': pr.number,
      'vcs.pull_request.changed_files': pr.changedFiles.length,
    };
    return tracer.startActiveSpan(`llm.${pass}`, { attributes }, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}

/** Token usage of one model call, as reported by the model server. */
export interface TokenUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Attach token usage to the active LLM span (no-op when tracing is off).
 * Several calls in one pass accumulate onto the same span.
 */
export function recordTokenUsage(usage: TokenUsage): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('gen_ai.request.model', usage.model);
  span.addEvent('gen_ai.usage', {
    'gen_ai.usage.input_tokens': usage.inputTokens ?? 0,
    'gen_ai.usage.output_tokens': usage.outputTokens ?? 0,
  });
  if (usage.inputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
  }
}
