import { describe, expect, it } from 'vitest';
import { ReviewPipeline } from '../src/application/review-pipeline.js';
import { DocumentContextProvider } from '../src/context/document-context-provider.js';
import { NullHistoryProvider } from '../src/integrations/history/history-provider.js';
import { FixtureGitHubClient } from '../src/integrations/github/fixture-github-client.js';
import { StubLLMProvider } from '../src/integrations/llm/stub-llm-provider.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import type { CandidateReview } from '../src/domain/review.js';
import type { ValidationInput, ValidationResult } from '../src/domain/review-input.js';
import type { ReviewFixture } from '../src/integrations/github/fixture.js';
import { makeFinding, testLogger } from './helpers.js';

type ValidationArg = ValidationResult | ((input: ValidationInput) => ValidationResult);

function fixtureFor(): ReviewFixture {
  return {
    relevantCode: [],
    files: {},
    pullRequest: {
      repo: { owner: 'acme', name: 'wallet' },
      number: 42,
      title: 'Associate payment to person by payer email during reconciliation',
      body: 'faster reconciliation',
      author: 'dev',
      baseRef: 'main',
      headRef: 'f',
      headSha: 'sha42',
      draft: false,
      changedFiles: [
        {
          filename: 'src/payments/payment.service.ts',
          status: 'modified',
          additions: 2,
          deletions: 2,
          patch: '@@ -1,2 +1,2 @@\n-  await validateIdentity(cpf);\n+  const person = await findByEmail(payerEmail);',
        },
      ],
      commits: [],
    },
  };
}

function buildPipeline(review: CandidateReview, validation?: ValidationArg) {
  const fixture = fixtureFor();
  const llm = new StubLLMProvider(review, validation);
  const context = new DocumentContextProvider('docs/ai');
  const pipeline = new ReviewPipeline({
    github: new FixtureGitHubClient(fixture, testLogger()),
    context,
    history: new NullHistoryProvider(),
    llm,
    policy: { ...DEFAULT_POLICY },
    logger: testLogger(),
    contextMaxResults: 8,
  });
  return { pipeline, fixture, llm };
}

const emptyReview: CandidateReview = { summary: 'looks fine', findings: [], positives: ['clean'] };

describe('ReviewPipeline (integration, stubbed LLM)', () => {
  it('approves a clean PR and does not post when post=false', async () => {
    const { pipeline, fixture } = buildPipeline(emptyReview);
    const { result, posted } = await pipeline.review(
      { repo: fixture.pullRequest.repo, pullNumber: fixture.pullRequest.number },
      { post: false },
    );
    expect(result.verdict).toBe('approve');
    expect(result.findings).toHaveLength(0);
    expect(posted).toBe(false);
  });

  it('retrieves real business context for a payments PR', async () => {
    const { pipeline, fixture } = buildPipeline(emptyReview);
    const { result } = await pipeline.review({
      repo: fixture.pullRequest.repo,
      pullNumber: fixture.pullRequest.number,
    });
    expect(result.stats.businessRulesConsulted).toBeGreaterThan(0);
  });

  it('requests changes on a confident business BLOCKER with evidence', async () => {
    const review: CandidateReview = {
      summary: 'risky',
      positives: [],
      findings: [
        makeFinding({
          id: 'f1',
          category: 'business',
          severity: 'BLOCKER',
          certainty: 'confirmed',
          confidence: 0.95,
          file: 'src/payments/payment.service.ts',
          line: 2,
          businessRule: 'docs/ai/domain/payments.md#identity-invariant',
          evidence: [{ source: 'docs/ai/domain/payments.md', detail: 'CPF required before association' }],
        }),
      ],
    };
    const { pipeline, fixture, llm } = buildPipeline(review);
    const { result } = await pipeline.review({
      repo: fixture.pullRequest.repo,
      pullNumber: fixture.pullRequest.number,
    });
    expect(result.verdict).toBe('request_changes');
    expect(result.findings[0]?.severity).toBe('BLOCKER');
    // both passes ran
    expect(llm.calls.generate).toBe(1);
    expect(llm.calls.validate).toBe(1);
  });

  it('filters a low-confidence finding down to approve', async () => {
    const review: CandidateReview = {
      summary: 'maybe',
      positives: [],
      findings: [makeFinding({ id: 'f1', confidence: 0.4, certainty: 'potential' })],
    };
    const { pipeline, fixture } = buildPipeline(review);
    const { result } = await pipeline.review({
      repo: fixture.pullRequest.repo,
      pullNumber: fixture.pullRequest.number,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.verdict).toBe('approve');
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('drops a finding the validator rejects', async () => {
    const review: CandidateReview = {
      summary: 'x',
      positives: [],
      findings: [makeFinding({ id: 'f1', confidence: 0.95, severity: 'BLOCKER' })],
    };
    const { pipeline, fixture } = buildPipeline(review, () => ({
      decisions: [
        { findingId: 'f1', keep: false, adjustedConfidence: 0.1, adjustedCertainty: 'insufficient-evidence', reason: 'unsupported' },
      ],
    }));
    const { result } = await pipeline.review({
      repo: fixture.pullRequest.repo,
      pullNumber: fixture.pullRequest.number,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.verdict).toBe('approve');
  });

  it('posts the review when post=true', async () => {
    const { pipeline, fixture } = buildPipeline(emptyReview);
    const { posted } = await pipeline.review(
      { repo: fixture.pullRequest.repo, pullNumber: fixture.pullRequest.number },
      { post: true },
    );
    // FixtureGitHubClient is dry-run: reports not-posted but does not throw.
    expect(posted).toBe(false);
  });
});
