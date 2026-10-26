/**
 * DD-AUTH-019 確認のメールのリンクの窓口（src/app/api/auth/confirm/route.ts）の単体テスト。
 * Supabase・回数の制限・セッション保存・ゲスト注文の紐付け・監査・戻り先の控え（return-intent-service）は差し替え、窓口の分岐だけを確かめる。
 * 控えの使い切り自体は return-intent-service の単体試験と API-AUTH-006 の結合試験が見る。
 */

jest.mock('next/server', () => {
  const makeHeaders = () => {
    const map = new Map<string, string>();
    return {
      set: (key: string, value: string) => map.set(key.toLowerCase(), value),
      get: (key: string) => map.get(key.toLowerCase()) ?? null,
    };
  };
  return {
    NextResponse: {
      redirect: (url: URL, init?: { status?: number }) => {
        const headers = makeHeaders();
        headers.set('Location', url.toString());
        return { status: init?.status ?? 307, headers };
      },
      json: (body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        json: async () => body,
        headers: makeHeaders(),
      }),
    },
  };
});

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createPublicClient: jest.fn() }));
jest.mock('@/lib/redirect', () => ({
  ...jest.requireActual('@/lib/redirect'),
  getRequestOrigin: () => 'http://localhost:3000',
}));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/features/cart/services/guest-shopping-token', () => ({ readGuestShoppingTokens: jest.fn() }));
jest.mock('@/lib/orders/link-guest-orders', () => ({ linkGuestOrdersByEmail: jest.fn() }));
const mockConsumeSignupBinding = jest.fn();
const mockResolveStoredDestination = jest.fn();
const mockApplyReturnIntentCookie = jest.fn();
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  consumeSignupBinding: (...args: unknown[]) => mockConsumeSignupBinding(...args),
  resolveStoredDestination: (...args: unknown[]) => mockResolveStoredDestination(...args),
  applyReturnIntentCookie: (...args: unknown[]) => mockApplyReturnIntentCookie(...args),
}));

