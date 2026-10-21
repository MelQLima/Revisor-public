import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentContextProvider } from '../src/context/document-context-provider.js';

async function makeDocs(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'revisor-docs-'));
  await mkdir(join(dir, 'domain'), { recursive: true });
  await writeFile(
    join(dir, 'domain', 'payments.md'),
    '# Payments\n\n## Identity invariant\n\nA payment must be associated to a person only after CPF validation. Email is not a unique identifier.\n\n## Reversal invariant\n\nA reverted payment must not participate in reconciliation.\n',
  );
  await writeFile(
    join(dir, 'architecture.md'),
    '# Architecture\n\n## Money as cents\n\nAll monetary values are integer cents. Floats for money are prohibited.\n',
  );
  return dir;
}

describe('DocumentContextProvider', () => {
  it('returns the most relevant business chunk for a query', async () => {
    const provider = new DocumentContextProvider(await makeDocs());
    const results = await provider.search('associate payment person cpf email reconciliation', {
      kinds: ['business'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toMatch(/payments\.md/);
    expect(results[0]?.kind).toBe('business');
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('classifies docs/ai/business-rules/** as business context (reviewer-accessible)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'revisor-docs-'));
    await mkdir(join(dir, 'business-rules', 'payments'), { recursive: true });
    await writeFile(
      join(dir, 'business-rules', 'payments', 'rules.md'),
      '# Payments rules\n\n## PAYMENT-002 Payment status may never regress\n\nAn out-of-order webhook must not flip an approved payment back to pending.\n',
    );
    const provider = new DocumentContextProvider(dir);
    const results = await provider.search('payment status regression webhook approved pending', {
      kinds: ['business'],
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.kind).toBe('business');
    expect(results[0]?.source).toMatch(/business-rules/);
  });

  it('filters by kind', async () => {
    const provider = new DocumentContextProvider(await makeDocs());
    const results = await provider.search('money cents float prohibited', { kinds: ['architecture'] });
    expect(results.every((r) => r.kind === 'architecture')).toBe(true);
  });

  it('returns [] when the docs directory does not exist', async () => {
    const provider = new DocumentContextProvider('/no/such/dir/revisor-xyz');
    expect(await provider.search('anything')).toEqual([]);
  });

  it('returns [] for an empty query', async () => {
    const provider = new DocumentContextProvider(await makeDocs());
    expect(await provider.search('   ')).toEqual([]);
  });
});
