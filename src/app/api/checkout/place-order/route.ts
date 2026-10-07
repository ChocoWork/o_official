import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import { stripeKeyLivemode } from '@/lib/stripe/handled-webhook-events';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';
import type { OrderStatus, PlaceOrderRejection } from '@/lib/orders/order-payment-types';
import {
  getDraftIdFromStripeMetadata,
  type CheckoutDraftItemSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';
import {
  CHECKOUT_SESSION_ID_PATTERN,
  PLACE_ORDER_GUARD,
  guardCheckoutPost,
} from '@/features/checkout/services/checkout-route-guard';
import { findPaidCheckoutSession, reconcileCheckoutSession } from '@/features/checkout/services/checkout-session-lifecycle.service';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/** 受け付けに要る決済の画面の残り時間（設計書 6-1）。受け付けた後に時間切れで支払えなくならないように */
const ACCEPT_MIN_REMAINING_SECONDS = 10 * 60;

const requestSchema = z
  .object({
    checkoutSessionId: z.string().regex(CHECKOUT_SESSION_ID_PATTERN),
    // 最終確認画面で「在庫あり」と見せた明細のバリアント。偽って送られても、在庫の確保はサーバーが決める
    inStockVariantIds: z.array(z.number().int().positive()).max(100),
  })
  .strict();

type RejectionCode = 'stock_changed' | 'item_unavailable' | 'price_changed' | 'cart_changed' | 'zero_amount' | 'session_expired' | 'superseded';

/** 断ったときの案内（設計書 5-3・6-3）。どれもお金は動いていない */
const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  stock_changed: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
  item_unavailable: 'ご注文いただけない商品が含まれています',
  price_changed: '商品の価格が変わりました。内容をご確認ください',
  cart_changed: 'カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。',
  zero_amount: 'このご注文は合計が0円になるため、お受けできません',
  session_expired: '時間がたったため、お支払い情報をもう一度入力してください',
  superseded: '別の画面で手続きが進んでいます。画面を読み込み直してください',
};

/** 受付 RPC の理由コードを、画面の案内の理由に読み替える（決め事 D12） */
const REJECTION_BY_RPC: Record<PlaceOrderRejection, RejectionCode> = {
  draft_not_found: 'superseded',
  item_unavailable: 'item_unavailable',
  amount_mismatch: 'price_changed',
  currency_mismatch: 'price_changed',
  zero_amount: 'zero_amount',
  price_changed: 'price_changed',
  stock_changed: 'stock_changed',
  cart_changed: 'cart_changed',
};

const FAILED_MESSAGE = 'ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。';

type DraftRow = {
  id: string;
  session_id: string;
  checkout_session_id: string | null;
  created_at: string;
  items_snapshot: CheckoutDraftItemSnapshot[] | null;
};

type PlaceOrderRow = {
  order_id: string | null;
  order_status: OrderStatus | null;
  created: boolean;
  rejection: PlaceOrderRejection | null;
};

async function loadDraft(draftId: string): Promise<DraftRow | null> {
  const { data, error } = await supabase
    .from('checkout_drafts')
    .select('id, session_id, checkout_session_id, created_at, items_snapshot')
    .eq('id', draftId)
    .maybeSingle<DraftRow>();
  if (error) {
    throw error;
  }
  return data;
}

/** 後から別のタブで「確認へ進む」を押していれば、そちらを優先する（設計書 8） */
async function hasNewerDraft(cartSessionId: string, draft: DraftRow, checkoutSessionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('checkout_drafts')
    .select('id')
    .eq('session_id', cartSessionId)
    .gt('created_at', draft.created_at)
    .not('checkout_session_id', 'is', null)
    .neq('checkout_session_id', checkoutSessionId)
    .limit(1);
  if (error) {
    throw error;
  }
  return (data ?? []).length > 0;
}

/** 「在庫あり」と見せたのに、今は受注生産になる明細（カート画面で示す。設計書 5-3） */
async function changedLinesOf(draft: DraftRow, inStockVariantIds: number[]) {
  const items = draft.items_snapshot ?? [];
  const preview = await previewFulfillment(
    supabase,
    items.map((item) => ({ item_id: item.item_id, color: item.color, size: item.size, quantity: item.quantity })),
  );
  const shown = new Set(inStockVariantIds);
  return preview
    .filter((line) => line.variantId !== null && shown.has(line.variantId) && line.fulfillment === 'backorder')
    .map((line) => ({
      itemId: line.itemId,
      name: items[line.lineNo - 1]?.item_name ?? '',
      color: line.color,
      size: line.size,
    }));
}

/** 断った画面の確保をすぐ戻す。失敗しても Stripe の知らせと見回りが仕上げるので、拒否の応答は変えない。 */
async function expireRejectedCheckoutSession(stripe: ReturnType<typeof getStripeServerClient>, checkoutSessionId: string) {
  try {
    if ((await expireOpenCheckoutSession(stripe, checkoutSessionId)) !== 'expired') {
      return;
    }
  } catch (expireError) {
    console.error('Failed to expire the rejected checkout session:', expireError);
    return;
  }
  try {
    await reconcileCheckoutSession(checkoutSessionId);
  } catch (reconcileError) {
    console.error('Failed to reconcile the rejected checkout session:', reconcileError);
  }
}

