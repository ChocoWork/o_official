import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { addCartLinesSchema } from '@/features/cart/services/cart-stock';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse, cartRpcErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。会員には CSRF の合言葉を求め、
// 送信元（Origin）の確かめは src/proxy.ts が掛ける。

function clientIpOf(req: NextRequest): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
}

/** POST /api/cart/add（Shopify の /cart/add.js。設計書 6-1） */
export async function POST(req: NextRequest) {
  const clientIp = clientIpOf(req);
  const userAgent = req.headers.get('user-agent');
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const byIp = await enforceRateLimit({ request: req, endpoint: 'cart:add', limit: 60, windowSeconds: 60 });
    if (byIp) return byIp;

    const csrfDenied = await denyIfCsrfInvalid();
    if (csrfDenied) return csrfDenied;

    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: true });
    if (!opened.ok) return opened.response;
    const { context } = opened;

    if (context.rateLimitSubject) {
      const byOwner = await enforceRateLimit({ request: req, endpoint: 'cart:add', limit: 30, windowSeconds: 60, subject: context.rateLimitSubject });
      if (byOwner) return byOwner;
    }

    const parsed = addCartLinesSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return context.finish(cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest));
    }
    // バリアントと数量の組を追跡できるよう、監査でも送信順と重複を保つ。
    const lines = parsed.data.items.map((line) => ({ variant_id: line.id, quantity: line.quantity }));

    const cartId = await context.ensureOwnerId();
    const { error } = await supabase.rpc('cart_add_lines', { _cart_id: cartId, _lines: lines });
    if (error) {
      const mapped = cartRpcErrorResponse(error.message ?? '');
      await logAudit({
        action: 'cart.add',
        outcome: mapped ? 'failure' : 'error',
        detail: error.message ?? 'cart_add_lines failed',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, lines },
      });
      return context.finish(mapped ?? cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed));
    }

    const cart = await buildCartJson(supabase, cartId);
    const added = new Set(lines.map((line) => line.variant_id));
    await logAudit({
      action: 'cart.add',
      outcome: 'success',
      resource: 'cart_lines',
      ip: clientIp,
      user_agent: userAgent,
      metadata: { ...context.auditOwner, lines },
    });
    return context.finish(NextResponse.json({ items: cart.items.filter((line) => added.has(line.variant_id)) }));
  } catch (error) {
    console.error('Cart add error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
