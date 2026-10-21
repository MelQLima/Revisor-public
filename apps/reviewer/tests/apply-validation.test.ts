import { describe, expect, it } from 'vitest';
import { applyValidation } from '../src/application/apply-validation.js';
import { makeFinding } from './helpers.js';

describe('applyValidation', () => {
  it('keeps a finding the validator affirmed and applies adjusted confidence', () => {
    const finding = makeFinding({ id: 'f1', confidence: 0.9, certainty: 'confirmed' });
    const { kept, rejected } = applyValidation([finding], {
      decisions: [
        { findingId: 'f1', keep: true, adjustedConfidence: 0.7, adjustedCertainty: 'likely', reason: 'ok' },
      ],
    });
    expect(rejected).toHaveLength(0);
    expect(kept[0]?.confidence).toBe(0.7);
    expect(kept[0]?.certainty).toBe('likely');
  });

  it('drops a low-criticality finding on a well-formed contradiction', () => {
    const { kept, rejected } = applyValidation([makeFinding({ id: 'f1' })], {
      decisions: [
        {
          findingId: 'f1',
          status: 'CONTRADICTED',
          contradictionFound: true,
          contradictingEvidence: 'the value is re-derived from source; the assertion cannot fail',
          adjustedConfidence: 0.1,
          adjustedCertainty: 'insufficient-evidence',
          reason: 'refuted',
        },
      ],
    });
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/validator dropped/);
  });

  it('drops a low-criticality finding via the legacy keep=false path', () => {
    const { kept, rejected } = applyValidation([makeFinding({ id: 'f1' })], {
      decisions: [
        { findingId: 'f1', keep: false, adjustedConfidence: 0.1, adjustedCertainty: 'insufficient-evidence', reason: 'no evidence' },
      ],
    });
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/validator dropped/);
  });

  it('KEEPS a low-criticality finding when the "rejection" has no contradicting evidence', () => {
    const { kept, rejected } = applyValidation([makeFinding({ id: 'f1' })], {
      decisions: [
        {
          findingId: 'f1',
          status: 'CONTRADICTED',
          contradictionFound: true,
          contradictingEvidence: '', // self-contradiction: says reject, gives nothing
          adjustedConfidence: 0.1,
          adjustedCertainty: 'insufficient-evidence',
          reason: 'the code does X which is not allowed',
        },
      ],
    });
    expect(rejected).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it('ESCALATES (never drops) a high-criticality FIN-1 finding on a self-contradicting reject', () => {
    // The exact qwen2.5-coder:7b failure: it rejected a real FIN-1 violation with
    // a reason that CONFIRMS the violation. This must escalate, not silently approve.
    const finding = makeFinding({
      id: 'fin',
      category: 'business',
      severity: 'BLOCKER',
      confidence: 0.9,
      businessRule: 'FIN-1',
      title: 'Money converted to integer cents',
      problem: 'Math.round(totalPaid * 100) converts Decimal reais into integer cents',
    });
    const { kept, rejected } = applyValidation([finding], {
      decisions: [
        {
          findingId: 'fin',
          status: 'CONTRADICTED',
          contradictionFound: true,
          contradictingEvidence: 'introduces a function that rounds paid amounts to integer cents, not allowed by FIN-1',
          adjustedConfidence: 0.0,
          adjustedCertainty: 'insufficient-evidence',
          reason: 'rounds to integer cents which violates FIN-1',
        },
      ],
    });
    expect(rejected).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.contested?.criticality).toBe(6);
    // The validator may not bury it by zeroing confidence.
    expect(kept[0]?.confidence).toBe(0.9);
  });

  it('ESCALATES a high-criticality finding when the validator returns no decision', () => {
    const finding = makeFinding({ id: 'ref', businessRule: 'REFUND-003', category: 'business' });
    const { kept, rejected } = applyValidation([finding], { decisions: [] });
    expect(rejected).toHaveLength(0);
    expect(kept[0]?.contested).toBeTruthy();
  });

  it('drops a low-criticality finding with no matching decision (fail-safe)', () => {
    const { kept, rejected } = applyValidation([makeFinding({ id: 'f1' })], { decisions: [] });
    expect(kept).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/no validation decision/);
  });
});
