/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
const mockAfter: Array<() => unknown> = [];
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
  after: (callback: () => unknown) => mockAfter.push(callback),
}));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/turnstile', () => ({ verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('@/lib/pwned-password', () => ({ checkPwnedPassword: jest.fn().mockResolvedValue({ status: 'ok' }) }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn().mockResolvedValue(undefined) }));
// この試験の NextResponse は json だけの簡易版で cookies を持たない。戻り先の控えは別の試験で確かめるので、ここでは何もしない部品に差し替える
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  issueReturnIntent: jest.fn().mockResolvedValue({ action: { kind: 'clear' }, outcome: 'cleared' }),
  applyReturnIntentCookie: jest.fn(),
}));
jest.mock('@/lib/ops/site-url-alert', () => ({ notifySiteUrlInvalid: jest.fn().mockResolvedValue(undefined) }), { virtual: true });
const mockSignUp = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockCreateUser = jest.fn();
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(async () => ({ auth: { signUp: mockSignUp } })),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: mockRpc, from: mockFrom, auth: { admin: { createUser: mockCreateUser } } })),
}));

import { POST as reset } from '@/app/api/auth/password-reset/request/route';
import sendMail from '@/lib/mail';
import { notifySiteUrlInvalid } from '@/lib/ops/site-url-alert';

function request(path: string, origin = 'https://unlisted.example.test') {
  return new Request(`${origin}/api/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'fixture@example.test', password: 'Passw0rd!23456789', turnstileToken: 'test' }),
  });
}

// ARC-AUTH-007 の住所の見張り。再設定の申請は同じ 200 を返して、送らず運用へ知らせる
describe('ARC-AUTH-007 認証メールに実際に入る origin の確認', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAfter.length = 0;
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production' });
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockSignUp.mockResolvedValue({ data: { session: null, user: { id: 'new-user' } }, error: null });
    const chain = { update: jest.fn(), eq: jest.fn(), insert: jest.fn().mockResolvedValue({ error: null }) };
    chain.update.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    mockFrom.mockReturnValue(chain);
  });
  afterEach(() => jest.restoreAllMocks());
  async function flush() { for (const callback of mockAfter.splice(0)) await callback(); }

  it.each([null, 'existing-user'])('ARC-AUTH-007 再設定は本番の不正な origin で同じ200を返し、送らず知らせる (case %#)', async (userId) => {
    mockRpc.mockResolvedValue({ data: userId, error: null });
    const response = await reset(request('password-reset/request'));
    await flush();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  it('ARC-AUTH-007 設定が正常でも実際の origin が http なら送らない', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.test';
    process.env.APP_ALLOWED_ORIGINS = 'http://allowed.example.test';
    const response = await reset(request('password-reset/request', 'http://allowed.example.test'));
    await flush();
    expect(response.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  it('ARC-AUTH-007 設定が未設定でも実際の origin が許可済みの https なら送る', async () => {
    const origin = 'https://allowed.example.test';
    process.env.APP_ALLOWED_ORIGINS = origin;
    mockRpc.mockResolvedValue({ data: 'existing-user', error: null });
    const response = await reset(request('password-reset/request', origin));
    await flush();
    expect(response.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
  });

  it('ARC-AUTH-007 手元の localhost は従来どおり送れる', async () => {
    delete process.env.VERCEL_ENV;
    mockRpc.mockResolvedValue({ data: 'existing-user', error: null });
    const response = await reset(request('password-reset/request', 'http://localhost:3000'));
    await flush();
    expect(response.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
  });
});
