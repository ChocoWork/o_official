/** @jest-environment node */
/**
 * DD-AUTH-041 パスワード変更の開始の窓口（src/app/api/auth/password/change/start/route.ts）の単体テスト。
 * 共有部品（回数の制限・認証・CSRF・監査・メール・Supabase）は差し替え、窓口の順序と分岐だけを確かめる。
 * SEC-AUTH-034-AC-03（本人ごとの回数）・SEC-AUTH-034-AC-04（監査に固定の符号だけ）。
 */

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  })),
}));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/services/password-change', () => ({
  ...jest.requireActual('@/features/auth/services/password-change'),
  verifyCurrentPassword: jest.fn(),
  sendPasswordChangeCodeMail: jest.fn(),
  voidPasswordChangeChallenge: jest.fn(),
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  sendPasswordChangeCodeMail,
  verifyCurrentPassword,
  voidPasswordChangeChallenge,
} from '@/features/auth/services/password-change';
import { POST } from '@/app/api/auth/password/change/start/route';

const mockRateLimit = enforceRateLimit as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;
const mockCsrf = requireCsrfOrDeny as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;
const mockServiceClient = createServiceRoleClient as jest.Mock;
const mockVerify = verifyCurrentPassword as jest.Mock;
const mockSendCodeMail = sendPasswordChangeCodeMail as jest.Mock;
const mockVoid = voidPasswordChangeChallenge as jest.Mock;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CURRENT_PASSWORD = 'current-password-ZZZ-9876';
const rpc = jest.fn();
const ORIGINAL_SECRET = process.env.JWT_SECRET;

function authAs(overrides: Record<string, unknown> = {}) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: {
      sub: USER_ID,
      email: 'member@example.com',
      aal: 'aal1',
      session_id: SESSION_ID,
      app_metadata: { role: 'user' },
      ...overrides,
    },
  });
}

function jsonRequest(payload: unknown) {
  return new Request('http://localhost/api/auth/password/change/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function call(payload: unknown = { current_password: CURRENT_PASSWORD }) {
  const res = await POST(jsonRequest(payload));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockFailure.mockImplementation((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  }));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  process.env.JWT_SECRET = 'unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  mockRateLimit.mockResolvedValue(undefined);
  mockCsrf.mockResolvedValue(undefined);
  mockVerify.mockResolvedValue({ ok: true });
  mockSendCodeMail.mockResolvedValue(undefined);
  mockVoid.mockResolvedValue(true);
  rpc.mockResolvedValue({ data: 'challenge-1', error: null });
  mockServiceClient.mockResolvedValue({ rpc });
  authAs();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('DD-AUTH-041 パスワード変更の開始 順序', () => {
  test('DD-AUTH-041 正しい手順: 現行パスワードを確かめ、コードを発行してメールで送り、200 を返す', async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockVerify).toHaveBeenCalledWith('member@example.com', CURRENT_PASSWORD);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe('issue_password_change_challenge');
    expect(args).toMatchObject({ p_user_id: USER_ID, p_auth_session_id: SESSION_ID, p_ttl_seconds: 600 });
    expect(args.p_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mockSendCodeMail).toHaveBeenCalledTimes(1);
    const [to, code] = mockSendCodeMail.mock.calls[0] as [string, string];
    expect(to).toBe('member@example.com');
    expect(code).toMatch(/^\d{8}$/);
    // コードの平文は DB へ渡さない
    expect(JSON.stringify(args)).not.toContain(code);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_change_start', outcome: 'success', detail: 'code_sent', actor_id: USER_ID }),
    );
  });

  test('DD-AUTH-041 IP の枠が 429 なら認証も現行パスワードの確かめも呼ばない', async () => {
    mockRateLimit.mockResolvedValueOnce({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const { status } = await call();

    expect(status).toBe(429);
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 IP の枠は 20 回／10 分、本人ごとの枠は subject に利用者の id を渡して 5 回／10 分', async () => {
    await call();

    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    const first = mockRateLimit.mock.calls[0][0] as Record<string, unknown>;
    const second = mockRateLimit.mock.calls[1][0] as Record<string, unknown>;
    expect(first).toMatchObject({ endpoint: 'auth:password_change_start', limit: 20, windowSeconds: 600 });
    expect(first.subject).toBeUndefined();
    expect(second).toMatchObject({
      endpoint: 'auth:password_change_start',
      limit: 5,
      windowSeconds: 600,
      subject: USER_ID,
    });
  });

  test('DD-AUTH-041 本人ごとの枠が 429（6 回目）なら現行パスワードを試さない', async () => {
    mockRateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const { status } = await call();

    expect(status).toBe(429);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendCodeMail).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 未ログイン（authenticateRequest が失敗）は 401 で、CSRF も本人ごとの枠も確かめない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });

    const { status } = await call();

    expect(status).toBe(401);
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 CSRF が拒否なら、その応答をそのまま返し、監査も現行パスワードの確かめも呼ばない（aal1 の管理者への要求でも）', async () => {
    authAs({ aal: 'aal1', app_metadata: { role: 'admin' } });
    mockCsrf.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));

    const { status } = await call();

    expect(status).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendCodeMail).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 session_id の無い通行証は 401（コードを結ぶ session が無い）', async () => {
    authAs({ session_id: undefined });

    const { status } = await call();

    expect(status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の開始 役割の無い通行証・想定外の例外', () => {
  test('DD-AUTH-041 app_metadata の無い通行証は役割なしの会員として扱い、aal1 でも 200', async () => {
    authAs({ app_metadata: undefined });

    const { status } = await call();

    expect(status).toBe(200);
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'aal2_required' }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', detail: 'code_sent' }),
    );
  });

  test.each([
    ['Error', new TypeError('boom with secret'), 'TypeError'],
    ['Error でない値', 'plain string with secret', 'unknown'],
  ])('DD-AUTH-041 想定外の例外（%s）は 500・ログには名前だけ残し、メールを送らない', async (_label, thrown, logged) => {
    mockVerify.mockRejectedValue(thrown);

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
    expect(console.error).toHaveBeenCalledWith('Password change start error:', logged);
    expect(mockSendCodeMail).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の開始 管理者・サポーターは aal2 が要る', () => {
  test.each(['admin', 'supporter'])('DD-AUTH-041 aal1 の %s は 403・監査 denied・コードを送らない', async (role) => {
    authAs({ aal: 'aal1', app_metadata: { role } });

    const { status } = await call();

    expect(status).toBe(403);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendCodeMail).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_change_start', outcome: 'denied', detail: 'aal2_required' }),
    );
  });

  test('DD-AUTH-041 aal2 の管理者は通る', async () => {
    authAs({ aal: 'aal2', app_metadata: { role: 'admin' } });
    const { status } = await call();
    expect(status).toBe(200);
  });

  test('DD-AUTH-041 一般会員は aal1 で通る', async () => {
    authAs({ aal: 'aal1', app_metadata: { role: 'user' } });
    const { status } = await call();
    expect(status).toBe(200);
  });
});

