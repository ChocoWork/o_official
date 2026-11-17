/**
 * DD-AUTH-060 窓口を呼ぶ部品（src/features/auth/passkey/passkey-client.ts）の、形の崩れた応答・省いた引数の単体テスト。
 */
const clientFetchMock = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => clientFetchMock(...args) }));

import { listPasskeys, loginWithPasskey, registerPasskey, renamePasskey } from '@/features/auth/passkey/passkey-client';
import { resolvePostLoginPath } from '@/features/auth/passkey/post-login';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const options = { challenge: 'AQID', rpId: 'localhost', userVerification: 'required' };
const credential = { id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key', response: { clientDataJSON: 'a' } };
const okStart = async () => ({ ok: true as const, start: { challenge_id: 'c', options, expires_at: 1 } });
const okAssert = async () => ({ ok: true as const, credential });

async function withGlobalFetch<T>(response: Response, run: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  global.fetch = jest.fn(async () => response) as never;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
}

describe('DD-AUTH-060 省いた引数', () => {
  test('DD-AUTH-060 loginWithPasskey は fetchApp を省くとグローバルの fetch を使い、role が無ければ user', async () => {
    const result = await withGlobalFetch(json(200, { user: { id: 'u1' } }), () =>
      loginWithPasskey({ start: okStart as never, assert: okAssert as never }),
    );
    expect(result).toEqual({ ok: true, user: { id: 'u1', email: null, role: 'user' } });
  });

  test('DD-AUTH-060 resolvePostLoginPath は fetch・origin を省くと、グローバルの fetch と window.location.origin を使う', async () => {
    await expect(withGlobalFetch(json(200, { redirectTo: '/account' }), () => resolvePostLoginPath())).resolves.toBe('/account');
  });
});

describe('DD-AUTH-060 形の崩れた応答', () => {
  const login = (response: Response) =>
    loginWithPasskey({ start: okStart as never, assert: okAssert as never, fetchApp: (async () => response) as never });

  test('DD-AUTH-060 終わりの失敗が JSON でない・配列・Retry-After が 0 でも落ちない', async () => {
    await expect(login(new Response('boom', { status: 500 }))).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(login(json(401, []))).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(login(json(429, {}, { 'Retry-After': '0' }))).resolves.toEqual({ ok: false, reason: 'rate_limited' });
  });

  test('DD-AUTH-060 鍵の選択が already_registered を返しても failed にそろえる', async () => {
    const result = await loginWithPasskey({
      start: okStart as never,
      assert: (async () => ({ ok: false, reason: 'already_registered' })) as never,
      fetchApp: jest.fn() as never,
    });
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  test('DD-AUTH-060 registerPasskey: 403 の本文が JSON でなければ failed。終わりの本文が JSON でない成功も failed', async () => {
    const make = (responses: Response[]) => {
      const queue = [...responses];
      return registerPasskey({
        fetchApi: (async () => queue.shift()) as never,
        create: (async () => ({ ok: true, credential })) as never,
        deviceName: 'iPhone',
      });
    };
    await expect(make([new Response('x', { status: 403 })])).resolves.toEqual({ ok: false, reason: 'failed' });
    const start = json(200, { challenge_id: 'c', options: { challenge: 'AQID' } });
    await expect(make([start, new Response('x', { status: 200 })])).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  test('DD-AUTH-060 registerPasskey: 終わりの応答に friendly_name が在れば控える（名前の変更が失敗しても残る）', async () => {
    const queue = [
      json(200, { challenge_id: 'c', options: { challenge: 'AQID' } }),
      json(200, { passkey: { id: 'k1', friendly_name: 'もとの名前', created_at: 'c' } }),
      json(502, {}),
    ];
    const result = await registerPasskey({
      fetchApi: (async () => queue.shift()) as never,
      create: (async () => ({ ok: true, credential })) as never,
      deviceName: 'iPhone',
    });
    expect(result).toEqual({
      ok: true,
      passkey: { id: 'k1', friendly_name: 'もとの名前', created_at: 'c' },
      nameApplied: false,
    });
  });

  test('DD-AUTH-060 一覧・名前の変更: 本文が JSON でない成功・passkeys の無い成功は failed', async () => {
    clientFetchMock.mockResolvedValue(new Response('x', { status: 200 }));
    await expect(listPasskeys()).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(renamePasskey('k1', 'x')).resolves.toEqual({ ok: false, reason: 'failed' });
    clientFetchMock.mockResolvedValue(json(200, {}));
    await expect(listPasskeys()).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
