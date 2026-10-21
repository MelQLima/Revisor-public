import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/infrastructure/config/config.js';

const base: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  GITHUB_ALLOWED_REPOS: 'Acme/Wallet, other/repo',
  REVIEW_DRY_RUN: 'true',
  REVIEW_MIN_CONFIDENCE: '0.6',
};

describe('loadConfig', () => {
  it('parses env with defaults and normalizes the repo allowlist', () => {
    const config = loadConfig(base);
    expect(config.policy.dryRun).toBe(true);
    expect(config.policy.minConfidence).toBe(0.6);
    expect(config.github.allowedRepos).toEqual(['acme/wallet', 'other/repo']);
    // default validation model falls back to the main model
    expect(config.llm.anthropic.validationModel).toBe(config.llm.anthropic.model);
  });

  it('defaults to the local Qwen3-Coder provider', () => {
    const config = loadConfig(base);
    expect(config.llm.provider).toBe('qwen');
    expect(config.llm.local.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.llm.local.model).toBe('qwen3-coder');
  });

  it('accepts an explicit provider override', () => {
    expect(loadConfig({ ...base, LLM_PROVIDER: 'claude' }).llm.provider).toBe('claude');
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'bogus' })).toThrow(/Invalid environment/);
  });

  it('throws on an out-of-range confidence', () => {
    expect(() => loadConfig({ ...base, REVIEW_MIN_CONFIDENCE: '5' })).toThrow(/Invalid environment/);
  });

  it('leaves secrets undefined when not provided', () => {
    const config = loadConfig(base);
    expect(config.llm.anthropic.apiKey).toBeUndefined();
    expect(config.github.token).toBeUndefined();
  });
});
