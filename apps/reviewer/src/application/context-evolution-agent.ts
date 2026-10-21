import type { ContextProvider, ContextResult } from '../domain/context.js';
import type { PullRequest } from '../domain/pull-request.js';
import type { ContextStore } from '../domain/context-store.js';
import {
  type ContextChangeProposal,
  type ContextEntry,
  type ContextEvolutionInput,
  type RevertResult,
} from '../domain/context-evolution.js';
import { validateProposal } from '../domain/context-policy.js';
import type { LLMProvider } from '../integrations/llm/llm-provider.js';
import type { RevertDetector } from '../integrations/github/revert-detector.js';
import { noChangeProposal, sourceFromPr } from '../integrations/llm/context-normalize.js';
import { buildContextQuery } from '../context/query-builder.js';
import { tokenize } from '../context/tokenize.js';
import { ContextEvent, withCorrelation, type Logger } from '../infrastructure/logging/logger.js';

export interface ContextEvolutionAgentDeps {
  llm: LLMProvider;
  context: ContextProvider;
  store: ContextStore;
  revertDetector: RevertDetector;
  logger: Logger;
  contextMaxResults: number;
  /** Below this revert confidence, we do not apply deterministic revert semantics. */
  revertConfidenceThreshold: number;
}

export interface AnalysisResult {
  proposal: ContextChangeProposal;
  revert: RevertResult;
  /** True when the proposal was produced by deterministic revert reconciliation. */
  isRevertProposal: boolean;
}

const MAX_EXISTING_CONTEXT = 6;

/**
 * The Context Evolution Agent. Decides — for a single merged PR — whether the
 * system's context should change. Kept out of the webhook handler and the
 * persistence layer: it only *proposes*.
 */
export class ContextEvolutionAgent {
  constructor(private readonly deps: ContextEvolutionAgentDeps) {}

  async analyzeMergedPR(pr: PullRequest, correlationId: string): Promise<AnalysisResult> {
    const log = withCorrelation(this.deps.logger, correlationId);
    const revert = await this.deps.revertDetector.detectRevert(pr);
    if (revert.isRevert) {
      log.info(
        {
          event: ContextEvent.RevertDetected,
          pr: pr.number,
          originalPr: revert.originalPullRequestNumber,
          confidence: revert.confidence,
        },
        'Revert detected',
      );
    }

    log.info({ event: ContextEvent.ContextAnalysisStarted, pr: pr.number }, 'Context analysis started');

    // Retrieve reference docs + relevant existing context.
    const query = buildContextQuery(pr);
    const limit = this.deps.contextMaxResults;
    const [businessContext, architecture, guideline] = await Promise.all([
      this.deps.context.search(query, { kinds: ['business'], limit }),
      this.deps.context.search(query, { kinds: ['architecture'], limit }),
      this.deps.context.search(query, { kinds: ['guideline'], limit: 4 }),
    ]);
    const { existingContext, originalEntry } = await this.gatherExistingContext(query, revert);

    const input: ContextEvolutionInput = {
      correlationId,
      pullRequest: pr,
      existingContext,
      businessContext,
      technicalContext: [...architecture, ...guideline],
      ...(revert.isRevert ? { revert } : {}),
    };

    // Ask the model — falling back to NO_CHANGE if it throws or is invalid.
    let proposal: ContextChangeProposal;
    try {
      proposal = await this.deps.llm.proposeContextChange(input);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'LLM context proposal failed; defaulting to NO_CHANGE');
      proposal = noChangeProposal(pr, `llm error: ${(err as Error).message}`);
    }
    const validation = validateProposal(proposal);
    if (!validation.valid) {
      log.info({ reason: validation.reason }, 'Proposal failed validation; treating as NO_CHANGE');
      proposal = noChangeProposal(pr, `validation failed: ${validation.reason}`);
    }

    // Deterministic revert reconciliation: deactivate the reverted topic while
    // preserving history, even if the model was weak or unsure.
    if (
      revert.isRevert &&
      revert.confidence >= this.deps.revertConfidenceThreshold &&
      originalEntry
    ) {
      log.info(
        { event: ContextEvent.ContextAnalysisCompleted, pr: pr.number, revert: true, topic: originalEntry.topic },
        'Context analysis completed (revert reconciliation)',
      );
      return {
        proposal: this.buildRevertProposal(pr, originalEntry, revert, proposal),
        revert,
        isRevertProposal: true,
      };
    }

    log.info(
      { event: ContextEvent.ContextAnalysisCompleted, pr: pr.number, type: proposal.type, confidence: proposal.confidence },
      'Context analysis completed',
    );
    return { proposal, revert, isRevertProposal: false };
  }

  /** Existing current entries relevant to this PR (by keyword + by reverted PR). */
  private async gatherExistingContext(
    query: string,
    revert: RevertResult,
  ): Promise<{ existingContext: ContextEntry[]; originalEntry?: ContextEntry }> {
    const current = await this.deps.store.listCurrent();
    const originalEntry = revert.originalPullRequestNumber
      ? current.find((e) => e.source.number === revert.originalPullRequestNumber)
      : undefined;

    const queryTerms = new Set(tokenize(query));
    const scored = current
      .map((e) => {
        const terms = tokenize(`${e.topic} ${e.summary} ${e.content}`);
        const overlap = terms.filter((t) => queryTerms.has(t)).length;
        return { entry: e, overlap };
      })
      .filter((s) => s.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, MAX_EXISTING_CONTEXT)
      .map((s) => s.entry);

    const byId = new Map<string, ContextEntry>();
    if (originalEntry) byId.set(originalEntry.id, originalEntry);
    for (const e of scored) byId.set(e.id, e);
    return { existingContext: [...byId.values()], ...(originalEntry ? { originalEntry } : {}) };
  }

  /** A deterministic DEPRECATE proposal that records the revert with provenance. */
  private buildRevertProposal(
    pr: PullRequest,
    original: ContextEntry,
    revert: RevertResult,
    llmProposal: ContextChangeProposal,
  ): ContextChangeProposal {
    // Prefer the model's statement of the now-current behavior, if it gave one.
    const content =
      llmProposal.type !== 'NO_CHANGE' && llmProposal.proposedContent?.trim()
        ? llmProposal.proposedContent
        : `The behavior introduced for "${original.topic}" (PR #${original.source.number}) was reverted ` +
          `by PR #${pr.number} and is no longer in effect. Treat the pre-#${original.source.number} behavior as current.`;

    const evidence: ContextChangeProposal['evidence'] = [
      { source: 'PR', reference: `#${pr.number}`, detail: 'revert PR' },
      { source: 'PR', reference: `#${original.source.number}`, detail: 'reverted PR (introduced this topic)' },
      { source: 'HISTORY', reference: original.topic, detail: `context v${original.version}` },
      ...revert.evidence.map((e) => ({
        source: 'COMMIT' as const,
        reference: `#${pr.number}`,
        detail: `${e.signal}: ${e.detail}`,
      })),
    ];

    return {
      type: 'DEPRECATE',
      confidence: Math.max(revert.confidence, llmProposal.type !== 'NO_CHANGE' ? llmProposal.confidence : 0),
      topic: original.topic,
      category: original.category,
      summary: `Reverted: ${original.summary}`,
      proposedContent: content,
      evidence,
      sourcePullRequest: sourceFromPr(pr),
      affectedDomains: original.affectedDomains,
      reason: `PR #${pr.number} reverts PR #${original.source.number}; deactivating the introduced context while preserving history.`,
    };
  }
}

export type { ContextResult };
