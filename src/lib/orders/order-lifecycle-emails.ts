import sendMail from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import { greeting } from '@/lib/orders/email/order-email-compose';
import {
  PAYMENT_EXCEPTION_REASON_LABELS,
  type PaymentExceptionReason,
} from '@/lib/orders/order-payment-types';

/**
 * 注文にならなかった支払いのお客様への案内と、店への要対応メール（グループ A 設計書 5-3・5-4）。
 * お客様への注文のメール（入金待ち・入金済み・期限切れ・取消・発送）は src/lib/orders/email/ が送る（グループ D）。
 * 件名は固定の文面で組み、外から来た値（氏名・商品名）は本文にだけ入れる（メールヘッダーの注入を防ぐ）。
 */
const SHOP_NAME = 'Le Fil des Heures';

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

/** 自動の返金（グループ E-2 設計書 6-4）の結果。照合が付ける。付くのは、設定がオンで自動の返金を試した時だけ */
export type ShopAlertAutomation = 'auto_refunded' | 'auto_refund_failed' | 'auto_cancelled' | 'auto_cancel_failed';

/** 返金の失敗の知らせに足す行の材料（設計書 8-4）。返金の結果を書いた後の始末が組み立てる */
export type ShopAlertRefundFailure = {
  /** 失敗の理由の言葉（例: 口座の入力の期限が過ぎました） */
  failureReasonLabel: string;
  /** 在庫を確保し直せなかった商品。無ければ空 */
  shortages: Array<{ name: string; quantity: number }>;
  /** 返金のもとになったキャンセルのお知らせを、お客様に送っていたか */
  cancelEmailSent: boolean;
};

export type ShopPaymentAlert = {
  reason: PaymentExceptionReason;
  detail: string | null;
  orderId: string | null;
  /** Session ID（無ければ PaymentIntent ID） */
  paymentRef: string;
  detectedAt: Date;
  automation?: ShopAlertAutomation;
  refundFailure?: ShopAlertRefundFailure;
};

/**
 * 店への知らせの「次にやること」（グループ E-2 設計書 8-4）。理由と、自動の返金の結果（automation）で決まる。
 * autoEnabled は、その理由の自動の返金の設定がオンか（①は cancelled_order_paid、②は paid_amount_mismatch。ほかの理由では使わない）。
 * ①は、設定がオンなのに結果が付いていない知らせを「返金できなかった」の文にする。要対応が開いたままなのは、自動の返金で
 * 閉じられなかったということで、店がすること（管理画面の注文から返金する）は同じ。
 * ②は、設定がオフの時と取り消せなかった時で店がすることが同じなので、文も同じ。
 */
export function shopAlertNextStep(
  alert: Pick<ShopPaymentAlert, 'reason' | 'automation'>,
  autoEnabled: boolean,
): string {
  switch (alert.reason) {
    case 'refund_failed':
      return 'お客様に連絡し、別の方法で返金するか、管理画面からもう一度返金してください。';
    case 'cancelled_order_paid':
      if (alert.automation === 'auto_refunded') {
        return '自動で全額を返金しました。対応は要りません。';
      }
      return autoEnabled
        ? '自動の返金ができませんでした。管理画面の注文から返金してください。'
        : '管理画面の注文から返金してください。';
    case 'paid_amount_mismatch':
      return alert.automation === 'auto_cancelled'
        ? '自動で全額を返金し、注文を取り消しました。'
        : '管理画面で差額を返金するか、注文をキャンセルしてください。解決済みにするまで発送できません。';
    case 'order_not_creatable':
      return '支払いを確かめ、管理画面から返金するか、お客様に連絡して注文を登録してください。お客様には確認中の案内を送っています。';
    case 'state_conflict':
    case 'unexpected_state':
      return '管理画面と Stripe の記録で支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。';
    case 'stripe_object_missing':
      return '管理画面と Stripe の記録で支払いがあるか確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。';
  }
}

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** Stripe の番号の形（接頭辞 + 英数字）。返金は re_ のほか、支払い方法によって pyr_ などもある */
const STRIPE_ID_PATTERN = /^[a-z]{2,4}_[A-Za-z0-9]+$/;

/**
 * 知らせの「参照」の名前。返金の失敗の参照は Stripe の返金の番号。Stripe に返金が無い時（返事待ちのまま Stripe に見つからなかった返金）は
 * 返金の記録の番号なので、Stripe の物とは書かない。ほかの理由の参照は Session の番号か支払いの番号
 */
function paymentRefLabel(alert: Pick<ShopPaymentAlert, 'reason' | 'paymentRef'>): string {
  if (alert.reason !== 'refund_failed') {
    return 'Stripe の支払い';
  }
  return STRIPE_ID_PATTERN.test(alert.paymentRef) ? 'Stripe の返金' : '返金の記録';
}

/** 返金の失敗の知らせに足す行（後ろに空行を1つ置く）。材料が無ければ（知らせの送り直し）足さない */
function refundFailureLines(failure: ShopAlertRefundFailure | undefined): string[] {
  if (!failure) {
    return [];
  }

  const shortages = failure.shortages.map((shortage) => `${shortage.name} × ${shortage.quantity}`).join('、');
  return [
    `失敗の理由: ${failure.failureReasonLabel}`,
    ...(shortages ? [`確保し直せなかった商品: ${shortages}`] : []),
    ...(failure.cancelEmailSent ? ['キャンセルのお知らせを送った注文です。お客様への連絡が要ります。'] : []),
    '',
  ];
}

/**
 * 店への要対応メール。お客様の氏名・住所・メールは入れない（個人情報の最小化）。
 * 送り先は SHOP_ALERT_EMAIL。未設定なら送らず、毎時の見回りが送り直す。
 * ALERT_AUDIT_URL は監査ログを全件転送するので使わない（重要な通知が埋もれる）。
 * 自動の返金の結果（automation）が付くのは設定がオンで試した時だけなので、「設定がオンか」にそのまま使う。
 * 送り直す知らせには、結果も返金の失敗の材料も付かない。
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
        `${paymentRefLabel(alert)}: ${alert.paymentRef}`,
        `検知時刻: ${formatJst(alert.detectedAt)}`,
        '',
        ...refundFailureLines(alert.refundFailure),
        `次にやること: ${shopAlertNextStep(alert, alert.automation !== undefined)}`,
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
