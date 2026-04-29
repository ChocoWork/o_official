import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
  const rateLimitResponse = await enforceRateLimit({
    request: req,
    endpoint: 'checkout:payment-intent:deprecated',
    limit: 20,
    windowSeconds: 60,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  return NextResponse.json(
    {
      error: 'This endpoint is deprecated. Please use /api/checkout/create-session to start Stripe checkout sessions.',
      documentation: '/api/checkout/create-session',
    },
    { status: 410 }
  );
}
