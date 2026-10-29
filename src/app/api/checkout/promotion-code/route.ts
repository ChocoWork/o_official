import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { findCartIdForBuyer } from '@/features/cart/services/shopping-context';
import { checkoutBuyerFailureResponse, resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';
import { loadCheckoutCart } from '@/features/checkout/services/checkout-cart.service';
import { PROMOTION_CODE_GUARD, guardCheckoutPost } from '@/features/checkout/services/checkout-route-guard';
import { checkoutPromotionRefusalMessage, promotionCodesSchema, publicDiscountRefusals } from '@/features/checkout/services/promotion-code.service';
import { evaluateCheckoutDiscounts } from '@/features/checkout/services/checkout-discounts.service';
import { DiscountInputError, type DiscountBuyer } from '@/lib/discounts/discount-types';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const requestSchema = z.object({ codes: promotionCodesSchema, guestEmail: z.string().email().max(254).optional() }).strict().transform(({ codes }) => ({ codes }));
const FAILED_MESSAGE = '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。';

// PUBLIC: guest preview never uses typed email for identity/history. Only verified app sessions identify members.
export async function POST(req: NextRequest) {
  const guard = await guardCheckoutPost(req, PROMOTION_CODE_GUARD);
  if (!guard.ok) return guard.response;
  const finish = (response: NextResponse) => { response.headers.set('Cache-Control', 'no-store'); return guard.finish(response); };
  const audit = async (outcome: 'success' | 'failure' | 'error', metadata: Record<string, unknown>) => {
    try { await logAudit({ action: 'checkout.promotion_code.check', outcome, detail: 'discount_code_check', ip: guard.clientIp, user_agent: guard.userAgent,
      metadata: { session_id: guard.sessionId, ...metadata } }); } catch { console.error('discount_audit_failed'); }
  };
  try {
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return finish(NextResponse.json({ error: 'invalid_request', message: 'このコードは使えません' }, { status: 400 }));
    const buyer = await resolveCheckoutBuyer(req);
    if (buyer.kind === 'expired' || buyer.kind === 'unavailable') return finish(checkoutBuyerFailureResponse(buyer.kind));
    if (buyer.kind === 'member') {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const limited = await enforceRateLimit({ request: req, endpoint: 'checkout:promotion-code:member', subject: buyer.userId, limit: 10, windowSeconds: 60 });
      if (limited) { limited.headers.set('Cache-Control', 'no-store'); return limited; }
    }
    const discountBuyer: DiscountBuyer = buyer.kind === 'member' ? { kind: 'member', userId: buyer.userId } : { kind: 'guest', normalizedEmail: null };
    const cart = await loadCheckoutCart(supabase, await findCartIdForBuyer(supabase, req, buyer));
    if (cart.kind === 'empty') return finish(NextResponse.json({ error: 'cart_empty', message: 'ご購入いただける商品がありません。' }, { status: 400 }));
    const evaluated = await evaluateCheckoutDiscounts(supabase, discountBuyer, cart.cartRows.map(l => ({ lineKey: l.id, itemId: l.item_id,
      unitPrice: cart.itemMap.get(l.item_id)?.price ?? 0, quantity: l.quantity, lineKind: 'order' as const })), parsed.data.codes, new Date().toISOString(), 'preview');
    const refusals = publicDiscountRefusals(discountBuyer, evaluated.refusals, [], evaluated.facts);
    // The service already masks restricted member codes; preserve its public member refusals.
    const visible = discountBuyer.kind === 'guest' ? refusals : evaluated.refusals;
    if (visible.length) {
      await audit('failure', { refusal_count: visible.length });
      return finish(NextResponse.json({ error: 'promotion_code_invalid', refusals: visible, message: checkoutPromotionRefusalMessage(discountBuyer, visible[0]) }, { status: 422 }));
    }
    await audit('success', { discount_ids: evaluated.result.applied.map(e => e.discountId), code_ids: evaluated.result.applied.flatMap(e => e.codeId ? [e.codeId] : []), applied_count: evaluated.result.applied.length });
    return finish(NextResponse.json({ result: evaluated.result }));
  } catch (error) {
    if (error instanceof DiscountInputError && error.code === 'total_below_minimum') return finish(NextResponse.json({ error: 'total_below_minimum', message: 'お支払い金額は50円以上にしてください。' }, { status: 422 }));
    console.error('discount_code_check_failed');
    await audit('error', { result_code: 'discount_failed' });
    return finish(NextResponse.json({ error: 'promotion_code_failed', message: FAILED_MESSAGE }, { status: 500 }));
  }
}
