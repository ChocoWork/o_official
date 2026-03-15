import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const createSessionSchema = z.object({
  paymentMethod: z.enum(['stripe_card', 'stripe_paypay', 'stripe_konbini']),
  shipping: z
    .object({
      email: z.string().trim().email().optional(),
      fullName: z.string().trim().optional(),
      postalCode: z.string().trim().optional(),
      prefecture: z.string().trim().optional(),
      city: z.string().trim().optional(),
      address: z.string().trim().optional(),
      building: z.string().trim().optional(),
      phone: z.string().trim().optional(),
    })
    .optional(),
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

export async function POST(req: NextRequest) {
  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const parsed = createSessionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { paymentMethod, shipping } = parsed.data;

    const { data: cartData, error: cartError } = await supabase
      .from('carts')
      .select('item_id, quantity, color, size')
      .eq('session_id', sessionId);

    if (cartError) {
      console.error('Failed to fetch cart for checkout session:', cartError);
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
      console.error('Failed to fetch items for checkout session:', itemsError);
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

    const stripe = getStripeServerClient();

    const paymentMethodTypes =
      paymentMethod === 'stripe_paypay'
        ? ['paypay']
        : paymentMethod === 'stripe_konbini'
        ? ['konbini']
        : ['card'];

    // Stripe の公式型では paypay/konbini が含まれていないため、
    // 明示的にキャストして型エラーを回避します。
    const paymentMethodTypesForStripe = paymentMethodTypes as unknown as
      Stripe.Checkout.SessionCreateParams.PaymentMethodType[];

    const lineItems = (cartData as CartRow[]).map((cartItem) => {
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

    const origin = new URL(req.url).origin;
    const successUrl = `${origin}/checkout?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/checkout?cancelled=1`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: paymentMethodTypesForStripe,
      mode: 'payment',
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        session_id: sessionId,
        selected_payment_method: paymentMethod,
      },
      customer_email: shipping?.email ?? undefined,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session creation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
