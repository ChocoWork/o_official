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
jest.mock('@/lib/ops/site-url-alert', () => ({ notifySiteUrlInvalid: jest.fn().mockResolvedValue(undefined) }), { virtual: true });
const mockSignUp = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockCreateUser = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ auth: { signUp: mockSignUp } })),
  createServiceRoleClient: jest.fn(async () => ({ rpc: mockRpc, from: mockFrom, auth: { admin: { createUser: mockCreateUser } } })),
}));

import { POST as register } from '@/app/api/auth/register/route';
import { POST as reset } from '@/app/api/auth/password-reset/request/route';
import sendMail from '@/lib/mail';
import { notifySiteUrlInvalid } from '@/lib/ops/site-url-alert';
import { createServiceRoleClient } from '@/lib/supabase/server';

function request(path: string, origin = 'https://unlisted.example.test') {
  return new Request(`${origin}/api/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'fixture@example.test', password: 'Passw0rd!23456789', turnstileToken: 'test' }),
  });
}

describe('認証メールに実際に入る origin の確認', () => {
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

  it.each([null, 'existing-user'])('再設定は本番の不正な origin で同じ200を返し、送らず知らせる (case %#)', async (userId) => {
    mockRpc.mockResolvedValue({ data: userId, error: null });
    const response = await reset(request('password-reset/request'));
    await flush();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'existing-user'])('登録は本番の不正な origin で503。確認・登録済み通知を送らずアカウントも作らない (case %#)', async (userId) => {
    mockRpc.mockResolvedValue({ data: userId, error: null });
    const response = await register(request('register'));
    await flush();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'ただいま会員登録を受け付けられません。時間をおいてお試しください。' });
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  it.each(['register', 'password-reset/request'])('設定が正常でも実際の origin が http なら送らない (%s)', async (path) => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.test';
    process.env.APP_ALLOWED_ORIGINS = 'http://allowed.example.test';
    const response = await (path === 'register' ? register : reset)(request(path, 'http://allowed.example.test'));
    await flush();
    expect(response.status).toBe(path === 'register' ? 503 : 200);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  it.each(['register', 'password-reset/request'])('設定が未設定でも実際の origin が許可済みの https なら送る (%s)', async (path) => {
    const origin = 'https://allowed.example.test';
    process.env.APP_ALLOWED_ORIGINS = origin;
    if (path !== 'register') mockRpc.mockResolvedValue({ data: 'existing-user', error: null });
    const response = await (path === 'register' ? register : reset)(request(path, origin));
    await flush();
    expect(response.status).toBe(path === 'register' ? 202 : 200);
    expect(path === 'register' ? mockSignUp : sendMail).toHaveBeenCalledTimes(1);
    expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
  });

  it.each(['register', 'password-reset/request'])('手元の localhost は従来どおり送れる (%s)', async (path) => {
    delete process.env.VERCEL_ENV;
    if (path !== 'register') mockRpc.mockResolvedValue({ data: 'existing-user', error: null });
    const response = await (path === 'register' ? register : reset)(request(path, 'http://localhost:3000'));
    await flush();
    expect(response.status).toBe(path === 'register' ? 202 : 200);
    expect(path === 'register' ? mockSignUp : sendMail).toHaveBeenCalledTimes(1);
    expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
  });
});
