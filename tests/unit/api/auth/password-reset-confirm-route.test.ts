// パスワード再設定の確定の窓口（DD-AUTH-025）の単体テスト。
// 再設定の Cookie の署名・寿命と Cookie 名は本物の共有部品を使い、DB・漏洩照合・制限・メール・監査を差し替える。

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: (fn: () => unknown) => {
    mockAfterCallbacks.push(fn);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookieCalls: Array<Record<string, unknown>> = [];
      return {
        status: init?.status ?? 200,
        _body: body,
        _cookies: cookieCalls,
        cookies: {
          set: (cookie: Record<string, unknown>) => {
            cookieCalls.push(cookie);
          },
        },
        json: async () => body,
      };
    },
  },
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockSendMail = jest.fn();
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

const mockCheckPwnedPassword = jest.fn();
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: (...args: unknown[]) => mockCheckPwnedPassword(...args),
  PWNED_PASSWORD_MESSAGE: 'pwned-message',
}));

const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));

import { POST } from '@/app/api/auth/password-reset/confirm/route';
import {
  accessCookieName,
  csrfCookieName,
  passwordResetSessionCookieName,
  refreshCookieName,
} from '@/lib/cookie';
import { createPasswordResetSessionToken } from '@/features/auth/services/password-reset-session';

const VALID_PASSWORD = 'a-very-long-password-1';

type Result = { data?: unknown; error: unknown };
type FakeResponse = {
  status: number;
  _body: unknown;
  _cookies: Array<Record<string, unknown>>;
};

// 各 DB 操作の結果。テストごとに差し替える。
let lookupResult: Result;
let claimResult: Result;
let deleteResult: Result;
let appSessionResult: Result;
let rpcResult: Result;
let updateUserResult: Result;

// DB 操作を呼ばれた順に残す（順序が大事な所の確かめ用）。
let callLog: string[];
const mockUpdateUserById = jest.fn();
const mockRpc = jest.fn();
const mockTokenSelectEqId = jest.fn();
const mockTokenSelectEqUsed = jest.fn();
const mockTokenClaimEqId = jest.fn();
const mockTokenClaimEqUsed = jest.fn();
const mockTokenDeleteEqId = jest.fn();
const mockSessionsUpdate = jest.fn();
const mockSessionsEq = jest.fn();

function buildServiceClient() {
  return {
    auth: {
      admin: {
        updateUserById: (...args: unknown[]) => {
          callLog.push('updateUserById');
          mockUpdateUserById(...args);
          return Promise.resolve(updateUserResult);
        },
      },
    },
    rpc: (...args: unknown[]) => {
      callLog.push('rpc');
      mockRpc(...args);
      return Promise.resolve(rpcResult);
    },
    from: (table: string) => {
      if (table === 'sessions') {
        return {
          update: (...args: unknown[]) => {
            callLog.push('sessions.update');
            mockSessionsUpdate(...args);
            return {
              eq: (...eqArgs: unknown[]) => {
                mockSessionsEq(...eqArgs);
                return Promise.resolve(appSessionResult);
              },
            };
          },
        };
      }
      return {
        select: () => ({
          eq: (...idArgs: unknown[]) => {
            mockTokenSelectEqId(...idArgs);
            return {
              eq: (...usedArgs: unknown[]) => {
                mockTokenSelectEqUsed(...usedArgs);
                return {
                  maybeSingle: () => {
                    callLog.push('token.lookup');
                    return Promise.resolve(lookupResult);
                  },
                };
              },
            };
          },
        }),
        update: (values: unknown) => ({
          eq: (...idArgs: unknown[]) => {
            mockTokenClaimEqId(values, ...idArgs);
            return {
              eq: (...usedArgs: unknown[]) => {
                mockTokenClaimEqUsed(...usedArgs);
                return {
                  select: () => ({
                    maybeSingle: () => {
                      callLog.push('token.claim');
                      return Promise.resolve(claimResult);
                    },
                  }),
                };
              },
            };
          },
        }),
        delete: () => ({
          eq: (...idArgs: unknown[]) => {
            callLog.push('token.delete');
            mockTokenDeleteEqId(...idArgs);
            return Promise.resolve(deleteResult);
          },
        }),
      };
    },
  };
}

function resetCookie(overrides: Partial<{ userId: string; email: string; tokenId: string; expiresInSeconds: number }> = {}) {
  const token = createPasswordResetSessionToken({
    userId: 'user-1',
    email: 'user@example.com',
    tokenId: 'token-1',
    ...overrides,
  });
  return `${passwordResetSessionCookieName}=${encodeURIComponent(token)}`;
}

function makeRequest(body: unknown, cookie: string | null = resetCookie()) {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return { headers, json: jest.fn(async () => body) } as unknown as Request & { json: jest.Mock };
}

async function flushAfter() {
  for (const callback of mockAfterCallbacks.splice(0)) {
    await callback();
  }
}

