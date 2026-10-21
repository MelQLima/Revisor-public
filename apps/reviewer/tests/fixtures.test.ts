import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { ReviewPipeline } from '../src/application/review-pipeline.js';
import { DocumentContextProvider } from '../src/context/document-context-provider.js';
import { NullHistoryProvider } from '../src/integrations/history/history-provider.js';
import { FixtureGitHubClient } from '../src/integrations/github/fixture-github-client.js';
import { HeuristicLLMProvider } from '../src/integrations/llm/heuristic-llm-provider.js';
import { loadFixture } from '../src/integrations/github/fixture.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import { testLogger } from './helpers.js';

const FIXTURES_DIR = resolve('fixtures');
const context = new DocumentContextProvider('docs/ai');

beforeAll(async () => {
  await context.load();
});

async function runFixture(name: string) {
  const fixture = await loadFixture(join(FIXTURES_DIR, name));
  const pipeline = new ReviewPipeline({
    github: new FixtureGitHubClient(fixture, testLogger()),
    context,
    history: new NullHistoryProvider(),
    llm: new HeuristicLLMProvider(),
    policy: { ...DEFAULT_POLICY },
    logger: testLogger(),
    contextMaxResults: 8,
  });
  const outcome = await pipeline.review(
    { repo: fixture.pullRequest.repo, pullNumber: fixture.pullRequest.number },
    { post: false, extraRelevantCode: fixture.relevantCode },
  );
  return { fixture, outcome };
}

describe('fixtures (offline heuristic pipeline)', () => {
  it('reviews every fixture without throwing and respects declared expectations', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const { fixture, outcome } = await runFixture(file);
      const expects = fixture.expect;
      if (!expects) continue;
      if (expects.verdict) expect(outcome.result.verdict, `${file} verdict`).toBe(expects.verdict);
      if (expects.minFindings !== undefined)
        expect(outcome.result.findings.length, `${file} minFindings`).toBeGreaterThanOrEqual(
          expects.minFindings,
        );
      if (expects.maxFindings !== undefined)
        expect(outcome.result.findings.length, `${file} maxFindings`).toBeLessThanOrEqual(
          expects.maxFindings,
        );
    }
  });

  it('does not raise false positives on a clean refactor (no false positives guard)', async () => {
    const { outcome } = await runFixture('01-clean-refactor.json');
    expect(outcome.result.findings).toHaveLength(0);
    expect(outcome.result.verdict).toBe('approve');
    expect(outcome.result.positives.length).toBeGreaterThan(0);
  });

  it('flags the business-rule violation with evidence', async () => {
    const { outcome } = await runFixture('02-business-rule-violation.json');
    expect(outcome.result.findings.length).toBeGreaterThan(0);
    const business = outcome.result.findings.filter((f) => f.category === 'business');
    expect(business.length).toBeGreaterThan(0);
    expect(business.every((f) => f.evidence.length > 0)).toBe(true);
  });

  it('flags the technical bug (SQL string concatenation)', async () => {
    const { outcome } = await runFixture('03-technical-bug.json');
    const titles = outcome.result.findings.map((f) => f.title.toLowerCase());
    expect(titles.some((t) => t.includes('sql'))).toBe(true);
  });
});
