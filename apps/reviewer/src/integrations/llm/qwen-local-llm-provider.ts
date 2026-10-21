import type { Logger } from '../../infrastructure/logging/logger.js';
import { ReviewEvent } from '../../infrastructure/logging/logger.js';
import type {
  ReviewInput,
  ValidationInput,
  ValidationResult,
} from '../../domain/review-input.js';
import { type CandidateReview, CandidateReviewSchema } from '../../domain/review.js';
import {
  ANALYSIS_TOOL_SCHEMA,
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
  CONTEXT_PROPOSAL_TOOL_SCHEMA,
  buildContextEvolutionPrompt,
} from '../../prompts/context-evolution-prompt.js';
import type { LLMProvider } from './llm-provider.js';
import { assignFindingIds, coerceValidation } from './normalize.js';
import { toProposal } from './context-normalize.js';
import { extractJsonObject } from './json-extract.js';

/**
 * Local, self-hosted reviewer — the PRIMARY provider.
 *
 * Talks to any OpenAI-compatible chat endpoint (default: Ollama at
 * http://localhost:11434/v1) running Qwen3-Coder. Unlike the Anthropic path,
 * local models don't reliably support forced tool-calls, so structured output
 * is driven by `response_format: json_object` + a strict schema instruction in
 * the prompt, then validated against the SAME domain Zod schemas. Nothing else
 * in the codebase knows which model produced the review.
 */

/** Minimal fetch contract so tests can inject a fake transport. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponse>;

export interface QwenLocalLLMOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** Local models accept sampling params; defaults to 0 for deterministic reviews. */
  temperature?: number;
  /** Optional bearer token (some servers require a placeholder like "ollama"). */
  apiKey?: string;
  /** Send response_format json_object (Ollama/vLLM/LM Studio support it). */
  jsonMode?: boolean;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchFn;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** Warn once above this estimate; Ollama's default context (~2-4K) truncates here. */
const LARGE_PROMPT_TOKENS = 3500;

export class QwenLocalLLMProvider implements LLMProvider {
  readonly name = 'qwen-local';
  private readonly fetchFn: FetchFn;
  private warnedLargePrompt = false;

  constructor(private readonly options: QwenLocalLLMOptions) {
    this.fetchFn =
      options.fetchFn ??
      ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
  }

  async generateReview(input: ReviewInput): Promise<CandidateReview> {
    const log = this.options.logger;
    log.info({ event: ReviewEvent.LlmRequestStarted, model: this.options.model, pass: 'analysis' });

    const content = await this.chat(
      buildAnalysisPrompt(input),
      ANALYSIS_TOOL_SCHEMA,
    );
    const raw = (typeof content === 'object' && content !== null ? content : {}) as Record<
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

    log.info({
      event: ReviewEvent.ValidationStarted,
      model: this.options.model,
      candidates: input.candidateFindings.length,
    });
    const content = await this.chat(
      buildValidationPrompt(input),
      VALIDATION_TOOL_SCHEMA,
    );
    const result = coerceValidation(content);
    log.info({ event: ReviewEvent.ValidationCompleted, decisions: result.decisions.length });
    return result;
  }

  async proposeContextChange(input: ContextEvolutionInput): Promise<ContextChangeProposal> {
    const content = await this.chat(
      buildContextEvolutionPrompt(input),
      CONTEXT_PROPOSAL_TOOL_SCHEMA,
      CONTEXT_EVOLUTION_SYSTEM_PROMPT,
    );
    return toProposal(content, input.pullRequest);
  }

  /** POST one chat completion, then extract + return the parsed JSON object. */
  private async chat(
    prompt: string,
    schema: unknown,
    systemPrompt: string = SYSTEM_PROMPT,
  ): Promise<unknown> {
    const instruction = [
      'OUTPUT FORMAT (STRICT): respond with a SINGLE JSON object and nothing else —',
      'no markdown, no code fences, no commentary before or after. The object MUST',
      'conform to this JSON Schema:',
      JSON.stringify(schema),
    ].join('\n');

    const userContent = `${prompt}\n\n${instruction}`;
    // ~3.7 chars/token is a rough heuristic; enough to catch context-truncation risk.
    const estTokens = Math.round((systemPrompt.length + userContent.length) / 3.7);
    if (estTokens > LARGE_PROMPT_TOKENS && !this.warnedLargePrompt) {
      this.warnedLargePrompt = true;
      this.options.logger.warn(
        { estPromptTokens: estTokens },
        `Prompt is ~${estTokens} tokens. Ensure your local server's context window exceeds this ` +
          '(for Ollama: OLLAMA_CONTEXT_LENGTH=16384) — otherwise the prompt is truncated and the diff is dropped.',
      );
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxTokens,
      temperature: this.options.temperature ?? 0,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    };
    if (this.options.jsonMode !== false) {
      body.response_format = { type: 'json_object' };
    }

    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let response: HttpResponse;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(
        `Could not reach the local model at ${url} (${msg}). ` +
          `Is your server running? For Ollama: \`ollama serve\` and \`ollama pull ${this.options.model}\`.`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Local model HTTP ${response.status} from ${url}: ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    return extractJsonObject(content);
  }
}
