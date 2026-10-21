/**
 * Argument redaction for the audit trail (§14). Values under sensitive keys are
 * replaced before anything is persisted, and obvious secret-shaped strings are
 * masked wherever they appear. This is a guardrail, not a vault — connectors
 * should not put raw secrets in tool args in the first place.
 */

const SENSITIVE_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-ant-[a-zA-Z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function redactString(s: string): string {
  let out = s;
  for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, '[REDACTED_SECRET]');
  return out;
}

export function redactArgs(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactArgs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactArgs(v);
    }
    return out;
  }
  return value;
}
