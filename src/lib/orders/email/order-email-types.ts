import type { OrderStatus, PaidEmailVariant } from '@/lib/orders/order-payment-types';

/**
 * 注文のメールの種類・状態・原因の記号（グループ D 設計書 3・4・5・6 章）。
 * DB の CHECK 制約（移行 20261009095633_order_email_outbox.sql）と同じ値を1か所に置く。画面からも読む。
 * 取りやめの理由は、返品のメールの扱いを足して作り直した移行 20261013001143_order_return_receipts.sql の関数と同じ（値は E-1 の移行 20261010122320_fulfillment_order_emails.sql から変わらない）。
 * 種類・書き分けは、返品のメール4種類と返金のお知らせの返品の書き分けを足した移行 20261012235910_order_return_records.sql と同じ（グループ E-3 設計書 9 章）。
 * 再送できる状態の表は、返品のメールを再送の対象にしない形に作り直した移行 20261013001143_order_return_receipts.sql の関数と同じ。
 */
export const ORDER_EMAIL_KINDS = [
  'paid',
  'awaiting_payment',
  'payment_expired',
  'canceled',
  'shipped',
  'refund',
  'return_accepted',
  'return_received',
  'return_sent_back',
  'return_refund_pending_shop',
] as const;
export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];

/** 取消のメールの書き出しは、取り消す前の状態で変わる。paid は支払い済みの注文のキャンセル（返金を知らせる。グループ E-2 設計書 8-2） */
export type CanceledEmailVariant = 'payment_in_progress' | 'pending' | 'paid';
/**
 * 返金のお知らせの書き分け。after_cancel は、未入金のうちに取り消した注文へ後から入金があって、自動で全額を返した時（自動の返金①。グループ E-2 設計書 8-1）。
 * return は返品の返金（受け取りと一緒の返金・額を決めて後で返した返金。グループ E-3 設計書 9 章）
 */
export type RefundEmailVariant = 'standard' | 'after_cancel' | 'return';
export type OrderEmailVariant = PaidEmailVariant | CanceledEmailVariant | RefundEmailVariant;

export const ORDER_EMAIL_STATUSES = ['pending', 'sending', 'retry_wait', 'sent', 'skipped', 'dead'] as const;
export type OrderEmailStatus = (typeof ORDER_EMAIL_STATUSES)[number];

export const ORDER_EMAIL_DELIVERY_STATUSES = [
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'suppressed',
  'failed',
] as const;
export type OrderEmailDeliveryStatus = (typeof ORDER_EMAIL_DELIVERY_STATUSES)[number];

/** 店へ知らせ、履歴に注意の印を付ける配達の状態（設計書 6-3） */
export const DELIVERY_PROBLEM_STATUSES: readonly OrderEmailDeliveryStatus[] = ['bounced', 'complained', 'suppressed', 'failed'];

export const ORDER_EMAIL_ERROR_CODES = [
  'provider_unavailable',
  'rate_limited',
  'network_error',
  'db_unavailable',
  'lease_expired',
  'unexpected_error',
  'config_api_key',
  'config_sender_domain',
  'config_provider',
  'quota_daily',
  'quota_monthly',
  'invalid_message',
  'idempotency_conflict',
  'source_missing',
  'superseded',
  'no_recipient',
  'fulfillment_cancelled',
  // 返品の取消で DB が直に書く記号（まだ送っていない受付のお知らせを取りやめにする。グループ E-3 設計書 7-3）。worker が渡す取りやめの理由ではない
  'return_cancelled',
  'legacy_suppressed',
] as const;
export type OrderEmailErrorCode = (typeof ORDER_EMAIL_ERROR_CODES)[number];

export type OrderEmailFailureCategory = 'transient' | 'config' | 'permanent';
export type OrderEmailPauseReason = Extract<
  OrderEmailErrorCode,
  'config_api_key' | 'config_sender_domain' | 'config_provider' | 'quota_daily' | 'quota_monthly'
>;
export type OrderEmailSkipReason = Extract<OrderEmailErrorCode, 'superseded' | 'no_recipient' | 'fulfillment_cancelled'>;

