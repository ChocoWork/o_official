import sendMail from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  claimOrderEmail,
  fetchOrderEmailSource,
  formatCurrency,
  formatItemLines,
  releaseOrderEmail,
  type OrderEmailSource,
  type OrderEmailSourceStore,
} from '@/lib/orders/order-confirmation-email';
import {
  PAYMENT_EXCEPTION_REASON_LABELS,
  type PaymentExceptionReason,
} from '@/lib/orders/order-payment-types';

/**
 * 注文の状態が変わったときのお客様へのメールと、店への要対応メール（グループ A 設計書 5-3・5-4）。
 *
 * 件名は固定の文面で組み、外から来た値（氏名・商品名）は本文にだけ入れる（メールヘッダーの注入を防ぐ）。
 * お客様へのメールは送信権（1注文・1種類につき1通）を取ってから送り、送れなければ権利を戻す。
 */
const SHOP_NAME = 'Le Fil des Heures';

function greeting(fullName: string | null): string {
  return fullName ? `${fullName} 様` : 'お客様';
}

function contactLine(orderId: string): string {
  return `お問い合わせの際は、注文番号（${toOrderNumber(orderId)}）をお問い合わせフォームにご入力ください。`;
}

function orderSummaryLines({ order, items }: OrderEmailSource): string[] {
  return [
    `注文番号: ${toOrderNumber(order.id)}`,
    '',
    'ご注文内容:',
    ...formatItemLines(items, order.currency),
    '',
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
  ];
}

async function sendClaimedOrderEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  kind: 'payment_expired' | 'canceled';
  logLabel: string;
  compose: (source: OrderEmailSource) => { subject: string; text: string };
}): Promise<boolean> {
  const { store, orderId, kind, logLabel, compose } = params;
  if (!process.env.MAIL_FROM_ADDRESS) {
    return false;
  }

  const source = await fetchOrderEmailSource(store, orderId, logLabel);
  const to = source?.order.shipping_email;
  if (!source || !to) {
    return false;
  }

  if (!(await claimOrderEmail(store, orderId, kind))) {
    return false;
  }

  const { subject, text } = compose(source);
  try {
    await sendMail({ to, subject, text });
    return true;
  } catch (error) {
    console.warn(`${logLabel} order lifecycle mail send failed`, orderId, kind, error);
    await logAudit({
      action: 'order.lifecycle.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
      metadata: { kind },
    });
    await releaseOrderEmail(store, orderId, kind);
    return false;
  }
}

/** 払込票の期限切れで失敗にしたとき。支払い方法を問わない文面にする（銀行振込を足しても同じ仕組みに載る） */
export function sendPaymentExpiredEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  logLabel: string;
}): Promise<boolean> {
  return sendClaimedOrderEmail({
    ...params,
    kind: 'payment_expired',
    compose: (source) => ({
      subject: `【${SHOP_NAME}】お支払い期限切れのお知らせ（${toOrderNumber(source.order.id)}）`,
      text: [
        greeting(source.order.shipping_full_name),
        '',
        'お支払い期限が過ぎたため、ご注文を取り消しました。',
        'お支払いは発生していません。引き続きご購入を希望される場合は、あらためてご注文ください。',
        '',
        ...orderSummaryLines(source),
        '',
        contactLine(source.order.id),
        '',
        SHOP_NAME,
      ].join('\n'),
    }),
  });
}

/** 管理画面で未入金の注文を取り消したとき。支払い手続き中の注文では、これが最初のメールになる */
export function sendOrderCanceledEmail(params: {
  store: OrderEmailSourceStore;
  orderId: string;
  previousStatus: 'payment_in_progress' | 'pending';
  logLabel: string;
}): Promise<boolean> {
  const lead =
    params.previousStatus === 'payment_in_progress'
      ? 'お手続き中のご注文を取り消しました。'
      : 'お支払い待ちのご注文を取り消しました。';

  return sendClaimedOrderEmail({
    store: params.store,
    orderId: params.orderId,
    logLabel: params.logLabel,
    kind: 'canceled',
    compose: (source) => ({
      subject: `【${SHOP_NAME}】ご注文取消のお知らせ（${toOrderNumber(source.order.id)}）`,
      text: [
        greeting(source.order.shipping_full_name),
        '',
        lead,
        'お支払いは発生していません。',
        '',
        ...orderSummaryLines(source),
        '',
        contactLine(source.order.id),
        '',
        SHOP_NAME,
      ].join('\n'),
    }),
  });
}

