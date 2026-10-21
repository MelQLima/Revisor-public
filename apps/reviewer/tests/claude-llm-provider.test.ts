import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeLLMProvider } from '../src/integrations/llm/claude-llm-provider.js';
import { makeReviewInput, makeFinding, testLogger } from './helpers.js';

function fakeAnthropic(toolName: string, input: unknown) {
  const create = vi.fn(async () => ({
    content: [{ type: 'tool_use', name: toolName, input }],
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const opts = (client: Anthropic) => ({
  apiKey: 'test',
  model: 'claude-x',
  validationModel: 'claude-x',
  maxTokens: 1024,
  temperature: 0,
  logger: testLogger(),
  client,
});

describe('ClaudeLLMProvider', () => {
  it('parses the analysis tool call and assigns finding ids', async () => {
    const { client } = fakeAnthropic('submit_review', {
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
    const provider = new ClaudeLLMProvider(opts(client));
    const review = await provider.generateReview(makeReviewInput());
    expect(review.summary).toBe('ok');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]?.id).toBeTruthy();
  });

  it('coerces the validation tool call', async () => {
    const { client } = fakeAnthropic('submit_validation', {
      decisions: [
        { findingId: 'f1', keep: true, adjustedConfidence: 0.7, adjustedCertainty: 'likely', reason: 'ok' },
      ],
    });
    const provider = new ClaudeLLMProvider(opts(client));
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

  it('short-circuits validation when there are no candidates', async () => {
    const { client, create } = fakeAnthropic('submit_validation', { decisions: [] });
    const provider = new ClaudeLLMProvider(opts(client));
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
    expect(create).not.toHaveBeenCalled();
  });

  it('throws when the model omits the expected tool call', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'no tool' }] }));
    const client = { messages: { create } } as unknown as Anthropic;
    const provider = new ClaudeLLMProvider(opts(client));
    await expect(provider.generateReview(makeReviewInput())).rejects.toThrow(/did not return/);
  });
});
