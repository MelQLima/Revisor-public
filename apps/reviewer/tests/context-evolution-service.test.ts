import { describe, expect, it } from 'vitest';
import type { ContextProvider } from '../src/domain/context.js';
import type { ContextStore } from '../src/domain/context-store.js';
import type { ContextChangeProposal } from '../src/domain/context-evolution.js';
import { DEFAULT_CONTEXT_POLICY, type ContextPolicyConfig } from '../src/domain/context-policy.js';
import { ContextEvolutionAgent } from '../src/application/context-evolution-agent.js';
import { ContextEvolutionService } from '../src/application/context-evolution-service.js';
import { HeuristicRevertDetector } from '../src/integrations/github/revert-detector.js';
import { StubLLMProvider } from '../src/integrations/llm/stub-llm-provider.js';
import { makeMergedPr, makeProposal, testLogger, tmpContextStore } from './helpers.js';

const emptyReview = { summary: '', findings: [], positives: [] };
const fakeContext: ContextProvider = { name: 'fake', async search() { return []; } };

async function buildService(
  store: ContextStore,
  proposal: ContextChangeProposal | ((...a: unknown[]) => ContextChangeProposal) | Error,
  policy: ContextPolicyConfig = DEFAULT_CONTEXT_POLICY,
) {
  const llm =
    proposal instanceof Error
      ? new StubLLMProvider(emptyReview, { decisions: [] }, () => {
          throw proposal;
        })
      : new StubLLMProvider(emptyReview, { decisions: [] }, proposal as ContextChangeProposal);
  const agent = new ContextEvolutionAgent({
    llm,
    context: fakeContext,
    store,
    revertDetector: new HeuristicRevertDetector(),
    logger: testLogger(),
    contextMaxResults: 8,
    revertConfidenceThreshold: 0.6,
  });
  return new ContextEvolutionService({ agent, store, policy, logger: testLogger() });
}

describe('ContextEvolutionService — merges', () => {
  it('applies a high-confidence business change (AUTO_UPDATE + version + provenance)', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ confidence: 0.95 }));
    const outcome = await service.onMergedPR(makeMergedPr());

    expect(outcome.status).toBe('AUTO_UPDATE');
    expect(outcome.entry?.version).toBe(1);
    const current = await store.getCurrent('payment-external-identifier-reconciliation');
    expect(current?.status).toBe('ACTIVE');
    expect(current?.source.number).toBe(421); // provenance
    expect(current?.evidence.length).toBeGreaterThan(0);
  });

  it('a technical-only PR produces NO_CONTEXT_CHANGE', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ type: 'NO_CHANGE', confidence: 0 }));
    const outcome = await service.onMergedPR(makeMergedPr({ number: 500 }));
    expect(outcome.status).toBe('REJECTED');
    expect(await store.listCurrent()).toHaveLength(0);
  });

  it('a mid-confidence change becomes PENDING_REVIEW without changing context', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ confidence: 0.8 }));
    const outcome = await service.onMergedPR(makeMergedPr());
    expect(outcome.status).toBe('PENDING_REVIEW');
    expect(await store.getCurrent('payment-external-identifier-reconciliation')).toBeNull();
    expect(await store.listProposals('PENDING_REVIEW')).toHaveLength(1);
  });

  it('is idempotent across duplicate webhook deliveries', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ confidence: 0.95 }));
    const pr = makeMergedPr();
    const first = await service.onMergedPR(pr);
    const second = await service.onMergedPR(pr);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    // Only one version created.
    expect(await store.getHistory('payment-external-identifier-reconciliation')).toHaveLength(1);
  });

  it('does not crash when the LLM fails (defaults to NO_CHANGE)', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, new Error('model down'));
    const outcome = await service.onMergedPR(makeMergedPr());
    expect(outcome.status).toBe('REJECTED');
  });

  it('treats invalid model output (no evidence) as NO_CHANGE', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ confidence: 0.99, evidence: [] }));
    const outcome = await service.onMergedPR(makeMergedPr());
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.decisionReason).toMatch(/NO_CONTEXT_CHANGE/);
  });

  it('enforces the review-required safeguard for high-impact categories', async () => {
    const store = await tmpContextStore();
    const guarded = { ...DEFAULT_CONTEXT_POLICY, reviewRequiredCategories: ['BUSINESS_RULE' as const] };
    const service = await buildService(store, makeProposal({ confidence: 0.98, category: 'BUSINESS_RULE' }), guarded);
    const outcome = await service.onMergedPR(makeMergedPr());
    expect(outcome.status).toBe('PENDING_REVIEW');
    expect(await store.listCurrent()).toHaveLength(0);
  });
});

describe('ContextEvolutionService — reverts', () => {
  it('deactivates the reverted topic while preserving history', async () => {
    const store = await tmpContextStore();
    // Seed the knowledge introduced by PR #421.
    await store.createVersion({
      topic: 'payment-external-identifier-reconciliation',
      category: 'BUSINESS_RULE',
      content: 'External identifiers may be used as a reconciliation key.',
      summary: 'External identifiers accepted for reconciliation.',
      changeType: 'CREATE',
      confidence: 1,
      evidence: [{ source: 'PR', reference: '#421' }],
      source: { number: 421, repository: 'acme/core', title: 'Allow external id reconciliation' },
      affectedDomains: ['payments'],
      reason: 'introduced',
    });

    // The model is unsure (NO_CHANGE) — deterministic revert reconciliation must still fire.
    const service = await buildService(store, makeProposal({ type: 'NO_CHANGE', confidence: 0 }));
    const revertPr = makeMergedPr({
      number: 450,
      title: 'Revert "Allow external id reconciliation"',
      body: 'Reverts #421',
      headRef: 'revert-421-feature/external-id',
      commits: [{ sha: 'r1', message: 'Revert "..."\n\nThis reverts commit c1.' }],
    });

    const outcome = await service.onMergedPR(revertPr);
    expect(outcome.revert?.isRevert).toBe(true);
    expect(outcome.status).toBe('AUTO_UPDATE');
    expect(outcome.entry?.changeType).toBe('REVERT');

    const history = await store.getHistory('payment-external-identifier-reconciliation');
    expect(history).toHaveLength(2);
    expect(history[0]?.status).toBe('REVERTED'); // original preserved as history
    expect(history[0]?.source.number).toBe(421);
    const current = await store.getCurrent('payment-external-identifier-reconciliation');
    expect(current?.changeType).toBe('REVERT');
    expect(current?.content).toMatch(/reverted|no longer/i);
  });
});

describe('ContextEvolutionService — approval', () => {
  it('approves a pending proposal into a new version, and can reject others', async () => {
    const store = await tmpContextStore();
    const service = await buildService(store, makeProposal({ confidence: 0.8 }));
    const outcome = await service.onMergedPR(makeMergedPr());
    expect(outcome.status).toBe('PENDING_REVIEW');

    const entry = await service.approveProposal(outcome.proposalRecordId!);
    expect(entry?.status).toBe('ACTIVE');
    expect((await store.getCurrent('payment-external-identifier-reconciliation'))?.id).toBe(entry?.id);

    // A second pending proposal can be rejected without changing context.
    const store2 = await tmpContextStore();
    const service2 = await buildService(store2, makeProposal({ confidence: 0.8 }));
    const o2 = await service2.onMergedPR(makeMergedPr());
    expect(await service2.rejectProposal(o2.proposalRecordId!)).toBe(true);
    expect(await store2.listCurrent()).toHaveLength(0);
  });
});