describe('DD-AUTH-025 パスワード再設定の確定の窓口', () => {
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;
  const originalSecret = process.env.JWT_SECRET;
  const originalResetSecret = process.env.PASSWORD_RESET_SESSION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAfterCallbacks.length = 0;
    callLog = [];
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.PASSWORD_RESET_SESSION_SECRET;

    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockSendMail.mockResolvedValue(undefined);
    mockCheckPwnedPassword.mockImplementation(async () => {
      callLog.push('pwned');
      return { status: 'ok' };
    });

    lookupResult = { data: { id: 'token-1' }, error: null };
    claimResult = { data: { id: 'token-1' }, error: null };
    deleteResult = { error: null };
    appSessionResult = { error: null };
    rpcResult = { error: null };
    updateUserResult = { error: null };
    mockCreateServiceRoleClient.mockImplementation(async () => buildServiceClient());
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalResetSecret === undefined) delete process.env.PASSWORD_RESET_SESSION_SECRET;
    else process.env.PASSWORD_RESET_SESSION_SECRET = originalResetSecret;
  });

  it('DD-AUTH-025 有効な Cookie と未使用の行なら 200 でパスワードを変え、行を消し、全セッションを切り、4つの Cookie を消して通知する', async () => {
    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ ok: true });

    // Cookie の印の行を未使用の条件で引く。期限は見ない
    expect(mockTokenSelectEqId).toHaveBeenCalledWith('id', 'token-1');
    expect(mockTokenSelectEqUsed).toHaveBeenCalledWith('used', false);

    // 勝ち取りは used=false を条件にした更新
    expect(mockTokenClaimEqId).toHaveBeenCalledWith({ used: true }, 'id', 'token-1');
    expect(mockTokenClaimEqUsed).toHaveBeenCalledWith('used', false);

    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { password: VALID_PASSWORD });
    expect(mockTokenDeleteEqId).toHaveBeenCalledWith('id', 'token-1');

    // 自前のセッションの失効と Supabase のセッションの失効
    expect(mockSessionsUpdate).toHaveBeenCalledWith({ revoked_at: expect.any(String) });
    expect(mockSessionsEq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockRpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'user-1' });

    // 再設定・access・refresh・CSRF の Cookie を空にして即時に消す
    expect(res._cookies.map((c) => c.name).sort()).toEqual(
      [passwordResetSessionCookieName, accessCookieName, refreshCookieName, csrfCookieName].sort(),
    );
    for (const cookie of res._cookies) {
      expect(cookie.value).toBe('');
      expect(cookie.maxAge).toBe(0);
    }

    // 通知は応答の外。パスワードは本文に入れない
    expect(mockSendMail).not.toHaveBeenCalled();
    await flushAfter();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('user@example.com');
    expect(mail.subject).toBe('パスワードを変更しました');
    expect(mail.html).not.toContain(VALID_PASSWORD);
    expect(mail.text).not.toContain(VALID_PASSWORD);

    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'success',
      resource_id: 'user-1',
    });
  });

  it('DD-AUTH-025 行の確認、漏洩の照合、勝ち取り、パスワード変更、行の削除、失効の順に進む', async () => {
    await POST(makeRequest({ new_password: VALID_PASSWORD }));

    expect(callLog).toEqual([
      'token.lookup',
      'pwned',
      'token.claim',
      'updateUserById',
      'token.delete',
      'sessions.update',
      'rpc',
    ]);
  });

  it('DD-AUTH-025 回数の制限が応答を返したらそれを返し、Cookie も本文も読まない', async () => {
    const limited = { status: 429, _body: { error: 'Too many requests' } };
    mockEnforceRateLimit.mockResolvedValueOnce(limited);
    const req = makeRequest({ new_password: VALID_PASSWORD });

    const res = await POST(req);

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:password_reset_confirm', limit: 10, windowSeconds: 3600 }),
    );
    expect(req.json).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-AUTH-025 回数の制限の呼び出しが投げたら 500 で、先へ進まない（SEC-AUTH-013-AC-02）', async () => {
    mockEnforceRateLimit.mockRejectedValueOnce(new Error('redis down'));

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(consoleError).not.toHaveBeenCalledWith(
      'Rate limit middleware error (password-reset-confirm):',
      expect.anything(),
    );
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    ['Cookie ヘッダーが無い', () => null],
    ['再設定の Cookie が無い', () => 'other=1'],
    ['再設定の Cookie の署名が違う', () => `${passwordResetSessionCookieName}=forged.signature`],
    ['再設定の Cookie の期限が切れている', () => resetCookie({ expiresInSeconds: -60 })],
  ])('DD-AUTH-025 %s と missing_reset_session を残して 400 を返し、本文を読まない', async (_label, buildCookie) => {
    // 署名の秘密は beforeEach で入れるので、Cookie は実行時に作る
    const req = makeRequest({ new_password: VALID_PASSWORD }, buildCookie());

    const res = (await POST(req)) as unknown as FakeResponse;

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid or expired reset session' });
    expect(req.json).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      outcome: 'failure',
      detail: 'missing_reset_session',
    });
  });

  it.each([
    ['15 文字', { new_password: 'a'.repeat(15) }],
    ['129 文字', { new_password: 'a'.repeat(129) }],
    ['new_password が無い', {}],
    ['文字列でない', { new_password: 12345678901234567890 }],
  ])('DD-AUTH-025 新しいパスワードが形に合わない（%s）と 400 を返し、DB も漏洩照合も触れない', async (_label, body) => {
    const res = (await POST(makeRequest(body))) as unknown as FakeResponse;

    expect(res.status).toBe(400);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockCheckPwnedPassword).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('DD-AUTH-025 16 文字ちょうどのパスワードは通る', async () => {
    const res = (await POST(makeRequest({ new_password: 'a'.repeat(16) }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('user-1', { password: 'a'.repeat(16) });
  });

  it('DD-AUTH-025 行の照会が誤りなら token_lookup_failed を残して 500', async () => {
    lookupResult = { data: null, error: { message: 'db down' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Token lookup error:', { message: 'db down' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'token_lookup_failed',
    });
    expect(mockCheckPwnedPassword).not.toHaveBeenCalled();
  });

  it('DD-AUTH-025 行が無ければ（使用済み・消えた）invalid_or_consumed_token を残して 400 を返し、漏洩照合の外部呼び出しをしない', async () => {
    lookupResult = { data: null, error: null };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid or expired reset session' });
    expect(mockCheckPwnedPassword).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'failure',
      detail: 'invalid_or_consumed_token',
    });
  });

  it('DD-AUTH-025 漏洩済みのパスワードは pwned_password を残して 400 を返し、印を焼かない', async () => {
    mockCheckPwnedPassword.mockResolvedValue({ status: 'pwned' });

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'pwned-message' });
    expect(mockCheckPwnedPassword).toHaveBeenCalledWith(VALID_PASSWORD);
    expect(mockTokenClaimEqId).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'failure',
      detail: 'pwned_password',
    });
  });

  it('DD-AUTH-025 漏洩の照合先が使えない時は pwned_check_unavailable を監査に残して再設定を続ける', async () => {
    mockCheckPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'pwned_check_unavailable:timeout',
    });
    expect(mockLogAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success' }));
    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-025 勝ち取りの更新が誤りなら token_claim_failed を残して 500 を返し、パスワードを変えない', async () => {
    claimResult = { data: null, error: { message: 'claim failed' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Token claim error:', { message: 'claim failed' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'token_claim_failed',
    });
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('DD-AUTH-025 勝ち取りに負けた（0 行）ら token_already_consumed を残して 400 を返し、パスワードを変えない', async () => {
    claimResult = { data: null, error: null };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid or expired reset session' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'failure',
      detail: 'token_already_consumed',
    });
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DD-AUTH-025 パスワードの更新が誤りなら誤りの文を監査に残して 500 を返し、失効も通知もしない', async () => {
    updateUserResult = { error: { message: 'Password should be stronger' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to update password' });
    expect(res._cookies).toHaveLength(0);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'Password should be stronger',
    });
    expect(mockTokenDeleteEqId).not.toHaveBeenCalled();
    expect(mockSessionsUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockAfterCallbacks).toHaveLength(0);
  });

  it('DD-AUTH-025 行の削除が誤りでも記録して 200 のまま続ける', async () => {
    deleteResult = { error: { message: 'delete failed' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith('Failed to delete consumed password reset token:', {
      message: 'delete failed',
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-025 自前のセッションの失効が誤りでも記録して 200 のまま Supabase の失効に進む（監査には残さない）', async () => {
    appSessionResult = { error: { message: 'sessions failed' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith('[password-reset.confirm] failed to revoke app sessions:', {
      message: 'sessions failed',
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('DD-AUTH-025 Supabase のセッションの失効が誤りでも記録して 200 のまま（監査には残さない）', async () => {
    rpcResult = { error: { message: 'rpc failed' } };

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith('[password-reset.confirm] failed to revoke auth sessions:', {
      message: 'rpc failed',
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('DD-AUTH-025 通知メールの送信が失敗しても記録だけで、応答は 200 のまま', async () => {
    mockSendMail.mockRejectedValue(new Error('smtp down'));

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;
    expect(res.status).toBe(200);

    await expect(flushAfter()).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith('Failed to send password change notification:', expect.any(Error));
  });

  it('DD-AUTH-025 本文が JSON でなければ 500', async () => {
    const req = makeRequest(null);
    req.json.mockRejectedValue(new SyntaxError('Unexpected token'));

    const res = (await POST(req)) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Password reset confirm error:', expect.any(SyntaxError));
  });

  it('DD-AUTH-025 service role の client を作れずに投げたら 500', async () => {
    mockCreateServiceRoleClient.mockRejectedValue(new Error('no service key'));

    const res = (await POST(makeRequest({ new_password: VALID_PASSWORD }))) as unknown as FakeResponse;

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
  });
});
