/**
 * Login Cancel API Integration Tests
 * 対応 REQ: FREQ-334-REQ-06（別のアドレスでやり直すときに 2FA Cookie を捨てる）
 */

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/services/login-2fa-session', () => ({
  readLoginTwoFactorSessionFromCookieHeader: jest.fn(),
}));

jest.mock('@/lib/cookie', () => ({
  loginTwoFactorSessionCookieName: 'sb-login-2fa-session',
  clearCookieOptions: jest.fn(() => ({ path: '/', maxAge: 0 })),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) {
            this._cookies.push(c);
          },
          get(name: string) {
            return this._cookies.find((item: any) => item.name === name);
          },
        },
      };
      return res;
    },
  },
}));

const { logAudit } = require('@/lib/audit');
const {
  readLoginTwoFactorSessionFromCookieHeader,
} = require('@/features/auth/services/login-2fa-session');

let cancelHandler: any;

function buildRequest() {
  return new Request('http://localhost/api/auth/login/cancel', {
    method: 'POST',
    headers: { cookie: 'sb-login-2fa-session=whatever' },
  });
}

describe('POST /api/auth/login/cancel - Integration Tests', () => {
  beforeAll(async () => {
    cancelHandler = (await import('@/app/api/auth/login/cancel/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue({
      purpose: 'login_2fa',
      userId: 'user-123',
      email: 'test@example.com',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
  });

  test('[SUCCESS] 2FA Cookie を破棄して 200 を返す', async () => {
    const res: any = await cancelHandler(buildRequest());

    expect(res.status).toBe(200);
    const cleared = res.cookies.get('sb-login-2fa-session');
    expect(cleared).toBeDefined();
    expect(cleared.maxAge).toBe(0);
  });

  test('[AUDIT] 中断を監査ログに残す', async () => {
    await cancelHandler(buildRequest());

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'login',
        actor_email: 'test@example.com',
        outcome: 'cancelled',
      }),
    );
  });

  test('Cookie が無くても 200 で破棄指示を返す', async () => {
    // 既に切れている状態で押されても、利用者から見た結果は同じにする。
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue(null);

    const res: any = await cancelHandler(
      new Request('http://localhost/api/auth/login/cancel', { method: 'POST' }),
    );

    expect(res.status).toBe(200);
    expect(res.cookies.get('sb-login-2fa-session').maxAge).toBe(0);
    // 捨てるものが無ければ記録すべき事実も無い。無条件に書くと監査行を水増しできる。
    expect(logAudit).not.toHaveBeenCalled();
  });
});

// このファイルをモジュールとして扱わせる（他テストとの const 名衝突を防ぐ）。
export {};
