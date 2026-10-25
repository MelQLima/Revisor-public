import { startTracing } from '@triple-r/observability';
import { loadConfig } from '../config/config.js';
import { createLogger } from '../logging/logger.js';
import { buildServer } from './server.js';

/**
 * HTTP entrypoint. Loads + validates config, builds the webhook server, and
 * listens. Fails fast (non-zero exit) on invalid configuration.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  // Opt-in: only starts when OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. docker compose).
  const tracing = startTracing('revisor');

  const app = await buildServer(config, logger);
  await app.listen({ port: config.port, host: '0.0.0.0' });

  logger.info(
    {
      port: config.port,
      dryRun: config.policy.dryRun,
      githubConfigured: Boolean(config.github.token),
      webhookConfigured: Boolean(config.github.webhookSecret),
      tracing: tracing.enabled,
    },
    `Revisor listening on :${config.port}`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down`);
      void app
        .close()
        .then(() => tracing.shutdown())
        .then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
