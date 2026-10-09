import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import {
  findMissingShippingFields,
  type CheckoutShippingSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import {
  sendShopPaymentAlert,
  sendUnplacedPaymentNotice,
  type ShopPaymentAlert,
} from '@/lib/orders/order-lifecycle-emails';
import {
  PAYMENT_EXCEPTION_REASONS,
  PLACE_ORDER_REJECTIONS,
  type OrderStatus,
  type PaymentExceptionReason,
  type PlaceOrderRejection,
} from '@/lib/orders/order-payment-types';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  ReconcileTransientError,
  isTransientStripeError,
  readCheckoutPayment,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';
import {
  OrderRefundSyncNotConvergedError,
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';
import type {
  ReconcilerAudit,
  ReconcilerDatabase,
  ReconcilerDeps,
  ReconcilerMailer,
} from '@/lib/stripe/checkout-payment-reconciler';

// 照合関数の既定の依存（設計書 2-1）。注文・在庫・要対応は service_role 専用の RPC だけで書く。
// 直接 UPDATE するのは、注文詳細の表示に使う下書きの支払方法（persistDraftPaymentMethod）だけ。

/**
 * Supabase のエラーが一時的な失敗か（設計書 5-1）。接続・タイムアウト・デッドロック・直列化の失敗だけを一時的とみなす。
 * code が無い（空）のは通信の失敗。SQLSTATE の 08 系（接続）・40001（直列化）・40P01（デッドロック）・53 系（資源不足）・
 * 57014（文の取り消し・タイムアウト）・57P01〜57P03（DB の停止・起動中）と、PostgREST の PGRST000〜PGRST003
 * （DB に接続できない・プールの空き接続待ちの時間切れ）。
 */
export function isTransientSupabaseError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || code === '') {
    return true;
  }
  return (
    code.startsWith('08')
    || code.startsWith('53')
    || ['40001', '40P01', '57014', '57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)
  );
}

/** 一時的な失敗は ReconcileTransientError にして投げ（呼び出し元がイベントを再試行する）、それ以外は元のエラーのまま投げる */
function throwSupabaseError(error: unknown): never {
  if (isTransientSupabaseError(error)) {
    throw new ReconcileTransientError('db_unavailable', { cause: error });
  }
  throw error;
}

function firstRow<T>(data: unknown): T | null {
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as T | null;
}

function isPlaceOrderRejection(value: unknown): value is PlaceOrderRejection {
  return typeof value === 'string' && (PLACE_ORDER_REJECTIONS as readonly string[]).includes(value);
}

function isPaymentExceptionReason(value: unknown): value is PaymentExceptionReason {
  return typeof value === 'string' && (PAYMENT_EXCEPTION_REASONS as readonly string[]).includes(value);
}

type OrderLookupRow = {
  id: string;
  status: OrderStatus;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  total_amount: number;
  currency: string;
};

export function createSupabaseReconcilerDatabase(client: SupabaseClient): ReconcilerDatabase {
  async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throwSupabaseError(error);
    return firstRow<T>(data);
  }

  return {
    async findOrder({ checkoutSessionId, paymentIntentId }) {
      const lookups: Array<['checkout_session_id' | 'payment_intent_id', string | null]> = [
        ['checkout_session_id', checkoutSessionId],
        ['payment_intent_id', paymentIntentId],
      ];

      for (const [column, value] of lookups) {
        if (!value) continue;
        const { data, error } = await client
          .from('orders')
          .select('id, status, payment_intent_id, checkout_session_id, total_amount, currency')
          .eq(column, value)
          .maybeSingle<OrderLookupRow>();
        if (error) throwSupabaseError(error);
        if (data) {
          return {
            id: data.id,
            status: data.status,
            paymentIntentId: data.payment_intent_id,
            checkoutSessionId: data.checkout_session_id,
            totalAmount: data.total_amount,
            currency: data.currency,
          };
        }
      }

      return null;
    },

    async placeOrder(args) {
      const row = await callRpc<{
        order_id: string | null;
        order_status: OrderStatus | null;
        created: boolean;
        rejection: string | null;
      }>('place_order_from_checkout_draft', {
        _draft_id: args.draftId,
        _checkout_session_id: args.checkoutSessionId,
        _cart_session_id: args.cartSessionId,
        _stripe_amount_total: args.amountTotal,
        _stripe_amount_discount: args.amountDiscount,
        _stripe_currency: args.currency,
        _checkout_session_created_at: args.sessionCreatedAt.toISOString(),
        _payment_intent_id: args.paymentIntentId,
      });

      if (row?.order_id && row.order_status) {
        return { placed: true, orderId: row.order_id, orderStatus: row.order_status, created: row.created === true };
      }
      const rejection = row?.rejection;
      if (isPlaceOrderRejection(rejection)) {
        return { placed: false, rejection };
      }
      throw new Error('Unexpected place_order_from_checkout_draft result');
    },

    async markOrderPaid(args) {
      const row = await callRpc<{ updated: boolean; amount_matches: boolean | null; needs_review: boolean | null }>(
        'mark_order_paid',
        {
          _order_id: args.orderId,
          _expected_status: args.expectedStatus,
          _payment_intent_id: args.paymentIntentId,
          _paid_amount: args.paidAmount,
          _paid_currency: args.paidCurrency,
          _notify_customer: args.notifyCustomer,
          _paid_email_variant: args.paidEmailVariant,
          _source_event_id: args.sourceEventId,
        },
      );
      return {
        updated: row?.updated === true,
        amountMatches: row?.amount_matches === true,
        needsReview: row?.needs_review === true,
      };
    },

    async markOrderAwaitingPayment(args) {
      const row = await callRpc<{ updated: boolean }>('mark_order_awaiting_payment', {
        _order_id: args.orderId,
        _payment_intent_id: args.paymentIntentId,
        _source_event_id: args.sourceEventId,
      });
      return { updated: row?.updated === true };
    },

    async releaseStock(args) {
      const row = await callRpc<{ released: boolean }>('release_stock_for_unpaid_order', {
        _order_id: args.orderId,
        _expected_status: args.expectedStatus,
        _next_status: args.nextStatus,
        _change_reason: args.changeReason,
        _actor_id: args.actorId,
        _source_event_id: args.sourceEventId,
        _cancel_reason: args.cancelReason,
        _cancel_note: args.cancelNote,
        _notify_customer: args.notifyCustomer,
      });
      return { released: row?.released === true };
    },

    async recordException(args) {
      const row = await callRpc<{ exception_id: string; is_new: boolean; is_resolved: boolean }>(
        'record_payment_exception',
        {
          _payment_ref: args.paymentRef,
          _reason: args.reason,
          _detail: args.detail,
          _checkout_session_id: args.checkoutSessionId,
          _payment_intent_id: args.paymentIntentId,
          _draft_id: args.draftId,
          _order_id: args.orderId,
        },
      );
      if (!row?.exception_id) {
        throw new Error('Unexpected record_payment_exception result');
      }
      return { exceptionId: row.exception_id, isNew: row.is_new === true, isResolved: row.is_resolved === true };
    },

    async claimExceptionNotification(exceptionId, channel) {
      const { data, error } = await client.rpc('claim_payment_exception_notification', {
        _exception_id: exceptionId,
        _channel: channel,
      });
      if (error) throwSupabaseError(error);
      return data === true;
    },

    async releaseExceptionNotification(exceptionId, channel) {
      const { error } = await client.rpc('release_payment_exception_notification', {
        _exception_id: exceptionId,
        _channel: channel,
      });
      if (error) {
        console.error('[reconcile] failed to release exception notification claim', exceptionId, channel, error);
      }
    },

    async findDraftContact(draftId) {
      const { data, error } = await client
        .from('checkout_drafts')
        .select('shipping_snapshot')
        .eq('id', draftId)
        .maybeSingle<{ shipping_snapshot: CheckoutShippingSnapshot | null }>();
      if (error) throwSupabaseError(error);
      if (!data) return null;

      return {
        email: data.shipping_snapshot?.email ?? null,
        fullName: data.shipping_snapshot?.fullName ?? null,
        missingShippingFields: findMissingShippingFields(data.shipping_snapshot),
      };
    },

    async persistDraftPaymentMethod(draftId, paymentMethod) {
      const { error } = await client.from('checkout_drafts').update({ payment_method: paymentMethod }).eq('id', draftId);
      if (error) {
        // 注文は成立しているので止めない。注文詳細の支払方法の表示だけが古くなる
        console.error('[reconcile] failed to persist payment_method on checkout draft', draftId, error);
        await logAudit({
          action: 'checkout.payment.reconcile',
          resource: 'checkout_drafts',
          resource_id: draftId,
          outcome: 'error',
          detail: 'Failed to persist payment_method on checkout draft',
          metadata: { error_message: error.message ?? null },
        });
      }
    },
  };
}

