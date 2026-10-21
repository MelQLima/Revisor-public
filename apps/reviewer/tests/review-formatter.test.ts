import { describe, expect, it } from 'vitest';
import { formatReviewBody, toInlineComments } from '../src/review/review-formatter.js';
import type { ReviewResult } from '../src/domain/review.js';
import { makeFinding } from './helpers.js';

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    correlationId: 'rev_abc',
    summary: 'Summary text',
    verdict: 'comment',
    findings: [],
    positives: [],
    rejected: [],
    stats: {
      changedFiles: 2,
      contextResults: 3,
      businessRulesConsulted: 1,
      historyReferences: 0,
      candidateFindings: 1,
      rejectedFindings: 0,
    },
    ...overrides,
  };
}

describe('formatReviewBody', () => {
  it('renders header, summary and verdict', () => {
    const body = formatReviewBody(makeResult({ verdict: 'approve' }));
    expect(body).toMatch(/## AI Code Review/);
    expect(body).toMatch(/### Summary/);
    expect(body).toMatch(/### Verdict/);
    expect(body).toMatch(/Approve/);
    expect(body).toMatch(/rev_abc/);
  });

  it('renders a BLOCKER finding with evidence, impact and recommendation', () => {
    const body = formatReviewBody(
      makeResult({
        verdict: 'request_changes',
        findings: [
          makeFinding({
            severity: 'BLOCKER',
            title: 'Bad thing',
            file: 'src/pay.ts',
            line: 42,
            businessRule: 'docs/ai/domain/payments.md#identity-invariant',
          }),
        ],
      }),
    );
    expect(body).toMatch(/🔴 BLOCKER/);
    expect(body).toMatch(/src\/pay\.ts:42/);
    expect(body).toMatch(/Evidence:/);
    expect(body).toMatch(/Business rule:/);
    expect(body).toMatch(/Changes requested/);
  });

  it('shows a clean message when there are no findings', () => {
    expect(formatReviewBody(makeResult())).toMatch(/No actionable findings/);
  });
});

describe('toInlineComments', () => {
  it('creates one inline comment per finding with a location', () => {
    const comments = toInlineComments(
      makeResult({
        findings: [
          makeFinding({ file: 'a.ts', line: 3, title: 'Loc finding' }),
          makeFinding({ id: 'f2', title: 'No location' }),
        ],
      }),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: 'a.ts', line: 3 });
  });
});
