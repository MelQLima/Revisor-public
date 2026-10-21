import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { Logger } from '../src/infrastructure/logging/logger.js';
import type { ReviewFinding } from '../src/domain/review.js';
import type { ReviewInput } from '../src/domain/review-input.js';
import type { PullRequest } from '../src/domain/pull-request.js';
import type { ContextChangeProposal } from '../src/domain/context-evolution.js';
import { FileContextStore } from '../src/infrastructure/context-store/file-context-store.js';

/** Silent logger for tests. */
export function testLogger(): Logger {
  return pino({ level: 'silent' });
}

export function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: overrides.id ?? 'f1',
    category: overrides.category ?? 'technical',
    severity: overrides.severity ?? 'IMPORTANT',
    certainty: overrides.certainty ?? 'likely',
    confidence: overrides.confidence ?? 0.9,
    title: overrides.title ?? 'Test finding',
    problem: overrides.problem ?? 'Something is wrong',
    evidence: overrides.evidence ?? [{ source: 'src/x.ts:1', detail: 'the thing' }],
    impact: overrides.impact ?? 'It could break',
    recommendation: overrides.recommendation ?? 'Fix it',
    ...(overrides.file ? { file: overrides.file } : {}),
    ...(overrides.line ? { line: overrides.line } : {}),
    ...(overrides.businessRule ? { businessRule: overrides.businessRule } : {}),
  };
}

export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: { owner: 'acme', name: 'core' },
    number: 1,
    title: 'Test PR',
    body: '',
    author: 'dev',
    baseRef: 'main',
    headRef: 'feature',
    headSha: 'sha1',
    draft: false,
    changedFiles: [],
    commits: [],
    ...overrides,
  };
}

export function makeReviewInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    correlationId: 'rev_test',
    pullRequest: makePullRequest(overrides.pullRequest),
    relevantCode: overrides.relevantCode ?? [],
    businessContext: overrides.businessContext ?? [],
    technicalContext: overrides.technicalContext ?? [],
    historyContext: overrides.historyContext ?? [],
  };
}

/** A merged PR with sensible defaults for context-evolution tests. */
export function makeMergedPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return makePullRequest({
    number: 421,
    title: 'Allow reconciliation by external identifier',
    merged: true,
    mergeCommitSha: 'mergesha421',
    commits: [{ sha: 'c1', message: 'Add external identifier reconciliation' }],
    ...overrides,
  });
}

export function makeProposal(overrides: Partial<ContextChangeProposal> = {}): ContextChangeProposal {
  return {
    type: overrides.type ?? 'CREATE',
    confidence: overrides.confidence ?? 0.95,
    topic: overrides.topic ?? 'payment-external-identifier-reconciliation',
    category: overrides.category ?? 'BUSINESS_RULE',
    summary: overrides.summary ?? 'External identifiers accepted for reconciliation.',
    proposedContent:
      overrides.proposedContent ??
      'External payment identifiers may be used as a reconciliation key when the internal id is missing.',
    evidence: overrides.evidence ?? [
      { source: 'PR', reference: '#421' },
      { source: 'FILE', reference: 'src/payment/reconciliation.ts' },
    ],
    sourcePullRequest: overrides.sourcePullRequest ?? {
      number: 421,
      repository: 'acme/core',
      title: 'Allow reconciliation by external identifier',
    },
    affectedDomains: overrides.affectedDomains ?? ['payments'],
    reason: overrides.reason ?? 'PR introduces a deliberate domain change.',
  };
}

/** A fresh FileContextStore backed by a unique temp file. */
export async function tmpContextStore(): Promise<FileContextStore> {
  const dir = await mkdtemp(join(tmpdir(), 'revisor-ctxstore-'));
  return new FileContextStore(join(dir, 'store.json'));
}
