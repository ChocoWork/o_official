import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';

/** 探す範囲。決済の画面は30分で失効するので、1日あれば開いているものは必ず入る */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** 「確認へ進む」1回で閉じる数の上限（Stripe への問い合わせを抑える） */
const CLOSE_LIMIT = 10;

type DraftToClose = {
  id: string;
  status: 'created' | 'completed';
  checkout_session_id: string;
  checkout_request_version: number | null;
  checkout_request_fingerprint: string | null;
};

/**
 * このカート（Cookie のセッション）で、受け付け済みのまま支払いが済んだ決済の画面を探す（設計書 2-5、R-56）。
 *
 * 支払いの後に完了の処理が届かなかった（画面の通信が切れた）お客様が入り直したとき、新しい決済の画面を
 * 作らせず、注文の確定を仕上げて状態を見せるために使う。DB・Stripe の失敗は投げる。
 */
export async function findPaidCheckoutSession(
  deps: { supabase: SupabaseClient; stripe: Stripe },
  cartSessionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const { data, error } = await deps.supabase
    .from('orders')
    .select('checkout_session_id')
    .eq('session_id', cartSessionId)
    .eq('status', 'payment_in_progress')
    .not('checkout_session_id', 'is', null)
    .gte('created_at', new Date(now.getTime() - LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) {
    throw error;
  }

  for (const row of (data ?? []) as Array<{ checkout_session_id: string }>) {
    const session = await deps.stripe.checkout.sessions.retrieve(row.checkout_session_id);
    if (session.status === 'complete') {
      return session.id;
    }
  }
  return null;
}

/**
 * 照合関数を既定の依存で呼ぶ。メールなどの部品を入口の読み込みに巻き込まないよう、呼んだときに読み込む。
 */
export async function reconcileCheckoutSession(checkoutSessionId: string): Promise<void> {
  const [{ reconcileCheckoutPayment }, { createDefaultReconcilerDeps }] = await Promise.all([
    import('@/lib/stripe/checkout-payment-reconciler'),
    import('@/lib/stripe/checkout-payment-reconciler-deps'),
  ]);
  await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), { checkoutSessionId });
}

/**
 * 同じ Cookie のセッションで開いている、ほかの決済の画面を閉じる（設計書 2-2・8、計画の決め事 D5）。
 *
 * - 受け付け済みの下書きの画面を閉じたら、照合関数で注文を放棄の扱いにして在庫をすぐ戻す
 * - 作成中の下書きの画面を閉じたら、下書きを退役させる（次に同じ画面を問い合わせ直さない）
 * - 閉じられなかった画面（支払いが済んだ・もう失効していた）は触らない。注文と在庫は照合関数が合わせる
 *
 * 失敗しても「確認へ進む」は止めない。Stripe の知らせ（checkout.session.expired）と毎時の見回りが仕上げる。
 */
export async function closeOtherCheckoutSessions(
  deps: {
    supabase: SupabaseClient;
    stripe: Stripe;
    reconcile(checkoutSessionId: string): Promise<unknown>;
    logFailure(detail: string, metadata: Record<string, unknown>): Promise<void>;
  },
  params: { cartSessionId: string; keepCheckoutSessionId: string },
  now: Date = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  const { data, error } = await deps.supabase
    .from('checkout_drafts')
    .select('id, status, checkout_session_id, checkout_request_version, checkout_request_fingerprint')
    .eq('session_id', params.cartSessionId)
    .in('status', ['created', 'completed'])
    .not('checkout_session_id', 'is', null)
    .neq('checkout_session_id', params.keepCheckoutSessionId)
    .gte('created_at', new Date(now.getTime() - LOOKBACK_MS).toISOString())
    .or(`checkout_session_expires_at.is.null,checkout_session_expires_at.gt.${nowIso}`)
    .order('created_at', { ascending: false })
    .limit(CLOSE_LIMIT);

  if (error) {
    const code = (error as { code?: unknown }).code;
    await deps.logFailure('Failed to list other checkout sessions', {
      error_code: typeof code === 'string' ? code : null,
    });
    return;
  }

  for (const draft of (data ?? []) as DraftToClose[]) {
    try {
      const result = await expireOpenCheckoutSession(deps.stripe, draft.checkout_session_id);
      if (result !== 'expired') {
        continue;
      }
      if (draft.status === 'completed') {
        await deps.reconcile(draft.checkout_session_id);
        continue;
      }
      await deps.supabase.rpc('retire_expired_checkout_draft', {
        _draft_id: draft.id,
        _session_id: params.cartSessionId,
        _checkout_session_id: draft.checkout_session_id,
        _request_version: draft.checkout_request_version,
        _request_fingerprint: draft.checkout_request_fingerprint,
      });
    } catch {
      await deps.logFailure('Failed to close other checkout session', {
        draft_id: draft.id,
        checkout_session_id: draft.checkout_session_id,
      });
    }
  }
}
