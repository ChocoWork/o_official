import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  mapFinalizeOrderRpcError,
  parseFinalizeOrderRpcResult,
} from '@/features/cart/services/cart-stock';
import {
  checkoutShippingSchema,
  findMissingShippingFields,
  getDraftIdFromStripeMetadata,
  isZeroAmountCheckoutSession,
  ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
  type CheckoutDraftRow,
} from '@/features/checkout/services/checkout-draft.service';
import { resolvePaymentMethodFromSession } from '@/features/checkout/services/payment-method.service';
import { logAudit } from '@/lib/audit';
import { extractAuthToken } from '@/lib/auth/request-token';
import { sendOrderConfirmationEmailForOrderId } from '@/lib/orders/order-confirmation-email';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  // 後方互換のためフィールドは残すが、クライアント申告は採用しない（resolvePaymentMethodFromSession 参照）。
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

type OrderRow = {
  id: string;
  user_id: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
};

/**
 * 実際に使われた支払方法（および関連カラム）を checkout_drafts へ書き戻す。
 *
 * 書き込みが失敗しても注文自体は成立しているため、リクエストは失敗させない。
 * ただし黙って捨てると `/api/orders/[id]` が誤った支払方法を表示し続ける原因が
 * 追えなくなるので、エラーは console.error と監査ログの両方に残す。
 */
async function persistCheckoutDraftUpdate(params: {
  draftId: string;
  update: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const { draftId, update, ip, userAgent } = params;
  const { error } = await supabase.from('checkout_drafts').update(update).eq('id', draftId);

  if (error) {
    console.error('Failed to update checkout draft after order finalization:', draftId, error);
    await logAudit({
      action: 'checkout.complete',
      outcome: 'error',
      detail: 'Failed to update checkout draft after order finalization',
      ip,
      user_agent: userAgent,
      metadata: {
        draft_id: draftId,
        error_message: error.message ?? null,
      },
    });
  }
}

async function resolveAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authToken = extractAuthToken(request);
  if (!authToken) {
    return null;
  }

  const authClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    }
  );

  const { data } = await authClient.auth.getUser(authToken);
  return data.user?.id ?? null;
}

/**
 * ゲストのまま作られた注文を、ログイン中のユーザーへ紐付ける。
 *
 * 決済は既に成立しているので、紐付けに失敗してもチェックアウトは成功として返す
 * （ここで失敗を返すと、支払い済みの客に注文失敗を見せることになる）。
 * ただし黙って捨てると「注文履歴に出てこない」形でしか表面化しないので、
 * 失敗も「対象0件」も監査ログに残して後から追えるようにする。
 *
 * @returns 実際に紐付いたら true
 */
