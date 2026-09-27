import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  mapFinalizeOrderRpcError,
  parseFinalizeOrderRpcResult,
} from '@/features/cart/services/cart-stock';
import {
  findMissingShippingFields,
  getDraftIdFromStripeMetadata,
  isZeroAmountCheckoutSession,
  ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
  type CheckoutDraftItemsSnapshot,
  type CheckoutShippingSnapshot,
  type StripeCheckoutPaymentMethod,
} from '@/features/checkout/services/checkout-draft.service';
import {
  resolvePaymentMethodFromPaymentIntent,
  resolvePaymentMethodFromSession,
} from '@/features/checkout/services/payment-method.service';
import { logAudit } from '@/lib/audit';

import {
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';
import {
  syncPaymentIntentAccounting,
  syncPayoutAccounting,
  syncRefundAccounting,
} from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { sendOrderConfirmationEmailForOrderId } from '@/lib/orders/order-confirmation-email';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type CheckoutDraftAuditSnapshot = {
  subtotalAmount: number | null;
  shippingAmount: number | null;
  totalAmount: number | null;
  currency: string | null;
  lineItemsCount: number;
  totalQuantity: number;
  lineTotalSum: number;
  /** 注文に必要な配送先の項目のうち、欠けているもの（FREQ-365）。 */
  missingShippingFields: string[];
};

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

async function logWebhookAudit(
  request: NextRequest,
  action: string,
  outcome: 'success' | 'failure' | 'error' | 'conflict',
  detail: string,
  metadata?: Record<string, unknown>
) {
  await logAudit({
    action,
    resource: 'stripe_webhook',
    outcome,
    detail,
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent'),
    metadata,
  });
}

async function getCheckoutDraftAuditSnapshot(
  draftId: string
): Promise<CheckoutDraftAuditSnapshot | null> {
  const { data: draftData, error: draftError } = await supabase
    .from('checkout_drafts')
    .select(
      'subtotal_amount, shipping_amount, total_amount, currency, items_snapshot, shipping_snapshot'
    )
    .eq('id', draftId)
    .maybeSingle<{
      subtotal_amount: number;
      shipping_amount: number;
      total_amount: number;
      currency: string;
      items_snapshot: CheckoutDraftItemsSnapshot | null;
      shipping_snapshot: CheckoutShippingSnapshot | null;
    }>();

  if (draftError || !draftData) {
    return null;
  }

  const itemsSnapshot = draftData.items_snapshot ?? [];
  const lineItemsCount = itemsSnapshot.length;
  const totalQuantity = itemsSnapshot.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const lineTotalSum = itemsSnapshot.reduce((sum, item) => sum + (item.line_total ?? 0), 0);

  return {
    subtotalAmount: draftData.subtotal_amount,
    shippingAmount: draftData.shipping_amount,
    totalAmount: draftData.total_amount,
    currency: draftData.currency,
    lineItemsCount,
    totalQuantity,
    lineTotalSum,
    missingShippingFields: findMissingShippingFields(draftData.shipping_snapshot),
  };
}

async function createOrderFromDraft(
  request: NextRequest,
  draftId: string,
  paymentIntentId: string,
  expectedTotalAmount: number,
  currency: string,
  status: 'paid' | 'pending',
  checkoutSessionId?: string,
  paymentMethod?: StripeCheckoutPaymentMethod | string | null
): Promise<void> {
  const draftSnapshot = await getCheckoutDraftAuditSnapshot(draftId);

  // 配送先の欠落を検知する（FREQ-365）。ブラウザが戻らず webhook だけで注文が作られる経路は、
  // 確定直前の同期が走っていないため欠落が起こりやすい。支払いは成立しているので注文は作り、
  // 出荷前に気づけるよう欠けた項目を監査ログに残す。
  if (draftSnapshot && draftSnapshot.missingShippingFields.length > 0) {
    console.error(
      '[webhook] checkout draft shipping snapshot is incomplete',
      draftId,
      draftSnapshot.missingShippingFields
    );
    await logWebhookAudit(
      request,
      'checkout.webhook.order_finalize',
      'error',
      'Checkout draft shipping snapshot is incomplete',
      {
        draft_id: draftId,
        payment_intent_id: paymentIntentId,
        checkout_session_id: checkoutSessionId ?? null,
        missing_shipping_fields: draftSnapshot.missingShippingFields,
      }
    );
  }

  const { data, error } = await supabase.rpc(
    'finalize_order_from_checkout_draft',
    {
      _draft_id: draftId,
      _payment_intent_id: paymentIntentId,
      _checkout_session_id: checkoutSessionId ?? null,
      _order_status: status,
      _expected_total_amount: expectedTotalAmount,
      _currency: currency,
    }
  );

  if (error) {
    const mappedError = mapFinalizeOrderRpcError(error.message ?? '');
    console.error('[webhook] finalize_order_from_checkout_draft failed', error);
    await logWebhookAudit(
      request,
      'checkout.webhook.order_finalize',
      'error',
      'Failed to finalize order from checkout draft',
      {
        draft_id: draftId,
        payment_intent_id: paymentIntentId,
        checkout_session_id: checkoutSessionId ?? null,
        error_message: error.message ?? null,
        draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
        draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
        draft_total_amount: draftSnapshot?.totalAmount ?? null,
        draft_currency: draftSnapshot?.currency ?? null,
        draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
        draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
        draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
        expected_total_amount: expectedTotalAmount,
        expected_currency: currency,
      }
    );
    throw new Error(mappedError?.body.message ?? 'Failed to create order');
  }

  const finalizedOrder = parseFinalizeOrderRpcResult(data);
  if (!finalizedOrder) {
    console.error('[webhook] unexpected finalize_order_from_checkout_draft payload', data);
    await logWebhookAudit(
      request,
      'checkout.webhook.order_finalize',
      'error',
      'Unexpected finalize_order_from_checkout_draft payload',
      {
        draft_id: draftId,
        payment_intent_id: paymentIntentId,
        checkout_session_id: checkoutSessionId ?? null,
        draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
        draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
        draft_total_amount: draftSnapshot?.totalAmount ?? null,
        draft_currency: draftSnapshot?.currency ?? null,
        draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
        draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
        draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
        expected_total_amount: expectedTotalAmount,
        expected_currency: currency,
      }
    );
    throw new Error('Failed to create order');
  }

  // RPC は checkout_drafts.status を 'completed' にするが payment_method までは書かないため、
  // 実際に使われた支払方法をここで書き戻す（呼び出し元が解決できた場合のみ）。
  if (paymentMethod) {
    const { error: paymentMethodUpdateError } = await supabase
      .from('checkout_drafts')
      .update({ payment_method: paymentMethod })
      .eq('id', draftId);

    if (paymentMethodUpdateError) {
      console.error(
        '[webhook] failed to persist payment_method on checkout draft',
        draftId,
        paymentMethodUpdateError
      );
      await logWebhookAudit(
        request,
        'checkout.webhook.order_finalize',
        'error',
        'Failed to persist payment_method on checkout draft',
        {
          draft_id: draftId,
          payment_intent_id: paymentIntentId,
          error_message: paymentMethodUpdateError.message ?? null,
        }
      );
    }
  }

  await logWebhookAudit(
    request,
    'checkout.webhook.order_finalize',
    'success',
    'Order finalized from checkout draft',
    {
      draft_id: draftId,
      payment_intent_id: paymentIntentId,
      checkout_session_id: checkoutSessionId ?? null,
      order_status: status,
      expected_total_amount: expectedTotalAmount,
      currency,
      draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
      draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
      draft_total_amount: draftSnapshot?.totalAmount ?? null,
      draft_currency: draftSnapshot?.currency ?? null,
      draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
      draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
      draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
      expected_vs_draft_total_delta:
        draftSnapshot?.totalAmount != null
          ? expectedTotalAmount - draftSnapshot.totalAmount
          : null,
    }
  );

  // ブラウザが戻らないまま webhook だけで注文が作られるケース（コンビニ・銀行振込）では、
  // 客に届く注文確認は Stripe の決済画面/メールだけになり、当店からの注文番号入りの
  // メールが一通も届かない（レビュー指摘 I6a）。
  // カード決済でも、webhook が complete より先に注文を作ると同じことが起きる。complete は
  // 既存の注文を見つけると何も送らずに返すため、どちらの経路も送らないまま終わっていた（FREQ-386）。
  // 二重送信は送信権（claim_order_email）で防ぐので、ここでは状態に合う種類を送る。
  if (finalizedOrder.order_status === 'pending' || finalizedOrder.order_status === 'paid') {
    await sendOrderEmailForOrder(
      finalizedOrder.order_id,
      finalizedOrder.order_status === 'pending' ? 'awaiting_payment' : 'paid',
    );
  }
}

async function sendOrderEmailForOrder(
  orderId: string,
  paymentState: 'awaiting_payment' | 'paid',
): Promise<void> {
  await sendOrderConfirmationEmailForOrderId({
    store: supabase,
    orderId,
    paymentState,
    logLabel: '[webhook]',
  });
}

/**
 * 割引が付いたセッションの実請求額と割引額を下書きへそろえる（FREQ-389 / FREQ-394）。
 *
 * 下書きは割引前の合計を持つため、そろえないまま注文確定を呼ぶと CHECKOUT_TOTAL_MISMATCH で
 * 必ず落ちる。ブラウザが戻らない経路（コンビニ・銀行振込、webhook 先行のカード）では
 * complete が走らないので webhook 側でもそろえる。
 *
 * Stripe はイベントの配信順を保証しないので、checkout.session.completed と
 * payment_intent.succeeded のどちらが先に届いてもそろうよう、両方から呼ぶ。
 * 書くのは Stripe から読んだ同じ値なので、二度走っても結果は変わらない。
 */
async function syncCheckoutDraftDiscount(
  request: NextRequest,
  params: {
    eventType: string;
    draftId: string;
    paymentIntentId: string;
    session: Pick<Stripe.Checkout.Session, 'id' | 'amount_total' | 'total_details'>;
  }
): Promise<void> {
  const { eventType, draftId, paymentIntentId, session } = params;
  const amountDiscount = session.total_details?.amount_discount ?? 0;
  if (amountDiscount <= 0) {
    return;
  }

  const { error: discountSyncError } = await supabase
    .from('checkout_drafts')
    .update({ total_amount: session.amount_total ?? 0, discount_amount: amountDiscount })
    .eq('id', draftId);

  if (discountSyncError) {
    console.error('[webhook] failed to sync checkout draft discount', draftId, discountSyncError);
    await logWebhookAudit(request, 'checkout.webhook.order_finalize', 'error', 'Failed to sync checkout draft discount amount', {
      event_type: eventType,
      checkout_session_id: session.id,
      draft_id: draftId,
      payment_intent_id: paymentIntentId,
      discount_amount: amountDiscount,
      error_message: discountSyncError.message ?? null,
    });
    // 例外にして 500 を返し、Stripe に再送させる（FREQ-369 と同じ扱い）。
    throw new Error(discountSyncError.message || 'Failed to sync checkout draft discount amount');
  }
}

/**
 * PaymentIntent を作った Checkout Session を引く（FREQ-394）。
 *
 * payment_intent.succeeded のペイロードには割引額が無いため、割引をそろえるには
 * セッション側を見るしかない。Checkout を経由しない PaymentIntent もありうるので、
 * 見つからない場合と引けなかった場合は null を返し、呼び出し側は割引なしとして進む
 * （その状態で合計が食い違えば注文確定が弾く。金額の根拠を推測で埋めない）。
 */
async function findCheckoutSessionForPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string
): Promise<Stripe.Checkout.Session | null> {
  try {
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    return sessions.data[0] ?? null;
  } catch (error) {
    console.error(
      '[webhook] failed to look up checkout session for payment intent',
      paymentIntentId,
      error
    );
    return null;
  }
}

