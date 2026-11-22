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

  test('DD-AUTH-060 失敗の状態・通信の失敗・読めない本文は /login', async () => {
    await expect(resolvePostLoginPath((async () => json(500, {})) as never, origin)).resolves.toBe('/login');
    await expect(resolvePostLoginPath((async () => { throw new TypeError('x'); }) as never, origin)).resolves.toBe('/login');
    await expect(resolvePostLoginPath((async () => new Response('not json', { status: 200 })) as never, origin)).resolves.toBe('/login');
  });

  test('DD-AUTH-060 needsMfa で認めた鍵が1本の店員は /admin/passkeys?more=1', async () => {
    const loadStaff = jest.fn(async () => ({ ok: true as const, isStaff: true, approvedCount: 1, passkeys: [] }));
    await expect(
      resolvePostLoginPath((async () => json(200, { needsMfa: true, redirectTo: '/login?error=staff_passkey_required' })) as never, origin, loadStaff),
    ).resolves.toBe('/admin/passkeys?more=1');
  });

  test.each([
    ['鍵が2本以上', { ok: true as const, isStaff: true, approvedCount: 2, passkeys: [] }],
    ['鍵が0本', { ok: true as const, isStaff: true, approvedCount: 0, passkeys: [] }],
    ['店員でない', { ok: true as const, isStaff: false, approvedCount: 1, passkeys: [] }],
    ['鍵の数が読めない', { ok: false as const, reason: 'failed' as const }],
  ])('DD-AUTH-060 needsMfa で %s は /login?error=staff_passkey_required', async (_name, status) => {
    const loadStaff = jest.fn(async () => status);
    await expect(
      resolvePostLoginPath((async () => json(200, { needsMfa: true, redirectTo: '/x' })) as never, origin, loadStaff as never),
    ).resolves.toBe('/login?error=staff_passkey_required');
  });

  test('DD-AUTH-060 needsMfa でない成功は鍵の数を読まない', async () => {
    const loadStaff = jest.fn();
    await resolvePostLoginPath((async () => json(200, { redirectTo: '/account' })) as never, origin, loadStaff as never);
    expect(loadStaff).not.toHaveBeenCalled();
  });

  test('DD-AUTH-060 成功は redirectTo を sanitizeReturnPath にかけ、外のアドレスは / に倒す', async () => {
    await expect(resolvePostLoginPath((async () => json(200, { redirectTo: '/account/orders' })) as never, origin)).resolves.toBe('/account/orders');
    await expect(resolvePostLoginPath((async () => json(200, { redirectTo: 'https://evil.example/x' })) as never, origin)).resolves.toBe('/');
    await expect(resolvePostLoginPath((async () => json(200, {})) as never, origin)).resolves.toBe('/');
  });

  test.each([401, 500, 503])('DD-AUTH-060 状態 %i の応答でも本文を読み切る（bodyUsed）', async (status) => {
    const response = new Response('{"error":"x"}', { status });
    await resolvePostLoginPath((async () => response) as never, origin);
    expect(response.bodyUsed).toBe(true);
  });
});
