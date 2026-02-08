import { sign, verify } from '../../../src/lib/jwt';
import * as audit from '../../../src/lib/audit';

describe('jwt (draft)', () => {
  beforeEach(() => {
    // Default: stub out audit logging so tests don't require Supabase env
    jest.spyOn(audit, 'logAudit').mockImplementation(async () => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
  test('sign and verify roundtrip (HS256)', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'user-123', role: 'user' }, { expiresInSeconds: 60 });
    const payload = await verify(token);
    expect(payload.sub).toBe('user-123');
    expect(payload.role).toBe('user');
  });

  test('expired token fails (HS256)', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'u' }, { expiresInSeconds: -10 });
    await expect(verify(token)).rejects.toThrow(/expired/i);
  });

  test('includes iss and aud from env when not provided (HS256)', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.JWT_ISS = 'https://example.com';
    process.env.JWT_AUD = 'my-audience';
    const token = sign({ sub: 'user-2' }, { expiresInSeconds: 60 });
    const payload = await verify(token);
    expect(payload.iss).toBe('https://example.com');
    expect(payload.aud).toBe('my-audience');
  });

  test('RS256 sign and verify via env keys', async () => {
    process.env.JWT_SIGNING_ALG = 'RS256';
    // generate a temporary keypair
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    process.env.JWT_PRIVATE_KEY = privPem;
    process.env.JWT_PUBLIC_KEY = pubPem;

    const token = sign({ sub: 'rs-user' }, { expiresInSeconds: 60 });
    const payload = await verify(token);
    expect(payload.sub).toBe('rs-user');
  });

  test('default expiry is 15 minutes', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'default-exp' });
    // decode without verifying to inspect claims
    const jsonwebtoken = await import('jsonwebtoken');
    const decoded: any = jsonwebtoken.decode(token);
    expect(decoded).toHaveProperty('iat');
    expect(decoded).toHaveProperty('exp');
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
  });

  test('tampered token fails verification', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'user-tamper' }, { expiresInSeconds: 60 });
    // simple tamper: flip last char of signature
    const parts = token.split('.');
    const sig = parts[2];
    const last = sig.slice(-1);
    const alt = last === 'a' ? 'b' : 'a';
    parts[2] = sig.slice(0, -1) + alt;
    const tampered = parts.join('.');
    await expect(verify(tampered)).rejects.toThrow(/invalid/i);
  });

  test('logs audit event on signature verification failure', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const spy = jest.spyOn(audit, 'logAudit').mockImplementation(async () => {});
    const token = sign({ sub: 'user-tamper' }, { expiresInSeconds: 60 });
    const parts = token.split('.');
    const sig = parts[2];
    const last = sig.slice(-1);
    const alt = last === 'a' ? 'b' : 'a';
    parts[2] = sig.slice(0, -1) + alt;
    const tampered = parts.join('.');
    await expect(verify(tampered)).rejects.toThrow(/invalid/i);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth_token_verify', outcome: 'failure', detail: 'signature_invalid' }));
  });

  test('logs audit event on issuer mismatch', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const spy = jest.spyOn(audit, 'logAudit').mockImplementation(async () => {});
    const token = sign({ sub: 'iss-user', iss: 'https://me' }, { expiresInSeconds: 60 });

    process.env.JWT_ISS = 'https://other';
    await expect(verify(token)).rejects.toThrow(/issuer/i);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_issuer' }));
  });

  test('logs audit event on audience mismatch', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const spy = jest.spyOn(audit, 'logAudit').mockImplementation(async () => {});
    const token = sign({ sub: 'aud-user', aud: 'my-aud' }, { expiresInSeconds: 60 });

    process.env.JWT_AUD = 'other-aud';
    await expect(verify(token)).rejects.toThrow(/audience|aud/i);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth_token_verify', outcome: 'failure', detail: 'invalid_audience' }));
  });

  test('rejects token with unexpected alg', async () => {
    // create HS256 token
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'alg-test' }, { expiresInSeconds: 60 });

    // change config to expect RS256 -> should fail with Unexpected token algorithm
    process.env.JWT_SIGNING_ALG = 'RS256';
    await expect(verify(token)).rejects.toThrow(/unexpected token algorithm/i);
  });

  test('rejects token when issuer mismatch', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'iss-user', iss: 'https://me' }, { expiresInSeconds: 60 });

    process.env.JWT_ISS = 'https://other';
    await expect(verify(token)).rejects.toThrow(/issuer/i);
  });

  test('rejects token when audience mismatch', async () => {
    process.env.JWT_SIGNING_ALG = 'HS256';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = sign({ sub: 'aud-user', aud: 'my-aud' }, { expiresInSeconds: 60 });

    process.env.JWT_AUD = 'other-aud';
    await expect(verify(token)).rejects.toThrow(/audience|aud/i);
  });
});
