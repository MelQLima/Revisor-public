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
import type { LLMProvider } from './llm-provider.js';
import { noChangeProposal } from './context-normalize.js';

/**
 * A fully scriptable LLM provider for deterministic unit tests. You supply the
 * exact candidate review and validation result (or functions computing them),
 * so pipeline behavior can be asserted without any network or model variance.
 */
export class StubLLMProvider implements LLMProvider {
  readonly name = 'stub';
  public calls = { generate: 0, validate: 0, propose: 0 };

  constructor(
    private readonly review: CandidateReview | ((input: ReviewInput) => CandidateReview),
    private readonly validation:
      | ValidationResult
      | ((input: ValidationInput) => ValidationResult) = { decisions: [] },
    /** Context-evolution output; defaults to NO_CHANGE. Throw to simulate LLM failure. */
    private readonly proposal?:
      | ContextChangeProposal
      | ((input: ContextEvolutionInput) => ContextChangeProposal),
  ) {}

  async proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal> {
    this.calls.propose += 1;
    if (typeof this.proposal === 'function') return this.proposal(input);
    return this.proposal ?? noChangeProposal(input.pullRequest, 'stub: no change');
  }

  async generateReview(input: ReviewInput): Promise<CandidateReview> {
    this.calls.generate += 1;
    return typeof this.review === 'function' ? this.review(input) : this.review;
  }

  async validateFindings(input: ValidationInput): Promise<ValidationResult> {
    this.calls.validate += 1;
    if (typeof this.validation === 'function') return this.validation(input);
    // Default: keep every candidate at its stated confidence.
    if (this.validation.decisions.length === 0 && input.candidateFindings.length > 0) {
      return {
        decisions: input.candidateFindings.map((f) => ({
          findingId: f.id,
          status: 'CONFIRMED' as const,
          contradictionFound: false,
          contradictingEvidence: '',
          keep: true,
          adjustedConfidence: f.confidence,
          adjustedCertainty: f.certainty,
          reason: 'stub: kept as-is',
        })),
      };
    }
    return this.validation;
  }
}
