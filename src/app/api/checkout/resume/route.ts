import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { logAudit } from '@/lib/audit';
import {
  getDraftIdFromStripeMetadata,
  type CheckoutDraftItemSnapshot,
  type CheckoutShippingSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import { buildCheckoutConfirmation } from '@/features/checkout/services/checkout-confirmation.service';
import { findPaidCheckoutSession } from '@/features/checkout/services/checkout-session-lifecycle.service';
import { resolveCheckoutBuyer, checkoutBuyerFailureResponse, buyerUserIdOf } from '@/features/checkout/services/checkout-buyer';
import {
  CHECKOUT_SESSION_ID_PATTERN,
  RESUME_GUARD,
  guardCheckoutPost,
} from '@/features/checkout/services/checkout-route-guard';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const requestSchema = z.object({ checkoutSessionId: z.string().regex(CHECKOUT_SESSION_ID_PATTERN).optional() }).strict();

type DraftRow = {
  id: string;
  session_id: string;
  checkout_session_id: string | null;
  buyer_user_id: string | null;
  status: string;
  items_snapshot: CheckoutDraftItemSnapshot[] | null;
  shipping_snapshot: CheckoutShippingSnapshot | null;
};

function isResourceMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'resource_missing';
}

/** 下書きが無ければ買い手を比べられないので、支払い済みの画面を返さない側に倒す */
async function buyerOfCheckoutSession(checkoutSessionId: string): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from('checkout_drafts')
    .select('buyer_user_id')
    .eq('checkout_session_id', checkoutSessionId)
    .maybeSingle<{ buyer_user_id: string | null }>();
  if (error) {
    throw error;
  }
  return data ? data.buyer_user_id : undefined;
}

// PUBLIC: ゲスト購入を許可する公開 Route。守りは guardCheckoutPost（Cookie・回数の制限・CSRF）。
// 決済の画面を開き直したときに、どこから続けるかを返す（グループ F 設計書 2-5、計画の決め事 D9）。
// - 決済の画面の ID があれば（最終確認画面の URL・Stripe からの戻り）、その画面の状態で決める
// - 無ければ、受け付け済みで支払いの済んだ画面がこのカートにあるかだけを見る
export async function POST(req: NextRequest) {
  const guard = await guardCheckoutPost(req, RESUME_GUARD);
  if (!guard.ok) {
    return guard.response;
  }

  // 前の確認画面を別の買い手に返さないため、何かに触れる前にログインを確かめる（グループ C 設計書 4-4）
  const buyerResolution = await resolveCheckoutBuyer(req);
  if (buyerResolution.kind === 'expired' || buyerResolution.kind === 'unavailable') {
    return guard.finish(checkoutBuyerFailureResponse(buyerResolution.kind));
  }
  const buyerUserId = buyerUserIdOf(buyerResolution);

  const none = () => guard.finish(NextResponse.json({ state: 'none' }));
  const paymentDone = (checkoutSessionId: string) =>
    guard.finish(NextResponse.json({ state: 'payment_done', checkoutSessionId }));

  try {
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return guard.finish(NextResponse.json({ error: 'invalid_request' }, { status: 400 }));
    }

    const stripe = getStripeServerClient();
    const { checkoutSessionId } = parsed.data;

    if (!checkoutSessionId) {
      const paid = await findPaidCheckoutSession({ supabase, stripe }, guard.sessionId);
      if (!paid) {
        return none();
      }
      const paidBuyer = await buyerOfCheckoutSession(paid);
      return paidBuyer !== undefined && paidBuyer === buyerUserId ? paymentDone(paid) : none();
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    } catch (error) {
      if (isResourceMissing(error)) {
        return none();
      }
      throw error;
    }

    if (session.metadata?.session_id !== guard.sessionId) {
      try {
        await logAudit({
          action: 'checkout.resume',
          outcome: 'failure',
          detail: 'Checkout session does not belong to current session',
          ip: guard.clientIp,
          user_agent: guard.userAgent,
          metadata: { session_id: guard.sessionId, checkout_session_id: checkoutSessionId, reason: 'not_owner' },
        });
      } catch (logError) {
        console.error('Failed to log resume audit:', logError);
      }
      return guard.finish(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    }

    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    const { data: draft, error: draftError } = draftId ? await supabase
      .from('checkout_drafts')
      .select('id, session_id, checkout_session_id, buyer_user_id, status, items_snapshot, shipping_snapshot')
      .eq('id', draftId)
      .maybeSingle<DraftRow>() : { data: null, error: null };
    if (draftError) {
      throw draftError;
    }
    // 支払い済みの ID も別の買い手には返さないので、complete の判断より前に比べる（設計書 4-4）
    if (draft && (draft.buyer_user_id ?? null) !== buyerUserId) {
      return none();
    }
    if (session.status === 'complete') {
      return paymentDone(session.id);
    }
    if (session.status !== 'open' || !session.client_secret) {
      return none();
    }
    if (
      !draft ||
      draft.session_id !== guard.sessionId ||
      draft.checkout_session_id !== session.id ||
      (draft.status !== 'created' && draft.status !== 'completed')
    ) {
      return none();
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id')
      .eq('checkout_session_id', session.id)
      .maybeSingle<{ id: string }>();
    if (orderError) {
      throw orderError;
    }

    const confirmation = await buildCheckoutConfirmation(
      { supabase, signImageUrl: (raw) => signItemImageUrl(supabase, raw) },
      {
        checkoutSessionId: session.id,
        clientSecret: session.client_secret,
        itemsSnapshot: draft.items_snapshot ?? [],
        shippingSnapshot: draft.shipping_snapshot,
        promotionCode: session.metadata?.promotion_code ?? null,
        acceptedOrderId: order?.id ?? null,
      },
    );
    return guard.finish(NextResponse.json({ state: 'resume', confirmation }));
  } catch (error) {
    console.error('Checkout resume error:', error);
    return guard.finish(NextResponse.json({ error: 'resume_failed' }, { status: 500 }));
  }
}
