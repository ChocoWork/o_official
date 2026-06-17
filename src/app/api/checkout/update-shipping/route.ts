import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  checkoutShippingSchema,
  type CheckoutShippingSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import { logAudit } from '@/lib/audit';
import { cookieOptionsForCsrf, csrfCookieName } from '@/lib/cookie';

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

type CsrfRotateResult = {
  rotatedCsrfToken: string;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

function hasRotatedCsrfToken(value: unknown): value is CsrfRotateResult {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

function applyRotatedCsrfCookie(response: NextResponse, csrfResult: unknown) {
  if (!hasRotatedCsrfToken(csrfResult)) {
    return response;
  }

  response.cookies.set({
    name: csrfCookieName,
    value: csrfResult.rotatedCsrfToken,
    ...cookieOptionsForCsrf(0),
  });

  return response;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const updateShippingSchema = z.object({
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

function buildShippingSnapshot(
  shipping: NonNullable<z.infer<typeof checkoutShippingSchema>> | undefined
): CheckoutShippingSnapshot {
  return {
    email: shipping?.email ?? null,
    fullName: shipping?.fullName ?? null,
    postalCode: shipping?.postalCode ?? null,
    prefecture: shipping?.prefecture ?? null,
    city: shipping?.city ?? null,
    address: shipping?.address ?? null,
    building: shipping?.building ?? null,
    phone: shipping?.phone ?? null,
  };
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:update-shipping',
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:update-shipping',
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (isCsrfDenyResponse(csrfResult)) {
      const denyResponse = NextResponse.json(csrfResult._body, { status: csrfResult.status });
      if (csrfResult.headers instanceof Headers) {
        csrfResult.headers.forEach((headerValue, headerName) => {
          denyResponse.headers.set(headerName, headerValue);
        });
      } else if (csrfResult.headers) {
        for (const [headerName, headerValue] of Object.entries(csrfResult.headers)) {
          denyResponse.headers.set(headerName, headerValue);
        }
      }

      return denyResponse;
    }

    const parsed = updateShippingSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { checkoutSessionId, shipping } = parsed.data;
    const shippingSnapshot = buildShippingSnapshot(shipping);

    const { data: updated, error: updateError } = await supabase
      .from('checkout_drafts')
      .update({ shipping_snapshot: shippingSnapshot })
      .eq('checkout_session_id', checkoutSessionId)
      .eq('session_id', sessionId)
      .neq('status', 'completed')
      .select('id')
      .maybeSingle<{ id: string }>();

    if (updateError) {
      console.error('Failed to update checkout draft shipping:', updateError);
      await logAudit({
        action: 'checkout.shipping.update',
        outcome: 'error',
        detail: 'Failed to update draft shipping snapshot',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, checkout_session_id: checkoutSessionId },
      });
      return NextResponse.json({ error: 'Failed to update shipping' }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: 'Checkout draft not found' }, { status: 404 });
    }

    return applyRotatedCsrfCookie(NextResponse.json({ ok: true }), csrfResult);
  } catch (error) {
    console.error('Update shipping error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