async function handleCheckoutSessionCompleted(
  request: NextRequest,
  session: Stripe.Checkout.Session,
  stripe: Stripe
): Promise<void> {
  const draftId = getDraftIdFromStripeMetadata(session.metadata);
  if (!draftId) {
    console.error('[webhook] checkout.session.completed missing draft_id metadata', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing draft_id metadata', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
    });
    return;
  }

  // 合計 0 のセッションには PaymentIntent が作られない。下の「payment_intent が無い」で
  // 終わらせると、Stripe 側の不具合と区別がつかないので先に明示して記録する（FREQ-397）。
  // 確定（complete）が 400 で断るのと同じ理由・同じ文言。ここは再送しても結果が変わらないため
  // 例外にせず、処理済みとして終える。
  if (isZeroAmountCheckoutSession(session)) {
    console.error('[webhook] checkout.session.completed with zero amount_total', session.id);
    await logWebhookAudit(
      request,
      'checkout.webhook.event_invalid',
      'failure',
      ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
      {
        event_type: 'checkout.session.completed',
        checkout_session_id: session.id,
        draft_id: draftId,
        amount_discount: session.total_details?.amount_discount ?? 0,
      }
    );
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.completed missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
      draft_id: draftId,
    });
    return;
  }

  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', paymentIntentId)
    .maybeSingle();

  if (existingOrder) {
    console.info('[webhook] order already exists for checkout session', session.id, 'skipping');
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'Order already exists for checkout session', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
      draft_id: draftId,
      payment_intent_id: paymentIntentId,
      order_id: existingOrder.id,
    });
    return;
  }

  // webhook イベントのペイロードは expand されていないため、実際に使われた支払方法を
  // 解決するには expand 付きで取り直す必要がある（Task 5 レビュー指摘）。
  let resolvedPaymentMethod: StripeCheckoutPaymentMethod | string | null = null;
  try {
    const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: [
        'payment_intent',
        'payment_intent.payment_method',
        'payment_intent.latest_charge',
      ],
    });
    resolvedPaymentMethod = resolvePaymentMethodFromSession(expandedSession);
  } catch (error) {
    console.error(
      '[webhook] failed to retrieve expanded checkout session for payment method resolution',
      session.id,
      error
    );
  }

  await syncCheckoutDraftDiscount(request, {
    eventType: 'checkout.session.completed',
    draftId,
    paymentIntentId,
    session,
  });

  await createOrderFromDraft(
    request,
    draftId,
    paymentIntentId,
    session.amount_total ?? 0,
    session.currency ?? 'jpy',
    session.payment_status === 'paid' ? 'paid' : 'pending',
    session.id,
    resolvedPaymentMethod
  );
}

