import { sign, verify, _clearJwksCache } from '../../../src/lib/jwt';

describe('JWKS integration-like tests', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.JWT_JWKS_URL;
    delete process.env.JWT_SIGNING_ALG;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_KID;
    // clear JWKS cache
    _clearJwksCache();
    delete (globalThis as any).fetch;
  });

  test('fetch failure surfaces error', async () => {
    process.env.JWT_SIGNING_ALG = 'RS256';
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    process.env.JWT_PRIVATE_KEY = privPem;

    // JWKS endpoint returns non-ok
    (globalThis as any).fetch = async (url: string) => ({ ok: false, status: 500 });
    process.env.JWT_JWKS_URL = 'https://example.com/.well-known/jwks.json';

    const token = sign({ sub: 'user-fetch-error' }, { expiresInSeconds: 60 });
    await expect(verify(token)).rejects.toThrow(/Failed to fetch JWKS/);
  });

  test('key rotation: initially fails then succeeds after JWKS updated', async () => {
    process.env.JWT_SIGNING_ALG = 'RS256';

    const { generateKeyPairSync } = await import('crypto');
    const kpA = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kpB = generateKeyPairSync('rsa', { modulusLength: 2048 });

    // Sign with key B
    const privB = kpB.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    process.env.JWT_PRIVATE_KEY = privB;

    const pubJwkA = kpA.publicKey.export({ format: 'jwk' }) as any;
    pubJwkA.kid = 'a';
    const pubJwkB = kpB.publicKey.export({ format: 'jwk' }) as any;
    pubJwkB.kid = 'b';

    process.env.JWT_JWKS_URL = 'https://example.com/.well-known/jwks.json';

    // JWKS initially only contains A
    (globalThis as any).fetch = async (url: string) => ({ ok: true, json: async () => ({ keys: [pubJwkA] }) });

    const token = sign({ sub: 'rot-user' }, { expiresInSeconds: 60 });

    // verify should fail because JWKS only has A
    await expect(verify(token)).rejects.toThrow(/Invalid token/);

    // Now JWKS rotated to include B as well; clear cache and update fetch
    (globalThis as any).fetch = async (url: string) => ({ ok: true, json: async () => ({ keys: [pubJwkA, pubJwkB] }) });
    _clearJwksCache();

    const payload = await verify(token);
    expect(payload.sub).toBe('rot-user');
  });
});