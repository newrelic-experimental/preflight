import { timingSafeEqual } from 'node:crypto';

/**
 * Validates an `Authorization: Basic ...` header against a single shared
 * token used as the password (RFC 7617 user-id is accepted but ignored).
 */
export function checkBasicAuthToken(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf-8');
  } catch {
    return false;
  }
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return false;
  const password = decoded.slice(colonIndex + 1);
  const passwordBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(expectedToken);
  if (passwordBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(passwordBuf, expectedBuf);
}
