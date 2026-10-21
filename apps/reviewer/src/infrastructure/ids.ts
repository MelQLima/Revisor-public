/**
 * Correlation-id generation now lives in `@triple-r/observability`. Re-exported
 * here so existing reviewer imports (`../infrastructure/ids.js`) keep working;
 * the default `rev_` prefix preserves the reviewer's correlation-id format.
 */
export { newCorrelationId } from '@triple-r/observability';
