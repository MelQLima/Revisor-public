import type { AppConfig } from '../infrastructure/config/config.js';
import type { Logger } from '../infrastructure/logging/logger.js';
import { DocumentContextProvider } from '../context/document-context-provider.js';
import {
  CompositeContextProvider,
  ContextStoreContextProvider,
} from '../context/context-store-provider.js';
import type { ContextProvider } from '../domain/context.js';
import type { ContextStore } from '../domain/context-store.js';
import type { ContextPolicyConfig } from '../domain/context-policy.js';
import type { PolicyConfig } from '../domain/policy.js';
import type { LLMProvider } from '../integrations/llm/llm-provider.js';
import { ClaudeLLMProvider } from '../integrations/llm/claude-llm-provider.js';
import { HeuristicLLMProvider } from '../integrations/llm/heuristic-llm-provider.js';
import { QwenLocalLLMProvider } from '../integrations/llm/qwen-local-llm-provider.js';
import { NullHistoryProvider, type HistoryProvider } from '../integrations/history/history-provider.js';
import { FileContextStore } from '../infrastructure/context-store/file-context-store.js';
import { HeuristicRevertDetector } from '../integrations/github/revert-detector.js';
import { ContextEvolutionAgent } from './context-evolution-agent.js';
import { ContextEvolutionService } from './context-evolution-service.js';

/** A ContextProvider that also supports eager index loading. */
export type LoadableContextProvider = ContextProvider & { load(): Promise<void> };

/**
 * Composition helpers — translate validated config into concrete providers.
 * Kept separate from the pipeline so wiring choices (which LLM, which store)
 * live in one place and both the CLI and HTTP server share them.
 */

export function createContextProvider(config: AppConfig): DocumentContextProvider {
  return new DocumentContextProvider(config.context.docsDir);
}

export function createContextStore(config: AppConfig): ContextStore {
  return new FileContextStore(config.contextEvolution.storePath);
}

export function toContextPolicy(config: AppConfig): ContextPolicyConfig {
  return {
    autoUpdateThreshold: config.contextEvolution.autoUpdateThreshold,
    proposalThreshold: config.contextEvolution.proposalThreshold,
    reviewRequiredCategories: config.contextEvolution.reviewRequiredCategories,
  };
}

/**
 * The context provider used for REVIEWS. When context evolution is enabled it
 * composes the docs provider with the evolving store, so reviews retrieve
 * knowledge learned from previously-merged PRs. Docs-only otherwise.
 */
export function createReviewContextProvider(
  config: AppConfig,
  store?: ContextStore,
): LoadableContextProvider {
  const docs = new DocumentContextProvider(config.context.docsDir);
  if (config.contextEvolution.enabled && store) {
    return new CompositeContextProvider([docs, new ContextStoreContextProvider(store)]);
  }
  return docs;
}

/**
 * Assemble the Context Evolution service (store + agent + revert detector).
 * The agent retrieves reference docs from the docs provider only; the store's
 * own entries are surfaced separately as `existingContext`.
 */
export function createContextEvolutionService(
  config: AppConfig,
  logger: Logger,
  store: ContextStore = createContextStore(config),
): { service: ContextEvolutionService; store: ContextStore } {
  const agent = new ContextEvolutionAgent({
    llm: createLLMProvider(config, logger),
    context: createContextProvider(config),
    store,
    revertDetector: new HeuristicRevertDetector(),
    logger,
    contextMaxResults: config.context.maxResults,
    revertConfidenceThreshold: config.contextEvolution.revertConfidenceThreshold,
  });
  const service = new ContextEvolutionService({
    agent,
    store,
    policy: toContextPolicy(config),
    logger,
  });
  return { service, store };
}

export function createHistoryProvider(_config: AppConfig): HistoryProvider {
  // MVP: no history backend wired yet. Swap for a git/PR-backed provider later.
  return new NullHistoryProvider();
}

/**
 * Choose the LLM provider based on LLM_PROVIDER.
 *   - `qwen` (default): local Qwen3-Coder via an OpenAI-compatible server.
 *   - `claude`: Anthropic (falls back to heuristic + warning if no API key).
 *   - `heuristic`: offline rule-based reviewer (no model, no network).
 */
export function createLLMProvider(config: AppConfig, logger: Logger): LLMProvider {
  switch (config.llm.provider) {
    case 'heuristic':
      logger.warn('LLM_PROVIDER=heuristic — using the offline rule-based reviewer (not a real AI review)');
      return new HeuristicLLMProvider();

    case 'claude': {
      if (!config.llm.anthropic.apiKey) {
        logger.warn('LLM_PROVIDER=claude but ANTHROPIC_API_KEY is not set — falling back to the offline heuristic reviewer');
        return new HeuristicLLMProvider();
      }
      return new ClaudeLLMProvider({
        apiKey: config.llm.anthropic.apiKey,
        model: config.llm.anthropic.model,
        validationModel: config.llm.anthropic.validationModel,
        maxTokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
        logger,
      });
    }

    case 'qwen':
    default:
      logger.info(
        { model: config.llm.local.model, baseUrl: config.llm.local.baseUrl },
        'Using local Qwen3-Coder reviewer',
      );
      return new QwenLocalLLMProvider({
        baseUrl: config.llm.local.baseUrl,
        model: config.llm.local.model,
        apiKey: config.llm.local.apiKey,
        maxTokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
        logger,
      });
  }
}

export function toPolicyConfig(config: AppConfig): PolicyConfig {
  return {
    minConfidence: config.policy.minConfidence,
    blockingConfidence: config.policy.blockingConfidence,
    maxFindings: config.policy.maxFindings,
    dryRun: config.policy.dryRun,
  };
}

export type { ContextProvider };