export const ORDER_EMAIL_KIND_LABELS: Record<OrderEmailKind, string> = {
  paid: '注文確認',
  awaiting_payment: '入金待ち',
  payment_expired: '支払い期限切れ',
  canceled: '取消',
  shipped: '発送',
  refund: '返金のお知らせ',
  return_accepted: '返品の受付のお知らせ',
  return_received: '返品の受け取りのお知らせ',
  return_sent_back: '品物のお返しのお知らせ',
  return_refund_pending_shop: '店への知らせ（返金待ち）',
};

/** 管理画面の履歴と店への知らせに出す原因（設計書 5-1） */
export const ORDER_EMAIL_ERROR_LABELS: Record<OrderEmailErrorCode, string> = {
  provider_unavailable: '送信サービスの一時的な失敗',
  rate_limited: '送信の回数の制限',
  network_error: '通信の失敗',
  db_unavailable: 'データベースの一時的な失敗',
  lease_expired: '処理の中断',
  unexpected_error: '想定外の失敗',
  config_api_key: '送信の鍵の設定',
  config_sender_domain: '送信元のドメインの設定',
  config_provider: '送信サービスの設定',
  quota_daily: '1日の送信の上限',
  quota_monthly: '1か月の送信の上限',
  invalid_message: '宛先の形が不正',
  idempotency_conflict: '同じ送信の印で中身が違う',
  source_missing: '注文の情報が足りない',
  superseded: '注文の状態が変わったため',
  no_recipient: '宛先が無い',
  fulfillment_cancelled: '発送の取消',
  return_cancelled: '返品の取消',
  legacy_suppressed: '移行前の注文のため',
};

export const ORDER_EMAIL_DELIVERY_LABELS: Record<OrderEmailDeliveryStatus, string> = {
  delivered: '配達済み',
  delayed: '配達の遅れ',
  bounced: '届かなかった',
  complained: '迷惑メールにされた',
  suppressed: '送信先が止められている',
  failed: '送信サービスで送れなかった',
};

/**
 * 再送できる種類と、そのときの注文の状態（設計書 5-3。DB の request_order_email_resend と同じ表）。
 * 発送のメールは、一部だけ送った間の注文（決済完了）でも再送できる（グループ E-1 設計書 8-2）。
 * その発送が取り消されていないことは、DB の関数と履歴の組み立てが見る。
 * 返金のお知らせは再送しない（返金ごとに1通。グループ E-2 設計書 8-1）。DB の関数も断るので、状態は1つも無い。
 * 返品のメール4種類（受付・受け取り・お返し・店への知らせ）も再送しない（返品ごと・受け取りごとに1通で、お返しのメッセージは
 * 送った時の事実。グループ E-3 計画 P7）。DB の関数も断るので、状態は1つも無い。
 */
export const RESENDABLE_ORDER_STATUSES: Record<OrderEmailKind, readonly OrderStatus[]> = {
  paid: ['paid', 'shipped'],
  awaiting_payment: ['pending'],
  payment_expired: ['failed'],
  canceled: ['cancelled'],
  shipped: ['paid', 'shipped'],
  refund: [],
  return_accepted: [],
  return_received: [],
  return_sent_back: [],
  return_refund_pending_shop: [],
};

export function isOrderEmailKind(value: unknown): value is OrderEmailKind {
  return typeof value === 'string' && (ORDER_EMAIL_KINDS as readonly string[]).includes(value);
}

export function isOrderEmailErrorCode(value: unknown): value is OrderEmailErrorCode {
  return typeof value === 'string' && (ORDER_EMAIL_ERROR_CODES as readonly string[]).includes(value);
}

/** 履歴に出す状態の名前と注意の印（設計書 5-1）。送信済みは、配達の状態が分かればそれを出す */
export function describeOrderEmailState(
  status: OrderEmailStatus,
  delivery: OrderEmailDeliveryStatus | null,
): { label: string; warning: boolean } {
  switch (status) {
    case 'pending':
    case 'sending':
      return { label: '送信待ち', warning: false };
    case 'retry_wait':
      return { label: 'やり直し待ち', warning: false };
    case 'skipped':
      return { label: '取りやめ', warning: false };
    case 'dead':
      return { label: '送れなかった', warning: true };
    case 'sent':
      return delivery
        ? { label: ORDER_EMAIL_DELIVERY_LABELS[delivery], warning: DELIVERY_PROBLEM_STATUSES.includes(delivery) }
        : { label: '送信済み', warning: false };
  }
}
