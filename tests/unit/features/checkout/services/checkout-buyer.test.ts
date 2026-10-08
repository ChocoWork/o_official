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

  test('検証済みの印なら会員（ID は claims.sub）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: { sub: 'user-1' } });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({ kind: 'member', userId: 'user-1' });
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
  expect(buyerUserIdOf({ kind: 'member', userId: 'u' })).toBe('u');
  expect(buyerUserIdOf({ kind: 'guest' })).toBeNull();
});
