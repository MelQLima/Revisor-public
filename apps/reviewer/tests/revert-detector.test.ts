import { describe, expect, it } from 'vitest';
import { HeuristicRevertDetector } from '../src/integrations/github/revert-detector.js';
import { makeMergedPr } from './helpers.js';

const detector = new HeuristicRevertDetector();

describe('HeuristicRevertDetector', () => {
  it('detects a standard GitHub revert (branch + title + reference + commit)', async () => {
    const r = await detector.detectRevert(
      makeMergedPr({
        number: 450,
        title: 'Revert "Allow reconciliation by external identifier"',
        body: 'Reverts #421',
        headRef: 'revert-421-feature/external-id',
        commits: [{ sha: 'rc1', message: 'Revert "..."\n\nThis reverts commit c1deadbeef01.' }],
      }),
    );
    expect(r.isRevert).toBe(true);
    expect(r.originalPullRequestNumber).toBe(421);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.revertedCommitShas).toContain('c1deadbeef01');
  });

  it('detects a revert from the commit message alone', async () => {
    const r = await detector.detectRevert(
      makeMergedPr({
        number: 460,
        title: 'Roll back the change',
        headRef: 'fix/rollback',
        commits: [{ sha: 'x', message: 'This reverts commit abc1234.' }],
      }),
    );
    expect(r.isRevert).toBe(true);
    expect(r.evidence.some((e) => e.signal === 'commit-reverts-sha')).toBe(true);
  });

  it('picks up an explicit PR reference', async () => {
    const r = await detector.detectRevert(
      makeMergedPr({ number: 470, title: 'Undo change', body: 'reverts PR #333', headRef: 'x' }),
    );
    expect(r.originalPullRequestNumber).toBe(333);
    expect(r.isRevert).toBe(true);
  });

  it('does not treat a loose "revert" mention as a revert (ambiguous)', async () => {
    const r = await detector.detectRevert(
      makeMergedPr({
        number: 512,
        title: 'Add undo/revert button to the payments UI',
        body: 'client-side revert button',
        headRef: 'feature/ui-revert-button',
        commits: [{ sha: 'u1', message: 'Add revert button component' }],
      }),
    );
    expect(r.isRevert).toBe(false);
    expect(r.confidence).toBeLessThan(0.5);
    expect(r.originalPullRequestNumber).toBeUndefined();
  });

  it('returns not-a-revert for an ordinary PR', async () => {
    const r = await detector.detectRevert(
      makeMergedPr({ number: 500, title: 'Add feature', body: 'a feature', headRef: 'feature/x' }),
    );
    expect(r.isRevert).toBe(false);
    expect(r.confidence).toBe(0);
  });
});
