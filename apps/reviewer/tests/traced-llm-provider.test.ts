import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StubLLMProvider } from '../src/integrations/llm/stub-llm-provider.js';
import { TracedLLMProvider, recordTokenUsage } from '../src/integrations/llm/traced-llm-provider.js';
import type { LLMProvider } from '../src/integrations/llm/llm-provider.js';
import { makeFinding, makeReviewInput } from './helpers.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
  trace.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

describe('TracedLLMProvider', () => {
  it('opens one span per analysis pass with the PR and the candidate count', async () => {
    const inner = new StubLLMProvider({
      summary: 'ok',
      findings: [makeFinding(), makeFinding({ id: 'f2' })],
      positives: [],
    });
    const traced = new TracedLLMProvider(inner);

    const review = await traced.generateReview(makeReviewInput());

    expect(review.findings).toHaveLength(2);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('llm.analysis');
    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'stub',
      'revisor.pass': 'analysis',
      'revisor.correlation_id': 'rev_test',
      'vcs.repository.name': 'acme/core',
      'vcs.pull_request.number': 1,
      'revisor.findings.candidates': 2,
    });
  });

  it('keeps the provider name so callers see no difference', () => {
    const traced = new TracedLLMProvider(new StubLLMProvider({ summary: '', findings: [], positives: [] }));
    expect(traced.name).toBe('stub');
  });

  it('records token usage reported inside the pass on the same span', async () => {
    const inner: LLMProvider = {
      name: 'fake-model',
      generateReview: async () => {
        recordTokenUsage({ model: 'qwen3-coder', inputTokens: 5200, outputTokens: 640 });
        return { summary: '', findings: [], positives: [] };
      },
      validateFindings: async () => ({ decisions: [] }),
      proposeContextChange: async () => {
        throw new Error('not used');
      },
    };

    await new TracedLLMProvider(inner).generateReview(makeReviewInput());

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      'gen_ai.request.model': 'qwen3-coder',
      'gen_ai.usage.input_tokens': 5200,
      'gen_ai.usage.output_tokens': 640,
    });
  });

  it('marks the span as an error and rethrows the original failure', async () => {
    const inner: LLMProvider = {
      name: 'broken',
      generateReview: async () => {
        throw new Error('model offline');
      },
      validateFindings: async () => ({ decisions: [] }),
      proposeContextChange: async () => {
        throw new Error('not used');
      },
    };

    await expect(new TracedLLMProvider(inner).generateReview(makeReviewInput())).rejects.toThrow(
      'model offline',
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('is a no-op outside a span: recordTokenUsage never throws', () => {
    expect(() => recordTokenUsage({ model: 'x', inputTokens: 1 })).not.toThrow();
  });
});
