import crypto from 'crypto';

// Password hashing using scrypt. Format: scrypt$<salt_hex>$<derived_hex>
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const derived = Buffer.from(parts[2], 'hex');
  const attempt = crypto.scryptSync(password, salt, derived.length);
  return crypto.timingSafeEqual(attempt, derived);
}

// Token hashing: SHA-256 hex digest. Used for refresh tokens / reset tokens persisted in DB.
export function tokenHashSha256(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Backwards-compatible verify function used by existing code (expecting `verify(plain, storedHash)`)
export async function verify(plain: string, storedHash: string | null) {
  if (!storedHash) return false;
  // If storedHash looks like a hex sha256 (64 hex chars), compare with sha256
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    return tokenHashSha256(plain) === storedHash;
  }
  // Otherwise assume it's a password-style scrypt hash
  return verifyPassword(plain, storedHash);
}

// Generic hash wrapper for passwords - keeps named `hash` to reduce churn; for tokens use tokenHashSha256
export async function hash(input: string) {
  return hashPassword(input);
}
