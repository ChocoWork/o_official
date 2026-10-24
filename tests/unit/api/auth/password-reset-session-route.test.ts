/**
 * 再設定の Cookie の状態の窓口の単体テスト（DD-AUTH-024）。
 * 印の署名と期限の判定は本物の共有の関数を通し、応答の部品だけ差し替える。
 */

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: { set: jest.fn() },
    }),
  },
}));

import { createPasswordResetSessionToken } from '@/features/auth/services/password-reset-session';
import { passwordResetSessionCookieName } from '@/lib/cookie';
import { GET } from '@/app/api/auth/password-reset/session/route';

type RouteResponse = {
  status: number;
  headers: Map<string, string>;
  json: () => Promise<{ ready: boolean; email: string | null }>;
  cookies: { set: jest.Mock };
};

const SECRET_KEYS = ['PASSWORD_RESET_SESSION_SECRET', 'JWT_SECRET'] as const;

function sessionRequest(cookie?: string) {
  return new Request('http://localhost/api/auth/password-reset/session', {
    method: 'GET',
    headers: cookie === undefined ? {} : { cookie },
  });
}

function callGet(cookie?: string) {
  return GET(sessionRequest(cookie)) as unknown as Promise<RouteResponse>;
}

function cookieFor(token: string) {
  return `${passwordResetSessionCookieName}=${encodeURIComponent(token)}`;
}

describe('再設定の Cookie の状態の窓口', () => {
  const savedEnv: Partial<Record<(typeof SECRET_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const key of SECRET_KEYS) savedEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of SECRET_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    process.env.PASSWORD_RESET_SESSION_SECRET = 'unit-test-reset-secret';
  });

  it('DD-AUTH-024 有効な印なら ready: true と宛先を 200 で返し、no-store を付けて Cookie は消さない', async () => {
    const token = createPasswordResetSessionToken({ userId: 'user-123', email: 'test@example.com', tokenId: 'token-123' });

    const res = await callGet(cookieFor(token));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, email: 'test@example.com' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.cookies.set).not.toHaveBeenCalled();
  });

  it('DD-AUTH-024 Cookie の見出しが無ければ ready: false と宛先 null にし、Cookie を寿命 0 で消す', async () => {
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.cookies.set).toHaveBeenCalledTimes(1);
    expect(res.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: passwordResetSessionCookieName,
        value: '',
        maxAge: 0,
        httpOnly: true,
        sameSite: 'strict',
      })
    );
  });

  it('DD-AUTH-024 再設定の印を含まない Cookie だけなら ready: false にして消す', async () => {
    const res = await callGet('theme=dark; other=1');

    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: passwordResetSessionCookieName, maxAge: 0 }));
  });

  it('DD-AUTH-024 署名が誤りの印なら ready: false にして消す', async () => {
    const token = createPasswordResetSessionToken({ userId: 'user-123', email: 'test@example.com', tokenId: 'token-123' });
    const [payload] = token.split('.');
    const forged = `${payload}.${'A'.repeat(43)}`;

    const res = await callGet(cookieFor(forged));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ value: '', maxAge: 0 }));
  });

  it('DD-AUTH-024 期限が切れた印なら ready: false にして消す', async () => {
    const token = createPasswordResetSessionToken({
      userId: 'user-123',
      email: 'test@example.com',
      tokenId: 'token-123',
      expiresInSeconds: -10,
    });

    const res = await callGet(cookieFor(token));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ value: '', maxAge: 0 }));
  });

  it('DD-AUTH-024 印の値が空なら ready: false にして消す', async () => {
    const res = await callGet(`${passwordResetSessionCookieName}=`);

    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ maxAge: 0 }));
  });
});
