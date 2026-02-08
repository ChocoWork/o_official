import { generateCsrfToken, verifyAndRotateCsrf } from '../../../src/lib/csrf';
import { tokenHashSha256 } from '../../../src/lib/hash';

describe('csrf helpers', () => {
  test('generate returns a token', () => {
    const t = generateCsrfToken();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(20);
  });

  test('verifyAndRotateCsrf verifies and rotates', async () => {
    const token = generateCsrfToken();
    const storedHash = tokenHashSha256(token);
    let storedNewHash: string | null = null;
    const storeNewHash = async (h: string) => {
      storedNewHash = h;
    };

    const res: any = await verifyAndRotateCsrf(token, storedHash, storeNewHash as any);
    expect(res.ok).toBe(true);
    expect(res.rotated).toBe(true);
    expect(typeof res.nextToken).toBe('string');
    expect(storedNewHash).toBe(tokenHashSha256(res.nextToken));
  });
});
