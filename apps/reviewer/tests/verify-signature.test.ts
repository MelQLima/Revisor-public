import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from '../src/infrastructure/http/verify-signature.js';

const secret = 'topsecret';
const body = '{"action":"opened"}';
const validSig = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

describe('verifyGithubSignature', () => {
  it('accepts a valid signature', () => {
    expect(verifyGithubSignature(secret, body, validSig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyGithubSignature(secret, '{"action":"closed"}', validSig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyGithubSignature('other', body, validSig)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubSignature(secret, body, 'md5=abc')).toBe(false);
  });
});
