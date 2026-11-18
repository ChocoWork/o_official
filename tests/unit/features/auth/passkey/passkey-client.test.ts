/**
 * DD-AUTH-060 1b の窓口を呼ぶ部品（src/features/auth/passkey/passkey-client.ts）の単体テスト。
 */
const clientFetchMock = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => clientFetchMock(...args) }));

import {
  deletePasskey,
  listPasskeys,
  loginWithPasskey,
  registerPasskey,
  renamePasskey,
} from '@/features/auth/passkey/passkey-client';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const startOptions = { challenge: 'AQID', rpId: 'localhost', userVerification: 'required' };
const credential = { id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key', response: { clientDataJSON: 'a' } };

describe('DD-AUTH-060 loginWithPasskey', () => {
  const okStart = jest.fn(async () => ({
    ok: true as const,
    start: { challenge_id: 'chal-1', options: startOptions, expires_at: 1 },
  }));
  const okAssert = jest.fn(async () => ({ ok: true as const, credential }));

  beforeEach(() => {
    okStart.mockClear();
    okAssert.mockClear();
  });

  const run = (finish: Response | Error, extra: Record<string, unknown> = {}) => {
    const fetchApp = jest.fn(async () => {
      if (finish instanceof Error) throw finish;
      return finish;
    });
    const promise = loginWithPasskey({
      start: okStart as never,
      assert: okAssert as never,
      fetchApp: fetchApp as never,
      ...extra,
    });
    return { promise, fetchApp };
  };

  test('DD-AUTH-060 成功: 終わりへ challenge_id・credential・next を POST し、user を返す', async () => {
    const { promise, fetchApp } = run(json(200, { user: { id: 'u1', email: 'a@example.com', role: 'user' } }), {
      next: '/account',
    });
    await expect(promise).resolves.toEqual({ ok: true, user: { id: 'u1', email: 'a@example.com', role: 'user' } });
    expect(okAssert).toHaveBeenCalledWith(startOptions);
    const [url, init] = fetchApp.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/passkey/login/finish');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({ challenge_id: 'chal-1', credential, next: '/account' });
  });

  test('DD-AUTH-060 next が無ければ本文に next を入れない。captchaToken は始めへ渡す', async () => {
    const { promise, fetchApp } = run(json(200, { user: { id: 'u1', email: null, role: 'user' } }), { captchaToken: 'cap' });
    await promise;
    expect(okStart).toHaveBeenCalledWith({ captchaToken: 'cap' });
    const init = (fetchApp.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect('next' in JSON.parse(init.body as string)).toBe(false);
  });

  test.each([
    [{ ok: false, reason: 'rate_limited', retryAfterSeconds: 30 }, { ok: false, reason: 'rate_limited', retryAfterSeconds: 30 }],
    [{ ok: false, reason: 'unavailable' }, { ok: false, reason: 'unavailable' }],
    [{ ok: false, reason: 'captcha_required' }, { ok: false, reason: 'captcha_required' }],
    [{ ok: false, reason: 'failed' }, { ok: false, reason: 'failed' }],
  ])('DD-AUTH-060 始めの失敗 %j はそのまま返し、鍵の選択・終わりを呼ばない', async (started, expected) => {
    const fetchApp = jest.fn();
    const result = await loginWithPasskey({
      start: (async () => started) as never,
      assert: okAssert as never,
      fetchApp: fetchApp as never,
    });
    expect(result).toEqual(expected);
    expect(okAssert).not.toHaveBeenCalled();
    expect(fetchApp).not.toHaveBeenCalled();
  });

  test.each(['cancelled', 'unsupported', 'failed'] as const)('DD-AUTH-060 鍵の選択の %s はそのまま返し、終わりを呼ばない', async (reason) => {
    const fetchApp = jest.fn();
    const result = await loginWithPasskey({
      start: okStart as never,
      assert: (async () => ({ ok: false, reason })) as never,
      fetchApp: fetchApp as never,
    });
    expect(result).toEqual({ ok: false, reason });
    expect(fetchApp).not.toHaveBeenCalled();
  });

  test.each([
    [401, { error: 'passkey_login_failed' }, 'not_found'],
    [400, { error: 'uv_required' }, 'uv_required'],
    [403, { error: 'staff_passkey_required' }, 'staff_blocked'],
    [403, { error: 'passkey_not_approved' }, 'staff_blocked'],
    [503, { error: 'passkey_login_unavailable' }, 'unavailable'],
    [502, {}, 'unavailable'],
    [409, {}, 'unavailable'],
    [400, { error: 'invalid_request' }, 'failed'],
    [500, { error: 'x' }, 'failed'],
  ])('DD-AUTH-060 終わりの %i %j は %s', async (status, body, reason) => {
    const { promise } = run(json(status, body));
    await expect(promise).resolves.toEqual({ ok: false, reason });
  });

  test('DD-AUTH-060 終わりの 429 は rate_limited で Retry-After を秒で返す', async () => {
    const { promise } = run(json(429, { error: 'Too many requests' }, { 'Retry-After': '120' }));
    await expect(promise).resolves.toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 120 });
    const { promise: noHeader } = run(json(429, {}));
    await expect(noHeader).resolves.toEqual({ ok: false, reason: 'rate_limited' });
  });

  test('DD-AUTH-060 通信の失敗・形の違う成功は failed', async () => {
    await expect(run(new TypeError('network')).promise).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(run(json(200, { user: {} })).promise).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(run(new Response('x', { status: 200 })).promise).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('DD-AUTH-060 registerPasskey', () => {
  const startBody = { challenge_id: 'chal-9', options: { challenge: 'AQID' }, expires_at: 1, mode: 'normal' };
  const passkey = { id: 'k1', friendly_name: null, created_at: '2026-11-18T00:00:00Z' };

  function setup(responses: Array<Response | Error>, createResult: unknown = { ok: true, credential }) {
    const queue = [...responses];
    const fetchApi = jest.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next as Response;
    });
    const create = jest.fn(async () => createResult);
    const run = () => registerPasskey({ fetchApi: fetchApi as never, create: create as never, deviceName: 'iPhone' });
    return { fetchApi, create, run };
  }

  test('DD-AUTH-060 成功: 始め → 作成 → 終わり → 名前の PATCH の順で、nameApplied が真', async () => {
    const { fetchApi, create, run } = setup([
      json(200, startBody),
      json(200, { passkey }),
      json(200, { passkey: { id: 'k1', friendly_name: 'iPhone' } }),
    ]);
    await expect(run()).resolves.toEqual({
      ok: true,
      passkey: { id: 'k1', friendly_name: 'iPhone', created_at: passkey.created_at },
      nameApplied: true,
    });
    const calls = fetchApi.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST /api/auth/passkey/register/start',
      'POST /api/auth/passkey/register/finish',
      'PATCH /api/auth/passkey/k1',
    ]);
    expect(create).toHaveBeenCalledWith(startBody.options);
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ challenge_id: 'chal-9', credential });
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ friendly_name: 'iPhone' });
  });

  test('DD-AUTH-060 名前の PATCH が失敗しても ok: true で nameApplied: false', async () => {
    for (const patch of [json(502, { error: 'passkey_manage_failed' }), new TypeError('network')]) {
      const { run } = setup([json(200, startBody), json(200, { passkey }), patch]);
      await expect(run()).resolves.toEqual({ ok: true, passkey, nameApplied: false });
    }
  });

  test.each([
    [403, { error: 'registration_not_allowed', reason: 'reauth_required' }, 'reauth_required'],
    [403, { error: 'registration_not_allowed', reason: 'window_closed' }, 'window_closed'],
    [403, { error: 'registration_not_allowed', reason: 'other' }, 'failed'],
    [401, { error: 'Unauthorized' }, 'unauthorized'],
    [429, {}, 'rate_limited'],
    [502, { error: 'passkey_register_failed' }, 'retry'],
    [400, { error: 'uv_required' }, 'retry'],
    [400, { error: 'invalid_request' }, 'retry'],
    [503, { error: 'passkey_register_unavailable' }, 'unavailable'],
    [500, {}, 'failed'],
  ])('DD-AUTH-060 始めの %i %j は %s', async (status, body, reason) => {
    const { create, run } = setup([json(status, body)]);
    await expect(run()).resolves.toEqual({ ok: false, reason });
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    [403, { error: 'registration_not_allowed', reason: 'reauth_required' }, 'reauth_required'],
    [403, { error: 'registration_not_allowed', reason: 'window_closed' }, 'window_closed'],
    [401, {}, 'unauthorized'],
    [502, { error: 'passkey_register_failed' }, 'retry'],
    [400, { error: 'uv_required' }, 'retry'],
    [503, {}, 'unavailable'],
  ])('DD-AUTH-060 終わりの %i %j は %s', async (status, body, reason) => {
    const { fetchApi, run } = setup([json(200, startBody), json(status, body)]);
    await expect(run()).resolves.toEqual({ ok: false, reason });
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  test.each(['cancelled', 'already_registered', 'unsupported', 'failed'] as const)(
    'DD-AUTH-060 鍵の作成の %s はそのまま返し、終わりを呼ばない',
    async (reason) => {
      const { fetchApi, run } = setup([json(200, startBody)], { ok: false, reason });
      await expect(run()).resolves.toEqual({ ok: false, reason });
      expect(fetchApi).toHaveBeenCalledTimes(1);
    },
  );

  test('DD-AUTH-060 通信の失敗・形の違う応答は failed', async () => {
    await expect(setup([new TypeError('network')]).run()).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(setup([json(200, {})]).run()).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(setup([json(200, startBody), json(200, { passkey: {} })]).run()).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('DD-AUTH-060 listPasskeys・renamePasskey・deletePasskey', () => {
  beforeEach(() => clientFetchMock.mockReset());

  test('DD-AUTH-060 一覧: GET で読み、お客さんの形を返す', async () => {
    clientFetchMock.mockResolvedValue(
      json(200, {
        passkeys: [{ id: 'k1', friendly_name: 'iPhone', created_at: 'c', last_used_at: null }],
        isStaff: false,
      }),
    );
    await expect(listPasskeys()).resolves.toEqual({
      ok: true,
      passkeys: [{ id: 'k1', friendly_name: 'iPhone', created_at: 'c', last_used_at: null }],
    });
    expect(clientFetchMock).toHaveBeenCalledWith('/api/auth/passkey', { method: 'GET' });
  });

  test('DD-AUTH-060 一覧: 店員の項目（isStaff・approved・approvedCount）は返さない', async () => {
    clientFetchMock.mockResolvedValue(
      json(200, {
        passkeys: [{ id: 'k1', friendly_name: null, created_at: 'c', last_used_at: 'l', approved: true }],
        isStaff: true,
        approvedCount: 1,
      }),
    );
    await expect(listPasskeys()).resolves.toEqual({
      ok: true,
      passkeys: [{ id: 'k1', friendly_name: null, created_at: 'c', last_used_at: 'l' }],
    });
  });

  test('DD-AUTH-060 名前の変更: PATCH で friendly_name を送る', async () => {
    clientFetchMock.mockResolvedValue(json(200, { passkey: { id: 'k 1', friendly_name: '新しい名前' } }));
    await expect(renamePasskey('k 1', '新しい名前')).resolves.toEqual({
      ok: true,
      passkey: { id: 'k 1', friendly_name: '新しい名前' },
    });
    const [url, init] = clientFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/passkey/k%201');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ friendly_name: '新しい名前' });
  });

  test('DD-AUTH-060 削除: DELETE を送る', async () => {
    clientFetchMock.mockResolvedValue(json(200, { ok: true }));
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: true });
    expect(clientFetchMock).toHaveBeenCalledWith('/api/auth/passkey/k1', { method: 'DELETE' });
  });

  test.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [502, 'failed'],
    [409, 'failed'],
    [500, 'failed'],
  ])('DD-AUTH-060 一覧・名前・削除の %i は %s', async (status, reason) => {
    clientFetchMock.mockImplementation(async () => json(status, {}));
    await expect(listPasskeys()).resolves.toEqual({ ok: false, reason });
    await expect(renamePasskey('k1', 'x')).resolves.toEqual({ ok: false, reason });
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason });
  });

  test('DD-AUTH-060 通信の失敗・形の違う成功は failed', async () => {
    clientFetchMock.mockRejectedValue(new TypeError('network'));
    await expect(listPasskeys()).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(renamePasskey('k1', 'x')).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(deletePasskey('k1')).resolves.toEqual({ ok: false, reason: 'failed' });
    clientFetchMock.mockResolvedValue(json(200, { passkeys: [{ id: 1 }] }));
    await expect(listPasskeys()).resolves.toEqual({ ok: false, reason: 'failed' });
    clientFetchMock.mockResolvedValue(json(200, {}));
    await expect(renamePasskey('k1', 'x')).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