export function createReconcilerMailer(): ReconcilerMailer {
  return {
    sendUnplacedPaymentNotice,
    sendShopAlert: sendShopPaymentAlert,
  };
}

const reconcileAudit: ReconcilerAudit = (event) =>
  logAudit({
    action: 'checkout.payment.reconcile',
    resource: 'orders',
    outcome: event.outcome,
    detail: event.detail,
    metadata: event.metadata,
  });

/** 返金の同期の失敗を、一時的なら ReconcileTransientError に、そうでなければ元のエラーのままにする */
function toReconcileError(error: unknown): unknown {
  if (isTransientStripeError(error)) {
    return new ReconcileTransientError('stripe_unavailable', { cause: error });
  }

  // 同時の更新や Stripe の返金の変化に負け続けただけで、読み直せば収まる
  if (error instanceof OrderRefundSyncNotConvergedError) {
    return new ReconcileTransientError('not_converged', { cause: error });
  }

  // syncOrderRefunds は DB の失敗を message だけの Error にして投げ、元のエラー（code 付き）を cause に残す
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined && isTransientSupabaseError(cause)) {
    return new ReconcileTransientError('db_unavailable', { cause: error });
  }

  return error;
}

/**
 * 照合が呼ぶ返金の同期（order-refund-sync.ts の syncOrderRefunds）。Stripe は読むだけ。同期したあとの注文の状態を返す。
 * 一時的な失敗（Stripe の通信・5xx・回数制限、DB の接続・直列化、競合で収まらない）は ReconcileTransientError にして
 * 投げ（呼び出し元が再試行する）、それ以外は元のエラーのまま投げる。
 */
