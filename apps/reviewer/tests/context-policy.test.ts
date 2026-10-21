import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_POLICY,
  decideStatus,
  idempotencyKey,
  validateProposal,
} from '../src/domain/context-policy.js';
import { makeProposal } from './helpers.js';

describe('validateProposal', () => {
  it('accepts NO_CHANGE trivially', () => {
    expect(validateProposal(makeProposal({ type: 'NO_CHANGE' })).valid).toBe(true);
  });

  it('rejects a real change with no evidence', () => {
    const v = validateProposal(makeProposal({ evidence: [] }));
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/evidence/);
  });

  it('rejects CREATE/UPDATE without proposedContent', () => {
    const v = validateProposal(makeProposal({ type: 'CREATE', proposedContent: '' }));
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/proposedContent/);
  });

  it('accepts a well-formed proposal', () => {
    expect(validateProposal(makeProposal()).valid).toBe(true);
  });
});

describe('decideStatus', () => {
  const policy = DEFAULT_CONTEXT_POLICY;

  it('NO_CHANGE → REJECTED', () => {
    expect(decideStatus(makeProposal({ type: 'NO_CHANGE' }), policy).status).toBe('REJECTED');
  });

  it('below proposal threshold → REJECTED (NO_CONTEXT_CHANGE)', () => {
    expect(decideStatus(makeProposal({ confidence: 0.5 }), policy).status).toBe('REJECTED');
  });

  it('mid confidence → PENDING_REVIEW', () => {
    expect(decideStatus(makeProposal({ confidence: 0.8 }), policy).status).toBe('PENDING_REVIEW');
  });

  it('high confidence → AUTO_UPDATE', () => {
    expect(decideStatus(makeProposal({ confidence: 0.95 }), policy).status).toBe('AUTO_UPDATE');
  });

  it('review-required category forces PENDING_REVIEW even at high confidence', () => {
    const guarded = { ...policy, reviewRequiredCategories: ['BUSINESS_RULE' as const] };
    const d = decideStatus(makeProposal({ confidence: 0.98, category: 'BUSINESS_RULE' }), guarded);
    expect(d.status).toBe('PENDING_REVIEW');
  });
});

describe('idempotencyKey', () => {
  it('is stable for the same event and differs across merge SHAs', () => {
    const a = idempotencyKey({ repository: 'Acme/Core', pullNumber: 1, mergeCommitSha: 'x', eventType: 'merged' });
    const b = idempotencyKey({ repository: 'acme/core', pullNumber: 1, mergeCommitSha: 'x', eventType: 'merged' });
    const c = idempotencyKey({ repository: 'acme/core', pullNumber: 1, mergeCommitSha: 'y', eventType: 'merged' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
