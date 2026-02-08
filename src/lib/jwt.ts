import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { logAudit } from '@/lib/audit';

export type JwtPayload = {
  iss?: string;
  sub: string;
  aud?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  sid?: string;
  role?: string | string[];
  email?: string | null;
  [k: string]: any;
};

const DEFAULT_EXPIRES_SECONDS = 15 * 60; // 15 minutes

function getSigningConfig() {
  const alg = process.env.JWT_SIGNING_ALG || 'HS256';
  const secret = process.env.JWT_SECRET || null; // HS256
  const publicKey = process.env.JWT_PUBLIC_KEY || null; // RS* public key
  const jwksUrl = process.env.JWT_JWKS_URL || null; // optional JWKS endpoint
  const expectedIss = process.env.JWT_ISS || null;
  const expectedAud = process.env.JWT_AUD || null;
  return { alg, secret, publicKey, jwksUrl, expectedIss, expectedAud };
}

function generateJti() {
  return crypto.randomBytes(16).toString('hex');
}

export function sign(payload: Partial<JwtPayload>, opts?: { expiresInSeconds?: number }) {
  const { alg, secret, publicKey } = getSigningConfig();
  const expiresIn = opts?.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  const iat = Math.floor(Date.now() / 1000);
  const jti = (payload.jti as string) || generateJti();
  // Let jsonwebtoken handle `exp` via options.expiresIn. Do not set `exp` in payload.
  const body: JwtPayload = {
    ...(payload as JwtPayload),
    iss: (payload as JwtPayload).iss || process.env.JWT_ISS,
    aud: (payload as JwtPayload).aud || process.env.JWT_AUD,
    iat,
    jti,
  };

  // For RS* signing use JWT_PRIVATE_KEY env var
  const signKey = alg.startsWith('HS') ? (secret as string) : (process.env.JWT_PRIVATE_KEY || publicKey);
  if (!signKey) throw new Error('JWT signing key not configured');

  const header: Record<string, any> = { typ: 'JWT' };
  if (process.env.JWT_KID) header.kid = process.env.JWT_KID;

  const token = jwt.sign(body as object, signKey, {
    algorithm: alg as jwt.Algorithm,
    expiresIn: expiresIn,
    header,
  });

  return token;
}

// JWKS cache
const JWKS_CACHE: {
  keys?: any[];
  fetchedAt?: number;
  ttlMs?: number;
} = { ttlMs: 5 * 60 * 1000 };

async function fetchJwks(jwksUrl: string) {
  const now = Date.now();
  if (JWKS_CACHE.keys && JWKS_CACHE.fetchedAt && now - JWKS_CACHE.fetchedAt < (JWKS_CACHE.ttlMs || 0)) {
    return JWKS_CACHE.keys;
  }
  // Prefer global fetch (node 18+ or test polyfill), otherwise dynamic import node-fetch
  let fetchFn: any = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') {
    fetchFn = (await import('node-fetch')).default as any;
  }
  const res = await fetchFn(jwksUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
  const body = await res.json();
  JWKS_CACHE.keys = body.keys || [];
  JWKS_CACHE.fetchedAt = Date.now();
  return JWKS_CACHE.keys;
}

// Exported for tests to clear the cache between runs
export function _clearJwksCache() {
  JWKS_CACHE.keys = undefined;
  JWKS_CACHE.fetchedAt = undefined;
}


function jwkToPem(jwk: any) {
  if (!jwk || jwk.kty !== 'RSA') throw new Error('Unsupported JWK type');
  // Node can import a JWK object directly
  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' } as any);
  return keyObj.export({ type: 'spki', format: 'pem' }) as string;
}

