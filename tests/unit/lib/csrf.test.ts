import { generateCsrfToken, verifyAndRotateCsrf } from '../../../src/lib/csrf';
import { tokenHashSha256 } from '../../../src/lib/hash';

describe('csrf helpers', () => {
  test('generate returns a header-safe token', () => {
    const t = generateCsrfToken();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(20);
    expect(t).toMatch(/^[0-9a-f]+$/);
  });

  test('verifyAndRotateCsrf verifies and rotates', async () => {
    const token = generateCsrfToken();
    const storedHash = await tokenHashSha256(token);
    let storedNewHash: string | null = null;
    const storeNewHash = async (h: string) => {
      storedNewHash = h;
    };

    const res: any = await verifyAndRotateCsrf(token, storedHash, storeNewHash as any);
    expect(res.ok).toBe(true);
    expect(res.rotated).toBe(true);
    expect(typeof res.nextToken).toBe('string');
    expect(storedNewHash).toBe(await tokenHashSha256(res.nextToken));
  });

  test('verifyAndRotateCsrf accepts a percent-encoded transport token', async () => {
    const rawToken = '\u0001legacy-csrf-token';
    const storedHash = await tokenHashSha256(rawToken);
    let storedNewHash: string | null = null;
    const storeNewHash = async (hash: string) => {
      storedNewHash = hash;
    };

    const result: any = await verifyAndRotateCsrf(encodeURIComponent(rawToken), storedHash, storeNewHash as any);

    expect(result.ok).toBe(true);
    expect(result.rotated).toBe(true);
    expect(storedNewHash).toBe(await tokenHashSha256(result.nextToken));
  });
});
