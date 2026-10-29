import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { checkoutBuyerFailureResponse, resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';
import { listDiscountAdvertisements } from '@/lib/discounts/discount-preview-store';
import type { DiscountBuyer } from '@/lib/discounts/discount-types';

// PUBLIC: 商品ページの案内。会員とゲストで結果が違うので、どの応答も共有cacheに載せない。
// 回数制限の送り元IPは enforceRateLimit が getClientIp だけから取る（x-forwarded-for は読まない）。
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/;

function respond(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** GET /api/discounts/advertisements?itemId=<正整数> → 200 {rows:[{discountId,text}]} */
export async function GET(req: NextRequest) {
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const limited = await enforceRateLimit({ request: req, endpoint: 'discounts:advertisements', limit: 60, windowSeconds: 600 });
    if (limited) {
      limited.headers.set('Cache-Control', 'no-store');
      return limited;
    }

    const values = req.nextUrl.searchParams.getAll('itemId');
    const itemId = values.length === 1 && POSITIVE_INTEGER.test(values[0]) ? Number(values[0]) : NaN;
    if (!Number.isSafeInteger(itemId)) return respond({ error: 'invalid_request' }, 400);

    const buyer = await resolveCheckoutBuyer(req);
    if (buyer.kind === 'expired' || buyer.kind === 'unavailable') {
      const failure = checkoutBuyerFailureResponse(buyer.kind);
      failure.headers.set('Cache-Control', 'no-store');
      return failure;
    }
    const discountBuyer: DiscountBuyer = buyer.kind === 'member'
      ? { kind: 'member', userId: buyer.userId }
      : { kind: 'guest', normalizedEmail: null };

    const supabase = await createServiceRoleClient();
    const { data: item, error } = await supabase.from('items').select('id, status').eq('id', itemId).maybeSingle();
    if (error) throw new Error('item lookup failed');
    if (!item || item.status !== 'published') return respond({ error: 'not_found' }, 404);

    const rows = await listDiscountAdvertisements(supabase, discountBuyer, itemId, new Date().toISOString());
    return respond({ rows }, 200);
  } catch {
    console.error('discount_advertisements_failed');
    return respond({ error: 'advertisements_failed' }, 500);
  }
}
