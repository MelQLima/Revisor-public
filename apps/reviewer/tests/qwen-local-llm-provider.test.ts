import { describe, expect, it, vi } from 'vitest';
import {
  QwenLocalLLMProvider,
  type FetchFn,
  type HttpResponse,
} from '../src/integrations/llm/qwen-local-llm-provider.js';
import { makeReviewInput, makeFinding, testLogger } from './helpers.js';

function chatResponse(content: string): HttpResponse {
  return {
    ok: true,
    status: 200,
    text: async () => content,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const opts = (fetchFn: FetchFn) => ({
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3-coder',
  maxTokens: 2048,
  logger: testLogger(),
  fetchFn,
});

const analysisJson = JSON.stringify({
  summary: 'ok',
  positives: ['nice'],
  findings: [
    {
      category: 'technical',
      severity: 'IMPORTANT',
      certainty: 'likely',
      confidence: 0.8,
      title: 'A bug',
      problem: 'p',
      evidence: [{ source: 'a.ts:1', detail: 'd' }],
      impact: 'i',
      recommendation: 'r',
    },
  ],
});

describe('QwenLocalLLMProvider', () => {
  it('POSTs to the OpenAI-compatible chat endpoint and parses findings', async () => {
    const fetchFn = vi.fn(async () => chatResponse(analysisJson)) as unknown as FetchFn;
    const provider = new QwenLocalLLMProvider(opts(fetchFn));
    const review = await provider.generateReview(makeReviewInput());

    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.id).toBeTruthy();
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, { body: string }][] } }).mock
      .calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen3-coder');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
  });

  it('recovers JSON wrapped in a markdown code fence', async () => {
    const fenced = `Here is the review:\n\`\`\`json\n${analysisJson}\n\`\`\`\nDone.`;
    const provider = new QwenLocalLLMProvider(opts((async () => chatResponse(fenced)) as FetchFn));
    const review = await provider.generateReview(makeReviewInput());
    expect(review.summary).toBe('ok');
    expect(review.findings).toHaveLength(1);
  });

  it('coerces validation decisions', async () => {
    const validationJson = JSON.stringify({
      decisions: [
        { findingId: 'f1', keep: true, adjustedConfidence: 0.7, adjustedCertainty: 'likely', reason: 'ok' },
      ],
    });
    const provider = new QwenLocalLLMProvider(
      opts((async () => chatResponse(validationJson)) as FetchFn),
    );
    const result = await provider.validateFindings({
      correlationId: 'c',
      pullRequest: makeReviewInput().pullRequest,
      candidateFindings: [makeFinding({ id: 'f1' })],
      businessContext: [],
      technicalContext: [],
      historyContext: [],
      relevantCode: [],
    });
    expect(result.decisions[0]?.findingId).toBe('f1');
  });

  it('short-circuits validation with no candidates (no HTTP call)', async () => {
    const fetchFn = vi.fn(async () => chatResponse('{}')) as unknown as FetchFn;
    const provider = new QwenLocalLLMProvider(opts(fetchFn));
    const result = await provider.validateFindings({
      correlationId: 'c',
      pullRequest: makeReviewInput().pullRequest,
      candidateFindings: [],
      businessContext: [],
      technicalContext: [],
      historyContext: [],
      relevantCode: [],
    });
    expect(result.decisions).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws a helpful error when the local server is unreachable', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const provider = new QwenLocalLLMProvider(opts(fetchFn));
    await expect(provider.generateReview(makeReviewInput())).rejects.toThrow(/ollama|reach the local model/i);
  });

  it('throws on a non-OK HTTP status', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 404,
      text: async () => 'model not found',
      json: async () => ({}),
    });
    const provider = new QwenLocalLLMProvider(opts(fetchFn));
    await expect(provider.generateReview(makeReviewInput())).rejects.toThrow(/HTTP 404/);
  });
});
