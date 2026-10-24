// ログインの状態を答える窓口（DD-AUTH-026）の単体テスト。
// 共有の確かめ（authenticateRequest）だけを差し替え、役割・MFA・メールの決め方と、
// 全部の応答に付く見出しを見る。

import { GET } from '@/app/api/auth/me/route';
import { authenticateRequest } from '@/lib/auth/authenticate';

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

const mockedAuthenticateRequest = authenticateRequest as jest.Mock;

const request = () => new Request('http://localhost:3000/api/auth/me');

const verifiedWith = (claims: Record<string, unknown>) => ({
  ok: true,
  claims: { sub: 'user-1', email: 'user@example.com', aal: 'aal1', app_metadata: { role: 'user' }, ...claims },
});

type MeResponse = Awaited<ReturnType<typeof GET>> & { headers: Map<string, string> };

const expectCommonHeaders = (res: MeResponse) => {
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
};

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('DD-AUTH-026 確かめが通り、役割 admin・aal2 なら mfaVerified が true で全応答の見出しが付く', async () => {
    mockedAuthenticateRequest.mockResolvedValue(
      verifiedWith({ aal: 'aal2', app_metadata: { role: 'admin' } }),
    );

    const req = request();
    const res = (await GET(req)) as MeResponse;

    expect(mockedAuthenticateRequest).toHaveBeenCalledWith(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      user: { id: 'user-1', email: 'user@example.com', role: 'admin', mfaVerified: true },
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

  test.each([
    { aal: 'aal1', expected: false },
    { aal: 'aal2', expected: true },
    { aal: undefined, expected: false },
  ])('DD-AUTH-026 aal が $aal のとき mfaVerified は $expected', async ({ aal, expected }) => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ aal }));

    const body = await ((await GET(request())) as MeResponse).json();

    expect(body.user.mfaVerified).toBe(expected);
  });

  test('DD-AUTH-026 メールのクレームが無ければ email は null', async () => {
    mockedAuthenticateRequest.mockResolvedValue(verifiedWith({ email: undefined }));

    const body = await ((await GET(request())) as MeResponse).json();

    expect(body.user.email).toBeNull();
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
