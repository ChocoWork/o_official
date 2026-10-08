/** @jest-environment node */
import { NextRequest } from 'next/server';

const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  ...jest.requireActual('@/lib/auth/authenticate'),
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

import { buyerUserIdOf, checkoutBuyerFailureResponse, resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';

const originalResponseJson = Response.json;
beforeAll(() => {
  // 共通の node-fetch ポリフィルに静的 json が無いので、このファイル内で実際の応答を検証できる形に補う。
  Response.json = (body: unknown, init?: ResponseInit): Response => {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(body), { ...init, headers });
  };
});
afterAll(() => {
  Response.json = originalResponseJson;
});

function request(cookie = ''): NextRequest {
  return new NextRequest('http://localhost/api/checkout/place-order', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

describe('resolveCheckoutBuyer', () => {
  beforeEach(() => mockAuthenticate.mockReset());

  test('検証済みの印なら会員（ID は claims.sub、メールは claims.email）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: { sub: 'user-1', email: 'member@example.com' } });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({
      kind: 'member', userId: 'user-1', email: 'member@example.com',
    });
  });

  // 注文のメールを画面から送られた値にしないための値。空・文字列でない claims.email は「無い」として扱い、画面のメールに任せる
  test.each([
    ['claims.email が無い', {}],
    ['claims.email が空文字', { email: '' }],
    ['claims.email が文字列でない', { email: 123 }],
  ])('%s会員は email を null にする', async (_label, extraClaims) => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: { sub: 'user-1', ...extraClaims } });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({ kind: 'member', userId: 'user-1', email: null });
  });

  test('印が無ければゲスト', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({ kind: 'guest' });
  });

  test.each(['invalid', 'revoked'] as const)('%s で更新の印があれば expired', async (reason) => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'expired' });
  });

  test.each(['invalid', 'revoked'] as const)('%s で更新の印が無ければゲスト（古い印は使わない）', async (reason) => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason });
    await expect(resolveCheckoutBuyer(request('sb-access-token=old'))).resolves.toEqual({ kind: 'guest' });
  });

  test('確かめられなければ unavailable', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'unavailable' });
  });

  test('sub の無い印は会員として扱わない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: {} });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'expired' });
  });
});

describe('checkoutBuyerFailureResponse', () => {
  test('expired は 401 auth_expired', async () => {
    const response = checkoutBuyerFailureResponse('expired');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'auth_expired' });
  });

  test('unavailable は 503 と Retry-After', () => {
    const response = checkoutBuyerFailureResponse('unavailable');
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
  });
});

test('buyerUserIdOf はゲストを null にする', () => {
  expect(buyerUserIdOf({ kind: 'member', userId: 'u', email: 'u@example.com' })).toBe('u');
  expect(buyerUserIdOf({ kind: 'member', userId: 'u', email: null })).toBe('u');
  expect(buyerUserIdOf({ kind: 'guest' })).toBeNull();
});
