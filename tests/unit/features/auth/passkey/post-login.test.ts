/**
 * DD-AUTH-060 ログイン後の行き先（src/features/auth/passkey/post-login.ts）の単体テスト。
 */
import { resolvePostLoginPath } from '@/features/auth/passkey/post-login';

const origin = 'https://example.test';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('DD-AUTH-060 resolvePostLoginPath', () => {
  test('DD-AUTH-060 POST /api/auth/post-login を no-store・same-origin で呼ぶ', async () => {
    const fetchApp = jest.fn(async () => json(200, { redirectTo: '/account' }));
    await resolvePostLoginPath(fetchApp as never, origin);
    expect(fetchApp).toHaveBeenCalledWith('/api/auth/post-login', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  test('DD-AUTH-060 401 は /login', async () => {
    await expect(resolvePostLoginPath((async () => json(401, {})) as never, origin)).resolves.toBe('/login');
  });

  test('DD-AUTH-060 失敗の状態・通信の失敗・読めない本文・needsMfa は /auth/verified', async () => {
    await expect(resolvePostLoginPath((async () => json(500, {})) as never, origin)).resolves.toBe('/auth/verified');
    await expect(resolvePostLoginPath((async () => { throw new TypeError('x'); }) as never, origin)).resolves.toBe('/auth/verified');
    await expect(resolvePostLoginPath((async () => new Response('not json', { status: 200 })) as never, origin)).resolves.toBe('/auth/verified');
    await expect(resolvePostLoginPath((async () => json(200, { needsMfa: true, redirectTo: '/account' })) as never, origin)).resolves.toBe('/auth/verified');
  });

  test('DD-AUTH-060 成功は redirectTo を sanitizeReturnPath にかけ、外のアドレスは / に倒す', async () => {
    await expect(resolvePostLoginPath((async () => json(200, { redirectTo: '/account/orders' })) as never, origin)).resolves.toBe('/account/orders');
    await expect(resolvePostLoginPath((async () => json(200, { redirectTo: 'https://evil.example/x' })) as never, origin)).resolves.toBe('/');
    await expect(resolvePostLoginPath((async () => json(200, {})) as never, origin)).resolves.toBe('/');
  });
});