describe('DD-AUTH-041 パスワード変更の開始 入力の検査', () => {
  test.each([{}, { current_password: '' }, { current_password: 'a'.repeat(129) }, { current_password: 1234 }])(
    'DD-AUTH-041 本文 %j は 400 で、現行パスワードを試さない',
    async (payload) => {
      const { status } = await call(payload);
      expect(status).toBe(400);
      expect(mockVerify).not.toHaveBeenCalled();
    },
  );

  test('DD-AUTH-041 JSON でない本文は 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/auth/password/change/start', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の開始 現行パスワードの確かめ', () => {
  test('DD-AUTH-041 違う現行パスワードは 401・固定の文・残りの回数を言わない。コードを発行せずメールも送らない。監査 current_password_invalid', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'invalid' });

    const { status, body } = await call();

    expect(status).toBe(401);
    expect(body).toEqual({ error: '現行のパスワードが正しくありません。' });
    expect(rpc).not.toHaveBeenCalled();
    expect(mockSendCodeMail).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_change_start', outcome: 'failure', detail: 'current_password_invalid' }),
    );
  });

  test('DD-AUTH-041 captcha の拒否は 500・監査 supabase_captcha_rejected（利用者の誤りに丸めない）', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'captcha_rejected' });

    const { status } = await call();

    expect(status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'supabase_captcha_rejected' }),
    );
  });

  test('DD-AUTH-041 確かめられない（unavailable）は 503', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const { status } = await call();

    expect(status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockSendCodeMail).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の開始 コードの発行とメール', () => {
  test('DD-AUTH-041 発行の RPC が失敗したら 500・メールを送らない・監査 issue_failed', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'rpc failed' } });

    const { status } = await call();

    expect(status).toBe(500);
    expect(mockSendCodeMail).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'issue_failed' }),
    );
  });

  test('DD-AUTH-041 発行の RPC が誤りなしで challenge の id を返さなくても 500・メールを送らない・監査 issue_failed', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    const { status } = await call();

    expect(status).toBe(500);
    expect(mockSendCodeMail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('password change start: issue failed', { code: undefined });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'issue_failed' }),
    );
  });

  test('DD-AUTH-041 メールが送れなかったら 500・発行したコードを無効にする・監査 mail_failed', async () => {
    mockSendCodeMail.mockRejectedValue(new Error('smtp down'));

    const { status } = await call();

    expect(status).toBe(500);
    expect(mockVoid).toHaveBeenCalledWith('challenge-1');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'mail_failed' }),
    );
  });

  test('DD-AUTH-041 コードを無効にするのも失敗したら、監査の detail に challenge_void_failed を足す（500 は隠さない）', async () => {
    mockSendCodeMail.mockRejectedValue(new Error('smtp down'));
    mockVoid.mockResolvedValue(false);

    const { status } = await call();

    expect(status).toBe(500);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'mail_failed:challenge_void_failed' }),
    );
  });
});

describe('DD-AUTH-041 パスワード変更の開始 監査と応答に秘密を残さない', () => {
  test('DD-AUTH-041 監査の引数・応答にパスワード・コード・session_id・トークンの値が現れない', async () => {
    const ok = await call();
    mockVerify.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    const ng = await call();

    const code = (mockSendCodeMail.mock.calls[0] as [string, string])[1];
    const dump = JSON.stringify([mockLogAudit.mock.calls, ok.body, ng.body]);
    expect(dump).not.toContain(CURRENT_PASSWORD);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(SESSION_ID);
  });
});
