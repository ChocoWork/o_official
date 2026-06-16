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
  getDraftIdFromStripeMetadata,
  isStripeCheckoutPaymentMethod,
  mapStripePaymentMethodType,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
  type CheckoutDraftItemsSnapshot,
  type CheckoutDraftRow,
  type CheckoutShippingSnapshot,
  type StripeCheckoutPaymentMethod,
} from '@/features/checkout/services/checkout-draft.service';
import { logAudit } from '@/lib/audit';
import { extractAuthToken } from '@/lib/supabase/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

type OrderRow = {
  id: string;
  user_id: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
};

type CheckoutDraftDetails = CheckoutDraftRow & {
  subtotal_amount: number;
  shipping_amount: number;
};

function isLegacyCheckoutSessionColumnError(message: string | null | undefined) {
  return typeof message === 'string' && message.includes('checkout_session_id does not exist');
}

function mapShippingSnapshotValue(
  shippingSnapshot: CheckoutShippingSnapshot | null,
  key: keyof NonNullable<CheckoutShippingSnapshot>
) {
  return shippingSnapshot?.[key] ?? null;
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

async function finalizeOrderDirectlyFromDraft(params: {
  draftData: CheckoutDraftDetails;
  paymentIntentId: string;
  orderStatus: 'pending' | 'paid';
  userId: string | null;
  discountAmount: number;
}) {
  const { draftData, paymentIntentId, orderStatus, userId, discountAmount } = params;
  const itemsSnapshot = (draftData.items_snapshot ?? []) as CheckoutDraftItemsSnapshot;

  const { data: itemRows, error: itemsError } = await supabase
    .from('items')
    .select('id, status, stock_quantity')
    .in(
      'id',
      Array.from(new Set(itemsSnapshot.map((item) => item.item_id)))
    );

  if (itemsError) {
    return { error: itemsError };
  }

  const itemMap = new Map((itemRows ?? []).map((item) => [item.id, item] as const));

  for (const itemSnapshot of itemsSnapshot) {
    const itemRow = itemMap.get(itemSnapshot.item_id);
    if (!itemRow || itemRow.status !== 'published') {
      return { error: new Error(`ITEM_NOT_PUBLISHED:${itemSnapshot.item_id}`) };
    }

    if (
      itemRow.stock_quantity !== null &&
      itemSnapshot.quantity > itemRow.stock_quantity
    ) {
      return {
        error: new Error(
          `INSUFFICIENT_STOCK:${itemSnapshot.item_id}:${itemSnapshot.quantity}:${itemRow.stock_quantity}`
        ),
      };
    }
  }

  const { data: insertedOrder, error: orderInsertError } = await supabase
    .from('orders')
    .insert({
      session_id: draftData.session_id,
      user_id: userId,
      payment_intent_id: paymentIntentId,
      status: orderStatus,
      subtotal_amount: draftData.subtotal_amount,
      shipping_amount: draftData.shipping_amount,
      discount_amount: discountAmount,
      total_amount: draftData.total_amount,
      currency: draftData.currency,
      shipping_email: mapShippingSnapshotValue(draftData.shipping_snapshot, 'email'),
      shipping_full_name: mapShippingSnapshotValue(draftData.shipping_snapshot, 'fullName'),
      shipping_postal_code: mapShippingSnapshotValue(draftData.shipping_snapshot, 'postalCode'),
      shipping_prefecture: mapShippingSnapshotValue(draftData.shipping_snapshot, 'prefecture'),
      shipping_city: mapShippingSnapshotValue(draftData.shipping_snapshot, 'city'),
      shipping_address: mapShippingSnapshotValue(draftData.shipping_snapshot, 'address'),
      shipping_building: mapShippingSnapshotValue(draftData.shipping_snapshot, 'building'),
      shipping_phone: mapShippingSnapshotValue(draftData.shipping_snapshot, 'phone'),
    })
    .select('id, status')
    .single<OrderRow>();

  if (orderInsertError) {
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, status')
      .eq('payment_intent_id', paymentIntentId)
      .maybeSingle<OrderRow>();

    if (existingOrder) {
      return { data: existingOrder };
    }

    return { error: orderInsertError };
  }

  const orderItems = itemsSnapshot.map((itemSnapshot) => ({
    order_id: insertedOrder.id,
    item_id: itemSnapshot.item_id,
    item_name: itemSnapshot.item_name,
    item_price: itemSnapshot.item_price,
    item_image_url: itemSnapshot.item_image_url,
    color: itemSnapshot.color,
    size: itemSnapshot.size,
    quantity: itemSnapshot.quantity,
    line_total: itemSnapshot.line_total,
  }));

  const { error: orderItemsError } = await supabase.from('order_items').insert(orderItems);
  if (orderItemsError) {
    return { error: orderItemsError };
  }

  const requestedQuantities = new Map<number, number>();
  for (const itemSnapshot of itemsSnapshot) {
    requestedQuantities.set(
      itemSnapshot.item_id,
      (requestedQuantities.get(itemSnapshot.item_id) ?? 0) + itemSnapshot.quantity
    );
  }

  await Promise.all(
    Array.from(requestedQuantities.entries()).map(async ([itemId, quantity]) => {
      const itemRow = itemMap.get(itemId);
      if (!itemRow || itemRow.stock_quantity === null) {
        return;
      }

      await supabase
        .from('items')
        .update({ stock_quantity: itemRow.stock_quantity - quantity })
        .eq('id', itemId);
    })
  );

  await Promise.all(
    itemsSnapshot
      .filter((itemSnapshot) => itemSnapshot.source_cart_id)
      .map(async (itemSnapshot) => {
        await supabase
          .from('carts')
          .delete()
          .eq('id', itemSnapshot.source_cart_id)
          .eq('session_id', draftData.session_id);
      })
  );

  await supabase
    .from('checkout_drafts')
    .update({
      checkout_session_id: draftData.checkout_session_id ?? null,
      payment_intent_id: paymentIntentId,
      status: 'completed',
    })
    .eq('id', draftData.id);

  return { data: insertedOrder };
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
        expand: ['payment_intent'],
      }
    );

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
      .select('id, session_id, checkout_session_id, total_amount, subtotal_amount, shipping_amount, currency, shipping_snapshot, items_snapshot')
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

    // 割引後の請求額 + 値引額 が割引前 draft 合計と一致することを検証
    if (draftData.total_amount !== resolvedAmount + resolvedDiscount) {
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

    // draft を割引後の実請求額に同期 (RPC / フォールバックの整合用)
    if (resolvedDiscount > 0) {
      await supabase
        .from('checkout_drafts')
        .update({ total_amount: resolvedAmount, discount_amount: resolvedDiscount })
        .eq('id', draftId);
      draftData.total_amount = resolvedAmount;
    }

    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('payment_intent_id', resolvedPaymentIntentId)
      .maybeSingle<OrderRow>();

    if (existingOrder?.id && activeUserId && existingOrder.user_id !== activeUserId) {
      await supabase
        .from('orders')
        .update({ user_id: activeUserId })
        .eq('id', existingOrder.id)
        .is('user_id', null);
      existingOrder.user_id = activeUserId;
    }

    if (existingOrder) {
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
        paymentMethod: resolvePaymentMethod(parsed.data.paymentMethod, session),
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
      if (isLegacyCheckoutSessionColumnError(finalizeOrderError.message)) {
        const fallbackResult = await finalizeOrderDirectlyFromDraft({
          draftData: draftData as CheckoutDraftDetails,
          paymentIntentId: resolvedPaymentIntentId,
          orderStatus: session.payment_status === 'paid' ? 'paid' : 'pending',
          userId: activeUserId,
          discountAmount: resolvedDiscount,
        });

        if (fallbackResult.data && activeUserId) {
          await supabase
            .from('orders')
            .update({ user_id: activeUserId })
            .eq('id', fallbackResult.data.id)
            .is('user_id', null);
        }

        if (fallbackResult.data) {
          await logAudit({
            action: 'checkout.complete',
            outcome: 'success',
            detail: 'Order finalized via direct fallback',
            ip: clientIp,
            user_agent: userAgent,
            metadata: {
              session_id: sessionId,
              checkout_session_id: parsed.data.checkoutSessionId,
              draft_id: draftId,
              payment_intent_id: resolvedPaymentIntentId,
              order_id: fallbackResult.data.id,
              order_status: fallbackResult.data.status,
            },
          });

          return NextResponse.json({
            orderId: fallbackResult.data.id,
            status: fallbackResult.data.status,
            paymentMethod: resolvePaymentMethod(parsed.data.paymentMethod, session),
          });
        }

        console.error('Direct fallback order finalization failed:', fallbackResult.error);
      }

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
      paymentMethod: resolvePaymentMethod(parsed.data.paymentMethod, session),
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

function resolvePaymentMethod(
  requestedPaymentMethod: StripeCheckoutPaymentMethod | undefined,
  session: Awaited<ReturnType<ReturnType<typeof getStripeServerClient>['checkout']['sessions']['retrieve']>>
): StripeCheckoutPaymentMethod {
  const selectedPaymentMethod = session.metadata?.selected_payment_method;
  if (isStripeCheckoutPaymentMethod(selectedPaymentMethod)) {
    return requestedPaymentMethod ?? selectedPaymentMethod;
  }

  if (requestedPaymentMethod) {
    return requestedPaymentMethod;
  }

  if (typeof session.payment_intent !== 'string') {
    return mapStripePaymentMethodType(
      session.payment_intent?.payment_method_types?.[0]
    );
  }

  return 'stripe_card';
}