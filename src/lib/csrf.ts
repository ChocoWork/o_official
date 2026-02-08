// CSRF helpers (draft)
// Implements a double-submit cookie strategy with rotation.
// TODO: Adjust integration with session persistence and DB fields (csrf_token_hash, csrf_prev_token_hash)

import crypto from 'crypto';
import { tokenHashSha256 } from './hash';

export function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function verifyAndRotateCsrf(providedToken: string | undefined, storedHash: string | null, storeNewHash: (hash: string) => Promise<void>) {
  // Provided token is the raw token from header; storedHash is the stored sha256 hash in DB
  if (!providedToken) return false;
  const providedHash = tokenHashSha256(providedToken);
  // Immediate match: OK
  if (storedHash && providedHash === storedHash) {
    // rotate: store new hash for next time (optional)
    const nextToken = generateCsrfToken();
    const nextHash = tokenHashSha256(nextToken);
    await storeNewHash(nextHash);
    return { ok: true, rotated: true, nextToken } as const;
  }
  return { ok: false } as const;
}

export default { generateCsrfToken, verifyAndRotateCsrf };
