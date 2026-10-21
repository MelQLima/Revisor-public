import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextProvider } from '../src/domain/context.js';
import type { ContextChangeProposal } from '../src/domain/context-evolution.js';
import { DEFAULT_CONTEXT_POLICY } from '../src/domain/context-policy.js';
import { ContextEvolutionAgent } from '../src/application/context-evolution-agent.js';
import { ContextEvolutionService } from '../src/application/context-evolution-service.js';
import { loadContextFixture, seedContextStore } from '../src/application/context-fixture.js';
import { HeuristicRevertDetector } from '../src/integrations/github/revert-detector.js';
import { StubLLMProvider } from '../src/integrations/llm/stub-llm-provider.js';
import { sourceFromPr } from '../src/integrations/llm/context-normalize.js';
import { makeProposal, testLogger, tmpContextStore } from './helpers.js';

const fixture = (name: string) => resolve('fixtures/context', name);
const emptyReview = { summary: '', findings: [], positives: [] };
const fakeContext: ContextProvider = { name: 'fake', async search() { return []; } };

async function serviceWith(
  store: Awaited<ReturnType<typeof tmpContextStore>>,
  proposal: ContextChangeProposal | ((...a: unknown[]) => ContextChangeProposal),
) {
  const agent = new ContextEvolutionAgent({
    llm: new StubLLMProvider(emptyReview, { decisions: [] }, proposal as ContextChangeProposal),
    context: fakeContext,
    store,
    revertDetector: new HeuristicRevertDetector(),
    logger: testLogger(),
    contextMaxResults: 8,
    revertConfidenceThreshold: 0.6,
  });
  return new ContextEvolutionService({ agent, store, policy: DEFAULT_CONTEXT_POLICY, logger: testLogger() });
}

describe('context fixtures (offline)', () => {
  it('merged-pr.json → applies a business context change', async () => {
    const fx = await loadContextFixture(fixture('merged-pr.json'));
    const store = await tmpContextStore();
    const service = await serviceWith(store, (i) =>
      makeProposal({ sourcePullRequest: sourceFromPr((i as { pullRequest: never }).pullRequest) }),
    );
    const outcome = await service.onMergedPR(fx.pullRequest);
    expect(outcome.status).toBe('AUTO_UPDATE');
    expect((await store.listCurrent()).length).toBe(1);
  });

  it('technical-only-pr.json → NO_CONTEXT_CHANGE', async () => {
    const fx = await loadContextFixture(fixture('technical-only-pr.json'));
    const store = await tmpContextStore();
    const service = await serviceWith(store, makeProposal({ type: 'NO_CHANGE', confidence: 0 }));
    const outcome = await service.onMergedPR(fx.pullRequest);
    expect(outcome.status).toBe('REJECTED');
    expect(await store.listCurrent()).toHaveLength(0);
  });

  it('reverted-pr.json → deactivates prior context, preserves history', async () => {
    const fx = await loadContextFixture(fixture('reverted-pr.json'));
    const store = await tmpContextStore();
    await seedContextStore(store, fx); // seed the #421 knowledge
    // Model unsure; deterministic revert reconciliation drives the change.
    const service = await serviceWith(store, makeProposal({ type: 'NO_CHANGE', confidence: 0 }));
    const outcome = await service.onMergedPR(fx.pullRequest);
    expect(outcome.revert?.isRevert).toBe(true);
    expect(outcome.revert?.originalPullRequestNumber).toBe(421);
    expect(outcome.status).toBe('AUTO_UPDATE');
    const history = await store.getHistory('payment-external-identifier-reconciliation');
    expect(history.map((h) => h.status)).toContain('REVERTED');
    expect((await store.getCurrent('payment-external-identifier-reconciliation'))?.changeType).toBe('REVERT');
  });

  it('ambiguous-revert.json → not treated as a revert; no fabricated original PR', async () => {
    const fx = await loadContextFixture(fixture('ambiguous-revert.json'));
    const store = await tmpContextStore();
    const service = await serviceWith(store, makeProposal({ type: 'NO_CHANGE', confidence: 0 }));
    const outcome = await service.onMergedPR(fx.pullRequest);
    expect(outcome.revert?.isRevert ?? false).toBe(false);
    expect(outcome.status).toBe('REJECTED');
  });
});
