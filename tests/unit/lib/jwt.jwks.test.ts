jest.mock('node-fetch', () => ({
  default: jest.fn(),
}));

import { sign, verify } from '../../../src/lib/jwt';
import fetchMock from 'node-fetch';

describe('jwt JWKS verification', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.JWT_JWKS_URL;
    delete process.env.JWT_SIGNING_ALG;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_KID;
    // clear JWKS cache in module
    const jwtLib = require('../../../src/lib/jwt');
    if (typeof jwtLib._clearJwksCache === 'function') jwtLib._clearJwksCache();
  });

  test('verifies token using JWKS (matching kid)', async () => {
    process.env.JWT_SIGNING_ALG = 'RS256';

    const { generateKeyPairSync } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    const pubJwk = publicKey.export({ format: 'jwk' }) as any;
    pubJwk.kid = 'jwks-test-kid';
    pubJwk.alg = 'RS256';

    process.env.JWT_PRIVATE_KEY = privPem;

    // mock JWKS endpoint
    // set global fetch so fetchJwks picks it up
    (globalThis as any).fetch = async (url: string) => ({ ok: true, json: async () => ({ keys: [pubJwk] }) });

    process.env.JWT_JWKS_URL = 'https://example.com/.well-known/jwks.json';
    process.env.JWT_KID = pubJwk.kid;

    const token = sign({ sub: 'jwks-user' }, { expiresInSeconds: 60 });
    const payload = await verify(token);
    expect(payload.sub).toBe('jwks-user');
  });

  test('falls back to first JWKS key when kid not matched', async () => {
    process.env.JWT_SIGNING_ALG = 'RS256';

    const { generateKeyPairSync } = await import('crypto');
    const kp1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kp2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // sign with the first key so fallback to first JWKS key succeeds
    const privPem = kp1.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    const pubJwk1 = kp1.publicKey.export({ format: 'jwk' }) as any;
    const pubJwk2 = kp2.publicKey.export({ format: 'jwk' }) as any;
    pubJwk1.kid = 'first-key';
    pubJwk2.kid = 'second-key';

    process.env.JWT_PRIVATE_KEY = privPem;
    process.env.JWT_JWKS_URL = 'https://example.com/.well-known/jwks.json';
    // intentionally set JWT_KID to a non-existent kid to test fallback
    process.env.JWT_KID = 'non-existent-kid';

    (globalThis as any).fetch = async (url: string) => ({ ok: true, json: async () => ({ keys: [pubJwk1, pubJwk2] }) });

    const token = sign({ sub: 'fallback-user' }, { expiresInSeconds: 60 });
    const payload = await verify(token);
    expect(payload.sub).toBe('fallback-user');
  });
});
