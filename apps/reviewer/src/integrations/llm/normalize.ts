import { createHash } from 'node:crypto';
import type { ValidationResult, ValidationStatus } from '../../domain/review-input.js';
import { FindingCertaintySchema } from '../../domain/review.js';

/**
 * Helpers to normalize raw LLM tool output before it hits the Zod schemas.
 * The model may omit finding ids or return slightly-off validation payloads;
 * we make those deterministic and safe rather than failing the whole review.
 */

/** Deterministic id from finding content, so the validation pass can reference it. */
function findingId(finding: Record<string, unknown>, correlationId: string, index: number): string {
  const basis = `${finding.title ?? ''}|${finding.file ?? ''}|${finding.problem ?? ''}`;
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 8);
  return `${correlationId}-f${index}-${hash}`;
}

export function assignFindingIds(findings: unknown[], correlationId: string): unknown[] {
  return findings.map((f, i) => {
    const finding = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
    return { ...finding, id: finding.id ?? findingId(finding, correlationId, i) };
  });
}

/** Coerce loose validation tool output into a typed ValidationResult. */
export function coerceValidation(raw: unknown): ValidationResult {
  const decisionsRaw =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { decisions?: unknown }).decisions)
      ? ((raw as { decisions: unknown[] }).decisions)
      : [];

  const decisions = decisionsRaw
    .map((d) => {
      if (typeof d !== 'object' || d === null) return null;
      const obj = d as Record<string, unknown>;
      if (typeof obj.findingId !== 'string') return null;
      const certainty = FindingCertaintySchema.safeParse(obj.adjustedCertainty);
      const confidence = typeof obj.adjustedConfidence === 'number' ? obj.adjustedConfidence : 0;
      const contradictingEvidence =
        typeof obj.contradictingEvidence === 'string' ? obj.contradictingEvidence.trim() : '';
      const contradictionFound = obj.contradictionFound === true && contradictingEvidence !== '';
      return {
        findingId: obj.findingId,
        // Always resolve an explicit status so model output goes through the
        // structured gate in applyValidation (never the legacy keep path). A
        // rejection is honored ONLY when the model asserts CONTRADICTED *and*
        // supplies concrete contradicting evidence — a self-contradicting
        // "reject" (no evidence) coerces to UNCERTAIN and the finding is kept.
        status: resolveStatus(obj.status, contradictionFound, obj.keep === true),
        contradictionFound,
        contradictingEvidence,
        adjustedConfidence: Math.max(0, Math.min(1, confidence)),
        adjustedCertainty: certainty.success ? certainty.data : 'insufficient-evidence',
        reason: typeof obj.reason === 'string' ? obj.reason : 'no reason provided',
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  return { decisions };
}

const VALID_STATUS: ReadonlySet<string> = new Set(['CONFIRMED', 'CONTRADICTED', 'UNCERTAIN']);

/** Normalize the model's status; a CONTRADICTED claim with no evidence is downgraded. */
function resolveStatus(raw: unknown, contradictionFound: boolean, legacyKeep: boolean): ValidationStatus {
  const stated = typeof raw === 'string' && VALID_STATUS.has(raw) ? (raw as ValidationStatus) : undefined;
  if (stated === 'CONTRADICTED') return contradictionFound ? 'CONTRADICTED' : 'UNCERTAIN';
  if (stated) return stated;
  // No/invalid status: infer conservatively. A real contradiction ⇒ CONTRADICTED;
  // an affirmative keep ⇒ CONFIRMED; anything else ⇒ UNCERTAIN (kept, never dropped).
  if (contradictionFound) return 'CONTRADICTED';
  return legacyKeep ? 'CONFIRMED' : 'UNCERTAIN';
}