export function createReconcilerRefundSync(
  database: OrderRefundDatabase,
  stripe: RefundListClient,
): ReconcilerDeps['syncRefunds'] {
  return async (paymentIntentId) => {
    try {
      const synced = await syncOrderRefunds({ database, stripe, paymentIntentId });
      return synced.orderStatus;
    } catch (error) {
      throw toReconcileError(error);
    }
  };
}

export async function createDefaultReconcilerDeps(): Promise<ReconcilerDeps> {
  const client = await createServiceRoleClient();
  const stripeClient = getStripeServerClient();
  const stripe = stripeClient as unknown as CheckoutPaymentStripeClient;

  return {
    readPayment: (ref) => readCheckoutPayment(stripe, ref),
    database: createSupabaseReconcilerDatabase(client),
    mailer: createReconcilerMailer(),
    audit: reconcileAudit,
    syncRefunds: createReconcilerRefundSync(
      client as unknown as OrderRefundDatabase,
      stripeClient as unknown as RefundListClient,
    ),
    now: () => new Date(),
  };
}

export type UnsentShopAlert = { exceptionId: string; alert: ShopPaymentAlert };

/** 店へ未送信の未解決の要対応（毎時の見回りが送り直す。設計書 5-3） */
export async function listUnsentShopAlerts(client: SupabaseClient, limit: number): Promise<UnsentShopAlert[]> {
  const { data, error } = await client
    .from('payment_exceptions')
    .select('id, reason, detail, order_id, payment_ref, first_detected_at')
    .is('shop_notified_at', null)
    .is('resolved_at', null)
    .order('first_detected_at', { ascending: true })
    .limit(limit);
  if (error) throwSupabaseError(error);

  return (data ?? []).flatMap((row: {
    id: string;
    reason: string;
    detail: string | null;
    order_id: string | null;
    payment_ref: string;
    first_detected_at: string;
  }) =>
    isPaymentExceptionReason(row.reason)
      ? [{
          exceptionId: row.id,
          alert: {
            reason: row.reason,
            detail: row.detail,
            orderId: row.order_id,
            paymentRef: row.payment_ref,
            detectedAt: new Date(row.first_detected_at),
          },
        }]
      : [],
  );
}
