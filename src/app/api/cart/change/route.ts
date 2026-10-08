import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { changeCartLineSchema } from '@/features/cart/services/cart-stock';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse, cartRpcErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。明細は持ち主のカートの物だけを変えられる（DB の関数が照合する）。

function clientIpOf(req: NextRequest): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
}

/** POST /api/cart/change（Shopify の /cart/change.js。数量0で削除。設計書 6-1） */
export async function POST(req: NextRequest) {
  const clientIp = clientIpOf(req);
  const userAgent = req.headers.get('user-agent');
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const byIp = await enforceRateLimit({ request: req, endpoint: 'cart:change', limit: 120, windowSeconds: 60 });
    if (byIp) return byIp;

    const csrfDenied = await denyIfCsrfInvalid();
    if (csrfDenied) return csrfDenied;

    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: true });
    if (!opened.ok) return opened.response;
    const { context } = opened;

    if (context.rateLimitSubject) {
      const byOwner = await enforceRateLimit({ request: req, endpoint: 'cart:change', limit: 60, windowSeconds: 60, subject: context.rateLimitSubject });
      if (byOwner) return byOwner;
    }

    const parsed = changeCartLineSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return context.finish(cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest));
    }

    const cartId = await context.findOwnerId();
    if (!cartId) {
      return context.finish(cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.lineNotFound));
    }

    const { error } = await supabase.rpc('cart_change_line', {
      _cart_id: cartId,
      _line_id: parsed.data.id,
      _quantity: parsed.data.quantity,
    });
    if (error) {
      const mapped = cartRpcErrorResponse(error.message ?? '');
      await logAudit({
        action: 'cart.change',
        outcome: mapped ? 'failure' : 'error',
        detail: error.message ?? 'cart_change_line failed',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, line_id: parsed.data.id, quantity: parsed.data.quantity },
      });
      return context.finish(mapped ?? cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed));
    }

    await logAudit({
      action: 'cart.change',
      outcome: 'success',
      resource: 'cart_lines',
      resource_id: parsed.data.id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: { ...context.auditOwner, quantity: parsed.data.quantity },
    });
    return context.finish(NextResponse.json(await buildCartJson(supabase, cartId)));
  } catch (error) {
    console.error('Cart change error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