import { logAudit } from '@/lib/audit';
import { createPublicClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { readGuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
import { GET } from '@/app/api/auth/confirm/route';

const mockLogAudit = logAudit as jest.Mock;
const mockCreatePublicClient = createPublicClient as jest.Mock;
const mockRateLimit = enforceRateLimit as jest.Mock;
const mockPersist = persistSessionAndCookies as jest.Mock;
const mockReadTokens = readGuestShoppingTokens as jest.Mock;
const mockLink = linkGuestOrdersByEmail as jest.Mock;

const SESSION = { access_token: 'a', refresh_token: 'r' };
const USER = { id: 'user-1', email: 'hanako@example.com', email_confirmed_at: '2026-08-10T00:00:00Z' };
const TOKENS = { cartToken: 'cart-t', wishlistToken: 'wish-t' };

let verifyOtp: jest.Mock;
let signOut: jest.Mock;

function request(query: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/auth/confirm${query}`, { headers });
}

describe('GET /api/auth/confirm', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    verifyOtp = jest.fn().mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    signOut = jest.fn().mockResolvedValue({ error: null });
    mockCreatePublicClient.mockResolvedValue({ auth: { verifyOtp, signOut } });
    mockRateLimit.mockResolvedValue(undefined);
    mockPersist.mockResolvedValue({ ok: true });
    mockReadTokens.mockReturnValue(TOKENS);
    mockLink.mockResolvedValue(0);
    mockLogAudit.mockResolvedValue(undefined);
    mockConsumeSignupBinding.mockResolvedValue({ bound: true, storedPath: '/' });
    mockResolveStoredDestination.mockResolvedValue({ path: '/', needsMfa: false, action: { kind: 'clear' } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('回数の制限', () => {
    it('DD-AUTH-019 制限が Response を返したらそのまま返し、確かめには進まない', async () => {
      const limited = new Response(null, { status: 429 });
      mockRateLimit.mockResolvedValue(limited);

      const res = await GET(request('?token_hash=h'));

      expect(res).toBe(limited);
      expect(mockRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:confirm', limit: 50, windowSeconds: 600 }),
      );
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 制限が Response でない値を返したら Retry-After 600 の 429 を作って返す', async () => {
      mockRateLimit.mockResolvedValue({ blocked: true });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many requests' });
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 制限の呼び出しが投げたら記録して確かめへ進む', async () => {
      mockRateLimit.mockRejectedValue(new Error('rate down'));

      const res: any = await GET(request('?token_hash=h'));

      expect(console.error).toHaveBeenCalledWith('Rate limit middleware error (confirm):', expect.any(Error));
      expect(res.status).toBe(303);
      expect(verifyOtp).toHaveBeenCalled();
    });
  });

  describe('問い合わせの読み取り', () => {
    it('DD-AUTH-019 token_hash を印として signup の型で確かめる', async () => {
      await GET(request('?token_hash=hash-1&type=signup'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'signup' });
    });

    it('DD-AUTH-019 token_hash が無く token がある時は token を使う', async () => {
      await GET(request('?token=legacy-token&type=signup'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy-token', type: 'signup' });
    });

    it('DD-AUTH-019 type が無い時は signup にする', async () => {
      await GET(request('?token_hash=h'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    });

    it('DD-AUTH-019 type が空の文字なら signup にする', async () => {
      await GET(request('?token_hash=h&type='));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    });

    it.each(['magiclink', 'recovery', 'email', 'unknown', 'SIGNUP', 'invite'])(
      'DD-AUTH-019 type=%s は verifyOtp を呼ばず、監査 invalid_type を残して /login へ 303 で移す（Set-Cookie は無い）',
      async (type) => {
        const res: any = await GET(request(`?token_hash=h&type=${type}`, { cookie: 'sb-return-intent=x' }));

        expect(verifyOtp).not.toHaveBeenCalled();
        expect(mockCreatePublicClient).not.toHaveBeenCalled();
        expect(mockPersist).not.toHaveBeenCalled();
        expect(mockConsumeSignupBinding).not.toHaveBeenCalled();
        expect(res.status).toBe(303);
        expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
        expect(res.headers.get('Set-Cookie')).toBeNull();
        expect(mockLogAudit).toHaveBeenCalledWith({
          action: 'auth.confirm',
          outcome: 'failure',
          detail: 'invalid_type',
          metadata: { reason: 'invalid_type' },
        });
        expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(type === 'SIGNUP' ? 'SIGNUP' : `"${type}"`);
      },
    );

    it('DD-AUTH-019 結び付いた控えの戻り先が / なら / へ 303 で移す', async () => {
      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/');
    });

    it.each([
      ['外の住所', '%2F%2Fevil.example'],
      ['/auth/verified', '%2Fauth%2Fverified'],
      ['タブ入り /%09/evil.example', '%2F%09%2Fevil.example'],
      ['/look（内部の道でも）', '%2Flook'],
    ])('DD-AUTH-019 redirect_to（%s）は読まず、行き先は解決の結果だけで決める', async (_label, encoded) => {
      const res: any = await GET(request(`?token_hash=h&redirect_to=${encoded}`));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/');
      const [arg] = mockConsumeSignupBinding.mock.calls[0];
      expect(JSON.stringify(arg)).not.toContain('redirect_to');
      expect(JSON.stringify(arg)).not.toContain('evil');
    });

    it('DD-AUTH-019 トークンが無い失敗の枝は redirect_to を読まず固定の /login へ移す（外へ向く値でも）', async () => {
      const res: any = await GET(request('?redirect_to=%2F%09%2Fevil.example'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(mockConsumeSignupBinding).not.toHaveBeenCalled();
    });
  });

  describe('印が無い', () => {
    it('DD-AUTH-019 印が無ければ missing_token の failure を残し、確かめずに 303 を返す', async () => {
      const res: any = await GET(request(''));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockCreatePublicClient).not.toHaveBeenCalled();
      expect(mockConsumeSignupBinding).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        outcome: 'failure',
        detail: 'missing_token_hash',
        metadata: { reason: 'missing_token' },
      });
    });
  });

  describe('確かめの失敗', () => {
    it.each([
      ['Token has expired or is invalid', 'expired'],
      ['Email link is invalid', 'invalid'],
      ['Token already used', 'reused'],
      ['Token was reused', 'reused'],
      ['Something odd', 'unknown'],
    ])('DD-AUTH-019 誤りの文 "%s" を %s に分けて failure を残し（文は残さず固定の符号）、303 を返す', async (message, reason) => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message } });

      const res: any = await GET(request('?token_hash=h&redirect_to=%2Flook'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'failure',
        detail: 'verify_failed',
        metadata: { reason },
      });
      expect(mockPersist).not.toHaveBeenCalled();
      expect(mockConsumeSignupBinding).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 誤りが無くても data が null なら missing_session_or_user・unknown で 303 を返す', async () => {
      verifyOtp.mockResolvedValue({ data: null, error: null });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'failure',
        detail: 'missing_session_or_user',
        metadata: { reason: 'unknown' },
      });
    });

    it('DD-AUTH-019 誤りの文が空でも detail は固定の符号 verify_failed にする', async () => {
      verifyOtp.mockResolvedValue({ data: null, error: { message: '' } });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'verify_failed', metadata: { reason: 'unknown' } }),
      );
    });

    it('DD-AUTH-019 誤りが無く session が無い時は user のメールを監査の宛先にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: USER }, error: null });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ actor_email: 'hanako@example.com', detail: 'missing_session_or_user' }),
      );
      expect(mockPersist).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 session があり user が無い時も失敗として扱い、宛先は null にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: null }, error: null });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ actor_email: null, outcome: 'failure', detail: 'missing_session_or_user' }),
      );
      expect(mockPersist).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 user にメールが無ければ失敗の監査の宛先は null にする', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: null, user: { id: 'u' } },
        error: { message: 'invalid' },
      });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: null }));
    });
  });

  describe('成功', () => {
    it('DD-AUTH-019 正しい印なら 303 で解決した戻り先へ移し、ゲストの印を添えて保存し、紐付けと success を残す', async () => {
      const action = { kind: 'clear' };
      mockConsumeSignupBinding.mockResolvedValue({ bound: true, storedPath: '/look' });
      mockResolveStoredDestination.mockResolvedValue({ path: '/look', needsMfa: false, action });

      const res: any = await GET(request('?token_hash=h&type=signup', { cookie: 'guest=1' }));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/look');
      expect(mockApplyReturnIntentCookie).toHaveBeenCalledWith(res, action);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockReadTokens).toHaveBeenCalledWith('guest=1');
      expect(mockPersist).toHaveBeenCalledWith(res, SESSION, USER, TOKENS);
      expect(mockLink).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'hanako@example.com',
        emailConfirmedAt: '2026-08-10T00:00:00Z',
      });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: 'hanako@example.com',
        outcome: 'success',
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-019 控えは cookie の見出しと利用者のメール・id で使い切り、使い切った戻り先を出口の確かめ（aal1）に通す', async () => {
      mockConsumeSignupBinding.mockResolvedValue({ bound: true, storedPath: '/account' });

      await GET(request('?token_hash=h&type=signup', { cookie: 'sb-return-intent=x' }));

      expect(mockConsumeSignupBinding).toHaveBeenCalledTimes(1);
      expect(mockConsumeSignupBinding).toHaveBeenCalledWith({
        cookieHeader: 'sb-return-intent=x',
        email: 'hanako@example.com',
        userId: 'user-1',
      });
      expect(mockResolveStoredDestination).toHaveBeenCalledWith({
        stored: '/account',
        viewer: { role: 'user', aal: 'aal1' },
        origin: 'http://localhost:3000',
      });
    });

    it('DD-AUTH-019 type が無い時も signup なので控えを使い切る', async () => {
      await GET(request('?token_hash=h'));

      expect(mockConsumeSignupBinding).toHaveBeenCalledTimes(1);
    });

    it.each(['admin', 'supporter'])('DD-AUTH-019 役割が %s なら使い切った戻り先を捨てて /auth/verified へ移し、控えの Cookie を消す', async (role) => {
      verifyOtp.mockResolvedValue({
        data: { session: SESSION, user: { ...USER, app_metadata: { role } } },
        error: null,
      });
      mockConsumeSignupBinding.mockResolvedValue({ bound: true, storedPath: '/admin' });

      const res: any = await GET(request('?token_hash=h'));

      expect(mockResolveStoredDestination).not.toHaveBeenCalled();
      expect(res.headers.get('Location')).toBe('http://localhost:3000/auth/verified');
      expect(mockApplyReturnIntentCookie).toHaveBeenCalledWith(res, { kind: 'clear' });
      expect(mockPersist).toHaveBeenCalled();
    });

    it('DD-AUTH-019 役割が未知の値なら user として出口の確かめに渡す', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: SESSION, user: { ...USER, app_metadata: { role: 'root' } } },
        error: null,
      });

      await GET(request('?token_hash=h'));

      expect(mockResolveStoredDestination).toHaveBeenCalledWith(
        expect.objectContaining({ viewer: { role: 'user', aal: 'aal1' } }),
      );
    });

    it('DD-AUTH-019 cookie ヘッダが無ければ null をゲストの印の読み取りへ渡す', async () => {
      await GET(request('?token_hash=h'));

      expect(mockReadTokens).toHaveBeenCalledWith(null);
    });

    it('DD-AUTH-019 控えは session を保存する前に使い切る（結び付けの成否を先に決める）', async () => {
      const order: string[] = [];
      mockConsumeSignupBinding.mockImplementation(async () => {
        order.push('consume');
        return { bound: true, storedPath: '/' };
      });
      mockPersist.mockImplementation(async () => {
        order.push('persist');
        return { ok: true };
      });
      mockResolveStoredDestination.mockImplementation(async () => {
        order.push('resolve');
        return { path: '/', needsMfa: false, action: { kind: 'clear' } };
      });

      await GET(request('?token_hash=h'));

      expect(order).toEqual(['consume', 'persist', 'resolve']);
    });

    it('DD-AUTH-019 保存の後に紐付けを呼び、紐付けの後に success を残す', async () => {
      const order: string[] = [];
      mockPersist.mockImplementation(async () => {
        order.push('persist');
        return { ok: true };
      });
      mockLink.mockImplementation(async () => {
        order.push('link');
        return 0;
      });
      mockLogAudit.mockImplementation(async () => {
        order.push('audit');
      });

      await GET(request('?token_hash=h'));

      expect(order).toEqual(['persist', 'link', 'audit']);
    });

    it('DD-AUTH-019 確認日時が無ければ、紐付けは null を渡す', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: SESSION, user: { id: 'user-2', email: 'x@example.com' } },
        error: null,
      });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLink).toHaveBeenCalledWith({ userId: 'user-2', email: 'x@example.com', emailConfirmedAt: null });
    });
  });

  describe('結び付かない（登録を始めたブラウザではない）', () => {
    beforeEach(() => {
      mockConsumeSignupBinding.mockResolvedValue({ bound: false });
    });

    it('DD-AUTH-019 session を作らず保存・紐付け・出口の確かめを呼ばず、signOut(local) を 1 回呼んで /login?registered=1 へ 303 で移す', async () => {
      const res: any = await GET(request('?token_hash=h&type=signup', { cookie: 'guest=1' }));

      expect(verifyOtp).toHaveBeenCalledTimes(1);
      expect(mockPersist).not.toHaveBeenCalled();
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockResolveStoredDestination).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('DD-AUTH-019 Cookie を何も書かない（session の Cookie も控えの Cookie も、消しもしない）', async () => {
      const res: any = await GET(request('?token_hash=h', { cookie: 'sb-return-intent=x' }));

      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(mockApplyReturnIntentCookie).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 監査は success・confirmed_without_session・no_binding で、メールは宛先に残す', async () => {
      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: 'hanako@example.com',
        outcome: 'success',
        detail: 'confirmed_without_session',
        resource_id: 'user-1',
        metadata: { reason: 'no_binding' },
      });
    });

    it('DD-AUTH-019 signOut が reject しても 303 /login?registered=1 のままで、ログには符号だけを残す', async () => {
      signOut.mockRejectedValue(Object.assign(new Error('secret message'), { code: 'sign_out_failed' }));

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(console.error).toHaveBeenCalledWith('confirm signOut(local) failed', { code: 'sign_out_failed' });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret message');
    });

    it('DD-AUTH-019 signOut が { error } を返しても（本来の失敗の形）303 /login?registered=1 のままで、ログには符号だけを残す', async () => {
      signOut.mockResolvedValue({ error: { code: 'unexpected_failure', status: 500, message: 'secret message' } });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(console.error).toHaveBeenCalledWith('confirm signOut(local) failed', { code: 'unexpected_failure' });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret message');
    });

    it('DD-AUTH-019 signOut が { error } を符号なしで返したら status を符号の代わりに残す', async () => {
      signOut.mockResolvedValue({ error: { status: 502, message: 'secret message' } });

      await GET(request('?token_hash=h'));

      expect(console.error).toHaveBeenCalledWith('confirm signOut(local) failed', { code: 502 });
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('secret message');
    });

    it('DD-AUTH-019 利用者のメールが無ければ使い切りに空の文字を渡し（外れる）、監査の宛先は null にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'user-2' } }, error: null });

      const res: any = await GET(request('?token_hash=h'));

      expect(mockConsumeSignupBinding).toHaveBeenCalledWith(expect.objectContaining({ email: '', userId: 'user-2' }));
      expect(mockPersist).not.toHaveBeenCalled();
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: null, resource_id: 'user-2' }));
    });

    it('DD-AUTH-019 確かめ（verifyOtp）が失敗した時は使い切りを呼ばず /login へ移す', async () => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Token has expired' } });

      const res: any = await GET(request('?token_hash=h'));

      expect(mockConsumeSignupBinding).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
    });
  });

  describe('保存の失敗', () => {
    it('DD-AUTH-019 保存が失敗したら error（固定の符号。保存の誤りの文は残さない）を残し、紐付けを呼ばずに作った 303 を返し、控えの Cookie を消して session を失効させる', async () => {
      mockPersist.mockResolvedValue({ ok: false, error: 'db down' });

      const res: any = await GET(request('?token_hash=h', { cookie: 'sb-return-intent=x' }));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/');
      expect(mockResolveStoredDestination).not.toHaveBeenCalled();
      expect(mockApplyReturnIntentCookie).toHaveBeenCalledTimes(1);
      expect(mockApplyReturnIntentCookie).toHaveBeenCalledWith(res, { kind: 'clear' });
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: 'hanako@example.com',
        outcome: 'error',
        detail: 'session_persist_failed',
        resource_id: 'user-1',
      });
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('db down');
    });

    it('DD-AUTH-019 保存の結果に error が無くても同じ固定の符号を書く', async () => {
      mockPersist.mockResolvedValue({ ok: false });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed' }),
      );
    });

    it('DD-AUTH-019 保存の結果が空でも固定の符号を書き、利用者のメールが無ければ宛先は null にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'user-2' } }, error: null });
      mockPersist.mockResolvedValue(undefined);

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'error',
        detail: 'session_persist_failed',
        resource_id: 'user-2',
      });
    });
  });

  describe('例外', () => {
    it('DD-AUTH-019 確かめが投げたら error（固定の符号 unexpected。例外の文は残さない）を残して 303 を返す', async () => {
      verifyOtp.mockRejectedValue(new Error('network'));

      const res: any = await GET(request('?token_hash=h&redirect_to=%2Flook'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        outcome: 'error',
        detail: 'unexpected',
        metadata: { reason: 'unexpected' },
      });
    });

    it('DD-AUTH-019 匿名の client を作る段で投げても 303 と error を返す', async () => {
      mockCreatePublicClient.mockRejectedValue(new Error('no client'));

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', metadata: { reason: 'unexpected' } }),
      );
    });

    it('DD-AUTH-019 紐付けが投げても 303 と error を返し、success は残さない', async () => {
      mockLink.mockRejectedValue(new Error('link failed'));

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', metadata: { reason: 'unexpected' } }),
      );
    });
  });
});
