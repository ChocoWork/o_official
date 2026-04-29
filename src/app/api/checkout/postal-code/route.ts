import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { fetchAddressByPostalCode } from '@/features/checkout/services/postal-code.service';

const postalCodeSchema = z.object({
  postalCode: z
    .string()
    .min(1, 'postalCode is required')
    .max(16, 'postalCode is invalid'),
});

export async function GET(request: NextRequest) {
  const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
  const rateLimitResponse = await enforceRateLimit({
    request,
    endpoint: 'checkout:postal-code',
    limit: 60,
    windowSeconds: 600,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const { searchParams } = new URL(request.url);
  const parsed = postalCodeSchema.safeParse({
    postalCode: searchParams.get('postalCode') ?? '',
  });

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid postalCode' }, { status: 400 });
  }

  try {
    const address = await fetchAddressByPostalCode(parsed.data.postalCode);
    return NextResponse.json({ address });
  } catch (error) {
    console.error('Postal code lookup error:', error);
    return NextResponse.json({ error: 'Postal code lookup failed' }, { status: 502 });
  }
}
