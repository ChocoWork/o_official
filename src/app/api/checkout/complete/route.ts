import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  paymentMethod: z
    .enum(['stripe_card', 'stripe_paypay', 'stripe_konbini', 'bank', 'cod'])
    .optional(),
  paymentIntentId: z.string().trim().optional(),
  checkoutSessionId: z.string().trim().optional(),
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

    const { paymentMethod, paymentIntentId, checkoutSessionId, shipping } = parsed.data;

    const stripe = getStripeServerClient();

    type CheckoutPaymentMethod =
      | 'stripe_card'
      | 'stripe_paypay'
      | 'stripe_konbini'
      | 'bank'
      | 'cod';

    const isCheckoutPaymentMethod = (value: unknown): value is CheckoutPaymentMethod =>
      typeof value === 'string' &&
      ['stripe_card', 'stripe_paypay', 'stripe_konbini', 'bank', 'cod'].includes(value);

    const mapStripeType = (t: string | undefined): CheckoutPaymentMethod => {
      if (t === 'card') return 'stripe_card';
      if (t === 'konbini') return 'stripe_konbini';
      if (t === 'paypay') return 'stripe_paypay';
      return 'stripe_card';
    };

    let resolvedPaymentMethod = paymentMethod;
    let resolvedPaymentIntentId = paymentIntentId;

    if (checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
        expand: ['payment_intent'],
      });

      const sessionSelectedPaymentMethod = session.metadata?.selected_payment_method;
      if (isCheckoutPaymentMethod(sessionSelectedPaymentMethod)) {
        resolvedPaymentMethod = resolvedPaymentMethod ?? sessionSelectedPaymentMethod;
      }

      resolvedPaymentIntentId =
        resolvedPaymentIntentId ||
        (typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id);
    }

    const isStripePaymentMethod =
      resolvedPaymentMethod === 'stripe_card' ||
      resolvedPaymentMethod === 'stripe_paypay' ||
      resolvedPaymentMethod === 'stripe_konbini' ||
      Boolean(checkoutSessionId);

    const isStripeOnlinePayment = Boolean(resolvedPaymentIntentId);

    if (isStripePaymentMethod && !resolvedPaymentIntentId) {
      return NextResponse.json(
        { error: 'Stripe payment is not confirmed yet' },
        { status: 400 }
      );
    }

    if (isStripeOnlinePayment && resolvedPaymentIntentId) {
      const { data: existingOrder } = await supabase
        .from('orders')
        .select('id, status')
        .eq('payment_intent_id', resolvedPaymentIntentId)
        .maybeSingle<OrderRow>();

      if (existingOrder) {
        return NextResponse.json({
          orderId: existingOrder.id,
          status: existingOrder.status,
          paymentMethod: resolvedPaymentMethod,
        });
      }
    }

    if (isStripeOnlinePayment && resolvedPaymentIntentId && !resolvedPaymentMethod) {
      const pi = await stripe.paymentIntents.retrieve(resolvedPaymentIntentId);
      const type = pi.payment_method_types?.[0];

      const mapStripeType = (t: string | undefined): CheckoutPaymentMethod => {
        if (t === 'card') return 'stripe_card';
        if (t === 'konbini') return 'stripe_konbini';
        if (t === 'paypay') return 'stripe_paypay';
        return 'stripe_card';
      };

      resolvedPaymentMethod = mapStripeType(type);
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
    let storedPaymentIntentId =
      resolvedPaymentIntentId ?? `offline_${resolvedPaymentMethod ?? 'unknown'}_${crypto.randomUUID()}`;

    if (isStripePaymentMethod && !resolvedPaymentIntentId) {
      return NextResponse.json(
        { error: 'Stripe payment intent is missing' },
        { status: 400 }
      );
    }

    if (isStripeOnlinePayment && resolvedPaymentIntentId) {
      const stripe = getStripeServerClient();
      const pi = await stripe.paymentIntents.retrieve(resolvedPaymentIntentId);

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

      if (!resolvedPaymentMethod) {
        const type = pi.payment_method_types?.[0];
        resolvedPaymentMethod = mapStripeType(type);
      }
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

   // Filter cart items to only include items that exist in the database
   const validCartItems = (cartData as CartRow[]).filter(
     (cartItem) => itemMap.has(cartItem.item_id)
   );

   if (validCartItems.length === 0) {
     return NextResponse.json(
       { error: 'カート内に有効な商品がありません。商品が削除されている可能性があります。' },
       { status: 400 }
     );
   }

   const orderItems = validCartItems.map((cartItem) => {
      const item = itemMap.get(cartItem.item_id);
     if (!item) {
       throw new Error(`Item ${cartItem.item_id} not found in itemMap`);
     }
     const itemPrice = item.price;

      return {
        order_id: createdOrder.id,
        item_id: cartItem.item_id,
       item_name: item.name,
        item_price: itemPrice,
       item_image_url: item.image_url ?? null,
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
      paymentMethod: resolvedPaymentMethod,
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