async function handleCheckoutSessionAsyncPaymentSucceeded(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.async_payment_succeeded missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.async_payment_succeeded',
      checkout_session_id: session.id,
    });
    return;
  }

  const { data: updatedOrders, error } = await supabase
    .from('orders')
    .update({ status: 'paid' })
    .eq('payment_intent_id', paymentIntentId)
    .eq('status', 'pending')
    .select('id');

  if (error) {
    console.error('[webhook] failed to update order status to paid', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to mark order as paid', {
      event_type: 'checkout.session.async_payment_succeeded',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    // 例外にして 500 を返し、Stripe に再送させる（FREQ-369）。
    // supabase-js は失敗を例外にせず { error } で返すので、ここで return すると成功扱いの 200 になり、
    // 入金済みの注文が pending のまま残る。更新は status='pending' の行だけが対象なので、
    // 再送されても二重に paid にしたり確認メールを重ねて送ったりしない。
    throw new Error(error.message || 'Failed to mark order as paid');
  }

  // 更新行が0件なら再送イベント（既に paid 済み）なので、確認メールは送らない（冪等）。
  const updatedOrder = updatedOrders?.[0];
  if (updatedOrder) {
    await sendOrderEmailForOrder(updatedOrder.id, 'paid');
  }

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Marked pending order as paid', {
    event_type: 'checkout.session.async_payment_succeeded',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
  });
}

