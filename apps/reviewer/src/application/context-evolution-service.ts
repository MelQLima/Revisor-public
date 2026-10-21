import type { PullRequest } from '../domain/pull-request.js';
import type { ContextStore } from '../domain/context-store.js';
import {
  type ContextChangeProposal,
  type ContextEntry,
  type ContextEntryChangeType,
  type ContextEvolutionOutcome,
} from '../domain/context-evolution.js';
import {
  type ContextPolicyConfig,
  decideStatus,
  idempotencyKey,
} from '../domain/context-policy.js';
import { newCorrelationId } from '../infrastructure/ids.js';
import { ContextEvent, withCorrelation, type Logger } from '../infrastructure/logging/logger.js';
import type { AnalysisResult, ContextEvolutionAgent } from './context-evolution-agent.js';

export interface ContextEvolutionServiceDeps {
  agent: ContextEvolutionAgent;
  store: ContextStore;
  policy: ContextPolicyConfig;
  logger: Logger;
}

export interface OnMergedOptions {
  correlationId?: string;
}

/**
 * Orchestrates context evolution for a merged/reverted PR:
 *   idempotency guard → agent analysis → threshold decision → persist.
 *
 * It never throws into the webhook path: a merge must not fail because context
 * evolution did. The webhook acks first, then calls this asynchronously.
 */
export class ContextEvolutionService {
  constructor(private readonly deps: ContextEvolutionServiceDeps) {}

  async onMergedPR(pr: PullRequest, options: OnMergedOptions = {}): Promise<ContextEvolutionOutcome> {
    const correlationId = options.correlationId ?? newCorrelationId();
    const log = withCorrelation(this.deps.logger, correlationId);
    const repository = `${pr.repo.owner}/${pr.repo.name}`;

    log.info(
      { event: ContextEvent.ContextEvolutionStarted, repository, pr: pr.number },
      'Context evolution started',
    );
    log.info(
      { event: ContextEvent.MergedPrDetected, repository, pr: pr.number, mergeCommitSha: pr.mergeCommitSha },
      'Merged PR detected',
    );

    const key = idempotencyKey({
      repository,
      pullNumber: pr.number,
      mergeCommitSha: pr.mergeCommitSha,
      eventType: 'merged',
    });

    // Idempotency: a redelivered event is a no-op.
    const existing = await this.deps.store.findByIdempotencyKey(key);
    if (existing) {
      log.info(
        { event: ContextEvent.ContextEventDuplicate, pr: pr.number, key },
        'Duplicate context evolution event ignored',
      );
      return {
        correlationId,
        idempotent: true,
        status: existing.status,
        proposal: existing.proposal,
        decisionReason: `duplicate: ${existing.decisionReason}`,
        proposalRecordId: existing.id,
      };
    }

    let analysis: AnalysisResult;
    try {
      analysis = await this.deps.agent.analyzeMergedPR(pr, correlationId);
    } catch (err) {
      // Analysis failure must not crash the flow; log and record nothing.
      log.error(
        { event: ContextEvent.ContextUpdateFailed, pr: pr.number, err: (err as Error).message },
        'Context evolution failed',
      );
      throw err;
    }

    const { proposal, revert, isRevertProposal } = analysis;
    const decision = decideStatus(proposal, this.deps.policy);

    // NO_CHANGE / below-threshold: record a REJECTED proposal (audit + idempotency).
    if (decision.status === 'REJECTED') {
      const record = await this.deps.store.proposeChange(proposal, 'REJECTED', key, decision.reason);
      log.info(
        {
          event: ContextEvent.ContextUpdateRejected,
          pr: pr.number,
          type: proposal.type,
          confidence: proposal.confidence,
          reason: decision.reason,
        },
        'No context change',
      );
      return {
        correlationId,
        idempotent: false,
        status: 'REJECTED',
        proposal,
        ...(revert.isRevert ? { revert } : {}),
        decisionReason: decision.reason,
        proposalRecordId: record.id,
      };
    }

    // AUTO_UPDATE: apply immediately (a new version), then record the proposal.
    if (decision.status === 'AUTO_UPDATE') {
      const entry = await this.applyProposal(proposal, isRevertProposal);
      const record = await this.deps.store.proposeChange(
        proposal,
        'AUTO_UPDATE',
        key,
        decision.reason,
        entry.id,
      );
      log.info(
        {
          event: ContextEvent.ContextProposalCreated,
          pr: pr.number,
          topic: proposal.topic,
          type: proposal.type,
          confidence: proposal.confidence,
        },
        'Context proposal created',
      );
      log.info(
        {
          event: ContextEvent.ContextUpdateApplied,
          pr: pr.number,
          topic: entry.topic,
          version: entry.version,
          changeType: entry.changeType,
        },
        'Context update applied',
      );
      return {
        correlationId,
        idempotent: false,
        status: 'AUTO_UPDATE',
        proposal,
        ...(revert.isRevert ? { revert } : {}),
        entry,
        decisionReason: decision.reason,
        proposalRecordId: record.id,
      };
    }

    // PENDING_REVIEW: record without changing current context.
    const record = await this.deps.store.proposeChange(proposal, 'PENDING_REVIEW', key, decision.reason);
    log.info(
      {
        event: ContextEvent.ContextProposalCreated,
        pr: pr.number,
        topic: proposal.topic,
        type: proposal.type,
        confidence: proposal.confidence,
      },
      'Context proposal created',
    );
    log.info(
      { event: ContextEvent.ContextUpdatePending, pr: pr.number, topic: proposal.topic, reason: decision.reason },
      'Context update pending review',
    );
    return {
      correlationId,
      idempotent: false,
      status: 'PENDING_REVIEW',
      proposal,
      ...(revert.isRevert ? { revert } : {}),
      decisionReason: decision.reason,
      proposalRecordId: record.id,
    };
  }

  /** Approve a PENDING_REVIEW proposal — applies it as a new context version. */
  async approveProposal(recordId: string): Promise<ContextEntry | null> {
    const record = await this.deps.store.getProposal(recordId);
    if (!record || record.status !== 'PENDING_REVIEW') return null;
    const isRevertProposal = record.proposal.type === 'DEPRECATE';
    const entry = await this.applyProposal(record.proposal, isRevertProposal);
    await this.deps.store.updateProposalStatus(recordId, 'AUTO_UPDATE', entry.id);
    return entry;
  }

  /** Reject a PENDING_REVIEW proposal without changing context. */
  async rejectProposal(recordId: string): Promise<boolean> {
    const record = await this.deps.store.getProposal(recordId);
    if (!record || record.status !== 'PENDING_REVIEW') return false;
    await this.deps.store.updateProposalStatus(recordId, 'REJECTED');
    return true;
  }

  private async applyProposal(
    proposal: ContextChangeProposal,
    isRevertProposal: boolean,
  ): Promise<ContextEntry> {
    const changeType: ContextEntryChangeType =
      isRevertProposal && proposal.type === 'DEPRECATE'
        ? 'REVERT'
        : (proposal.type as Exclude<ContextChangeProposal['type'], 'NO_CHANGE'>);
    return this.deps.store.createVersion({
      topic: proposal.topic,
      category: proposal.category,
      content: proposal.proposedContent ?? '',
      summary: proposal.summary,
      changeType,
      confidence: proposal.confidence,
      evidence: proposal.evidence,
      source: proposal.sourcePullRequest,
      affectedDomains: proposal.affectedDomains,
      reason: proposal.reason,
    });
  }
}