async function linkOrderToUser(params: {
  orderId: string;
  userId: string;
  sessionId: string;
  checkoutSessionId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<boolean> {
  // 他人の注文を奪わないよう user_id が未設定の行だけを対象にする。
  const { data, error } = await supabase
    .from('orders')
    .update({ user_id: params.userId })
    .eq('id', params.orderId)
    .is('user_id', null)
    .select('id');

  if (!error && data && data.length > 0) {
    return true;
  }

  console.error(
    'Failed to link guest order to user:',
    error ?? 'no order row matched (already owned by another user)'
  );
  await logAudit({
    action: 'checkout.link_order_to_user',
    outcome: 'error',
    detail: error
      ? 'Failed to link guest order to user'
      : 'Guest order was not linked (already owned by another user)',
    ip: params.ip,
    user_agent: params.userAgent,
    metadata: {
      session_id: params.sessionId,
      checkout_session_id: params.checkoutSessionId,
      order_id: params.orderId,
      linked_user_id: params.userId,
      error_message: error?.message ?? null,
    },
  });
  return false;
}

/**
 * 確定した注文の確認メールを送る（FREQ-396）。
 *
 * 本文は注文行（orders）から組み立てる共通の入口に任せる。ここで draft のスナップショットから
 * 別に組み立てると、webhook・掃除ジョブが送る内容と項目がずれる。実際、値引額は注文行にしか
 * 無いため、draft から組むと「小計＋送料と合計が合わないメール」になっていた。
 *
 * 送信の失敗は中で監査ログに残る。注文は成立しているのでここでは止めない。
 */
async function sendConfirmationEmailForOrder(
	orderId: string,
	paymentState: 'awaiting_payment' | 'paid',
): Promise<void> {
	await sendOrderConfirmationEmailForOrderId({
		store: supabase,
		orderId,
		paymentState,
		logLabel: '[checkout]',
	});
}

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Session not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const activeUserId = await resolveAuthenticatedUserId(req);

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 30,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 15,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const parsed = completeCheckoutSchema.safeParse(
      await req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const stripe = getStripeServerClient();
    const session = await stripe.checkout.sessions.retrieve(
      parsed.data.checkoutSessionId,
      {
        expand: [
          'payment_intent',
          'payment_intent.payment_method',
          'payment_intent.latest_charge',
        ],
      }
    );

    // 実際に使われた支払方法をサーバ側で1回だけ確定する（クライアント申告は採用しない）。
    const resolvedPaymentMethod = resolvePaymentMethodFromSession(session);

    if (session.metadata?.session_id && session.metadata.session_id !== sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Checkout session does not belong to current session',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
        },
      });
      return NextResponse.json(
        { error: 'Checkout session does not belong to current session' },
        { status: 403 }
      );
    }

    if (session.mode !== 'payment') {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid checkout session mode',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          mode: session.mode,
        },
      });
      return NextResponse.json(
        { error: 'Invalid checkout session mode' },
        { status: 400 }
      );
    }

    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    if (!draftId) {
      return NextResponse.json(
        { error: 'Checkout session draft is missing' },
        { status: 400 }
      );
    }

    // 合計が 0 の Checkout セッションには PaymentIntent が作られない（判定と文言は
    // isZeroAmountCheckoutSession の注記を参照）。下の「PaymentIntent が無い」で弾くと
    // 理由が読めないため、ここで明示して断る（FREQ-389）。
    if (isZeroAmountCheckoutSession(session)) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          amount_discount: session.total_details?.amount_discount ?? 0,
        },
      });
      return NextResponse.json(
        { error: 'Zero-amount checkout is not supported' },
        { status: 400 }
      );
    }

    const resolvedPaymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
    if (!resolvedPaymentIntentId) {
      return NextResponse.json(
        { error: 'Stripe payment intent is missing' },
        { status: 400 }
      );
    }

    const resolvedCurrency = session.currency?.toLowerCase() ?? null;
    const resolvedAmount = session.amount_total ?? null;
    // プロモーションコード適用時の値引額 (税込・割引後が amount_total)
    const resolvedDiscount = session.total_details?.amount_discount ?? 0;
    if (!resolvedCurrency || !resolvedAmount) {
      return NextResponse.json(
        { error: 'Checkout session amount is missing' },
        { status: 400 }
      );
    }

    const isSessionComplete =
      session.payment_status === 'paid' || session.status === 'complete';
    if (!isSessionComplete) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Payment is not completed yet',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          payment_status: session.payment_status,
          checkout_status: session.status,
        },
      });
      return NextResponse.json(
        { error: 'Payment is not completed yet' },
        { status: 400 }
      );
    }

    const { data: draftData, error: draftError } = await supabase
      .from('checkout_drafts')
      .select('id, session_id, checkout_session_id, total_amount, discount_amount, subtotal_amount, shipping_amount, currency, shipping_snapshot, items_snapshot')
      .eq('id', draftId)
      .maybeSingle<CheckoutDraftRow>();

    if (draftError || !draftData) {
      return NextResponse.json(
        { error: 'Checkout draft not found' },
        { status: 400 }
      );
    }

    if (draftData.session_id !== sessionId) {
      return NextResponse.json(
        { error: 'Checkout draft does not belong to current session' },
        { status: 403 }
      );
    }

    // 割引前どうしで突き合わせる（FREQ-394）。
    //
    // この経路は1つの注文につき何度でも走る。webhook が先に注文を作ってからブラウザが戻る場合と、
    // 注文確定が落ちて客が再試行する場合がある。下の同期は draft の total_amount を割引後へ
    // 書き換えるので、割引後の合計を「割引前の額」と比べる形にすると2回目から必ず外れ、
    // 支払い済みの客に理由の読めない 400 を返し続けることになる。
    // total_amount + discount_amount は同期の前後で変わらないので、これを基準にする。
    // 取得結果は型注釈を当てているだけで検証はされないため、注文確定 RPC 側の
    // COALESCE(draft_row.discount_amount, 0) と同じく欠損は 0 として扱う。
    const draftAmountBeforeDiscount = draftData.total_amount + (draftData.discount_amount ?? 0);
    if (draftAmountBeforeDiscount !== resolvedAmount + resolvedDiscount) {
      return NextResponse.json(
        { error: 'Checkout session amount does not match draft total' },
        { status: 400 }
      );
    }

    if (draftData.currency.toLowerCase() !== resolvedCurrency) {
      return NextResponse.json(
        { error: 'Unsupported currency' },
        { status: 400 }
      );
    }

    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('payment_intent_id', resolvedPaymentIntentId)
      .maybeSingle<OrderRow>();

    if (existingOrder?.id && activeUserId && existingOrder.user_id !== activeUserId) {
      // 実際に紐付いたときだけ手元の値を進める（0件更新を成功扱いにしない）。
      const linked = await linkOrderToUser({
        orderId: existingOrder.id,
        userId: activeUserId,
        sessionId,
        checkoutSessionId: parsed.data.checkoutSessionId,
        ip: clientIp,
        userAgent,
      });
      if (linked) {
        existingOrder.user_id = activeUserId;
      }
    }

    if (existingOrder) {
      // Webhook が先に注文を作った場合、draft の payment_method は初期値のままなので
      // ここでも本線・フォールバックと同じ値を書き戻す（冪等なので無害）。
      await persistCheckoutDraftUpdate({
        draftId,
        update: { payment_method: resolvedPaymentMethod },
        ip: clientIp,
        userAgent,
      });

      await logAudit({
        action: 'checkout.complete',
        outcome: 'conflict',
        detail: 'Order already finalized',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          order_id: existingOrder.id,
          order_status: existingOrder.status,
        },
      });
      return NextResponse.json({
        orderId: existingOrder.id,
        status: existingOrder.status,
        paymentMethod: resolvedPaymentMethod,
      });
    }

    // draft を割引後の実請求額に同期する（RPC / フォールバックの整合用）。
    // 注文がまだ無いときだけ走らせる。既にある注文はこの下の確定処理を通らないため、
    // そろえる必要も、余計な書き込みを増やす理由も無い。
    // 同じ値を書くだけなので、再試行で二度走っても結果は変わらない。
    if (resolvedDiscount > 0) {
      const { error: discountSyncError } = await supabase
        .from('checkout_drafts')
        .update({ total_amount: resolvedAmount, discount_amount: resolvedDiscount })
        .eq('id', draftId);

      // そろえられないまま進むと、注文確定は割引前の合計と比べて必ず CHECKOUT_TOTAL_MISMATCH で
      // 落ちる。失敗を握りつぶすと本番の監査ログにその理由が残らない（FREQ-389）。
      if (discountSyncError) {
        console.error('Failed to sync checkout draft discount:', draftId, discountSyncError);
        await logAudit({
          action: 'checkout.complete',
          outcome: 'error',
          detail: 'Failed to sync checkout draft discount amount',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            checkout_session_id: parsed.data.checkoutSessionId,
            draft_id: draftId,
            discount_amount: resolvedDiscount,
            error_message: discountSyncError.message ?? null,
          },
        });
        return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
      }

      draftData.total_amount = resolvedAmount;
    }

    // 配送先の欠落を注文確定の前に検知する（FREQ-365）。
    // 支払いは既に成立しているので注文自体は止めない（客に失敗を見せない）。
    // 黙って作ると「発送先の無い注文」に出荷作業で初めて気づくことになるため、
    // 欠けた項目を監査ログに残す（OWASP ASVS V11.1.5 / V11.1.7）。
    const missingShippingFields = findMissingShippingFields(draftData.shipping_snapshot);
    if (missingShippingFields.length > 0) {
      console.error('Checkout draft shipping snapshot is incomplete:', draftId, missingShippingFields);
      await logAudit({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Checkout draft shipping snapshot is incomplete',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          draft_id: draftId,
          payment_intent_id: resolvedPaymentIntentId,
          missing_shipping_fields: missingShippingFields,
        },
      });
    }

    const { data: finalizedOrderData, error: finalizeOrderError } = await supabase.rpc(
      'finalize_order_from_checkout_draft',
      {
        _draft_id: draftId,
        _payment_intent_id: resolvedPaymentIntentId,
        _checkout_session_id: parsed.data.checkoutSessionId,
        _order_status: session.payment_status === 'paid' ? 'paid' : 'pending',
        _expected_total_amount: resolvedAmount,
        _currency: resolvedCurrency,
      }
    );

    if (finalizeOrderError) {
      console.error('Failed to finalize order in complete checkout:', finalizeOrderError);

      await logAudit({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Failed to finalize order via RPC',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          draft_id: draftId,
          payment_intent_id: resolvedPaymentIntentId,
          error_message: finalizeOrderError.message ?? null,
        },
      });
      const mappedError = mapFinalizeOrderRpcError(finalizeOrderError.message ?? '');
      if (mappedError) {
        return NextResponse.json(mappedError.body, { status: mappedError.status });
      }

      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    const finalizedOrder = parseFinalizeOrderRpcResult(finalizedOrderData);
    if (!finalizedOrder) {
      console.error('Unexpected finalize_order_from_checkout_draft payload:', finalizedOrderData);
      await logAudit({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Unexpected finalize_order_from_checkout_draft payload',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          draft_id: draftId,
          payment_intent_id: resolvedPaymentIntentId,
        },
      });
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    // RPC は checkout_drafts.status を 'completed' にするが payment_method までは書かないため、
    // 実際に使われた支払方法をここで書き戻す（注文一覧・注文詳細はこの値を参照する）。
    await persistCheckoutDraftUpdate({
      draftId,
      update: { payment_method: resolvedPaymentMethod },
      ip: clientIp,
      userAgent,
    });

    await sendConfirmationEmailForOrder(
      finalizedOrder.order_id,
      session.payment_status === 'paid' ? 'paid' : 'awaiting_payment',
    );

    await logAudit({
      action: 'checkout.complete',
      outcome: 'success',
      detail: 'Order finalized from checkout session',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        checkout_session_id: parsed.data.checkoutSessionId,
        draft_id: draftId,
        payment_intent_id: resolvedPaymentIntentId,
        order_id: finalizedOrder.order_id,
        order_status: finalizedOrder.order_status,
      },
    });

    return NextResponse.json({
      orderId: finalizedOrder.order_id,
      status: finalizedOrder.order_status,
      paymentMethod: resolvedPaymentMethod,
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    await logAudit({
      action: 'checkout.complete',
      outcome: 'error',
      detail: 'Complete checkout handler error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        error_message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
