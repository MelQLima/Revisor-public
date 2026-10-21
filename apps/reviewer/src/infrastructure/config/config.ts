import 'dotenv/config';
import { z } from 'zod';
import { ContextCategorySchema, type ContextCategory } from '../../domain/context-evolution.js';

/**
 * Environment configuration, validated once at startup. Secrets are read here
 * and NEVER logged. Everything downstream receives a typed, validated object.
 */

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Which reviewer to use. `qwen` = local Qwen3-Coder (default, primary),
  // `claude` = Anthropic, `heuristic` = offline rule-based (no model).
  LLM_PROVIDER: z.enum(['qwen', 'claude', 'heuristic']).default('qwen'),

  // ---- Local Qwen3-Coder (OpenAI-compatible; Ollama by default) --------------
  // 127.0.0.1 (not localhost): Node 18's fetch resolves localhost to IPv6 ::1,
  // but Ollama listens on IPv4 only, which would fail with "fetch failed".
  QWEN_BASE_URL: z.string().default('http://127.0.0.1:11434/v1'),
  QWEN_MODEL: z.string().default('qwen3-coder'),
  QWEN_API_KEY: z.string().optional(),

  // ---- Anthropic (alternative provider) --------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-4-8'),
  LLM_VALIDATION_MODEL: z.string().optional(),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  // Sampling params are rejected (400) by current Opus/Sonnet models, so this
  // is unset by default and only sent when explicitly configured. Local models
  // accept it; the Qwen provider defaults it to 0 for deterministic reviews.
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_ALLOWED_REPOS: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  REVIEW_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  REVIEW_BLOCKING_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  REVIEW_MAX_FINDINGS: z.coerce.number().int().positive().default(15),
  REVIEW_DRY_RUN: booleanish.default('false'),

  CONTEXT_DOCS_DIR: z.string().default('docs/ai'),
  CONTEXT_MAX_RESULTS: z.coerce.number().int().positive().default(12),

  // ---- Context Evolution -----------------------------------------------------
  CONTEXT_EVOLUTION_ENABLED: booleanish.default('true'),
  CONTEXT_STORE_PATH: z.string().default('data/context-store.json'),
  CONTEXT_AUTO_UPDATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  CONTEXT_PROPOSAL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  CONTEXT_REVERT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  // Comma-separated categories that always require human review (safeguard).
  CONTEXT_REVIEW_REQUIRED_CATEGORIES: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  port: number;
  llm: {
    provider: 'qwen' | 'claude' | 'heuristic';
    maxTokens: number;
    temperature?: number;
    /** Local Qwen3-Coder (OpenAI-compatible). */
    local: {
      baseUrl: string;
      model: string;
      apiKey?: string;
    };
    /** Anthropic. */
    anthropic: {
      apiKey?: string;
      model: string;
      validationModel: string;
    };
  };
  github: {
    token?: string;
    allowedRepos: string[];
    webhookSecret?: string;
  };
  policy: {
    minConfidence: number;
    blockingConfidence: number;
    maxFindings: number;
    dryRun: boolean;
  };
  context: {
    docsDir: string;
    maxResults: number;
  };
  contextEvolution: {
    enabled: boolean;
    storePath: string;
    autoUpdateThreshold: number;
    proposalThreshold: number;
    revertConfidenceThreshold: number;
    reviewRequiredCategories: ContextCategory[];
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    llm: {
      provider: env.LLM_PROVIDER,
      maxTokens: env.LLM_MAX_TOKENS,
      ...(env.LLM_TEMPERATURE !== undefined ? { temperature: env.LLM_TEMPERATURE } : {}),
      local: {
        baseUrl: env.QWEN_BASE_URL,
        model: env.QWEN_MODEL,
        apiKey: env.QWEN_API_KEY || undefined,
      },
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || undefined,
        model: env.LLM_MODEL,
        validationModel: env.LLM_VALIDATION_MODEL || env.LLM_MODEL,
      },
    },
    github: {
      token: env.GITHUB_TOKEN || undefined,
      allowedRepos: (env.GITHUB_ALLOWED_REPOS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    },
    policy: {
      minConfidence: env.REVIEW_MIN_CONFIDENCE,
      blockingConfidence: env.REVIEW_BLOCKING_CONFIDENCE,
      maxFindings: env.REVIEW_MAX_FINDINGS,
      dryRun: env.REVIEW_DRY_RUN,
    },
    context: {
      docsDir: env.CONTEXT_DOCS_DIR,
      maxResults: env.CONTEXT_MAX_RESULTS,
    },
    contextEvolution: {
      enabled: env.CONTEXT_EVOLUTION_ENABLED,
      storePath: env.CONTEXT_STORE_PATH,
      autoUpdateThreshold: env.CONTEXT_AUTO_UPDATE_THRESHOLD,
      proposalThreshold: env.CONTEXT_PROPOSAL_THRESHOLD,
      revertConfidenceThreshold: env.CONTEXT_REVERT_CONFIDENCE_THRESHOLD,
      reviewRequiredCategories: (env.CONTEXT_REVIEW_REQUIRED_CATEGORIES ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .map((s) => ContextCategorySchema.safeParse(s))
        .filter((r): r is { success: true; data: ContextCategory } => r.success)
        .map((r) => r.data),
    },
  };
}
