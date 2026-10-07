import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import { logAudit } from '@/lib/audit';
import { loadCheckoutCart } from '@/features/checkout/services/checkout-cart.service';
import { PROMOTION_CODE_GUARD, guardCheckoutPost } from '@/features/checkout/services/checkout-route-guard';
import { PROMOTION_CODE_PATTERN, checkPromotionCode } from '@/features/checkout/services/promotion-code.service';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const requestSchema = z.object({ code: z.string().trim().regex(PROMOTION_CODE_PATTERN) }).strict();

const FAILED_MESSAGE = '割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。';

// PUBLIC: ゲスト購入を許可する公開 Route。守りは guardCheckoutPost（Cookie・回数の制限・CSRF）。
// 割引コードの「適用」（グループ F 設計書第3章）。サーバーが Stripe に問い合わせ、今のカートで使えるかを確かめる。
// 決済の画面にコードを付けるのは「確認へ進む」（create-session）で、ここは確かめと割引後の金額の目安だけ。
export async function POST(req: NextRequest) {
  const guard = await guardCheckoutPost(req, PROMOTION_CODE_GUARD);
  if (!guard.ok) {
    return guard.response;
  }

  const audit = async (
    outcome: 'success' | 'failure' | 'error',
    detail: string,
    metadata: Record<string, unknown> = {},
  ) => {
    try {
      await logAudit({
        action: 'checkout.promotion_code.check',
        outcome,
        detail,
        ip: guard.clientIp,
        user_agent: guard.userAgent,
        metadata: { session_id: guard.sessionId, ...metadata },
      });
    } catch (logError) {
      console.error('Failed to log promotion code audit:', logError);
    }
  };

  try {
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return guard.finish(
        NextResponse.json({ error: 'invalid_request', message: 'このコードは使えません' }, { status: 400 }),
      );
    }

    const cart = await loadCheckoutCart(supabase, guard.sessionId);
    if (cart.kind === 'empty') {
      return guard.finish(
        NextResponse.json({ error: 'cart_empty', message: 'ご購入いただける商品がありません。' }, { status: 400 }),
      );
    }
    if (cart.kind === 'unavailable') {
      return guard.finish(NextResponse.json(cart.body, { status: 409 }));
    }

    const result = await checkPromotionCode(getStripeServerClient(), {
      code: parsed.data.code,
      preDiscountTotal: cart.amounts.totalAmount,
      now: new Date(),
    });
    if (!result.ok) {
      await audit('failure', 'Promotion code rejected', { reason: result.reason });
      return guard.finish(
        NextResponse.json(
          { error: 'promotion_code_invalid', reason: result.reason, message: result.message },
          { status: 422 },
        ),
      );
    }

    await audit('success', 'Promotion code accepted', { promotion_code_id: result.promotionCodeId });
    return guard.finish(
      NextResponse.json({
        code: result.code,
        subtotalAmount: cart.amounts.subtotalAmount,
        shippingAmount: cart.amounts.shippingAmount,
        discountAmount: result.discountAmount,
        totalAmount: result.totalAfterDiscount,
      }),
    );
  } catch (error) {
    console.error('Promotion code check error:', error);
    await audit('error', 'Promotion code check failed', {
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });
    return guard.finish(NextResponse.json({ error: 'promotion_code_failed', message: FAILED_MESSAGE }, { status: 500 }));
  }
}
