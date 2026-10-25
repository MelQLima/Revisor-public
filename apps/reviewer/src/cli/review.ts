#!/usr/bin/env node
import { resolve } from 'node:path';
import { startTracing } from '@triple-r/observability';
import { loadConfig, type AppConfig } from '../infrastructure/config/config.js';
import { createLogger, type Logger } from '../infrastructure/logging/logger.js';
import { ReviewPipeline } from '../application/review-pipeline.js';
import {
  createContextProvider,
  createHistoryProvider,
  createLLMProvider,
  toPolicyConfig,
} from '../application/providers.js';
import { FixtureGitHubClient } from '../integrations/github/fixture-github-client.js';
import { loadFixture } from '../integrations/github/fixture.js';

/**
 * Offline review runner:  `npm run review -- ./fixtures/example-pr.json [--json]`
 *
 * Runs the full pipeline against a fixture with NO GitHub calls, so prompts and
 * review logic can be iterated without opening a real PR. Uses Claude when
 * ANTHROPIC_API_KEY is set, otherwise the offline heuristic reviewer.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixturePath = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');

  if (!fixturePath) {
    console.error('Usage: npm run review -- <path-to-fixture.json> [--json]');
    process.exit(2);
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ level: asJson ? 'warn' : config.logLevel });
  // Opt-in tracing: set OTEL_EXPORTER_OTLP_ENDPOINT to see this review in Jaeger.
  const tracing = startTracing('revisor-cli');
  try {
    await runReview(fixturePath, asJson, config, logger);
  } finally {
    await tracing.shutdown();
  }
}

async function runReview(
  fixturePath: string,
  asJson: boolean,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const fixture = await loadFixture(resolve(fixturePath));
  const github = new FixtureGitHubClient(fixture, logger);
  const context = createContextProvider(config);
  await context.load();

  const pipeline = new ReviewPipeline({
    github,
    context,
    history: createHistoryProvider(config),
    llm: createLLMProvider(config, logger),
    policy: toPolicyConfig(config),
    logger,
    contextMaxResults: config.context.maxResults,
  });

  const outcome = await pipeline.review(
    { repo: fixture.pullRequest.repo, pullNumber: fixture.pullRequest.number },
    { post: false, extraRelevantCode: fixture.relevantCode },
  );

  if (asJson) {
    process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  } else {
    process.stdout.write('\n');
    process.stdout.write(outcome.body);
    process.stdout.write('\n\n');
    if (outcome.result.rejected.length > 0) {
      process.stdout.write(`Filtered ${outcome.result.rejected.length} low-confidence/unsupported finding(s):\n`);
      for (const r of outcome.result.rejected) {
        process.stdout.write(`  - [${r.finding.severity}] ${r.finding.title} — ${r.reason}\n`);
      }
      process.stdout.write('\n');
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