/**
 * 受付を通らない支払いの案内（要対応 order_not_creatable）。注文が無いので注文番号は書かない。
 * 送信権は呼び出し側が payment_exceptions.customer_notified_at で取る。
 */
export async function sendUnplacedPaymentNotice(params: {
  to: string;
  fullName: string | null;
  state: 'paid' | 'awaiting_payment';
}): Promise<boolean> {
  if (!process.env.MAIL_FROM_ADDRESS) {
    return false;
  }

  const lead =
    params.state === 'paid'
      ? ['お支払いは受け付けました。', 'ご注文の登録で確認が必要になりました。担当者からご連絡します。', '再度のお支払いは不要です。']
      : ['ご注文の登録で確認が必要になりました。', 'お支払いはお控えください。担当者からご連絡します。'];

  try {
    await sendMail({
      to: params.to,
      subject: `【${SHOP_NAME}】ご注文の確認についてのお知らせ`,
      text: [greeting(params.fullName), '', ...lead, '', SHOP_NAME].join('\n'),
    });
    return true;
  } catch (error) {
    console.warn('Unplaced payment notice send failed', error);
    await logAudit({
      action: 'order.lifecycle.mail',
      outcome: 'error',
      resource: 'payment_exception',
      detail: 'unplaced_notice_send_failed',
    });
    return false;
  }
}

export type ShopPaymentAlert = {
  reason: PaymentExceptionReason;
  detail: string | null;
  orderId: string | null;
  /** Session ID（無ければ PaymentIntent ID） */
  paymentRef: string;
  detectedAt: Date;
};

const SHOP_ALERT_NEXT_STEPS: Record<PaymentExceptionReason, string> = {
  order_not_creatable:
    'Stripe ダッシュボードで支払いを確かめ、返金するか、お客様に連絡して注文を登録してください。お客様には確認中の案内を送っています。',
  paid_amount_mismatch:
    'Stripe ダッシュボードで支払額を確かめ、差額の返金などを行ってください。解決済みにするまで発送できません。',
  cancelled_order_paid: 'Stripe ダッシュボードで返金してください。',
  state_conflict:
    'Stripe ダッシュボードで支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
  unexpected_state:
    'Stripe ダッシュボードで支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
  stripe_object_missing:
    'Stripe ダッシュボードに支払いがあるか確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
};

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * 店への要対応メール。お客様の氏名・住所・メールは入れない（個人情報の最小化）。
 * 送り先は SHOP_ALERT_EMAIL。未設定なら送らず、毎時の見回りが送り直す。
 * ALERT_AUDIT_URL は監査ログを全件転送するので使わない（重要な通知が埋もれる）。
 */
export async function sendShopPaymentAlert(alert: ShopPaymentAlert): Promise<boolean> {
  const to = process.env.SHOP_ALERT_EMAIL;
  if (!to || !process.env.MAIL_FROM_ADDRESS) {
    console.warn('[shop-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    return false;
  }

  const label = PAYMENT_EXCEPTION_REASON_LABELS[alert.reason];
  try {
    await sendMail({
      to,
      subject: `【要対応】${label}`,
      text: [
        '支払いの要対応を検知しました。管理画面の ORDER タブで確認してください。',
        '',
        `理由: ${label}${alert.detail ? `（${alert.detail}）` : ''}`,
        `注文番号: ${alert.orderId ? toOrderNumber(alert.orderId) : 'なし'}`,
        `Stripe の支払い: ${alert.paymentRef}`,
        `検知時刻: ${formatJst(alert.detectedAt)}`,
        '',
        `次にやること: ${SHOP_ALERT_NEXT_STEPS[alert.reason]}`,
      ].join('\n'),
    });
    return true;
  } catch (error) {
    console.warn('[shop-alert] send failed', error);
    await logAudit({
      action: 'payment_exception.shop_alert',
      outcome: 'error',
      resource: 'payment_exception',
      detail: 'mail_send_failed',
      metadata: { reason: alert.reason },
    });
    return false;
  }
}