// PUBLIC: ゲスト購入を許可する公開 Route。守りは guardCheckoutPost（Cookie・回数の制限・CSRF）。
// 「注文する」の受け付け（グループ F 設計書第6章）。決済の画面を Stripe から読み直し、その金額と下書きで
// 受付 RPC を呼ぶ。お客様から受け取るのは決済の画面の ID と「在庫あり」と見せた明細だけ。
export async function POST(req: NextRequest) {
  const guard = await guardCheckoutPost(req, PLACE_ORDER_GUARD);
  if (!guard.ok) {
    return guard.response;
  }

  const audit = async (
    outcome: 'success' | 'failure' | 'error',
    detail: string,
    metadata: Record<string, unknown> = {},
  ) => {
    try {
      await logAudit({
        action: 'checkout.place_order',
        outcome,
        detail,
        ip: guard.clientIp,
        user_agent: guard.userAgent,
        metadata: { session_id: guard.sessionId, ...metadata },
      });
    } catch (logError) {
      console.error('Failed to log place order audit:', logError);
    }
  };

  const reject = async (code: RejectionCode, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await audit('failure', 'Place order rejected', { reason: code, ...metadata });
    return guard.finish(NextResponse.json({ error: code, message: REJECTION_MESSAGES[code], ...extra }, { status: 409 }));
  };

  try {
    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return guard.finish(NextResponse.json({ error: 'invalid_request' }, { status: 400 }));
    }
    const { checkoutSessionId, inStockVariantIds } = parsed.data;
    const ref = { checkout_session_id: checkoutSessionId };

    const stripe = getStripeServerClient();
    const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);

    if (session.metadata?.session_id !== guard.sessionId) {
      await audit('failure', 'Checkout session does not belong to current session', { ...ref, reason: 'not_owner' });
      return guard.finish(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    }

    if (session.livemode !== stripeKeyLivemode(process.env.STRIPE_SECRET_KEY)) {
      await audit('error', 'Checkout session mode does not match the secret key', { ...ref, reason: 'mode_mismatch' });
      return guard.finish(NextResponse.json({ error: 'place_order_failed', message: FAILED_MESSAGE }, { status: 500 }));
    }

    if (session.status === 'complete') {
      return guard.finish(NextResponse.json({ error: 'payment_done', checkoutSessionId }, { status: 409 }));
    }

    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    const draft = draftId ? await loadDraft(draftId) : null;
    if (!draft || draft.session_id !== guard.sessionId || draft.checkout_session_id !== checkoutSessionId) {
      return reject('superseded', { ...ref, draft_id: draftId });
    }
    if (await hasNewerDraft(guard.sessionId, draft, checkoutSessionId)) {
      return reject('superseded', { ...ref, draft_id: draft.id, superseded_by: 'newer_draft' });
    }

    if (session.status !== 'open' || session.payment_status !== 'unpaid') {
      return reject('session_expired', { ...ref, draft_id: draft.id });
    }

    const remainingSeconds = (session.expires_at ?? 0) - Math.floor(Date.now() / 1000);
    if (remainingSeconds < ACCEPT_MIN_REMAINING_SECONDS) {
      // 閉じた画面に受け付け済みの注文があれば、照合関数が放棄の扱いにして在庫を戻す。
      // 失敗しても Stripe の知らせと見回りが仕上げるので、案内は止めない。
      if ((await expireOpenCheckoutSession(stripe, checkoutSessionId)) === 'expired') {
        try {
          await reconcileCheckoutSession(checkoutSessionId);
        } catch (reconcileError) {
          console.error('Failed to reconcile the expiring checkout session:', reconcileError);
        }
      }
      return reject('session_expired', { ...ref, draft_id: draft.id, remaining_seconds: remainingSeconds });
    }

    // 別のタブの支払いが先に済んでいれば、同じカートでもう一度課金せず、その注文を仕上げる。
    const paidCheckoutSessionId = await findPaidCheckoutSession({ supabase, stripe }, guard.sessionId);
    if (paidCheckoutSessionId && paidCheckoutSessionId !== checkoutSessionId) {
      await expireRejectedCheckoutSession(stripe, checkoutSessionId);
      return guard.finish(NextResponse.json({ error: 'payment_done', checkoutSessionId: paidCheckoutSessionId }, { status: 409 }));
    }

    const { data, error } = await supabase.rpc('place_order_from_checkout_draft', {
      _draft_id: draft.id,
      _checkout_session_id: checkoutSessionId,
      _cart_session_id: guard.sessionId,
      _stripe_amount_total: session.amount_total ?? 0,
      _stripe_amount_discount: session.total_details?.amount_discount ?? 0,
      _stripe_currency: session.currency ?? '',
      _checkout_session_created_at: new Date(session.created * 1000).toISOString(),
      _payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      _shown_in_stock_variant_ids: inStockVariantIds,
    });
    if (error) {
      throw error;
    }

    const row = (data as PlaceOrderRow[] | null)?.[0];
    if (!row) {
      throw new Error('place_order_from_checkout_draft returned no row');
    }

    if (row.rejection) {
      const code = REJECTION_BY_RPC[row.rejection];
      const metadata = { ...ref, draft_id: draft.id, rpc_rejection: row.rejection };
      if (code === 'stock_changed') {
        return reject(code, metadata, { changedLines: await changedLinesOf(draft, inStockVariantIds) });
      }
      if (code === 'cart_changed') {
        await expireRejectedCheckoutSession(stripe, checkoutSessionId);
      }
      return reject(code, metadata);
    }

    if (!row.order_id || !row.order_status) {
      throw new Error('place_order_from_checkout_draft returned no order');
    }

    await audit('success', 'Order placed for payment', {
      ...ref,
      draft_id: draft.id,
      order_id: row.order_id,
      created: row.created,
    });
    return guard.finish(NextResponse.json({ orderId: row.order_id, orderStatus: row.order_status }));
  } catch (error) {
    console.error('Place order error:', error);
    await audit('error', 'Place order handler error', {
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });
    return guard.finish(NextResponse.json({ error: 'place_order_failed', message: FAILED_MESSAGE }, { status: 500 }));
  }
}
