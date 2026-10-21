import { pino, type Logger } from 'pino';

/**
 * Structured logging with correlation IDs — shared across every Triple R agent.
 *
 * A `Logger` is a pino instance. `createLogger` builds a root logger;
 * `withCorrelation` derives a child bound to a correlation id so every event in
 * one unit of work (a review, a resolution, an operation) can be traced
 * end-to-end.
 *
 * Secret redaction is configured centrally so tokens/keys never leak into logs.
 * The default paths are domain-agnostic; each app may pass extra `redact` paths
 * for its own config shape.
 */

export type { Logger };

/** Domain-agnostic redaction. Apps append their own config-specific paths. */
const DEFAULT_REDACT_PATHS = [
  'apiKey',
  'token',
  'authorization',
  'headers.authorization',
  '*.apiKey',
  '*.token',
];

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Extra redaction paths for app-specific config shapes. */
  redact?: string[];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const pretty = options.pretty ?? process.env.NODE_ENV !== 'production';
  const paths = [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])];

  return pino({
    level,
    redact: { paths, censor: '[REDACTED]' },
    base: undefined,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export function withCorrelation(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
