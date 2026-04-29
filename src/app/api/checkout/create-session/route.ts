import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  buildInventoryConflictBody,
  collectInventoryIssues,
} from '@/features/cart/services/cart-stock';
import {
  checkoutShippingSchema,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
  type CheckoutCartSnapshotRow,
  type CheckoutDraftRow,
  type CheckoutItemSnapshotRow,
} from '@/features/checkout/services/checkout-draft.service';
import {
  calculateCheckoutAmountsFromCartRows,
  checkoutDisplayedAmountsSchema,
  isCheckoutDisplayedAmountsMatched,
} from '@/features/checkout/services/checkout-pricing.service';
import { logAudit } from '@/lib/audit';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const createSessionSchema = z.object({
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  uiMode: z.enum(['hosted', 'custom']).default('hosted'),
  shipping: checkoutShippingSchema,
  displayedAmounts: checkoutDisplayedAmountsSchema,
});

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
        action: 'checkout.session.create',
        outcome: 'failure',
        detail: 'Session cookie not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:create-session',
      limit: 20,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:create-session',
      limit: 10,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    // CSRF protection: enforced for authenticated users (sb-refresh-token present).
    // Unauthenticated guest sessions are mitigated by SameSite=Lax cookie policy.
    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult) {
      return csrfResult;
    }

    const parsed = createSessionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      await logAudit({
        action: 'checkout.session.create',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { paymentMethod, shipping, uiMode, displayedAmounts } = parsed.data;

    const { data: cartData, error: cartError } = await supabase
      .from('carts')
      .select('id, item_id, quantity, color, size')
      .eq('session_id', sessionId);

    if (cartError) {
      console.error('Failed to fetch cart for checkout session:', cartError);
      await logAudit({
        action: 'checkout.session.create',
        outcome: 'error',
        detail: 'Failed to fetch cart',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, error_message: cartError.message ?? null },
      });
      return NextResponse.json({ error: 'Failed to fetch cart' }, { status: 500 });
    }

    if (!cartData || cartData.length === 0) {
      await logAudit({
        action: 'checkout.session.create',
        outcome: 'failure',
        detail: 'Cart is empty',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
    }

    const itemIds = (cartData as CheckoutCartSnapshotRow[]).map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, name, price, image_url, stock_quantity, status')
      .in('id', itemIds)
      .eq('status', 'published');

    if (itemsError) {
      console.error('Failed to fetch items for checkout session:', itemsError);
      return NextResponse.json({ error: 'Failed to fetch items' }, { status: 500 });
    }

    const inventoryIssues = collectInventoryIssues(
      cartData as CheckoutCartSnapshotRow[],
      (itemsData ?? []) as CheckoutItemSnapshotRow[]
    );

    if (inventoryIssues.length > 0) {
      return NextResponse.json(
        buildInventoryConflictBody(inventoryIssues, 'out_of_stock'),
        { status: 409 }
      );
    }

    const itemMap = new Map<number, CheckoutItemSnapshotRow>(
      ((itemsData ?? []) as CheckoutItemSnapshotRow[]).map((item) => [item.id, item])
    );

    const { subtotalAmount, taxAmount, shippingAmount, totalAmount } = calculateCheckoutAmountsFromCartRows(
      cartData as CheckoutCartSnapshotRow[],
      itemMap
    );

    if (
      !isCheckoutDisplayedAmountsMatched(
        { subtotalAmount, taxAmount, shippingAmount, totalAmount },
        displayedAmounts
      )
    ) {
      await logAudit({
        action: 'checkout.session.create',
        outcome: 'failure',
        detail: 'Displayed checkout amounts do not match server-calculated amounts',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          displayed_amounts: displayedAmounts,
          server_amounts: { subtotalAmount, taxAmount, shippingAmount, totalAmount },
        },
      });
      return NextResponse.json(
        {
          error: 'checkout_amount_mismatch',
          message: '表示金額と請求金額が一致しません。画面を再読み込みして再度お試しください。',
        },
        { status: 409 }
      );
    }

    if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
      return NextResponse.json({ error: 'Invalid total amount' }, { status: 400 });
    }

    const { data: createdDraft, error: createDraftError } = await supabase
      .from('checkout_drafts')
      .insert({
        session_id: sessionId,
        payment_method: paymentMethod ?? 'stripe_card',
        subtotal_amount: subtotalAmount,
        shipping_amount: shippingAmount,
        total_amount: totalAmount,
        currency: 'jpy',
        shipping_email: shipping?.email ?? null,
        shipping_full_name: shipping?.fullName ?? null,
        shipping_postal_code: shipping?.postalCode ?? null,
        shipping_prefecture: shipping?.prefecture ?? null,
        shipping_city: shipping?.city ?? null,
        shipping_address: shipping?.address ?? null,
        shipping_building: shipping?.building ?? null,
        shipping_phone: shipping?.phone ?? null,
      })
      .select('id, session_id, total_amount, currency')
      .single<CheckoutDraftRow>();

    if (createDraftError || !createdDraft) {
      console.error('Failed to create checkout draft:', createDraftError);
      return NextResponse.json({ error: 'Failed to prepare checkout' }, { status: 500 });
    }

    const draftItems = (cartData as CheckoutCartSnapshotRow[]).map((cartItem) => {
      const item = itemMap.get(cartItem.item_id);

      return {
        draft_id: createdDraft.id,
        source_cart_id: cartItem.id,
        item_id: cartItem.item_id,
        item_name: item?.name ?? '商品',
        item_price: item?.price ?? 0,
        item_image_url: item?.image_url ?? null,
        color: cartItem.color,
        size: cartItem.size,
        quantity: cartItem.quantity,
        line_total: (item?.price ?? 0) * cartItem.quantity,
      };
    });

    const { error: createDraftItemsError } = await supabase
      .from('checkout_draft_items')
      .insert(draftItems);

    if (createDraftItemsError) {
      console.error('Failed to create checkout draft items:', createDraftItemsError);
      await supabase.from('checkout_drafts').delete().eq('id', createdDraft.id);
      return NextResponse.json({ error: 'Failed to prepare checkout' }, { status: 500 });
    }

    const stripe = getStripeServerClient();

    const paymentMethodTypes =
      paymentMethod === 'stripe_paypay'
        ? ['paypay']
        : paymentMethod === 'stripe_konbini'
        ? ['konbini']
        : paymentMethod === 'stripe_card'
        ? ['card']
        : undefined;

    const paymentMethodTypesForStripe =
      (paymentMethodTypes?.length ?? 0) > 0
        ? (paymentMethodTypes as unknown as Stripe.Checkout.SessionCreateParams.PaymentMethodType[])
        : undefined;

    const lineItems = (cartData as CheckoutCartSnapshotRow[]).map((cartItem) => {
      const item = itemMap.get(cartItem.item_id);
      const unitAmount = item?.price ?? 0;

      return {
        price_data: {
          currency: 'jpy',
          product_data: {
            name: item?.name ?? '商品',
          },
          unit_amount: unitAmount,
        },
        quantity: cartItem.quantity,
      };
    });

    // Add a shipping line item if applicable
    if (shippingAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'jpy',
          product_data: {
            name: '配送料',
          },
          unit_amount: shippingAmount,
        },
        quantity: 1,
      });
    }

    if (taxAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'jpy',
          product_data: {
            name: '消費税',
          },
          unit_amount: taxAmount,
        },
        quantity: 1,
      });
    }

    const origin = new URL(req.url).origin;
    const successUrl = `${origin}/checkout?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/checkout?cancelled=1`;

    const paymentMethodTypesForCustomUi =
      (paymentMethodTypes?.length ?? 0) > 0
        ? (paymentMethodTypes as unknown as Stripe.Checkout.SessionCreateParams.PaymentMethodType[])
        : undefined;

    if (uiMode === 'custom') {
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        ui_mode: 'custom',
        mode: 'payment',
        line_items: lineItems,
        metadata: {
          draft_id: createdDraft.id,
          session_id: sessionId,
          selected_payment_method: paymentMethod ?? 'auto',
        },
        payment_intent_data: {
          metadata: {
            draft_id: createdDraft.id,
            session_id: sessionId,
            selected_payment_method: paymentMethod ?? 'auto',
          },
        },
        customer_email: shipping?.email ?? undefined,
      };

      if (paymentMethodTypesForCustomUi) {
        sessionParams.payment_method_types = paymentMethodTypesForCustomUi;
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      await supabase
        .from('checkout_drafts')
        .update({ stripe_checkout_session_id: session.id })
        .eq('id', createdDraft.id);

      await logAudit({
        action: 'checkout.session.create',
        outcome: 'success',
        detail: 'Created Stripe checkout session (custom UI)',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          draft_id: createdDraft.id,
          stripe_checkout_session_id: session.id,
          ui_mode: 'custom',
        },
      });

      if (!session.client_secret) {
        return NextResponse.json({ error: 'Failed to create checkout client secret' }, { status: 500 });
      }

      return NextResponse.json({
        clientSecret: session.client_secret,
        checkoutSessionId: session.id,
      });
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        draft_id: createdDraft.id,
        session_id: sessionId,
        selected_payment_method: paymentMethod ?? 'auto',
      },
      payment_intent_data: {
        metadata: {
          draft_id: createdDraft.id,
          session_id: sessionId,
          selected_payment_method: paymentMethod ?? 'auto',
        },
      },
      customer_email: shipping?.email ?? undefined,
    };

    if (paymentMethodTypesForStripe) {
      sessionParams.payment_method_types = paymentMethodTypesForStripe;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    await supabase
      .from('checkout_drafts')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', createdDraft.id);

    await logAudit({
      action: 'checkout.session.create',
      outcome: 'success',
      detail: 'Created Stripe checkout session (hosted)',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        draft_id: createdDraft.id,
        stripe_checkout_session_id: session.id,
        ui_mode: 'hosted',
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session creation error:', error);
    await logAudit({
      action: 'checkout.session.create',
      outcome: 'error',
      detail: 'Checkout session creation error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        error_message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
