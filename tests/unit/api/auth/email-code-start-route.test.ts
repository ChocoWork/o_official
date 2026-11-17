/** @jest-environment node */
/**
 * DD-AUTH-059 メールのコードの始めの窓口（src/app/api/auth/email-code/start/route.ts）の単体テスト。
 * 共有部品（Supabase の client・回数の制限・Turnstile・監査・戻り先の控え）は差し替え、窓口の分岐を通す。保留の Cookie は本物。
 */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/lib/turnstile', () => ({ verifyTurnstile: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn(),
  applyReturnIntentCookie: jest.fn(),
}));

import { POST } from '@/app/api/auth/email-code/start/route';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';
import { verifyTurnstile } from '@/lib/turnstile';
import { logAudit } from '@/lib/audit';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';
import { verifyEmailCodeSessionToken } from '@/features/auth/services/email-code-session';

const rateLimit = enforceRateLimit as jest.Mock;
const adminClient = createServiceRoleClient as jest.Mock;
const authClient = createServiceRoleAuthClient as jest.Mock;
const turnstile = verifyTurnstile as jest.Mock;
const audit = logAudit as jest.Mock;
const issueIntent = issueReturnIntent as jest.Mock;
const applyIntent = applyReturnIntentCookie as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
let createUser: jest.Mock;
let signInWithOtp: jest.Mock;

