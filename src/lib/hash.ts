import crypto from 'crypto';
import argon2 from 'argon2';

// Password hashing using Argon2id. We keep backwards compatibility with older
// scrypt-based hashes and with token SHA-256 hashes used for refresh/reset tokens.

// Create an Argon2id password hash. Parameters chosen to balance security and
// CI/runtime performance; can be tuned later and documented in docs/specs.
export async function hashPassword(password: string) {
  return await argon2.hash(password, {
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 4096, // KiB (~4 MB)
    parallelism: 1,
  });
}

// Verify a password against a stored hash. Supports Argon2 hashes (preferred)
// and legacy scrypt hashes (format: scrypt$<salt_hex>$<derived_hex>). Returns boolean.
export async function verifyPassword(password: string, stored: string) {
  if (!stored) return false;

  // Argon2 hashed strings start with `$argon2` (argon2i/argon2id)
  if (stored.startsWith('$argon2')) {
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }

  // Legacy scrypt format: scrypt$<salt_hex>$<derived_hex>
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const derived = Buffer.from(parts[2], 'hex');
  const attempt = crypto.scryptSync(password, salt, derived.length);
  try {
    return crypto.timingSafeEqual(attempt, derived);
  } catch {
    return false;
  }
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
  // Otherwise handle password-style hashes (argon2 or legacy scrypt)
  return verifyPassword(plain, storedHash);
}

// Generic hash wrapper for passwords - keeps named `hash` to reduce churn; for tokens use tokenHashSha256
export async function hash(input: string) {
  return hashPassword(input);
}
