import { describe, expect, it } from 'vitest';
import type { CreateContextVersionInput } from '../src/domain/context-store.js';
import { makeProposal, tmpContextStore } from './helpers.js';

function versionInput(overrides: Partial<CreateContextVersionInput> = {}): CreateContextVersionInput {
  return {
    topic: 'payment-reconciliation',
    category: 'BUSINESS_RULE',
    content: 'v-content',
    summary: 'v-summary',
    changeType: 'CREATE',
    confidence: 0.95,
    evidence: [{ source: 'PR', reference: '#1' }],
    source: { number: 1, repository: 'acme/core', title: 'PR 1' },
    affectedDomains: ['payments'],
    reason: 'because',
    ...overrides,
  };
}

describe('FileContextStore', () => {
  it('creates a version and reports it as current', async () => {
    const store = await tmpContextStore();
    const entry = await store.createVersion(versionInput());
    expect(entry.version).toBe(1);
    expect(entry.status).toBe('ACTIVE');
    const current = await store.getCurrent('payment-reconciliation');
    expect(current?.id).toBe(entry.id);
  });

  it('supersedes the previous version on UPDATE and preserves history', async () => {
    const store = await tmpContextStore();
    const v1 = await store.createVersion(versionInput({ content: 'first' }));
    const v2 = await store.createVersion(
      versionInput({ changeType: 'UPDATE', content: 'second', source: { number: 2, repository: 'acme/core', title: 'PR 2' } }),
    );
    expect(v2.version).toBe(2);
    expect(v2.previousVersion).toBe(1);
    const current = await store.getCurrent('payment-reconciliation');
    expect(current?.content).toBe('second');
    const history = await store.getHistory('payment-reconciliation');
    expect(history.map((h) => h.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
    // v1 is preserved with its provenance.
    expect(history[0]?.id).toBe(v1.id);
    expect(history[0]?.source.number).toBe(1);
  });

  it('REVERT deactivates the prior version while keeping it in history', async () => {
    const store = await tmpContextStore();
    await store.createVersion(versionInput({ content: 'introduced' }));
    const rev = await store.createVersion(
      versionInput({
        changeType: 'REVERT',
        content: 'reverted: no longer in effect',
        source: { number: 2, repository: 'acme/core', title: 'Revert' },
      }),
    );
    const current = await store.getCurrent('payment-reconciliation');
    expect(current?.id).toBe(rev.id);
    expect(current?.changeType).toBe('REVERT');
    const history = await store.getHistory('payment-reconciliation');
    expect(history.map((h) => h.status)).toEqual(['REVERTED', 'ACTIVE']);
  });

  it('DEPRECATE with no content retires the topic (no current)', async () => {
    const store = await tmpContextStore();
    await store.createVersion(versionInput());
    await store.createVersion(versionInput({ changeType: 'DEPRECATE', content: '' }));
    expect(await store.getCurrent('payment-reconciliation')).toBeNull();
  });

  it('lists current entries and filters by category', async () => {
    const store = await tmpContextStore();
    await store.createVersion(versionInput({ topic: 'a', category: 'BUSINESS_RULE' }));
    await store.createVersion(versionInput({ topic: 'b', category: 'ARCHITECTURE' }));
    expect(await store.listCurrent()).toHaveLength(2);
    expect(await store.listCurrent(['ARCHITECTURE'])).toHaveLength(1);
  });

  it('records proposals, dedupes by idempotency key, and updates status', async () => {
    const store = await tmpContextStore();
    const rec = await store.proposeChange(makeProposal(), 'PENDING_REVIEW', 'key-1', 'mid confidence');
    expect(await store.findByIdempotencyKey('key-1')).not.toBeNull();
    expect(await store.findByIdempotencyKey('missing')).toBeNull();
    expect(await store.listProposals('PENDING_REVIEW')).toHaveLength(1);
    const updated = await store.updateProposalStatus(rec.id, 'REJECTED');
    expect(updated?.status).toBe('REJECTED');
    expect(await store.listProposals('PENDING_REVIEW')).toHaveLength(0);
  });

  it('persists across store instances (same file)', async () => {
    const store = await tmpContextStore();
    const entry = await store.createVersion(versionInput());
    // A second store over the same file sees the data.
    const { FileContextStore } = await import('../src/infrastructure/context-store/file-context-store.js');
    const reopened = new FileContextStore((store as unknown as { filePath: string }).filePath);
    const current = await reopened.getCurrent('payment-reconciliation');
    expect(current?.id).toBe(entry.id);
  });
});
