import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  paymentMethod: z.enum([
    'stripe_card',
    'stripe_paypay',
    'stripe_konbini',
    'bank',
    'cod',
  ]),
  paymentIntentId: z.string().trim().optional(),
  shipping: z.object({
    email: z.string().trim().email().optional(),
    fullName: z.string().trim().optional(),
    postalCode: z.string().trim().optional(),
    prefecture: z.string().trim().optional(),
    city: z.string().trim().optional(),
    address: z.string().trim().optional(),
    building: z.string().trim().optional(),
    phone: z.string().trim().optional(),
  }).optional(),
});

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

type OrderRow = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
};

const stripePaymentMethods = new Set([
  'stripe_card',
  'stripe_paypay',
  'stripe_konbini',
]);

export async function POST(req: NextRequest) {
  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const parsed = completeCheckoutSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { paymentMethod, paymentIntentId, shipping } = parsed.data;

    const isStripeOnlinePayment = stripePaymentMethods.has(paymentMethod);

    if (isStripeOnlinePayment && !paymentIntentId) {
      return NextResponse.json({ error: 'paymentIntentId is required for Stripe payment' }, { status: 400 });
    }

    if (isStripeOnlinePayment && paymentIntentId) {
      const { data: existingOrder } = await supabase
        .from('orders')
        .select('id, status')
        .eq('payment_intent_id', paymentIntentId)
        .maybeSingle<OrderRow>();

      if (existingOrder) {
        return NextResponse.json({
          orderId: existingOrder.id,
          status: existingOrder.status,
          paymentMethod,
        });
      }
    }

    const { data: cartData, error: cartError } = await supabase
      .from('carts')
      .select('item_id, quantity, color, size')
      .eq('session_id', sessionId);

    if (cartError) {
      console.error('Failed to fetch cart in complete checkout:', cartError);
      return NextResponse.json({ error: 'Failed to fetch cart' }, { status: 500 });
    }

    if (!cartData || cartData.length === 0) {
      return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
    }

    const itemIds = (cartData as CartRow[]).map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, name, price, image_url')
      .in('id', itemIds);

    if (itemsError) {
      console.error('Failed to fetch items in complete checkout:', itemsError);
      return NextResponse.json({ error: 'Failed to fetch items' }, { status: 500 });
    }

    const itemMap = new Map<number, ItemRow>(
      ((itemsData ?? []) as ItemRow[]).map((item) => [item.id, item])
    );

    const subtotal = (cartData as CartRow[]).reduce((sum, cartItem) => {
      const price = itemMap.get(cartItem.item_id)?.price ?? 0;
      return sum + price * cartItem.quantity;
    }, 0);

    const shippingAmount = subtotal === 0 ? 0 : 500;
    const totalAmount = subtotal + shippingAmount;

    if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
      return NextResponse.json({ error: 'Invalid total amount' }, { status: 400 });
    }

    let orderStatus: 'pending' | 'paid' = 'pending';
    let storedPaymentIntentId = paymentIntentId ?? `offline_${paymentMethod}_${crypto.randomUUID()}`;

    if (isStripeOnlinePayment && paymentIntentId) {
      const stripe = getStripeServerClient();
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.metadata?.session_id && pi.metadata.session_id !== sessionId) {
        return NextResponse.json({ error: 'Payment intent does not belong to current session' }, { status: 403 });
      }

      if (
        pi.status !== 'succeeded' &&
        pi.status !== 'processing' &&
        pi.status !== 'requires_capture'
      ) {
        return NextResponse.json({ error: 'Payment is not completed yet' }, { status: 400 });
      }

      orderStatus =
        pi.status === 'succeeded' || pi.status === 'requires_capture' ? 'paid' : 'pending';
      storedPaymentIntentId = pi.id;
    }

    const { data: createdOrder, error: createOrderError } = await supabase
      .from('orders')
      .insert({
        session_id: sessionId,
        payment_intent_id: storedPaymentIntentId,
        status: orderStatus,
        subtotal_amount: subtotal,
        shipping_amount: shippingAmount,
        total_amount: totalAmount,
        currency: 'jpy',
        shipping_email: shipping?.email,
        shipping_full_name: shipping?.fullName,
        shipping_postal_code: shipping?.postalCode,
        shipping_prefecture: shipping?.prefecture,
        shipping_city: shipping?.city,
        shipping_address: shipping?.address,
        shipping_building: shipping?.building,
        shipping_phone: shipping?.phone,
      })
      .select('id, status')
      .single<OrderRow>();

    if (createOrderError || !createdOrder) {
      console.error('Failed to create order in complete checkout:', createOrderError);
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    const orderItems = (cartData as CartRow[]).map((cartItem) => {
      const item = itemMap.get(cartItem.item_id);
      const itemPrice = item?.price ?? 0;

      return {
        order_id: createdOrder.id,
        item_id: cartItem.item_id,
        item_name: item?.name ?? '（商品名不明）',
        item_price: itemPrice,
        item_image_url: item?.image_url ?? null,
        color: cartItem.color,
        size: cartItem.size,
        quantity: cartItem.quantity,
        line_total: itemPrice * cartItem.quantity,
      };
    });

    const { error: orderItemsError } = await supabase.from('order_items').insert(orderItems);
    if (orderItemsError) {
      console.error('Failed to create order items in complete checkout:', orderItemsError);
      return NextResponse.json({ error: 'Failed to create order items' }, { status: 500 });
    }

    const { error: clearCartError } = await supabase
      .from('carts')
      .delete()
      .eq('session_id', sessionId);

    if (clearCartError) {
      console.error('Failed to clear cart in complete checkout:', clearCartError);
    }

    return NextResponse.json({
      orderId: createdOrder.id,
      status: createdOrder.status,
      paymentMethod,
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
