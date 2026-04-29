import { NextRequest } from 'next/server';

// ── NextResponse モック ─────────────────────────────────────────
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn(
        (body: unknown, init?: { status?: number }) => ({
          body,
          status: init?.status ?? 200,
        })
      ),
    },
  };
});

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

import { POST } from '@/app/api/checkout/payment-intent/route';

function makeRequest(body: Record<string, unknown>, sessionId = 'test-session'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/payment-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, 'cookies', {
    value: {
      get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined),
    },
  });
  return req;
}

describe('POST /api/checkout/payment-intent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  it('deprecated endpoint returns 410 Gone', async () => {
    const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_card' });
    const res = await POST(req);
    expect((res as { status: number }).status).toBe(410);
    expect((res as { body: { error: string } }).body.error).toContain('deprecated');
  });
});
