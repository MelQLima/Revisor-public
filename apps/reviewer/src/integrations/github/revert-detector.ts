import type { PullRequest } from '../../domain/pull-request.js';
import type { RevertEvidence, RevertResult } from '../../domain/context-evolution.js';

/**
 * Revert detection. GitHub has no semantic "PR reverted" event — a revert is a
 * commit/PR. We combine multiple signals (never title alone) and only claim an
 * original PR number when we actually found one. If we can't tell confidently,
 * we say so rather than fabricate the relationship.
 */
export interface RevertDetector {
  readonly name: string;
  detectRevert(pr: PullRequest): Promise<RevertResult>;
}

interface Signal {
  weight: number;
  evidence: RevertEvidence;
  originalPr?: number;
  revertedSha?: string;
}

/** GitHub names auto-revert branches `revert-<prNumber>-<original-branch>`. */
const REVERT_BRANCH = /^revert-(\d+)-/i;
/** Git revert commits carry `This reverts commit <sha>.`. */
const REVERTS_COMMIT = /this reverts commit ([0-9a-f]{7,40})/gi;
/** `Revert "<original title>"`. */
const REVERT_TITLE = /^revert\s+"(.+)"/i;
/** `reverts #421`, `revert PR #421`, `reverts pull request #421`. */
const REVERTS_PR = /reverts?\s+(?:pr\s*|pull\s+request\s*)?#(\d+)/i;
const GENERIC_REVERT = /\brevert(?:s|ed|ing)?\b/i;

/** Noisy-OR combination keeps confidence in [0,1] and rewards multiple signals. */
function combine(weights: number[]): number {
  const product = weights.reduce((acc, w) => acc * (1 - w), 1);
  return Number((1 - product).toFixed(4));
}

export class HeuristicRevertDetector implements RevertDetector {
  readonly name = 'heuristic-revert-detector';

  async detectRevert(pr: PullRequest): Promise<RevertResult> {
    const signals: Signal[] = [];
    const commitText = pr.commits.map((c) => c.message).join('\n');
    const haystack = `${pr.title}\n${pr.body}\n${commitText}`;

    // 1) GitHub auto-revert branch name — strongest, carries the PR number.
    const branch = REVERT_BRANCH.exec(pr.headRef);
    if (branch) {
      signals.push({
        weight: 0.7,
        originalPr: parseInt(branch[1]!, 10),
        evidence: { signal: 'github-revert-branch', detail: `head ref '${pr.headRef}'` },
      });
    }

    // 2) `This reverts commit <sha>` in any commit message.
    for (const m of commitText.matchAll(REVERTS_COMMIT)) {
      signals.push({
        weight: 0.6,
        revertedSha: m[1]!,
        evidence: { signal: 'commit-reverts-sha', detail: `reverts commit ${m[1]!.slice(0, 12)}` },
      });
    }

    // 3) Explicit PR reference near a revert.
    const prRef = REVERTS_PR.exec(haystack);
    if (prRef) {
      signals.push({
        weight: 0.6,
        originalPr: parseInt(prRef[1]!, 10),
        evidence: { signal: 'pr-reference', detail: `reverts #${prRef[1]}` },
      });
    }

    // 4) `Revert "<title>"` conventional message (no number by itself).
    const titleMatch = REVERT_TITLE.exec(pr.title) ?? REVERT_TITLE.exec(commitText);
    if (titleMatch) {
      signals.push({
        weight: 0.4,
        evidence: { signal: 'title-revert', detail: `revert of "${titleMatch[1]!.slice(0, 80)}"` },
      });
    }

    // 5) Generic "revert" word — weak, only meaningful alongside others.
    if (signals.length === 0 && GENERIC_REVERT.test(haystack)) {
      signals.push({
        weight: 0.15,
        evidence: { signal: 'generic-revert-word', detail: 'mentions "revert" without a clear pattern' },
      });
    }

    if (signals.length === 0) {
      return { isRevert: false, revertedCommitShas: [], confidence: 0, evidence: [] };
    }

    const confidence = combine(signals.map((s) => s.weight));
    // Prefer the branch-derived PR number, else the explicit reference.
    const originalPr =
      signals.find((s) => s.evidence.signal === 'github-revert-branch')?.originalPr ??
      signals.find((s) => s.evidence.signal === 'pr-reference')?.originalPr;
    const revertedShas = signals.map((s) => s.revertedSha).filter((s): s is string => Boolean(s));

    return {
      isRevert: confidence >= 0.5,
      ...(originalPr ? { originalPullRequestNumber: originalPr } : {}),
      revertedCommitShas: revertedShas,
      confidence,
      evidence: signals.map((s) => s.evidence),
    };
  }
}
