import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { ReviewEvent } from '../../infrastructure/logging/logger.js';
import type {
  ReviewInput,
  ValidationInput,
  ValidationResult,
} from '../../domain/review-input.js';
import { type CandidateReview, CandidateReviewSchema } from '../../domain/review.js';
import {
  ANALYSIS_TOOL_NAME,
  ANALYSIS_TOOL_SCHEMA,
  VALIDATION_TOOL_NAME,
  VALIDATION_TOOL_SCHEMA,
} from '../../prompts/output-schema.js';
import {
  SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildValidationPrompt,
} from '../../prompts/prompt-builder.js';
import type {
  ContextChangeProposal,
  ContextEvolutionInput,
} from '../../domain/context-evolution.js';
import {
  CONTEXT_EVOLUTION_SYSTEM_PROMPT,
  CONTEXT_PROPOSAL_TOOL_NAME,
  CONTEXT_PROPOSAL_TOOL_SCHEMA,
  buildContextEvolutionPrompt,
} from '../../prompts/context-evolution-prompt.js';
import type { LLMProvider } from './llm-provider.js';
import { assignFindingIds, coerceValidation } from './normalize.js';
import { toProposal } from './context-normalize.js';

export interface ClaudeLLMOptions {
  apiKey: string;
  model: string;
  validationModel: string;
  maxTokens: number;
  /** Omitted from the request when undefined — current models reject sampling params. */
  temperature?: number;
  logger: Logger;
  /** Injectable for tests. */
  client?: Anthropic;
}

/**
 * Claude-backed reviewer. Uses tool-use to force structured JSON output, then
 * validates it against the domain Zod schemas. The Anthropic SDK is confined to
 * this file — nothing else in the codebase imports it.
 */
export class ClaudeLLMProvider implements LLMProvider {
  readonly name = 'claude';
  private readonly client: Anthropic;

  constructor(private readonly options: ClaudeLLMOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async generateReview(input: ReviewInput): Promise<CandidateReview> {
    const log = this.options.logger;
    const prompt = buildAnalysisPrompt(input);
    log.info({ event: ReviewEvent.LlmRequestStarted, model: this.options.model, pass: 'analysis' });

    const toolInput = await this.callTool(
      this.options.model,
      prompt,
      ANALYSIS_TOOL_NAME,
      ANALYSIS_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema,
    );

    const raw = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<
      string,
      unknown
    >;
    const parsed = CandidateReviewSchema.parse({
      ...raw,
      findings: assignFindingIds(Array.isArray(raw.findings) ? raw.findings : [], input.correlationId),
    });
    log.info({
      event: ReviewEvent.LlmRequestCompleted,
      pass: 'analysis',
      findings: parsed.findings.length,
    });
    return parsed;
  }

  async validateFindings(input: ValidationInput): Promise<ValidationResult> {
    const log = this.options.logger;
    if (input.candidateFindings.length === 0) return { decisions: [] };

    const prompt = buildValidationPrompt(input);
    log.info({
      event: ReviewEvent.ValidationStarted,
      model: this.options.validationModel,
      candidates: input.candidateFindings.length,
    });

    const toolInput = await this.callTool(
      this.options.validationModel,
      prompt,
      VALIDATION_TOOL_NAME,
      VALIDATION_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema,
    );

    const result = coerceValidation(toolInput);
    log.info({ event: ReviewEvent.ValidationCompleted, decisions: result.decisions.length });
    return result;
  }

  async proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal> {
    const toolInput = await this.callTool(
      this.options.model,
      buildContextEvolutionPrompt(input),
      CONTEXT_PROPOSAL_TOOL_NAME,
      CONTEXT_PROPOSAL_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      CONTEXT_EVOLUTION_SYSTEM_PROMPT,
    );
    return toProposal(toolInput, input.pullRequest);
  }

  private async callTool(
    model: string,
    prompt: string,
    toolName: string,
    schema: Anthropic.Tool.InputSchema,
    systemPrompt: string = SYSTEM_PROMPT,
  ): Promise<unknown> {
    const response = await this.client.messages.create({
      model,
      max_tokens: this.options.maxTokens,
      // Only sent when explicitly configured; current Opus/Sonnet models reject it.
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      system: systemPrompt,
      tools: [{ name: toolName, description: `Return the structured result.`, input_schema: schema }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === toolName,
    );
    if (!toolUse) {
      throw new Error(`Claude did not return a '${toolName}' tool call`);
    }
    return toolUse.input;
  }
}
