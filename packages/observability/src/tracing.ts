import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

/**
 * Distributed tracing (OpenTelemetry), shared by every Triple R agent.
 *
 * Opt-in: nothing starts unless OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g.
 * `http://jaeger:4318` in docker compose), so tests and the offline CLI pay no
 * cost. When enabled, traces go to any OTLP/HTTP backend (Jaeger, Grafana
 * Tempo, Langfuse, Honeycomb…).
 *
 * Spans come from two places:
 *   - manual spans around each LLM pass (see the reviewer's TracedLLMProvider),
 *     carrying model, pass and token usage;
 *   - the undici instrumentation, which records every outbound `fetch` (Ollama,
 *     GitHub) as a child span with URL, status and latency. It hooks Node's
 *     diagnostics channels, so it works in native ESM without a loader.
 */
export interface Tracing {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const DISABLED: Tracing = { enabled: false, shutdown: async () => {} };

export function startTracing(
  serviceName: string,
  env: NodeJS.ProcessEnv = process.env,
): Tracing {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return DISABLED;
  }
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new UndiciInstrumentation()],
  });
  sdk.start();
  return {
    enabled: true,
    shutdown: () => sdk.shutdown().catch(() => undefined),
  };
}