export async function verify<T extends JwtPayload = JwtPayload>(token: string): Promise<T> {
  const { alg, secret, publicKey, jwksUrl, expectedIss, expectedAud } = getSigningConfig();

  const decodedHeader = (() => {
    try {
      const h = jwt.decode(token, { complete: true }) as any;
      return h?.header || {};
    } catch {
      return {};
    }
  })();

  // Reject token if header algorithm doesn't match configured algorithm
  if (decodedHeader && decodedHeader.alg && decodedHeader.alg !== alg) {
    // Record audit event for unexpected algorithm
    await logAudit({
      action: 'auth_token_verify',
      outcome: 'failure',
      detail: 'unexpected_algorithm',
      metadata: { expectedAlg: alg, tokenAlg: decodedHeader.alg, kid: decodedHeader.kid ?? null },
    });
    throw new Error('Unexpected token algorithm');
  }

  // HS* path (synchronous)
  if (alg.startsWith('HS')) {
    const verifyKey = secret as string;
    if (!verifyKey) throw new Error('JWT verification key not configured');
    try {
      const options: jwt.VerifyOptions = { algorithms: [alg as jwt.Algorithm] };
      if (expectedIss) options.issuer = expectedIss as string;
      if (expectedAud) options.audience = expectedAud as string as any;
      const payload = jwt.verify(token, verifyKey, options) as T;
      return payload;
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') throw new Error('Token expired');
      if (err.name === 'JsonWebTokenError') {
        const m = (err.message || '').toLowerCase();
        if (m.includes('issuer')) {
          await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_issuer', metadata: { expectedIss, message: err.message } });
          throw new Error('Invalid issuer');
        }
        if (m.includes('audience')) {
          await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_audience', metadata: { expectedAud, message: err.message } });
          throw new Error('Invalid audience');
        }
        // Signature or other token invalid
        await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'signature_invalid', metadata: { message: err.message } });
        throw new Error('Invalid token');
      }
      throw err;
    }
  }

  // RS* path: prefer JWKS if configured, fallback to JWT_PUBLIC_KEY
  let keyToUse: string | null = null;

  if (jwksUrl) {
    const keys = await fetchJwks(jwksUrl);
    if (!keys || keys.length === 0) throw new Error('No JWKS key found');

    // Build candidate list: prefer kid match, otherwise try all keys (to support rotation)
    const candidates: any[] = [];
    if (decodedHeader.kid) {
      const matched = keys.find((k: any) => k.kid === decodedHeader.kid);
      if (matched) candidates.push(matched);
      // include others as fallback
      for (const k of keys) if (k.kid !== decodedHeader.kid) candidates.push(k);
    } else {
      for (const k of keys) candidates.push(k);
    }

    // Try each candidate key until one verifies
    let lastErr: any = null;
    for (const jwk of candidates) {
      const pem = jwkToPem(jwk);
      try {
        const options: jwt.VerifyOptions = { algorithms: [alg as jwt.Algorithm] };
        if (expectedIss) options.issuer = expectedIss as string;
        if (expectedAud) options.audience = expectedAud as string as any;
        const payload = jwt.verify(token, pem, options) as T;
        return payload;
      } catch (e: any) {
        lastErr = e;
        // continue to next key
      }
    }

    // If none matched, throw normalized error and record audit
    if (lastErr && lastErr.name === 'TokenExpiredError') throw new Error('Token expired');
    if (lastErr && lastErr.name === 'JsonWebTokenError') {
      const m = (lastErr.message || '').toLowerCase();
      if (m.includes('issuer')) {
        await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_issuer', metadata: { expectedIss, message: lastErr.message } });
        throw new Error('Invalid issuer');
      }
      if (m.includes('audience')) {
        await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_audience', metadata: { expectedAud, message: lastErr.message } });
        throw new Error('Invalid audience');
      }
      await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'signature_invalid', metadata: { message: lastErr.message } });
      throw new Error('Invalid token');
    }
    await logAudit({ action: 'auth_token_verify', outcome: 'failure', detail: 'signature_invalid' });
    throw new Error('Invalid token');
  } else if (publicKey) {
    keyToUse = publicKey;
  }

  if (!keyToUse) throw new Error('JWT verification key not configured');

  try {
    const options: jwt.VerifyOptions = { algorithms: [alg as jwt.Algorithm] };
    if (expectedIss) options.issuer = expectedIss as string;
    if (expectedAud) options.audience = expectedAud as string as any;
    const payload = jwt.verify(token, keyToUse, options) as T;
    return payload;
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') throw new Error('Token expired');
    if (err.name === 'JsonWebTokenError') {
      const m = (err.message || '').toLowerCase();
      if (m.includes('issuer')) throw new Error('Invalid issuer');
      if (m.includes('audience')) throw new Error('Invalid audience');
      throw new Error('Invalid token');
    }
    throw err;
  }
}

export default { sign, verify };
