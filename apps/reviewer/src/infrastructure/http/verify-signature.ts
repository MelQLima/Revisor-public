import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` header against the raw request
 * body using the shared secret. Constant-time comparison; never logs the secret.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
