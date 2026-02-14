import { tokenHashSha256, hash, verify } from '../../../src/lib/hash';

describe('hash utilities', () => {
  test('tokenHashSha256 produces expected sha256 hex', async () => {
    const token = 'my-secret-token';
    const h = await tokenHashSha256(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/i);
    // deterministic
    expect(await tokenHashSha256(token)).toBe(h);
  });

  test('password hash and verify work', async () => {
    const pw = 'correct-horse-battery-staple';
    const hashed = await hash(pw);
    expect(typeof hashed).toBe('string');
    const ok = await verify(pw, hashed);
    expect(ok).toBe(true);
    const wrong = await verify('nope', hashed);
    expect(wrong).toBe(false);
  });

  test('verify falls back to sha256 token compare', async () => {
    const token = 'token123';
    const h = await tokenHashSha256(token);
    const ok = await verify(token, h);
    expect(ok).toBe(true);
  });
});
