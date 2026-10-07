/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

import {
  CHECKOUT_SESSION_ID_PATTERN,
  guardCheckoutPost,
  resolveCheckoutIpLimitMultiplier,
  type CheckoutGuardConfig,
} from '@/features/checkout/services/checkout-route-guard';

const CONFIG: CheckoutGuardConfig = {
  ipLimits: [
    { endpoint: 'checkout:test:ip-10s', limit: 10, windowSeconds: 10 },
    { endpoint: 'checkout:test:ip-10m', limit: 60, windowSeconds: 600 },
  ],
  sessionLimit: { endpoint: 'checkout:test', limit: 10, windowSeconds: 60 },
};

function makeRequest(sessionId: string | null = 'sess-abc'): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5, 10.0.0.1' };
  if (sessionId) headers.cookie = `session_id=${sessionId}`;
  return new NextRequest('http://localhost/api/checkout/test', { method: 'POST', headers, body: '{}' });
}

describe('guardCheckoutPost', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER;
    delete process.env.VERCEL;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('session_id Cookie が無ければ 400', async () => {
    const result = await guardCheckoutPost(makeRequest(null), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  test('IP 単位を時間枠ごとに数え、その後にセッション単位を数える', async () => {
    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(true);
    expect(mockEnforceRateLimit.mock.calls.map((call) => call[0].endpoint)).toEqual([
      'checkout:test:ip-10s',
      'checkout:test:ip-10m',
      'checkout:test',
    ]);
    expect(mockEnforceRateLimit.mock.calls[0][0]).toMatchObject({ limit: 10, windowSeconds: 10 });
    expect(mockEnforceRateLimit.mock.calls[2][0]).toMatchObject({ limit: 10, windowSeconds: 60, subject: 'sess-abc' });
    if (!result.ok) return;
    expect(result.sessionId).toBe('sess-abc');
    expect(result.clientIp).toBe('203.0.113.5');
  });

  test('上限に達したら 429 で、時間をおいて試すよう案内する（Retry-After を引き継ぐ）', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '7' } }),
    );

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get('Retry-After')).toBe('7');
    await expect(result.response.json()).resolves.toEqual({
      error: 'rate_limited',
      message: 'アクセスが集中しているため、手続きを一時的に止めています。少し時間をおいてから、もう一度お試しください。',
      retryable: true,
    });
  });

  test('回数制限を判定できない応答（503）はそのまま返す', async () => {
    const unavailable = new Response(null, { status: 503 });
    mockEnforceRateLimit.mockResolvedValueOnce(unavailable);

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response).toBe(unavailable);
  });

  test('CSRF で断られたら、その状態・本文・ヘッダーで返す', async () => {
    mockRequireCsrfOrDeny.mockResolvedValue({
      status: 403,
      _body: { error: 'csrf' },
      headers: { 'x-csrf-reason': 'missing' },
    });

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get('x-csrf-reason')).toBe('missing');
    await expect(result.response.json()).resolves.toEqual({ error: 'csrf' });
  });

  test('CSRF の合言葉が入れ替わったら、応答に新しい Cookie を付ける', async () => {
    mockRequireCsrfOrDeny.mockResolvedValue({ rotatedCsrfToken: 'rotated-token' });

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const response = result.finish(NextResponse.json({ ok: true }));
    expect(response.headers.get('set-cookie')).toContain('rotated-token');
  });

  test('E2E サーバーでは倍率で IP 単位だけを引き上げる。Vercel では倍率を無視し、倍率は30倍まで', async () => {
    process.env.E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER = '5';
    await guardCheckoutPost(makeRequest(), CONFIG);
    expect(mockEnforceRateLimit.mock.calls[0][0].limit).toBe(50);
    expect(mockEnforceRateLimit.mock.calls[2][0].limit).toBe(10);

    process.env.E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER = '1000';
    expect(resolveCheckoutIpLimitMultiplier()).toBe(30);

    process.env.VERCEL = '1';
    expect(resolveCheckoutIpLimitMultiplier()).toBe(1);
  });
  test('CSRF が本物の NextResponse の403を返したら、その応答・状態・本文で断る', async () => {
    const denied = NextResponse.json(
      { error: 'Forbidden', reason: 'CSRF validation failed' },
      { status: 403 },
    );
    mockRequireCsrfOrDeny.mockResolvedValue(denied);

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response).toBe(denied);
    expect(result.response.status).toBe(403);
    await expect(result.response.json()).resolves.toEqual({
      error: 'Forbidden',
      reason: 'CSRF validation failed',
    });
  });

  test('CSRF が本物の NextResponse の500を返したら、その応答・状態・本文で断る', async () => {
    const denied = NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    mockRequireCsrfOrDeny.mockResolvedValue(denied);

    const result = await guardCheckoutPost(makeRequest(), CONFIG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response).toBe(denied);
    expect(result.response.status).toBe(500);
    await expect(result.response.json()).resolves.toEqual({ error: 'Internal server error' });
  });

});

describe('CHECKOUT_SESSION_ID_PATTERN', () => {
  test('Stripe の Checkout Session の ID だけを通す', () => {
    expect(CHECKOUT_SESSION_ID_PATTERN.test('cs_test_a1B2c3')).toBe(true);
    expect(CHECKOUT_SESSION_ID_PATTERN.test('cs_live_a1B2c3')).toBe(true);
    expect(CHECKOUT_SESSION_ID_PATTERN.test('pi_test_a1B2c3')).toBe(false);
    expect(CHECKOUT_SESSION_ID_PATTERN.test('cs_test_a1/../b')).toBe(false);
  });
});
