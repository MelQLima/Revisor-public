import type { ReviewInput, ValidationInput } from '../domain/review-input.js';
import {
  formatCandidateFindings,
  formatContext,
  formatDiff,
  formatPullRequest,
  formatRelevantCode,
} from './context-formatter.js';
import {
  BUSINESS_REVIEW_INSTRUCTIONS,
  CONFIDENCE_GUIDANCE,
  TECHNICAL_REVIEW_INSTRUCTIONS,
} from './instructions.js';
import { REVIEW_POLICY } from './policy.js';
import { ANALYSIS_TOOL_NAME, VALIDATION_TOOL_NAME } from './output-schema.js';

/**
 * The prompt assembly layer. Each logical component (system prompt, policy,
 * business/technical instructions, context formatting, output contract) is a
 * separate piece composed here, so any part can evolve independently.
 */

export const SYSTEM_PROMPT = [
  `You are Revisor, a senior staff software engineer performing a business-aware
review of a GitHub Pull Request. You combine deep technical code analysis with
knowledge of the product's business rules and architecture.

Your distinguishing skill: catching code that is technically valid but violates a
business rule, domain constraint, architectural decision, or previously established
behavior. A generic "the diff looks fine" review is a failure.`,
  REVIEW_POLICY,
].join('\n\n');

export function buildAnalysisPrompt(input: ReviewInput): string {
  const pr = input.pullRequest;
  const changedFiles = pr.changedFiles.map((f) => f.filename).join(', ') || '(none)';
  return [
    `You are reviewing exactly ONE thing: the CHANGED CODE (DIFF) of PR #${pr.number} ("${pr.title}").`,
    `The ONLY files under review are: ${changedFiles}.`,
    'Everything under "RELEVANT CODE", "BUSINESS CONTEXT", "TECHNICAL CONTEXT" and',
    '"HISTORICAL CONTEXT" is REFERENCE MATERIAL — do NOT review it, do NOT report',
    'issues about it, and do NOT summarize it as if it were the change. It exists only',
    'to help you judge whether the DIFF is correct. Every finding MUST point at a line',
    'that appears in the DIFF (a `+` or `-` line) of one of the files listed above.',
    'Your summary must describe what the DIFF actually does — if you name a file or',
    'behavior that is not in the DIFF, you are hallucinating; re-read the DIFF.',
    '',
    BUSINESS_REVIEW_INSTRUCTIONS,
    '',
    TECHNICAL_REVIEW_INSTRUCTIONS,
    '',
    CONFIDENCE_GUIDANCE,
    '',
    '===== PR INFORMATION =====',
    formatPullRequest(pr),
    '',
    '===== CHANGED CODE (DIFF) — THIS IS WHAT YOU ARE REVIEWING =====',
    formatDiff(pr),
    '',
    '===== RELEVANT CODE (reference only — from repository HEAD) =====',
    formatRelevantCode(input.relevantCode),
    '',
    '===== BUSINESS CONTEXT (reference only — the rules to check the DIFF against) =====',
    formatContext('business_context', input.businessContext),
    '',
    '===== ARCHITECTURE / TECHNICAL CONTEXT (reference only) =====',
    formatContext('technical_context', input.technicalContext),
    '',
    '===== HISTORICAL CONTEXT (reference only) =====',
    formatContext('history_context', input.historyContext),
    '',
    `Now call the \`${ANALYSIS_TOOL_NAME}\` tool with your findings about the DIFF above.`,
    'Report only actionable, evidence-backed issues in the changed files. Check the DIFF',
    'against each BUSINESS CONTEXT rule: if the change removes or bypasses a documented',
    'guard/invariant, that is a business finding (cite the doc). If the DIFF is sound,',
    'return an empty findings array and note the positives.',
  ].join('\n');
}

export function buildValidationPrompt(input: ValidationInput): string {
  return [
    `You are the second-stage ADVERSARIAL VALIDATOR for the candidate findings on PR #${input.pullRequest.number}.`,
    'Your job is NOT to minimize findings. Your job is to try to DISPROVE each one.',
    'If you cannot disprove it, you PRESERVE it. The default is to keep the finding.',
    '',
    'For EACH candidate, classify `status` as exactly one of:',
    '- CONFIRMED    — the evidence supports the finding.',
    '- CONTRADICTED — you found concrete evidence that DIRECTLY disproves it.',
    '- UNCERTAIN    — the evidence is insufficient to decide.',
    '',
    'DECISION RULE (a finding is dropped ONLY when status=CONTRADICTED):',
    '- CONFIRMED  -> keep.',
    '- UNCERTAIN  -> keep (uncertainty is NOT a rejection).',
    '- CONTRADICTED -> requires `contradictionFound=true` AND concrete',
    '  `contradictingEvidence`: a rule/exception/test/code path proving the',
    "  finding's premise is FALSE. A vague alternative interpretation is not enough.",
    '',
    'CRITICAL — do not confuse CONFIRM with CONTRADICT. If your reasoning is',
    '"the code does X, which is NOT allowed by rule Y", that CONFIRMS the finding',
    '(status=CONFIRMED) — it does NOT contradict it. Never put a restatement of the',
    'violation into `contradictingEvidence`; leave it EMPTY when you have no',
    'evidence that the finding is wrong.',
    '',
    'ASYMMETRIC ERROR POLICY: for findings touching money, payments, refunds,',
    'credit, cash-out, authorization, or irreversible external effects, it is far',
    'safer to escalate a questionable finding to a human than to approve a real',
    'violation. When in doubt on these, use UNCERTAIN (keep) — never CONTRADICTED.',
    '',
    'Before EVERY CONTRADICTED verdict, self-check: "Does my evidence demonstrate',
    'the finding is FALSE, or does it merely restate the problem?" If the latter,',
    'the correct status is CONFIRMED, not CONTRADICTED.',
    '',
    'When you keep a finding, set adjustedConfidence/adjustedCertainty to what the',
    'evidence genuinely supports.',
    '',
    '===== PR INFORMATION =====',
    formatPullRequest(input.pullRequest),
    '',
    '===== CHANGED CODE (DIFF) =====',
    formatDiff(input.pullRequest),
    '',
    '===== RELEVANT CODE =====',
    formatRelevantCode(input.relevantCode),
    '',
    '===== BUSINESS CONTEXT =====',
    formatContext('business_context', input.businessContext),
    '',
    '===== TECHNICAL CONTEXT =====',
    formatContext('technical_context', input.technicalContext),
    '',
    '===== HISTORICAL CONTEXT =====',
    formatContext('history_context', input.historyContext),
    '',
    '===== CANDIDATE FINDINGS TO VALIDATE =====',
    formatCandidateFindings(input.candidateFindings),
    '',
    `Now call the \`${VALIDATION_TOOL_NAME}\` tool with one decision per candidate finding,`,
    'each carrying status, contradictionFound, and contradictingEvidence.',
  ].join('\n');
}
