/**
 * JSON Schemas describing the structured output we force the model to produce
 * via tool use. Keeping these as explicit JSON Schema (rather than deriving from
 * Zod) gives us tight control over the tool contract; the responses are still
 * validated against the Zod schemas in `domain/review.ts` after parsing.
 */

export const ANALYSIS_TOOL_NAME = 'submit_review';

export const ANALYSIS_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'One-paragraph summary of what the PR does and the overall risk.',
    },
    findings: {
      type: 'array',
      description: 'Actionable findings. Empty array is valid and preferred over weak findings.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', enum: ['business', 'technical'] },
          severity: { type: 'string', enum: ['BLOCKER', 'IMPORTANT', 'SUGGESTION'] },
          certainty: {
            type: 'string',
            enum: ['confirmed', 'likely', 'potential', 'insufficient-evidence'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['source', 'detail'],
            },
          },
          businessRule: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: [
          'category',
          'severity',
          'certainty',
          'confidence',
          'title',
          'problem',
          'evidence',
          'impact',
          'recommendation',
        ],
      },
    },
    positives: {
      type: 'array',
      description: 'Genuinely good things worth acknowledging (good tests, preserved invariants).',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'findings', 'positives'],
} as const;

export const VALIDATION_TOOL_NAME = 'submit_validation';

export const VALIDATION_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          findingId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['CONFIRMED', 'CONTRADICTED', 'UNCERTAIN'],
            description:
              'CONFIRMED = evidence supports the finding. CONTRADICTED = concrete evidence disproves it. UNCERTAIN = insufficient evidence. A finding is only rejected when status=CONTRADICTED.',
          },
          contradictionFound: {
            type: 'boolean',
            description: 'True ONLY if you found evidence that DIRECTLY contradicts the finding.',
          },
          contradictingEvidence: {
            type: 'string',
            description:
              'The concrete evidence that disproves the finding (quote the rule/code/test). Empty string if none — do NOT restate the violation here.',
          },
          adjustedConfidence: { type: 'number', minimum: 0, maximum: 1 },
          adjustedCertainty: {
            type: 'string',
            enum: ['confirmed', 'likely', 'potential', 'insufficient-evidence'],
          },
          reason: { type: 'string' },
        },
        required: [
          'findingId',
          'status',
          'contradictionFound',
          'contradictingEvidence',
          'adjustedConfidence',
          'adjustedCertainty',
          'reason',
        ],
      },
    },
  },
  required: ['decisions'],
} as const;