async function handleCheckoutSessionAsyncPaymentFailed(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.async_payment_failed missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.async_payment_failed',
      checkout_session_id: session.id,
    });
    return;
  }

  const { data, error } = await supabase.rpc('release_stock_for_unpaid_order', {
    _payment_intent_id: paymentIntentId,
  });

  if (error) {
    console.error('[webhook] failed to release stock for order', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to release stock for unpaid order', {
      event_type: 'checkout.session.async_payment_failed',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    throw new Error(error.message || 'Failed to release stock for unpaid order');
  }

  const result = Array.isArray(data) ? data[0] : data;

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Released stock for unpaid order', {
    event_type: 'checkout.session.async_payment_failed',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
    released: result?.released ?? false,
    order_id: result?.order_id ?? null,
  });
}

async function handleCheckoutSessionExpired(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.info('[webhook] checkout.session.expired without payment_intent, skipping', session.id);
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'checkout.session.expired without payment_intent', {
      event_type: 'checkout.session.expired',
      checkout_session_id: session.id,
    });
    return;
  }

  const { data, error } = await supabase.rpc('release_stock_for_unpaid_order', {
    _payment_intent_id: paymentIntentId,
  });

  if (error) {
    console.error('[webhook] failed to release stock for order', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to release stock for unpaid order', {
      event_type: 'checkout.session.expired',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    throw new Error(error.message || 'Failed to release stock for unpaid order');
  }

  const result = Array.isArray(data) ? data[0] : data;

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Released stock for unpaid order', {
    event_type: 'checkout.session.expired',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
    released: result?.released ?? false,
    order_id: result?.order_id ?? null,
  });
}

