import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import { logAudit } from '@/lib/audit';
import {
  OrderNotFoundForPaymentIntentError,
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';
import {
  syncPaymentIntentAccounting,
  syncPayoutAccounting,
  syncRefundAccounting,
} from '@/lib/stripe/accounting-sync';
import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';
import { reconcileCheckoutPayment, type ReconcileInput } from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { raiseRefundFailureWithoutOrder, type FailedRefundStatus } from '@/lib/stripe/refund-failure-exception';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

async function logWebhookAudit(
  request: NextRequest,
  action: string,
  outcome: 'success' | 'failure' | 'error' | 'conflict',
  detail: string,
  metadata?: Record<string, unknown>
) {
  await logAudit({
    action,
    resource: 'stripe_webhook',
    outcome,
    detail,
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent'),
    metadata,
  });
}

/**
 * 決済系のイベントは、Session か PaymentIntent の ID だけを取り出して照合関数へ渡す（設計書 2-2）。
 * イベントの中身（状態・金額）は判定に使わず、Stripe の現在値だけで決める（R-01・R-02）。
 * 要対応・要確認は照合関数が記録と通知まで済ませるので、イベントは完了にする。
 * 一時的な失敗（ReconcileTransientError）は投げ直し、worker がイベントを失敗にして再試行する。
 */
async function reconcilePaymentEvent(input: ReconcileInput): Promise<void> {
  await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), input);
}

function resolvePaymentIntentId(
  value: string | Stripe.PaymentIntent | null | undefined,
): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

/**
 * 返金が失敗・取消で終わったか。refund.failed は失敗そのものの通知。refund.created・refund.updated は、
 * 返金の状態が failed・canceled のときだけ（保留・成功・要操作は、まだ終わっていないか、うまくいっている）。
 * Charge（charge.refunded）には返金の状態が無い。
 */
function failedRefundStatusOf(event: Stripe.Event, object: Stripe.Refund | Stripe.Charge): FailedRefundStatus | null {
  if (event.type === 'charge.refunded') {
    return null;
  }

  const status = (object as Stripe.Refund).status;
  if (status === 'canceled') {
    return 'canceled';
  }
  return status === 'failed' || event.type === 'refund.failed' ? 'failed' : null;
}

/**
 * 返金の変化を注文へ反映する。注文に結び付いていない支払いの返金（注文を作れず要対応になった支払いを、
 * 店が Stripe で返金したとき）は、注文が現れないので再試行しても直らない。失敗にして永久に再試行させず、
 * ID だけを監査に残して完了にする（後段の会計の同期は呼び出し側が続ける）。
 *
 * ただし、その返金が失敗・取消で終わったときは、支払いだけが残り、照合も二度とこの支払いを見ないので、
 * 飛ばさずに要対応として記録し、店へ知らせる（既存の要対応の仕組み。同じ返金のイベントが何度届いても1件・1通）。
 * 記録できなかったときは握りつぶさず投げる（worker がイベントを失敗にして再試行する）。
 */
async function handleRefundChanged(
  event: Stripe.Event,
  object: Stripe.Refund | Stripe.Charge,
  stripe: Stripe,
  auditRequest: NextRequest,
): Promise<void> {
  const paymentIntentId = resolvePaymentIntentId(object.payment_intent);
  if (!paymentIntentId) {
    throw new Error('Stripe refund event is missing payment_intent');
  }

  try {
    await syncOrderRefunds({
      database: supabase as unknown as OrderRefundDatabase,
      stripe: stripe as unknown as RefundListClient,
      paymentIntentId,
    });
  } catch (error) {
    if (!(error instanceof OrderNotFoundForPaymentIntentError)) {
      throw error;
    }

    const isCharge = event.type === 'charge.refunded';
    const identifiers = {
      event_id: event.id,
      event_type: event.type,
      payment_intent_id: paymentIntentId,
      refund_id: isCharge ? null : object.id,
      charge_id: isCharge ? object.id : null,
    };

    const failedStatus = failedRefundStatusOf(event, object);
    if (!failedStatus) {
      await logWebhookAudit(
        auditRequest,
        'checkout.webhook.refund_without_order',
        'success',
        'Refund event skipped: no order for the PaymentIntent',
        identifiers,
      );
      return;
    }

    const exception = await raiseRefundFailureWithoutOrder(await createDefaultReconcilerDeps(), {
      paymentIntentId,
      refundId: object.id,
      refundStatus: failedStatus,
    });
    await logWebhookAudit(
      auditRequest,
      'checkout.webhook.refund_without_order',
      'error',
      'Refund failed or canceled without an order: payment exception recorded',
      { ...identifiers, refund_status: failedStatus, exception_id: exception.exceptionId },
    );
  }
}

type AccountingStripeClient = Parameters<typeof syncPayoutAccounting>[0]['stripe'];

/**
 * 注文更新とは独立に、Stripe原始記録（Balance Transaction / Refund / Payout）を同期する。
 */
async function syncAccountingForEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  const database = createStripeAccountingDatabase(supabase);
  const client = stripe as unknown as AccountingStripeClient;
  const object = event.data.object as { id?: string };
  if (!object?.id) {
    return;
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      await syncPaymentIntentAccounting({ stripe: client, database, paymentIntentId: object.id });
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await syncRefundAccounting({ stripe: client, database, refundId: object.id });
      break;
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.reconciliation_completed':
      await syncPayoutAccounting({ stripe: client, database, payoutId: object.id });
      break;
    default:
      break;
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  auditRequest: NextRequest,
): Promise<void> {
  const stripe = getStripeServerClient();

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await reconcilePaymentEvent({
        checkoutSessionId: (event.data.object as Stripe.Checkout.Session).id,
        sourceEventId: event.id,
      });
      break;
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
      await reconcilePaymentEvent({
        paymentIntentId: (event.data.object as Stripe.PaymentIntent).id,
        sourceEventId: event.id,
      });
      break;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await handleRefundChanged(event, event.data.object as Stripe.Refund, stripe, auditRequest);
      break;
    case 'charge.refunded':
      await handleRefundChanged(event, event.data.object as Stripe.Charge, stripe, auditRequest);
      break;
    default:
      break;
  }

  await syncAccountingForEvent(event, stripe);
  await logWebhookAudit(
    auditRequest,
    'checkout.webhook.event_processing',
    'success',
    'Webhook event processed',
    { event_id: event.id, event_type: event.type },
  );
}
