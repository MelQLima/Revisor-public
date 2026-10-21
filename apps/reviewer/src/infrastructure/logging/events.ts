/**
 * Reviewer + context-evolution lifecycle event vocabulary.
 *
 * These names are reviewer-domain concepts, so they live in the app — the
 * shared `@triple-r/observability` package stays domain-agnostic. Other Triple R
 * agents define their own event vocabularies alongside their own logging facade.
 */

/** Canonical review lifecycle events (used for consistent structured logging). */
export const ReviewEvent = {
  ReviewStarted: 'review_started',
  ContextRetrieved: 'context_retrieved',
  LlmRequestStarted: 'llm_request_started',
  LlmRequestCompleted: 'llm_request_completed',
  ValidationStarted: 'validation_started',
  ValidationCompleted: 'validation_completed',
  FindingGenerated: 'finding_generated',
  FindingRejected: 'finding_rejected',
  ReviewCompleted: 'review_completed',
  GithubCommentCreated: 'github_comment_created',
  ReviewFailed: 'review_failed',
} as const;

/** Canonical context-evolution lifecycle events. */
export const ContextEvent = {
  ContextEvolutionStarted: 'context_evolution_started',
  MergedPrDetected: 'merged_pr_detected',
  RevertDetected: 'revert_detected',
  ContextAnalysisStarted: 'context_analysis_started',
  ContextAnalysisCompleted: 'context_analysis_completed',
  ContextProposalCreated: 'context_proposal_created',
  ContextUpdateApplied: 'context_update_applied',
  ContextUpdatePending: 'context_update_pending',
  ContextUpdateRejected: 'context_update_rejected',
  ContextUpdateFailed: 'context_update_failed',
  ContextEventDuplicate: 'context_event_duplicate',
} as const;