async function handlePaymentIntentSucceeded(
  request: NextRequest,
  paymentIntent: Stripe.PaymentIntent,
  stripe: Stripe
): Promise<void> {
  const draftId = getDraftIdFromStripeMetadata(paymentIntent.metadata);
  if (!draftId) {
    console.error('[webhook] payment_intent.succeeded missing draft_id metadata', paymentIntent.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing draft_id metadata', {
      event_type: 'payment_intent.succeeded',
      payment_intent_id: paymentIntent.id,
    });
    return;
  }

  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', paymentIntent.id)
    .maybeSingle();

  if (existingOrder) {
    console.info('[webhook] order already exists for payment_intent', paymentIntent.id, 'skipping');
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'Order already exists for payment_intent', {
      event_type: 'payment_intent.succeeded',
      payment_intent_id: paymentIntent.id,
      draft_id: draftId,
      order_id: existingOrder.id,
    });
    return;
  }

  // webhook イベントのペイロードは expand されていないため、実際に使われた支払方法を
  // 解決するには expand 付きで PaymentIntent を取り直す必要がある（checkout.session.completed
  // と同じ理由。このイベントのペイロードに Checkout Session は入らないため session 側の
  // resolve は使えない）。
  let resolvedPaymentMethod: StripeCheckoutPaymentMethod | string | null = null;
  try {
    const expandedPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ['payment_method', 'latest_charge'],
    });
    resolvedPaymentMethod = resolvePaymentMethodFromPaymentIntent(expandedPaymentIntent);
  } catch (error) {
    console.error(
      '[webhook] failed to retrieve expanded payment intent for payment method resolution',
      paymentIntent.id,
      error
    );
  }

  // checkout.session.completed より先にこのイベントが届くと、下書きは割引前の合計のまま。
  // 割引額はこのペイロードに無いので、セッション側から引いてそろえる（FREQ-394）。
  const checkoutSession = await findCheckoutSessionForPaymentIntent(stripe, paymentIntent.id);
  if (checkoutSession) {
    await syncCheckoutDraftDiscount(request, {
      eventType: 'payment_intent.succeeded',
      draftId,
      paymentIntentId: paymentIntent.id,
      session: checkoutSession,
    });
  }

  await createOrderFromDraft(
    request,
    draftId,
    paymentIntent.id,
    paymentIntent.amount ?? 0,
    paymentIntent.currency ?? 'jpy',
    'paid',
    checkoutSession?.id,
    resolvedPaymentMethod
  );
}

