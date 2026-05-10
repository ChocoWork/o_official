// CSRF helpers (draft)
// Implements a double-submit cookie strategy with rotation.
// TODO: Adjust integration with session persistence and DB fields (csrf_token_hash, csrf_prev_token_hash)

import { tokenHashSha256 } from './hash';

export function generateCsrfToken() {
  // Use a header-safe ASCII representation so the token can travel via
  // cookie and X-CSRF-Token without introducing control characters.
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeTransportToken(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

export async function verifyAndRotateCsrf(providedToken: string | undefined, storedHash: string | null, storeNewHash: (hash: string) => Promise<void>) {
  // Provided token is the raw token from header; storedHash is the stored sha256 hash in DB
  if (!providedToken) return false;
  const normalizedProvidedToken = normalizeTransportToken(providedToken);
  const providedHash = await tokenHashSha256(normalizedProvidedToken);
  // Immediate match: OK
  if (storedHash && providedHash === storedHash) {
    // rotate: store new hash for next time (optional)
    const nextToken = generateCsrfToken();
    const nextHash = await tokenHashSha256(nextToken);
    await storeNewHash(nextHash);
    return { ok: true, rotated: true, nextToken } as const;
  }
  return { ok: false } as const;
}

const csrfHelper = { generateCsrfToken, verifyAndRotateCsrf };

export default csrfHelper;
