import { describe, expect, it } from 'vitest';
import { buildContextQuery } from '../src/context/query-builder.js';
import { makePullRequest } from './helpers.js';

describe('buildContextQuery', () => {
  it('extracts terms from title, filenames and added diff lines', () => {
    const pr = makePullRequest({
      title: 'Associate payment by email',
      changedFiles: [
        {
          filename: 'src/payments/reconciliation.service.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          patch: '@@ -1 +1 @@\n+  const person = findByEmail(payerEmail);\n-  validateIdentity(cpf);',
        },
      ],
    });
    const query = buildContextQuery(pr);
    expect(query).toMatch(/payment/);
    expect(query).toMatch(/reconciliation/);
    expect(query).toMatch(/email/);
    // camelCase identifiers are split
    expect(query).toMatch(/payer/);
  });

  it('does not pick up removed lines as strongly as added ones', () => {
    const pr = makePullRequest({
      title: 'x',
      changedFiles: [
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 0,
          deletions: 1,
          patch: '@@ -1 +0 @@\n-  removedSecretTokenThing();',
        },
      ],
    });
    const query = buildContextQuery(pr);
    expect(query).not.toMatch(/removedSecretTokenThing/);
  });
});