function req(body: unknown = { email: 'new@example.com', turnstileToken: 't' }) {
  return new Request('http://localhost/api/auth/email-code/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function cookieOf(res: Response) {
  const raw = res.headers.get('set-cookie') ?? '';
  const first = raw.split(/,(?=\s*sb-)/).find((c) => c.trim().startsWith('sb-email-code-session=')) ?? '';
  const [pair, ...attrs] = first.split(';').map((p) => p.trim());
  const value = decodeURIComponent(pair.split('=')[1] ?? '');
  return { name: pair.split('=')[0], value, attrs: attrs.map((a) => a.replace(/=.*/, '').toLowerCase()).sort() };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret-for-email-code', LOGIN_2FA_SESSION_SECRET: '' };
  rateLimit.mockReset().mockResolvedValue(undefined);
  turnstile.mockReset().mockResolvedValue({ ok: true });
  audit.mockClear();
  createUser = jest.fn().mockResolvedValue({ data: {}, error: null });
  signInWithOtp = jest.fn().mockResolvedValue({ error: null });
  adminClient.mockReset().mockResolvedValue({ auth: { admin: { createUser } } });
  authClient.mockReset().mockResolvedValue({ auth: { signInWithOtp } });
  issueIntent.mockReset().mockResolvedValue({ action: { kind: 'clear' } });
  applyIntent.mockReset();
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('DD-AUTH-059 POST /api/auth/email-code/start', () => {
  test('DD-AUTH-059 未登録: 印つきで作り、コードを送り、202 と保留の Cookie（メールだけ・userId 無し）を返す', async () => {
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ step: 'code', message: '確認コードを送信しました。メールに届いたコードを入力してください。' });
    expect(createUser).toHaveBeenCalledWith({ email: 'new@example.com', email_confirm: true, app_metadata: { email_code_signup_pending: true } });
    expect(signInWithOtp).toHaveBeenCalledWith({ email: 'new@example.com', options: { shouldCreateUser: false } });
    const c = cookieOf(res);
    expect(verifyEmailCodeSessionToken(c.value)).toMatchObject({ email: 'new@example.com' });
    expect(c.value).not.toContain('userId');
  });

  test('DD-AUTH-059 未登録・登録済み・登録済みで未確認・店員の4つで、本文・状態・Cookie の名前と属性が同じ', async () => {
    const results: Array<{ status: number; body: unknown; cookie: { name: string; attrs: string[] } }> = [];
    for (const createResult of [
      { data: {}, error: null }, // 未登録
      { data: null, error: { code: 'email_exists', status: 422, message: 'exists' } }, // 登録済み・店員（OTP は同じく成功）
      { data: null, error: { code: 'email_exists', status: 422, message: 'exists' } }, // 旧の登録で未確認（確認メールが届く。応答は同じ）
    ]) {
      createUser.mockResolvedValueOnce(createResult);
      const res = await POST(req());
      const c = cookieOf(res);
      results.push({ status: res.status, body: await res.json(), cookie: { name: c.name, attrs: c.attrs } });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].status).toBe(202);
    expect(signInWithOtp).toHaveBeenCalledTimes(3);
  });

  test('DD-AUTH-059 email_address_invalid は形の誤りと同じ 400 で、コードを送らず Cookie も付けない', async () => {
    createUser.mockResolvedValueOnce({ data: null, error: { code: 'email_address_invalid', status: 400, message: 'bad' } });
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('DD-AUTH-059 email_exists 以外の createUser の失敗は 500 と監査の符号で、コードを送らない', async () => {
    createUser.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', status: 500, message: 'x' } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'supabase_create_user_failed' }));
  });

  test('DD-AUTH-059 captcha の拒否は 500 と監査 supabase_captcha_rejected', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: 'captcha_failed', status: 400, message: 'captcha' } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'supabase_captcha_rejected' }));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('DD-AUTH-059 GoTrue の 429 は成功と同じ 202・本文・Set-Cookie で隠し、監査 email_code_send_throttled とログを1回だけ残す', async () => {
    const ok = await POST(req());
    const okShape = { status: ok.status, body: await ok.json(), cookie: cookieOf(ok).attrs, name: cookieOf(ok).name };
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    audit.mockClear();
    signInWithOtp.mockResolvedValueOnce({ error: { status: 429, message: 'over_email_send_rate_limit' } });
    const limited = await POST(req());
    expect({ status: limited.status, body: await limited.json(), cookie: cookieOf(limited).attrs, name: cookieOf(limited).name }).toEqual(okShape);
    expect(verifyEmailCodeSessionToken(cookieOf(limited).value)).toMatchObject({ email: 'new@example.com' });
    expect(limited.headers.get('Retry-After')).toBeNull();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'email_code_send_throttled' }));
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'code_sent' }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  test('DD-AUTH-059 GoTrue の 5xx は 503 と Retry-After', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { status: 502, message: 'bad gateway' } });
    const down = await POST(req());
    expect(down.status).toBe(503);
    expect(down.headers.get('Retry-After')).toBe('30');
  });

  test('DD-AUTH-059 GoTrue への通信の失敗（AuthRetryableFetchError）は 503', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } });
    expect((await POST(req())).status).toBe(503);
  });

  test('DD-AUTH-059 送信のそれ以外の失敗は 500 と監査 otp_send_failed', async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { status: 400, message: 'other' } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'otp_send_failed' }));
  });

  test('DD-AUTH-059 IP の枠を使い切ったら 429 で、本文も読まない', async () => {
    rateLimit.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await POST(req())).status).toBe(429);
    expect(turnstile).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 Turnstile の失敗の理由が空でも 403 で、監査は turnstile_failed', async () => {
    turnstile.mockResolvedValueOnce({ ok: false });
    expect((await POST(req())).status).toBe(403);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'turnstile_failed' }));
  });

  test('DD-AUTH-059 メールの形・本文の形の誤りは 400 で、Turnstile も作成も呼ばない', async () => {
    expect((await POST(req({ email: 'not-an-email' }))).status).toBe(400);
    expect((await POST(req('{bad json'))).status).toBe(400);
    expect(turnstile).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 Turnstile の失敗は 403 で、作成・送信・メール単位の枠が0回', async () => {
    turnstile.mockResolvedValueOnce({ ok: false, error: 'invalid' });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Bot detection failed' });
    expect(createUser).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledTimes(1); // IP の枠だけ
    expect(rateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
  });

  test('DD-AUTH-059 枠は共有の名前 auth:email-code:send（IP 50・メール 5。メールは Turnstile の後）', async () => {
    await POST(req());
    expect(rateLimit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ endpoint: 'auth:email-code:send', limit: 50, windowSeconds: 600 }),
      expect.objectContaining({ endpoint: 'auth:email-code:send', limit: 5, windowSeconds: 600, subject: 'new@example.com' }),
    ]);
  });

  test('DD-AUTH-059 枠を使い切ったら 429 をそのまま返し、作成も送信もしない', async () => {
    rateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(createUser).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-059 戻り先の控えは Cookie だけ（purpose: login）。本文に番号が出ない', async () => {
    issueIntent.mockResolvedValueOnce({ action: { kind: 'set', id: 'rid-123' } });
    const res = await POST(req({ email: 'new@example.com', next: '/cart' }));
    expect(issueIntent).toHaveBeenCalledWith({ rawNext: '/cart', purpose: 'login' });
    expect(applyIntent).toHaveBeenCalledWith(expect.anything(), { kind: 'set', id: 'rid-123' });
    expect(JSON.stringify(await res.json())).not.toContain('rid-123');
  });
});
