import { describe, expect, it } from 'vitest';
import { decideVerdict, filterFindings, aggregateReview, DEFAULT_POLICY } from '../src/domain/policy.js';
import { makeFinding } from './helpers.js';

const policy = { ...DEFAULT_POLICY };

describe('filterFindings', () => {
  it('drops findings below the minimum confidence', () => {
    const { kept, rejected } = filterFindings([makeFinding({ confidence: 0.3 })], policy);
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/min/);
  });

  it('drops insufficient-evidence findings', () => {
    const { kept, rejected } = filterFindings(
      [makeFinding({ certainty: 'insufficient-evidence', confidence: 0.9 })],
      policy,
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/insufficient-evidence/);
  });

  it('drops business findings without evidence', () => {
    const { kept, rejected } = filterFindings(
      [makeFinding({ category: 'business', evidence: [], confidence: 0.9 })],
      policy,
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/without evidence/);
  });

  it('drops BLOCKER findings without evidence', () => {
    const { kept } = filterFindings(
      [makeFinding({ severity: 'BLOCKER', evidence: [], confidence: 0.95 })],
      policy,
    );
    expect(kept).toHaveLength(0);
  });

  it('downgrades a low-confidence BLOCKER to SUGGESTION (not blocking)', () => {
    const { kept } = filterFindings(
      [makeFinding({ severity: 'BLOCKER', confidence: 0.7 })],
      policy,
    );
    expect(kept[0]?.severity).toBe('SUGGESTION');
  });

  it('keeps a high-confidence BLOCKER with evidence', () => {
    const { kept } = filterFindings(
      [makeFinding({ severity: 'BLOCKER', confidence: 0.95 })],
      policy,
    );
    expect(kept[0]?.severity).toBe('BLOCKER');
  });

  it('sorts by severity then confidence and caps at maxFindings', () => {
    const findings = [
      makeFinding({ id: 'a', severity: 'SUGGESTION', confidence: 0.9 }),
      makeFinding({ id: 'b', severity: 'BLOCKER', confidence: 0.95 }),
      makeFinding({ id: 'c', severity: 'IMPORTANT', confidence: 0.85 }),
    ];
    const { kept } = filterFindings(findings, { ...policy, maxFindings: 2 });
    expect(kept.map((f) => f.id)).toEqual(['b', 'c']);
  });
});

describe('decideVerdict', () => {
  it('requests changes on a confident BLOCKER', () => {
    expect(decideVerdict([makeFinding({ severity: 'BLOCKER', confidence: 0.95 })], policy)).toBe(
      'request_changes',
    );
  });

  it('never requests changes in dry-run mode', () => {
    expect(
      decideVerdict([makeFinding({ severity: 'BLOCKER', confidence: 0.95 })], { ...policy, dryRun: true }),
    ).toBe('comment');
  });

  it('comments when there are non-blocking findings', () => {
    expect(decideVerdict([makeFinding({ severity: 'SUGGESTION' })], policy)).toBe('comment');
  });

  it('approves when there are no findings', () => {
    expect(decideVerdict([], policy)).toBe('approve');
  });
});

describe('aggregateReview', () => {
  it('produces a verdict consistent with the kept findings', () => {
    const outcome = filterFindings([makeFinding({ severity: 'BLOCKER', confidence: 0.95 })], policy);
    const agg = aggregateReview({ summary: 's', positives: ['nice'] }, outcome, policy);
    expect(agg.verdict).toBe('request_changes');
    expect(agg.positives).toEqual(['nice']);
    expect(agg.findings).toHaveLength(1);
  });
});
