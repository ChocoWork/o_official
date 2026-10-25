/**
 * DD-AUTH-017 保留の取り消しの窓口（src/app/api/auth/login/cancel/route.ts）の単体テスト。
 * 共有部品（Cookie 名と消去の設定・保留の読み取り・監査）は差し替え、窓口の分岐だけを確かめる。
 */

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/features/auth/services/login-2fa-session', () => ({
  readLoginTwoFactorSessionFromCookieHeader: jest.fn(),
}));

jest.mock('@/lib/cookie', () => ({
  ...jest.requireActual('@/lib/cookie'),
  loginTwoFactorSessionCookieName: 'sb-login-2fa-session',
  clearCookieOptions: jest.fn(() => ({ path: '/', maxAge: 0, httpOnly: true })),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: {
        _cookies: [] as Array<Record<string, unknown>>,
        set(cookie: Record<string, unknown>) {
          this._cookies.push(cookie);
        },
        get(name: string) {
          return this._cookies.find((item) => item.name === name);
        },
      },
    }),
  },
}));

import { logAudit } from '@/lib/audit';
import { readLoginTwoFactorSessionFromCookieHeader } from '@/features/auth/services/login-2fa-session';
import { POST } from '@/app/api/auth/login/cancel/route';

const mockLogAudit = logAudit as jest.Mock;
const mockReadPending = readLoginTwoFactorSessionFromCookieHeader as jest.Mock;

const PENDING = {
  purpose: 'login_2fa',
  userId: 'user-123',
  email: 'test@example.com',
  exp: Math.floor(Date.now() / 1000) + 300,
};

function buildRequest(cookie?: string) {
  return new Request('http://localhost/api/auth/login/cancel', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

describe('POST /api/auth/login/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
    mockReadPending.mockReturnValue(PENDING);
  });

  it('DD-AUTH-017 保留が有効なら 200 の { ok: true } を no-store で返し、保留の Cookie を消す', async () => {
    const res: any = await POST(buildRequest('sb-login-2fa-session=whatever'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const cleared = res.cookies.get('sb-login-2fa-session');
    expect(cleared).toEqual({
      name: 'sb-login-2fa-session',
      value: '',
      path: '/',
      maxAge: 0,
      httpOnly: true,
    });
  });

  it('DD-AUTH-017 保留が有効なら宛先を保留のメールにして login の cancelled を otp_step_abandoned で残す', async () => {
    await POST(buildRequest('sb-login-2fa-session=whatever'));

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: 'test@example.com',
      outcome: 'cancelled',
      detail: 'otp_step_abandoned',
    });
  });

  it('DD-AUTH-017 要求の cookie ヘッダをそのまま保留の読み取りへ渡す', async () => {
    await POST(buildRequest('a=1; sb-login-2fa-session=whatever'));

    expect(mockReadPending).toHaveBeenCalledWith('a=1; sb-login-2fa-session=whatever');
  });

  it('DD-AUTH-017 cookie ヘッダが無ければ null を渡し、保留が無いので監査を書かずに同じ 200 と Cookie の消去を返す', async () => {
    mockReadPending.mockReturnValue(null);

    const res: any = await POST(buildRequest());

    expect(mockReadPending).toHaveBeenCalledWith(null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.cookies.get('sb-login-2fa-session').maxAge).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-017 保留が無効（読み取りが null）なら Cookie があっても監査を書かない', async () => {
    mockReadPending.mockReturnValue(null);

    const res: any = await POST(buildRequest('sb-login-2fa-session=expired'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('sb-login-2fa-session').value).toBe('');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('DD-AUTH-017 監査が投げると例外がそのまま出る（窓口は包まない）', async () => {
    mockLogAudit.mockRejectedValue(new Error('audit down'));

    await expect(POST(buildRequest('sb-login-2fa-session=whatever'))).rejects.toThrow('audit down');
  });

  it('DD-AUTH-017 保留の有無に関わらず、戻り先の控えの Cookie を Max-Age 0 の空の値で消す', async () => {
    const withPending: any = await POST(buildRequest('sb-return-intent=' + 'A'.repeat(43)));
    mockReadPending.mockReturnValue(null);
    const withoutPending: any = await POST(buildRequest());

    for (const res of [withPending, withoutPending]) {
      expect(res.cookies.get('sb-return-intent')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    }
  });
});
