import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';

// Service-role Supabase client for server-side writes
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type CartRow = {
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
};

type ItemRow = {
  id: number;
  name: string;
  price: number;
  image_url: string | null;
};

// ---------------------------------------------------------------------------
// Helper: create order records from a succeeded PaymentIntent
// ---------------------------------------------------------------------------
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const sessionId = paymentIntent.metadata?.session_id;
  if (!sessionId) {
    console.error('[webhook] payment_intent.succeeded missing session_id metadata', paymentIntent.id);
    return;
  }

  // Idempotency: abort if an order already exists for this PaymentIntent
  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', paymentIntent.id)
    .maybeSingle();

  if (existingOrder) {
    console.info('[webhook] order already exists for payment_intent', paymentIntent.id, 'skipping');
    return;
  }

  // Fetch cart items snapshot
  const { data: cartData, error: cartError } = await supabase
    .from('carts')
    .select('item_id, quantity, color, size')
    .eq('session_id', sessionId);

  if (cartError || !cartData || cartData.length === 0) {
    console.error('[webhook] cart empty or fetch failed for session', sessionId, cartError);
    // Cart may have been cleared already; create order with amount from PaymentIntent only
    // Still create the order header so it appears in order history
  }

  const cartRows: CartRow[] = (cartData ?? []) as CartRow[];

  // Fetch item snapshots
  let itemMap = new Map<number, ItemRow>();
  if (cartRows.length > 0) {
    const itemIds = cartRows.map((c) => c.item_id);
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, name, price, image_url')
      .in('id', itemIds);

    if (itemsError) {
      console.error('[webhook] failed to fetch item prices', itemsError);
    }

    itemMap = new Map<number, ItemRow>(
      ((itemsData ?? []) as ItemRow[]).map((item) => [item.id, item])
    );
  }

  // Re-calculate amounts from cart (match what payment-intent route computed)
  const subtotal = cartRows.reduce((sum, cartItem) => {
    const price = itemMap.get(cartItem.item_id)?.price ?? 0;
    return sum + price * cartItem.quantity;
  }, 0);
  const shippingAmount = subtotal === 0 ? 0 : 500;
  const totalAmount = paymentIntent.amount; // authoritative: use Stripe's confirmed amount

  // Create order header
  const { data: newOrder, error: orderError } = await supabase
    .from('orders')
    .insert({
      session_id: sessionId,
      payment_intent_id: paymentIntent.id,
      status: 'paid',
      subtotal_amount: subtotal,
      shipping_amount: shippingAmount,
      total_amount: totalAmount,
      currency: paymentIntent.currency,
    })
    .select('id')
    .single();

  if (orderError || !newOrder) {
    console.error('[webhook] failed to create order', orderError);
    throw new Error('Failed to create order');
  }

  const orderId = newOrder.id as string;

  // Insert order items (snapshot)
  if (cartRows.length > 0) {
    const orderItems = cartRows.map((cartItem) => {
      const itemData = itemMap.get(cartItem.item_id);
      const itemPrice = itemData?.price ?? 0;
      return {
        order_id: orderId,
        item_id: cartItem.item_id,
        item_name: itemData?.name ?? '（商品名不明）',
        item_price: itemPrice,
        item_image_url: itemData?.image_url ?? null,
        color: cartItem.color,
        size: cartItem.size,
        quantity: cartItem.quantity,
        line_total: itemPrice * cartItem.quantity,
      };
    });

    const { error: itemsInsertError } = await supabase.from('order_items').insert(orderItems);
    if (itemsInsertError) {
      console.error('[webhook] failed to insert order_items', itemsInsertError);
      // Non-fatal: order header was created; do not throw to avoid double-processing
    }
  }

  // Clear the cart for this session
  const { error: cartDeleteError } = await supabase
    .from('carts')
    .delete()
    .eq('session_id', sessionId);

  if (cartDeleteError) {
    console.error('[webhook] failed to clear cart after order', sessionId, cartDeleteError);
    // Non-fatal
  }

  console.info('[webhook] order created successfully', orderId, 'for session', sessionId);
}

// ---------------------------------------------------------------------------
// Helper: mark payment intent as failed
// ---------------------------------------------------------------------------
async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'failed' })
    .eq('payment_intent_id', paymentIntent.id)
    .eq('status', 'pending'); // only downgrade pending orders

  if (error) {
    console.error('[webhook] failed to update order status to failed', error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/webhook/stripe
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  // Raw body required for signature verification
  const rawBody = Buffer.from(await req.arrayBuffer());

  const stripe = getStripeServerClient();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[webhook] Signature verification failed:', message);
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  // Idempotency guard: persist event (upsert — do nothing if already processed)
  const { error: persistError } = await supabase
    .from('stripe_webhook_events')
    .upsert(
      {
        id: event.id,
        event_type: event.type,
        raw_payload: event as unknown as Record<string, unknown>,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    );

  if (persistError) {
    console.error('[webhook] Failed to persist event', event.id, persistError);
    // Do not block processing on persistence failure
  }

  // Route event to handler
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      default:
        // Unhandled event types are fine — return 200 to acknowledge receipt
        break;
    }
  } catch (err) {
    console.error('[webhook] Error processing event', event.id, event.type, err);
    // Return 500 so Stripe will retry
    return NextResponse.json({ error: 'Internal server error during event processing' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
