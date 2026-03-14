import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import crypto from 'crypto';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const paymentIntentRequestSchema = z.object({
  currency: z.string().trim().toLowerCase().default('jpy'),
  paymentMethod: z
    .enum(['stripe_card', 'stripe_paypay', 'stripe_konbini'])
    .default('stripe_card'),
});

type CartRow = {
  item_id: number;
  quantity: number;
};

type ItemRow = {
  id: number;
  price: number;
};

export async function POST(req: NextRequest) {
  try {
    const sessionId = req.cookies.get('session_id')?.value;

    if (!sessionId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const parsedBody = paymentIntentRequestSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { data: cartData, error: cartError } = await supabase
      .from('carts')
      .select('item_id, quantity')
      .eq('session_id', sessionId);

    if (cartError) {
      console.error('Error fetching cart for payment intent:', cartError);
      return NextResponse.json({ error: 'Failed to fetch cart' }, { status: 500 });
    }

    if (!cartData || cartData.length === 0) {
      return NextResponse.json({ error: 'Cart is empty' }, { status: 400 });
    }

    const itemIds = (cartData as CartRow[]).map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, price')
      .in('id', itemIds);

    if (itemsError) {
      console.error('Error fetching item prices for payment intent:', itemsError);
      return NextResponse.json({ error: 'Failed to fetch item prices' }, { status: 500 });
    }

    const itemPriceMap = new Map<number, number>(
      ((itemsData || []) as ItemRow[]).map((item) => [item.id, item.price])
    );

    const subtotal = (cartData as CartRow[]).reduce((sum, cartItem) => {
      const price = itemPriceMap.get(cartItem.item_id) ?? 0;
      return sum + price * cartItem.quantity;
    }, 0);

    const shipping = subtotal === 0 ? 0 : 500;
    const amount = subtotal + shipping;

    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Invalid cart amount' }, { status: 400 });
    }

    const stripe = getStripeServerClient();

    const createIdempotencyKey = (parts: Record<string, unknown>) => {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(parts))
        .digest('hex')
        .slice(0, 16);
      return `checkout:${hash}`;
    };

    const idempotencyKey = createIdempotencyKey({
      sessionId,
      amount,
      currency: parsedBody.data.currency,
      paymentMethod: parsedBody.data.paymentMethod,
    });

    const basePayload = {
      amount,
      currency: parsedBody.data.currency,
      metadata: {
        session_id: sessionId,
        selected_payment_method: parsedBody.data.paymentMethod,
      },
    };

    const paymentIntent =
      parsedBody.data.paymentMethod === 'stripe_paypay'
        ? await stripe.paymentIntents.create(
            {
              ...basePayload,
              payment_method_types: ['paypay'],
              payment_method_options: {
                paypay: {
                  // Stripe may require explicit payload for PayPay; keep defaults but still allow customization.
                },
              },
            },
            { idempotencyKey }
          )
        : parsedBody.data.paymentMethod === 'stripe_konbini'
          ? await stripe.paymentIntents.create(
              {
                ...basePayload,
                payment_method_types: ['konbini'],
                payment_method_options: {
                  konbini: {
                    // 期限: 3日 (Stripe default), 明示的に設定して安定化する
                    expires_after_days: 3,
                  },
                },
              },
              { idempotencyKey }
            )
          : parsedBody.data.paymentMethod === 'stripe_card'
            ? await stripe.paymentIntents.create(
                {
                  ...basePayload,
                  payment_method_types: ['card'],
                },
                { idempotencyKey }
              )
            : await stripe.paymentIntents.create(
                {
                  ...basePayload,
                  payment_method_types: ['card'],
                },
                { idempotencyKey }
              );

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      amount,
      currency: parsedBody.data.currency,
    });
  } catch (error) {
    console.error('Payment intent creation error:', error);

    if (error instanceof Stripe.errors.StripeError) {
      const isUnsupportedPaymentMethod =
        error.code === 'payment_method_type_invalid' ||
        error.code === 'parameter_invalid_enum' ||
        error.code === 'parameter_unknown';

      if (isUnsupportedPaymentMethod) {
        return NextResponse.json(
          {
            error:
              '選択した決済方法は、このStripeアカウントまたは現在の環境では利用できません。Stripeダッシュボードで有効化されているかご確認ください。',
          },
          { status: 400 }
        );
      }

      if (error.code === 'idempotency_key_in_use') {
        return NextResponse.json(
          { error: '決済情報の初期化が競合しました。時間をおいて再度お試しください。' },
          { status: 409 }
        );
      }

      return NextResponse.json(
        {
          error:
            error.message || 'Stripe側で決済情報の初期化に失敗しました。時間をおいて再度お試しください。',
        },
        { status: error.statusCode ?? 400 }
      );
    }

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
