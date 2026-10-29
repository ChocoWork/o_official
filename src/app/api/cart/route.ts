import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import type { DiscountBuyer } from '@/lib/discounts/discount-types';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。持ち主は cart Cookie の印（ゲスト）か
// 確かめた会員の ID で決める（設計書第4章）。

/** GET /api/cart（Shopify の /cart.js と同じ形。設計書 6-1） */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: false });
    if (!opened.ok) {
      return opened.response;
    }
    const { context } = opened;
    const buyer: DiscountBuyer = context.owner?.kind === 'member' ? { kind: 'member', userId: context.owner.userId } : { kind: 'guest', normalizedEmail: null };
    const cart = await buildCartJson(supabase, await context.findOwnerId(), buyer);
    return context.finish(NextResponse.json(cart, { headers: { 'Cache-Control': 'no-store' } }));
  } catch (error) {
    console.error('Cart GET error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
