// ログインの状態を答える窓口（DD-AUTH-026）の単体テスト。
// 共有の確かめ（authenticateRequest）だけを差し替え、役割・MFA・メールの決め方と、
// 全部の応答に付く見出しを見る。

import { GET } from '@/app/api/auth/me/route';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { staffIdlePeek } from '@/lib/auth/staff-passkey-idle-rpc';
import { staffEntryClaims } from '../../helpers/staff-claims';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
    }),
  },
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
}));

jest.mock('@/lib/auth/staff-passkey-idle-rpc', () => ({
  staffIdleCheck: jest.fn(),
  staffIdlePeek: jest.fn(),
  staffSessionTouch: jest.fn(),
}));

const mockedAuthenticateRequest = authenticateRequest as jest.Mock;
const mockedPeek = staffIdlePeek as jest.Mock;

const request = () => new Request('http://localhost:3000/api/auth/me');

const verifiedWith = (claims: Record<string, unknown>) => ({
  ok: true,
  claims: { sub: 'user-1', session_id: 'session-1', email: 'user@example.com', aal: 'aal1', app_metadata: { role: 'user' }, ...claims },
});

type MeResponse = Awaited<ReturnType<typeof GET>> & { headers: Map<string, string> };

const expectCommonHeaders = (res: MeResponse) => {
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
};

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedPeek.mockResolvedValue({ ok: true, value: true });
  });

  describe('店員の無操作1時間（DD-AUTH-081）', () => {
    const staffClaims = () => verifiedWith({ ...staffEntryClaims(), app_metadata: { role: 'admin' } });

    test('DD-AUTH-081 店員が無操作を過ぎていたら、時刻を進めない確かめ（peek）で authenticated:false・reason:idle を 200 で返す', async () => {
      mockedAuthenticateRequest.mockResolvedValue(staffClaims());
      mockedPeek.mockResolvedValue({ ok: true, value: false });

      const res = (await GET(request())) as MeResponse;

      expect(mockedPeek).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false, reason: 'idle' });
      expectCommonHeaders(res);
    });

    test('DD-AUTH-081 確かめの失敗は今の形（200・reason:unavailable）で返す（503 にしない）', async () => {
      mockedAuthenticateRequest.mockResolvedValue(staffClaims());
      mockedPeek.mockResolvedValue({ ok: false });

      const res = (await GET(request())) as MeResponse;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false, reason: 'unavailable' });
    });

    test('DD-AUTH-081 店員の通行証に session_id が無ければ確かめられないので unavailable（peek を呼ばない）', async () => {
      mockedAuthenticateRequest.mockResolvedValue({ ok: true, claims: { ...staffEntryClaims(), session_id: undefined, app_metadata: { role: 'admin' } } });

      const res = (await GET(request())) as MeResponse;

      expect(await res.json()).toEqual({ authenticated: false, reason: 'unavailable' });
      expect(mockedPeek).not.toHaveBeenCalled();
    });

    test('DD-AUTH-081 お客さんには無操作の確かめを呼ばない', async () => {
      mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ app_metadata: { role: 'user' } }));

      const res = (await GET(request())) as MeResponse;

      expect(mockedPeek).not.toHaveBeenCalled();
      expect((await res.json()).authenticated).toBe(true);
    });
  });

  test('DD-AUTH-026 確かめが通り、役割 admin で管理の入口の条件の印があれば mfaVerified が true で全応答の見出しが付く', async () => {
    mockedAuthenticateRequest.mockResolvedValue(
      verifiedWith({ ...staffEntryClaims(), sub: 'user-1', app_metadata: { role: 'admin' } }),
    );

    const req = request();
    const res = (await GET(req)) as MeResponse;

    expect(mockedAuthenticateRequest).toHaveBeenCalledWith(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      user: { id: 'user-1', role: 'admin', mfaVerified: true },
    });
    expectCommonHeaders(res);
  });

  test.each(['admin', 'supporter', 'user'])(
    'DD-AUTH-026 役割が許可の3つのひとつ（%s）ならその役割を返す',
    async (role) => {
      mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ app_metadata: { role } }));

      const body = await ((await GET(request())) as MeResponse).json();

      expect(body.user.role).toBe(role);
    },
  );

  test.each([
    { label: '役割のクレームが無い', appMetadata: {} },
    { label: 'app_metadata 自体が無い', appMetadata: undefined },
    { label: '知らない値（owner）', appMetadata: { role: 'owner' } },
    { label: '文字ではない値（数）', appMetadata: { role: 1 } },
    { label: 'null', appMetadata: { role: null } },
  ])('DD-AUTH-026 役割が $label なら user にする', async ({ appMetadata }) => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ app_metadata: appMetadata }));

    const res = (await GET(request())) as MeResponse;
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user.role).toBe('user');
  });

  // 表示のヒント。認めた本数は DB で数えず、JWT の印 staff_passkeys_ok が真なら足りる数・それ以外は 0（DD-AUTH-048）。
  test.each([
    { label: '今の passkey と印が真', claims: staffEntryClaims(), expected: true },
    { label: '印が偽（認めた鍵が足りない）', claims: staffEntryClaims({ staff_passkeys_ok: false }), expected: false },
    { label: '印が無い', claims: staffEntryClaims({ staff_passkeys_ok: undefined }), expected: false },
    { label: '印が文字列の "true"', claims: staffEntryClaims({ staff_passkeys_ok: 'true' }), expected: false },
    { label: 'passkey の時刻が24時間より前', claims: staffEntryClaims({ amr: [{ method: 'passkey', timestamp: Math.floor(Date.now() / 1000) - 86401 }] }), expected: false },
    { label: 'passkey が無い（otp だけ）', claims: staffEntryClaims({ amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }] }), expected: false },
    { label: 'aal2 でも passkey が無い', claims: { sub: 'user-1', aal: 'aal2' }, expected: false },
    { label: 'aal が aal1 でも今の passkey と印が真', claims: staffEntryClaims({ aal: 'aal1' }), expected: true },
  ])('DD-AUTH-048 $label のとき mfaVerified は $expected', async ({ claims, expected }) => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith(claims));

    const body = await ((await GET(request())) as MeResponse).json();

    expect(body.user.mfaVerified).toBe(expected);
  });

  test('DD-AUTH-026 認証済みの応答の user のキーは id・role・mfaVerified ちょうどで、メールの住所は載らない', async () => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ email: 'user@example.com' }));

    const body = await ((await GET(request())) as MeResponse).json();

    expect(Object.keys(body.user).sort()).toEqual(['id', 'mfaVerified', 'role']);
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  test('DD-AUTH-026 メールのクレームが無くても user のキーは同じ', async () => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ email: undefined }));

    const body = await ((await GET(request())) as MeResponse).json();

    expect(Object.keys(body.user).sort()).toEqual(['id', 'mfaVerified', 'role']);
  });

  test('DD-AUTH-026 理由が unavailable なら 503・Retry-After・no-store・no-referrer で答える', async () => {
    mockedAuthenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const res = (await GET(request())) as MeResponse;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ authenticated: false, reason: 'unavailable' });
    expect(res.headers.get('Retry-After')).toBe('30');
    expectCommonHeaders(res);
  });

  test.each(['missing', 'invalid', 'revoked'])(
    'DD-AUTH-026 理由が unavailable 以外（%s）なら 200 の authenticated:false で見出しも付く',
    async (reason) => {
      mockedAuthenticateRequest.mockResolvedValue({ ok: false, reason });

      const res = (await GET(request())) as MeResponse;

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false });
      expect(res.headers.has('Retry-After')).toBe(false);
      expectCommonHeaders(res);
    },
  );

  test('DD-AUTH-026 確かめが投げたら記録して 200 の authenticated:false で見出しも付く', async () => {
    const error = new Error('boom');
    mockedAuthenticateRequest.mockRejectedValue(error);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = (await GET(request())) as MeResponse;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
    expectCommonHeaders(res);
    expect(consoleError).toHaveBeenCalledWith('Auth me handler error:', error);
    consoleError.mockRestore();
  });
});
