/**
 * DD-AUTH-019 確認のメールのリンクの窓口（src/app/api/auth/confirm/route.ts）の単体テスト。
 * Supabase・回数の制限・セッション保存・ゲスト注文の紐付け・監査は差し替え、窓口の分岐だけを確かめる。
 * 送り先の絞り込み（sanitizeRedirectPath）は本物を通す。
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

function request(query: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/auth/confirm${query}`, { headers });
}

describe('GET /api/auth/confirm', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    verifyOtp = jest.fn().mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    mockCreatePublicClient.mockResolvedValue({ auth: { verifyOtp } });
    mockRateLimit.mockResolvedValue(undefined);
    mockPersist.mockResolvedValue({ ok: true });
    mockReadTokens.mockReturnValue(TOKENS);
    mockLink.mockResolvedValue(0);
    mockLogAudit.mockResolvedValue(undefined);
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

      const res: any = await GET(request('?token_hash=h&redirect_to=%2Fauth%2Fverified'));

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
      await GET(request('?token=legacy-token&type=email'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy-token', type: 'email' });
    });

    it('DD-AUTH-019 type が無い時は signup にする', async () => {
      await GET(request('?token_hash=h'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    });

    it('DD-AUTH-019 type が許可の外なら signup にする', async () => {
      await GET(request('?token_hash=h&type=invite'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    });

    it.each(['signup', 'email', 'magiclink', 'recovery'])('DD-AUTH-019 許可の type %s はそのまま渡す', async (type) => {
      await GET(request(`?token_hash=h&type=${type}`));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type });
    });

    it('DD-AUTH-019 redirect_to が無ければ既定の /account へ 303 で移す', async () => {
      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/account');
    });

    it('DD-AUTH-019 redirect_to に //evil.example を渡しても既定の /account へ移す', async () => {
      const res: any = await GET(request('?token_hash=h&redirect_to=%2F%2Fevil.example'));

      expect(res.headers.get('Location')).toBe('http://localhost:3000/account');
    });
  });

  describe('印が無い', () => {
    it('DD-AUTH-019 印が無ければ missing_token の failure を残し、確かめずに 303 を返す', async () => {
      const res: any = await GET(request(''));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/account');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockCreatePublicClient).not.toHaveBeenCalled();
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
    ])('DD-AUTH-019 誤りの文 "%s" を %s に分けて failure を残し、303 を返す', async (message, reason) => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message } });

      const res: any = await GET(request('?token_hash=h&redirect_to=%2Fauth%2Fverified'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/auth/verified');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'failure',
        detail: message,
        metadata: { reason },
      });
      expect(mockPersist).not.toHaveBeenCalled();
    });

    it('DD-AUTH-019 誤りが無くても data が null なら missing_session_or_user・unknown で 303 を返す', async () => {
      verifyOtp.mockResolvedValue({ data: null, error: null });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'failure',
        detail: 'missing_session_or_user',
        metadata: { reason: 'unknown' },
      });
    });

    it('DD-AUTH-019 誤りの文が空なら missing_session_or_user を detail にする', async () => {
      verifyOtp.mockResolvedValue({ data: null, error: { message: '' } });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'missing_session_or_user', metadata: { reason: 'unknown' } }),
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
    it('DD-AUTH-019 正しい印なら 303 で redirect_to へ移し、ゲストの印を添えて保存し、紐付けと success を残す', async () => {
      const res: any = await GET(
        request('?token_hash=h&type=email&redirect_to=%2Fauth%2Fverified', { cookie: 'guest=1' }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/auth/verified');
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

    it('DD-AUTH-019 cookie ヘッダが無ければ null をゲストの印の読み取りへ渡す', async () => {
      await GET(request('?token_hash=h'));

      expect(mockReadTokens).toHaveBeenCalledWith(null);
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

    it('DD-AUTH-019 利用者のメールと確認日時が無ければ、監査は null・紐付けは空の文字と null にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'user-2' } }, error: null });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLink).toHaveBeenCalledWith({ userId: 'user-2', email: '', emailConfirmedAt: null });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'success',
        resource_id: 'user-2',
      });
    });
  });

  describe('保存の失敗', () => {
    it('DD-AUTH-019 保存が失敗したら error を残し、紐付けを呼ばずに作った 303 を返す', async () => {
      mockPersist.mockResolvedValue({ ok: false, error: 'db down' });

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: 'hanako@example.com',
        outcome: 'error',
        detail: 'session_persist_failed: db down',
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-019 保存の結果に error が無ければ unknown と書く', async () => {
      mockPersist.mockResolvedValue({ ok: false });

      await GET(request('?token_hash=h'));

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: unknown' }),
      );
    });

    it('DD-AUTH-019 保存の結果が空でも unknown と書き、利用者のメールが無ければ宛先は null にする', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'user-2' } }, error: null });
      mockPersist.mockResolvedValue(undefined);

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
      expect(mockLink).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: null,
        outcome: 'error',
        detail: 'session_persist_failed: unknown',
        resource_id: 'user-2',
      });
    });
  });

  describe('例外', () => {
    it('DD-AUTH-019 確かめが投げたら error（unexpected）を残して 303 を返す', async () => {
      verifyOtp.mockRejectedValue(new Error('network'));

      const res: any = await GET(request('?token_hash=h&redirect_to=%2Fauth%2Fverified'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/auth/verified');
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        outcome: 'error',
        detail: 'Error: network',
        metadata: { reason: 'unexpected' },
      });
    });

    it('DD-AUTH-019 匿名の client を作る段で投げても 303 と error を返す', async () => {
      mockCreatePublicClient.mockRejectedValue(new Error('no client'));

      const res: any = await GET(request('?token_hash=h'));

      expect(res.status).toBe(303);
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
