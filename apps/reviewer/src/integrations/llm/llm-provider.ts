import type {
  ReviewInput,
  ValidationInput,
  ValidationResult,
} from '../../domain/review-input.js';
import type { CandidateReview } from '../../domain/review.js';
import type {
  ContextChangeProposal,
  ContextEvolutionInput,
} from '../../domain/context-evolution.js';

/**
 * LLM abstraction. The domain logic depends only on this interface, never on
 * the Anthropic SDK, so the model vendor can be swapped without a rewrite.
 *
 * Methods:
 *   - generateReview: review analysis pass -> candidate findings
 *   - validateFindings: adversarial pass -> keep/drop + confidence adjustment
 *   - proposeContextChange: context-evolution pass on a merged PR -> proposal
 */
export interface LLMProvider {
  readonly name: string;

  /** Analysis pass. Produces candidate findings (business + technical). */
  generateReview(input: ReviewInput): Promise<CandidateReview>;

  /**
   * Validation pass. Independently checks each candidate finding against the
   * evidence and returns keep/drop decisions with adjusted confidence.
   */
  validateFindings(input: ValidationInput): Promise<ValidationResult>;

  /**
   * Analyze a merged/reverted PR and propose whether the system's context
   * should change. Defaults to NO_CHANGE; provenance is injected by the
   * provider (the model never authors it).
   */
  proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal>;
}
