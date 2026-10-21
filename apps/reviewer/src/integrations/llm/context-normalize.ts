import type { PullRequest } from '../../domain/pull-request.js';
import {
  type ContextChangeProposal,
  ContextChangeProposalSchema,
  type SourcePullRequest,
} from '../../domain/context-evolution.js';

/** Provenance the model must NOT author — derived from the real PR. */
export function sourceFromPr(pr: PullRequest): SourcePullRequest {
  return {
    number: pr.number,
    repository: `${pr.repo.owner}/${pr.repo.name}`,
    title: pr.title,
    ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
  };
}

/** A safe NO_CHANGE proposal — the default and the fallback on bad output. */
export function noChangeProposal(pr: PullRequest, reason: string): ContextChangeProposal {
  return {
    type: 'NO_CHANGE',
    confidence: 0,
    topic: 'none',
    category: 'DOMAIN_BEHAVIOR',
    summary: 'No durable context change.',
    evidence: [],
    sourcePullRequest: sourceFromPr(pr),
    affectedDomains: [],
    reason,
  };
}

/**
 * Turn raw model output into a validated ContextChangeProposal, injecting
 * trustworthy provenance. Invalid output collapses to NO_CHANGE rather than
 * throwing — a merged PR must never fail because the model misbehaved.
 */
export function toProposal(raw: unknown, pr: PullRequest): ContextChangeProposal {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const parsed = ContextChangeProposalSchema.safeParse({
    ...obj,
    sourcePullRequest: sourceFromPr(pr),
  });
  if (parsed.success) return parsed.data;
  return noChangeProposal(pr, `invalid model output: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
}
