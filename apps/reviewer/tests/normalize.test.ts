import { describe, expect, it } from 'vitest';
import { assignFindingIds, coerceValidation } from '../src/integrations/llm/normalize.js';

describe('assignFindingIds', () => {
  it('assigns deterministic ids to findings missing one', () => {
    const a = assignFindingIds([{ title: 'x', file: 'a.ts', problem: 'p' }], 'rev_1');
    const b = assignFindingIds([{ title: 'x', file: 'a.ts', problem: 'p' }], 'rev_1');
    expect((a[0] as { id: string }).id).toBe((b[0] as { id: string }).id);
  });

  it('preserves an existing id', () => {
    const out = assignFindingIds([{ id: 'keep-me', title: 'x' }], 'rev_1');
    expect((out[0] as { id: string }).id).toBe('keep-me');
  });

  it('tolerates non-object entries', () => {
    const out = assignFindingIds([null, 'nope'], 'rev_1');
    expect(out).toHaveLength(2);
    expect((out[0] as { id: string }).id).toMatch(/rev_1/);
  });
});

describe('coerceValidation', () => {
  it('normalizes valid decisions and clamps confidence', () => {
    const result = coerceValidation({
      decisions: [
        {
          findingId: 'f1',
          status: 'CONFIRMED',
          contradictionFound: false,
          contradictingEvidence: '',
          adjustedConfidence: 1.5,
          adjustedCertainty: 'likely',
          reason: 'ok',
        },
      ],
    });
    expect(result.decisions[0]?.adjustedConfidence).toBe(1);
    expect(result.decisions[0]?.status).toBe('CONFIRMED');
  });

  it('drops malformed decisions and defaults bad certainty to UNCERTAIN', () => {
    const result = coerceValidation({
      decisions: [
        { keep: true }, // no findingId -> dropped
        { findingId: 'f2', keep: 'yes', adjustedConfidence: 'x', adjustedCertainty: 'bogus' },
      ],
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.findingId).toBe('f2');
    // No status, no real contradiction, not an affirmative keep -> UNCERTAIN (kept).
    expect(result.decisions[0]?.status).toBe('UNCERTAIN');
    expect(result.decisions[0]?.adjustedCertainty).toBe('insufficient-evidence');
  });

  it('downgrades a CONTRADICTED verdict with no contradicting evidence to UNCERTAIN', () => {
    const result = coerceValidation({
      decisions: [
        {
          findingId: 'f1',
          status: 'CONTRADICTED',
          contradictionFound: true,
          contradictingEvidence: '   ', // whitespace only -> not real evidence
          adjustedConfidence: 0.2,
          adjustedCertainty: 'potential',
          reason: 'introduces integer cents, which is not allowed by FIN-1',
        },
      ],
    });
    // A "rejection" whose reasoning actually CONFIRMS the violation must not
    // survive as CONTRADICTED (Pass 2 spec §15).
    expect(result.decisions[0]?.status).toBe('UNCERTAIN');
    expect(result.decisions[0]?.contradictionFound).toBe(false);
  });

  it('returns empty decisions for garbage input', () => {
    expect(coerceValidation(null).decisions).toEqual([]);
    expect(coerceValidation({}).decisions).toEqual([]);
  });
});