async function handlePaymentIntentFailed(
  request: NextRequest,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const { data, error } = await supabase.rpc('release_stock_for_unpaid_order', {
    _payment_intent_id: paymentIntent.id,
  });

  if (error) {
    console.error('[webhook] failed to release stock for order', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to release stock for unpaid order', {
      event_type: 'payment_intent.payment_failed',
      payment_intent_id: paymentIntent.id,
      error_message: error.message ?? null,
    });
    throw new Error(error.message || 'Failed to release stock for unpaid order');
  }

  const result = Array.isArray(data) ? data[0] : data;

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Released stock for unpaid order', {
    event_type: 'payment_intent.payment_failed',
    payment_intent_id: paymentIntent.id,
    released: result?.released ?? false,
    order_id: result?.order_id ?? null,
  });
}

function resolvePaymentIntentId(
  value: string | Stripe.PaymentIntent | null | undefined,
): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

async function handleRefundChanged(
  object: Stripe.Refund | Stripe.Charge,
  stripe: Stripe,
): Promise<void> {
  const paymentIntentId = resolvePaymentIntentId(object.payment_intent);
  if (!paymentIntentId) {
    throw new Error('Stripe refund event is missing payment_intent');
  }

  await syncOrderRefunds({
    database: supabase as unknown as OrderRefundDatabase,
    stripe: stripe as unknown as RefundListClient,
    paymentIntentId,
  });
}

type AccountingStripeClient = Parameters<typeof syncPayoutAccounting>[0]['stripe'];

/**
 * 注文更新とは独立に、Stripe原始記録（Balance Transaction / Refund / Payout）を同期する。
 */
async function syncAccountingForEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  const database = createStripeAccountingDatabase(supabase);
  const client = stripe as unknown as AccountingStripeClient;
  const object = event.data.object as { id?: string };
  if (!object?.id) {
    return;
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      await syncPaymentIntentAccounting({ stripe: client, database, paymentIntentId: object.id });
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await syncRefundAccounting({ stripe: client, database, refundId: object.id });
      break;
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.reconciliation_completed':
      await syncPayoutAccounting({ stripe: client, database, payoutId: object.id });
      break;
    default:
      break;
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  auditRequest: NextRequest,
): Promise<void> {
  const stripe = getStripeServerClient();

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(
        auditRequest, event.data.object as Stripe.Checkout.Session, stripe
      );
      break;
    case 'checkout.session.async_payment_succeeded':
      await handleCheckoutSessionAsyncPaymentSucceeded(
        auditRequest, event.data.object as Stripe.Checkout.Session
      );
      break;
    case 'checkout.session.async_payment_failed':
      await handleCheckoutSessionAsyncPaymentFailed(
        auditRequest, event.data.object as Stripe.Checkout.Session
      );
      break;
    case 'checkout.session.expired':
      await handleCheckoutSessionExpired(
        auditRequest, event.data.object as Stripe.Checkout.Session
      );
      break;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(
        auditRequest, event.data.object as Stripe.PaymentIntent, stripe
      );
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(
        auditRequest, event.data.object as Stripe.PaymentIntent
      );
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await handleRefundChanged(event.data.object as Stripe.Refund, stripe);
      break;
    case 'charge.refunded':
      await handleRefundChanged(event.data.object as Stripe.Charge, stripe);
      break;
    default:
      break;
  }

  await syncAccountingForEvent(event, stripe);
  await logWebhookAudit(
    auditRequest,
    'checkout.webhook.event_processing',
    'success',
    'Webhook event processed',
    { event_id: event.id, event_type: event.type },
  );
}