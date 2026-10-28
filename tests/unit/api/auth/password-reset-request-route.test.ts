// パスワード再設定の申請の窓口（DD-AUTH-022）の単体テスト。
// 境界（制限・Turnstile・DB・メール・監査）は全部差し替え、窓口の分岐だけを見る。

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: (fn: () => unknown) => {
    mockAfterCallbacks.push(fn);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockVerifyTurnstile = jest.fn();
jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => mockVerifyTurnstile(...args),
}));

const mockSendMail = jest.fn();
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn(async (token: string) => `hashed_${token}`),
}));

const mockGetRequestOrigin = jest.fn();
jest.mock('@/lib/redirect', () => ({
  getRequestOrigin: (...args: unknown[]) => mockGetRequestOrigin(...args),
}));

const mockIsEmailOriginAllowed = jest.fn();
jest.mock('@/lib/site-url-guard', () => ({
  isEmailOriginAllowed: (...args: unknown[]) => mockIsEmailOriginAllowed(...args),
}));

const mockNotifySiteUrlInvalid = jest.fn();
jest.mock('@/lib/ops/site-url-alert', () => ({
  notifySiteUrlInvalid: (...args: unknown[]) => mockNotifySiteUrlInvalid(...args),
}));

const mockFindAuthUserIdByEmail = jest.fn();
jest.mock('@/features/auth/services/auth-admin-user', () => ({
  findAuthUserIdByEmail: (...args: unknown[]) => mockFindAuthUserIdByEmail(...args),
}));

// password_reset_tokens への update（前の印の無効化）と insert（新しい印の保存）を記録する。
const mockUpdateEqUsed = jest.fn();
const mockUpdateEqEmail = jest.fn();
const mockUpdate = jest.fn();
const mockInsert = jest.fn();
const mockFrom = jest.fn();
const mockServiceClient = { from: (...args: unknown[]) => mockFrom(...args) };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));

import { POST } from '@/app/api/auth/password-reset/request/route';

const ORIGIN = 'https://shop.example.com';

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Request;
}

