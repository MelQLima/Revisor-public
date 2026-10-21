import { createLogger as createBaseLogger, type Logger, type LoggerOptions } from '@triple-r/observability';

/**
 * Reviewer logging facade.
 *
 * The generic logging primitives now live in `@triple-r/observability`. This
 * app-level facade re-exports them, adds the reviewer's config-specific
 * secret-redaction paths, and re-exports the reviewer event vocabulary — so the
 * rest of the app keeps importing everything logging-related from one place.
 */

export { withCorrelation, type Logger, type LoggerOptions } from '@triple-r/observability';
export * from './events.js';

/** Redaction paths specific to the reviewer's config shape (see config.ts). */
const REVIEWER_REDACT_PATHS = [
  'config.llm.apiKey',
  'config.github.token',
  'config.github.webhookSecret',
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return createBaseLogger({
    ...options,
    redact: [...REVIEWER_REDACT_PATHS, ...(options.redact ?? [])],
  });
}
