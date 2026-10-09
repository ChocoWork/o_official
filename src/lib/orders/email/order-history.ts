import { toOrderNumber } from '@/lib/orders/order-number';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason, type OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  RESENDABLE_ORDER_STATUSES,
  type OrderEmailDeliveryStatus,
  type OrderEmailErrorCode,
  type OrderEmailKind,
  type OrderEmailStatus,
} from '@/lib/orders/email/order-email-types';

/**
 * 管理画面の「この注文の履歴」（グループ D 設計書 5-1）。窓口と画面の両方が使うので、サーバーだけの物を import しない。
 * 注文の状態の変化とメールを新しい順に並べる。再送できるかは窓口が決めて返す（画面は判断しない）。
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  payment_in_progress: '支払い手続き中',
  pending: '未決済',
  paid: '決済完了',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
  shipped: '発送済み',
};

export type OrderStatusHistoryRow = {
  changedAt: string;
  fromStatus: string | null;
  toStatus: string;
  changeReason: string | null;
  actorEmail: string | null;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  cancelReason: string | null;
};

export type OrderEmailHistoryRow = {
  id: string;
  kind: OrderEmailKind;
  origin: 'auto' | 'manual';
  requestedByEmail: string | null;
  status: OrderEmailStatus;
  attempts: number;
  lastErrorCode: string | null;
  deliveryStatus: OrderEmailDeliveryStatus | null;
  deliveryEventAt: string | null;
  createdAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  hasBody: boolean;
  bodyErased: boolean;
};

export type OrderHistoryCreatedEntry = { type: 'created'; at: string };

export type OrderHistoryStatusEntry = {
  type: 'status';
  at: string;
  fromLabel: string | null;
  toLabel: string;
  actorEmail: string | null;
  detail: string | null;
};

export type OrderHistoryEmailEntry = {
  type: 'email';
  at: string;
  emailId: string;
  kind: OrderEmailKind;
  kindLabel: string;
  manual: boolean;
  requestedByEmail: string | null;
  stateLabel: string;
  warning: boolean;
  attempts: number;
  errorLabel: string | null;
  sentAt: string | null;
  deliveryEventAt: string | null;
  canViewContent: boolean;
  bodyErased: boolean;
  resendable: boolean;
};

export type OrderHistoryEntry = OrderHistoryCreatedEntry | OrderHistoryStatusEntry | OrderHistoryEmailEntry;

export type OrderHistoryResponse = {
  order: { id: string; orderNumber: string; statusLabel: string; recipient: string | null };
  sendPaused: { reasonLabel: string } | null;
  entries: OrderHistoryEntry[];
};

export type OrderEmailContentResponse =
  | { status: 'available'; subject: string; bodyText: string; sentAt: string | null }
  | { status: 'erased'; sentAt: string | null };

export type BuildOrderHistoryInput = {
  order: { id: string; status: OrderStatus; shippingEmail: string | null; createdAt: string };
  statusRows: OrderStatusHistoryRow[];
  emailRows: OrderEmailHistoryRow[];
  sendState: { paused: boolean; reason: OrderEmailErrorCode | null };
};

const OPEN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['pending', 'sending', 'retry_wait']);
const ERROR_SHOWN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['retry_wait', 'dead', 'skipped']);

function statusLabel(value: string | null): string | null {
  return value && value in ORDER_STATUS_LABELS ? ORDER_STATUS_LABELS[value as OrderStatus] : value;
}

function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

function statusDetail(row: OrderStatusHistoryRow): string | null {
  // Stripe の返金の同期（DB の apply_order_refund_projection）で変わった行は、取消の理由（cancel_reason）が入らず説明が空になるので、
  // 返金として説明する。発送済みへ戻る行は配送業者も入るので、配送業者の説明より先に見る
  if (row.changeReason === 'stripe_refund_projection') {
    if (row.toStatus === 'cancelled') return '理由: 全額返金';
    if (row.fromStatus === 'cancelled') return '返金の取り消し';
  }
  if (row.toStatus === 'shipped' && isShippingCarrierId(row.shippingCarrier)) {
    return `配送業者: ${SHIPPING_CARRIERS[row.shippingCarrier].label} / 伝票番号: ${row.trackingNumber ?? ''}`;
  }
  if (row.toStatus === 'cancelled' && isCancelReason(row.cancelReason)) {
    return `理由: ${CANCEL_REASON_LABELS[row.cancelReason]}`;
  }
  return null;
}

export function buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse {
  const { order, statusRows, emailRows, sendState } = input;
  const openManualKinds = new Set(
    emailRows.filter((row) => row.origin === 'manual' && OPEN_STATUSES.has(row.status)).map((row) => row.kind),
  );

  const emailEntries: OrderHistoryEmailEntry[] = emailRows.map((row) => {
    const state = describeOrderEmailState(row.status, row.deliveryStatus);
    return {
      type: 'email',
      at: row.createdAt,
      emailId: row.id,
      kind: row.kind,
      kindLabel: ORDER_EMAIL_KIND_LABELS[row.kind],
      manual: row.origin === 'manual',
      requestedByEmail: row.requestedByEmail,
      stateLabel: state.label,
      warning: state.warning,
      attempts: row.attempts,
      errorLabel:
        ERROR_SHOWN_STATUSES.has(row.status) && isOrderEmailErrorCode(row.lastErrorCode)
          ? ORDER_EMAIL_ERROR_LABELS[row.lastErrorCode]
          : null,
      sentAt: row.sentAt,
      deliveryEventAt: row.deliveryEventAt,
      canViewContent: row.status === 'sent',
      bodyErased: row.bodyErased,
      resendable:
        (row.status === 'sent' || row.status === 'dead')
        && RESENDABLE_ORDER_STATUSES[row.kind].includes(order.status)
        && !openManualKinds.has(row.kind),
    };
  });

  const statusEntries: OrderHistoryStatusEntry[] = statusRows.map((row) => ({
    type: 'status',
    at: row.changedAt,
    fromLabel: statusLabel(row.fromStatus),
    toLabel: statusLabel(row.toStatus) ?? row.toStatus,
    actorEmail: row.actorEmail,
    detail: statusDetail(row),
  }));

  // 同じ時刻（状態の変更と同じ取引で書いたメール）は、メールを上に置く（新しい順で、変更が原因になる）
  const entries: OrderHistoryEntry[] = [...emailEntries, ...statusEntries, { type: 'created', at: order.createdAt }];
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    order: {
      id: order.id,
      orderNumber: toOrderNumber(order.id),
      statusLabel: ORDER_STATUS_LABELS[order.status],
      recipient: order.shippingEmail,
    },
    sendPaused: sendState.paused
      ? { reasonLabel: sendState.reason ? ORDER_EMAIL_ERROR_LABELS[sendState.reason] : ORDER_EMAIL_ERROR_LABELS.config_provider }
      : null,
    entries,
  };
}