function brokenBodyRequest() {
  return {
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Request;
}

async function flushAfter() {
  for (const callback of mockAfterCallbacks.splice(0)) {
    await callback();
  }
}

let invalidateResult: { error: unknown };
let insertResult: { error: unknown };

describe('DD-AUTH-022 パスワード再設定の申請の窓口', () => {
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAfterCallbacks.length = 0;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockVerifyTurnstile.mockResolvedValue({ ok: true });
    mockSendMail.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockGetRequestOrigin.mockReturnValue(ORIGIN);
    mockIsEmailOriginAllowed.mockReturnValue(true);
    mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'found', userId: 'user-1' });

    invalidateResult = { error: null };
    insertResult = { error: null };
    mockUpdateEqUsed.mockImplementation(() => Promise.resolve(invalidateResult));
    mockUpdateEqEmail.mockImplementation(() => ({ eq: mockUpdateEqUsed }));
    mockUpdate.mockImplementation(() => ({ eq: mockUpdateEqEmail }));
    mockInsert.mockImplementation(() => Promise.resolve(insertResult));
    mockFrom.mockImplementation(() => ({ update: mockUpdate, insert: mockInsert }));
    mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it('DD-AUTH-022 アカウントがあれば 200 で前の印を無効化し、新しい印を保存して応答の外でメールを送る', async () => {
    const before = Date.now();
    const res = (await POST(
      makeRequest({ email: 'User@Example.com', turnstileToken: 'ok' }, { 'x-real-ip': '203.0.113.5' }),
    )) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ ok: true });

    // 形の検査が大文字を直したメールで引く
    expect(mockFindAuthUserIdByEmail).toHaveBeenCalledWith(mockServiceClient, 'user@example.com');
    expect(mockVerifyTurnstile).toHaveBeenCalledWith('ok', '203.0.113.5');

    // 前の印の無効化は同じ宛先の未使用だけ
    expect(mockFrom).toHaveBeenCalledWith('password_reset_tokens');
    expect(mockUpdate).toHaveBeenCalledWith({ used: true });
    expect(mockUpdateEqEmail).toHaveBeenCalledWith('email', 'user@example.com');
    expect(mockUpdateEqUsed).toHaveBeenCalledWith('used', false);

    // 新しい印は生の値を保存せずハッシュだけ。期限は今から 10 分
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [rows] = mockInsert.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'user-1', email: 'user@example.com', used: false });
    expect(rows[0].token_hash).toMatch(/^hashed_[0-9a-f]{64}$/);
    const expiresMs = new Date(rows[0].expires_at as string).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

    // メールは応答の時点ではまだ送らない
    expect(mockSendMail).not.toHaveBeenCalled();
    await flushAfter();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('user@example.com');
    expect(mail.subject).toBe('Password reset');
    expect(mail.text).toContain(`${ORIGIN}/auth/password-reset/verify?token=`);
    expect(mail.text).toContain('10分間有効');
    expect(mail.html).toContain('10分間有効');

    // メールの印は DB に置いたハッシュの元の値
    const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token');
    expect(rows[0].token_hash).toBe(`hashed_${token}`);

    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'user@example.com',
      outcome: 'success',
      resource_id: 'user-1',
      detail: 'mail_queued',
    });
  });

  it('DD-AUTH-022 アカウントがなくても同じ 200 を返し、保存も送信もせず no_account を残す', async () => {
    mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'not_found' });

    const res = (await POST(makeRequest({ email: 'nobody@example.com' }))) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockAfterCallbacks).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'nobody@example.com',
      outcome: 'success',
      resource_id: null,
      detail: 'no_account',
    });
  });

  it('DD-AUTH-022 IP 単位の制限が応答を返したらそれをそのまま返し、本文を読まない', async () => {
    const limited = { status: 429, _body: { error: 'Too many requests' } };
    mockEnforceRateLimit.mockResolvedValueOnce(limited);
    const req = makeRequest({ email: 'user@example.com' });
    const jsonSpy = jest.spyOn(req, 'json');

    const res = await POST(req);

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:password_reset_request', limit: 10, windowSeconds: 3600 }),
    );
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 IP 単位の制限の呼び出しが投げたら 500 で、先へ進まない（SEC-AUTH-013-AC-02）', async () => {
    mockEnforceRateLimit.mockRejectedValueOnce(new Error('redis down'));

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(consoleError).not.toHaveBeenCalledWith('Rate limit middleware error (password-reset):', expect.anything());
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 メール単位の制限が応答を返したらそれを返し、DB に触れない', async () => {
    const limited = { status: 429, _body: { error: 'Too many requests' } };
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await POST(makeRequest({ email: 'User@Example.com' }));

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        endpoint: 'auth:password_reset_request',
        limit: 5,
        windowSeconds: 3600,
        subject: 'user@example.com',
      }),
    );
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 メール単位の制限の呼び出しが投げたら 500 で、DB に触れずメールも送らない（SEC-AUTH-013-AC-02）', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('redis down'));

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(consoleError).not.toHaveBeenCalledWith(
      'Rate limit middleware error (password-reset-account):',
      expect.anything(),
    );
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 形が合わないと 400 を返し、Turnstile も DB も呼ばない', async () => {
    const res = (await POST(makeRequest({ email: 'not-an-email' }))) as unknown as { status: number };

    expect(res.status).toBe(400);
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 Turnstile が誤りの文つきで落ちたら 403 でその文を監査に残す', async () => {
    mockVerifyTurnstile.mockResolvedValue({ ok: false, error: 'invalid-input-response' });

    const res = (await POST(makeRequest({ email: 'user@example.com', turnstileToken: 'bad' }))) as unknown as {
      status: number;
      _body: unknown;
    };

    expect(res.status).toBe(403);
    expect(res._body).toEqual({ error: 'Bot detection failed' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'user@example.com',
      outcome: 'failure',
      detail: 'invalid-input-response',
    });
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 Turnstile が文なしで落ちたら turnstile_failed を監査に残して 403', async () => {
    mockVerifyTurnstile.mockResolvedValue({ ok: false });

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number };

    expect(res.status).toBe(403);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'turnstile_failed' }),
    );
  });

  it('DD-AUTH-022 x-real-ip が無いか空なら Turnstile へ null を渡す', async () => {
    await POST(makeRequest({ email: 'user@example.com', turnstileToken: 't' }));
    expect(mockVerifyTurnstile).toHaveBeenLastCalledWith('t', null);

    await POST(makeRequest({ email: 'user@example.com', turnstileToken: 't' }, { 'x-real-ip': '' }));
    expect(mockVerifyTurnstile).toHaveBeenLastCalledWith('t', null);
  });

  it('DD-AUTH-022 x-forwarded-for は読まず、x-real-ip が在ればそちらを Turnstile に渡す', async () => {
    await POST(makeRequest({ email: 'user@example.com', turnstileToken: 't' }, { 'x-forwarded-for': '198.51.100.99' }));
    expect(mockVerifyTurnstile).toHaveBeenLastCalledWith('t', null);

    await POST(
      makeRequest(
        { email: 'user@example.com', turnstileToken: 't' },
        { 'x-forwarded-for': '198.51.100.99', 'x-real-ip': '203.0.113.7' },
      ),
    );
    expect(mockVerifyTurnstile).toHaveBeenLastCalledWith('t', '203.0.113.7');
  });

  it('DD-AUTH-022 住所の見張りに落ちたら運用へ知らせ、印もメールも作らずに同じ 200', async () => {
    mockIsEmailOriginAllowed.mockReturnValue(false);

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(mockIsEmailOriginAllowed).toHaveBeenCalledWith(ORIGIN);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();

    // 運用への通知は応答の外
    expect(mockNotifySiteUrlInvalid).not.toHaveBeenCalled();
    await flushAfter();
    expect(mockNotifySiteUrlInvalid).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 アカウントの照会が失敗したら user_lookup_failed を残して 500', async () => {
    mockFindAuthUserIdByEmail.mockResolvedValue({ status: 'error', message: 'rpc_failed' });

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'user_lookup_failed',
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 前の印の無効化が失敗しても記録して新しい印の発行を続ける', async () => {
    invalidateResult = { error: { message: 'update failed' } };

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number };

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to invalidate previous password reset tokens:',
      invalidateResult.error,
    );
    expect(mockInsert).toHaveBeenCalledTimes(1);
    await flushAfter();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-022 印の保存が失敗したら token_persist_failed を残して 500 を返し、メールを送らない', async () => {
    insertResult = { error: { message: 'insert failed' } };

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'user@example.com',
      outcome: 'error',
      detail: 'token_persist_failed',
    });
    expect(mockAfterCallbacks).toHaveLength(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('DD-AUTH-022 メールの送信が失敗しても記録だけで、応答は 200 のまま', async () => {
    mockSendMail.mockRejectedValue(new Error('smtp down'));

    const res = (await POST(makeRequest({ email: 'user@example.com' }))) as unknown as { status: number };
    expect(res.status).toBe(200);

    await expect(flushAfter()).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledWith('Failed to send password reset mail:', expect.any(Error));
  });

  it('DD-AUTH-022 本文が JSON でなければ 500', async () => {
    const res = (await POST(brokenBodyRequest())) as unknown as { status: number; _body: unknown };

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Password reset request error:', expect.any(SyntaxError));
  });
});
