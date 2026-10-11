import { toOrderNumber } from '@/lib/orders/order-number';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason, type OrderStatus } from '@/lib/orders/order-payment-types';
import {
  refundFailureReasonLabel,
  REFUND_SOURCE_LABELS,
  REFUND_STATUS_LABELS,
  STRIPE_REFUND_REASON_LABELS,
} from '@/lib/orders/refund/refund-messages';
import type { OrderRefundSource, OrderRefundStatus } from '@/lib/orders/refund/refund-types';
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
// 型だけを読む（実行時には何も読み込まない）。窓口が DB の関数から読んだ行を、そのまま渡してもらう
import type { OrderCompletionHistoryRow, OrderFulfillmentHistoryRow } from '@/lib/orders/fulfillment/fulfillment-store';
import type { OrderRefundRow } from '@/lib/orders/refund/refund-store';

/**
 * 管理画面の「この注文の履歴」（グループ D 設計書 5-1、グループ E-1・E-2 設計書 9-2）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。注文の状態の変化・メール・発送・仕上がり・返金とその取消を新しい順に並べる。
 * 再送できるか・取り消せるかは窓口が決めて返す（画面は判断しない）。
 */
export const ORDER_STATUS_LABELS = {
  payment_in_progress: '支払い手続き中',
  pending: '未決済',
  paid: '決済完了',
  failed: '決済失敗',
  abandoned: '放棄',
  cancelled: 'キャンセル',
  shipped: '発送済み',
} as const satisfies Record<OrderStatus, string>;

export type OrderStatusLabel = (typeof ORDER_STATUS_LABELS)[OrderStatus];

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
  /** 発送のメールだけが、どの発送のメールか・何回目の発送かを持つ */
  fulfillmentId: string | null;
  fulfillmentNumber: number | null;
  /** 返金のお知らせと、支払い済みのキャンセルのお知らせだけが、どの返金のお知らせかを持つ（グループ E-2 設計書 8-6） */
  refundId: string | null;
};

/** 注文の商品ごとの名前（商品名（色 / サイズ））と、発送した数・仕上がった数。取り消せるかの判断に使う */
export type OrderHistoryLine = { orderItemId: string; name: string; shipped: number; completed: number };

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
  fulfillmentId: string | null;
  fulfillmentNumber: number | null;
};

export type OrderHistoryFulfillmentEntry = {
  type: 'fulfillment';
  at: string;
  fulfillmentId: string;
  number: number;
  carrierLabel: string | null;
  trackingNumber: string | null;
  items: Array<{ name: string; quantity: number }>;
  actorEmail: string | null;
  notifyCustomer: boolean;
  completesOrder: boolean;
  cancelled: boolean;
  cancellable: boolean;
  legacy: boolean;
};

export type OrderHistoryFulfillmentCancelEntry = {
  type: 'fulfillment_cancel';
  at: string;
  fulfillmentId: string;
  number: number;
  actorEmail: string | null;
};

export type OrderHistoryCompletionEntry = {
  type: 'completion';
  at: string;
  completionId: string;
  items: Array<{ name: string; quantity: number }>;
  actorEmail: string | null;
  cancelled: boolean;
  cancellable: boolean;
  legacy: boolean;
};

export type OrderHistoryCompletionCancelEntry = {
  type: 'completion_cancel';
  at: string;
  completionId: string;
  actorEmail: string | null;
};

/** 返金1件の行（グループ E-2 設計書 9-2）。状態の移り変わり（返事待ち → 保留 → 成功・失敗など）を時刻つきで持つ。at は作った時刻 */
export type OrderHistoryRefundEntry = {
  type: 'refund';
  at: string;
  refundId: string;
  source: OrderRefundSource;
  sourceLabel: string;
  actorEmail: string | null;
  amount: number;
  shippingAmount: number;
  items: Array<{ name: string; quantity: number; beforeShipment: boolean; restockedQuantity: number }>;
  steps: Array<{ status: OrderRefundStatus; label: string; at: string }>;
  failureReasonLabel: string | null;
  referenceNumber: string | null;
  customerActionExpiresAt: string | null;
  note: string | null;
  stripeReasonLabel: string | null;
  cancelReasonLabel: string | null;
};

/** 返金の失敗で在庫を確保し直した行。at は失敗した時刻。quantity は確保し直せた数、shortage は足りなかった数 */
export type OrderHistoryRefundRereserveEntry = {
  type: 'refund_rereserve';
  at: string;
  refundId: string;
  items: Array<{ name: string; quantity: number; shortage: number }>;
};

export type OrderHistoryEntry =
  | OrderHistoryCreatedEntry
  | OrderHistoryStatusEntry
  | OrderHistoryEmailEntry
  | OrderHistoryFulfillmentEntry
  | OrderHistoryFulfillmentCancelEntry
  | OrderHistoryCompletionEntry
  | OrderHistoryCompletionCancelEntry
  | OrderHistoryRefundEntry
  | OrderHistoryRefundRereserveEntry;

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
  fulfillments: OrderFulfillmentHistoryRow[];
  completions: OrderCompletionHistoryRow[];
  refunds: OrderRefundRow[];
  lines: OrderHistoryLine[];
};

const OPEN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['pending', 'sending', 'retry_wait']);
const ERROR_SHOWN_STATUSES: ReadonlySet<OrderEmailStatus> = new Set(['retry_wait', 'dead', 'skipped']);
/** 商品の名前が分からない時に出す名前（注文の商品の行は消えないので、通常は使わない） */
const UNKNOWN_ITEM_NAME = '商品';

function statusLabel(value: string | null): string | null {
  return value && value in ORDER_STATUS_LABELS ? ORDER_STATUS_LABELS[value as OrderStatus] : value;
}

function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value);
}

function statusDetail(row: OrderStatusHistoryRow): string | null {
  // 返金の結果で変わった行（DB の結果を書く関数。前の版の stripe_refund_projection も含む）は、取消の理由（cancel_reason）が
  // 入らない、入っていても返金の行に出るので、返金として説明する。発送済みへ変わる・戻る行は配送業者も入るので、配送業者の説明より先に見る
  if (row.changeReason === 'refund_projection' || row.changeReason === 'stripe_refund_projection') {
    if (row.toStatus === 'cancelled') return '理由: 全額返金';
    if (row.fromStatus === 'cancelled') return '返金の取り消し';
  }
  if (row.changeReason === 'refund_completed_order') {
    return '残りの商品を返金したため発送済み';
  }
  if (row.changeReason === 'refund_failed_reopened') {
    return '返金の失敗で発送待ちに戻りました';
  }
  // 発送の取消で、全部を送った注文が発送済みから決済完了に戻った行
  if (row.changeReason === 'admin_cancel_fulfillment') {
    return '発送の取消';
  }
  if (row.toStatus === 'shipped' && isShippingCarrierId(row.shippingCarrier)) {
    return `配送業者: ${SHIPPING_CARRIERS[row.shippingCarrier].label} / 伝票番号: ${row.trackingNumber ?? ''}`;
  }
  if (row.toStatus === 'cancelled' && isCancelReason(row.cancelReason)) {
    return `理由: ${CANCEL_REASON_LABELS[row.cancelReason]}`;
  }
  return null;
}

/**
 * 返金の状態の移り変わり。作った時刻（返事待ち）と、Stripe の返事で状態が進んだ時刻を、時刻の順に並べる。
 * 受け付けてすぐ成功した返金は保留を通っていない（受け付けた時刻と成功の時刻が同じ）ので、成功の1行だけにする。
 * 同じ時刻の行は、状態の進む順（返事待ち → エラー → 保留 → 成功 → 失敗）に置く
 */
function refundSteps(row: OrderRefundRow): OrderHistoryRefundEntry['steps'] {
  const steps: OrderHistoryRefundEntry['steps'] = [
    { status: 'awaiting_response', label: REFUND_STATUS_LABELS.awaiting_response, at: row.createdAt },
  ];
  const addStep = (status: OrderRefundStatus, at: string | null) => {
    if (at !== null) {
      steps.push({ status, label: REFUND_STATUS_LABELS[status], at });
    }
  };
  const acceptedStraightToSuccess =
    row.acceptedAt !== null && row.succeededAt !== null && Date.parse(row.acceptedAt) === Date.parse(row.succeededAt);

  addStep('error', row.erroredAt);
  if (!acceptedStraightToSuccess) {
    addStep('pending', row.acceptedAt);
  }
  addStep('succeeded', row.succeededAt);
  addStep('failed', row.failedAt);
  return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse {
  const { order, statusRows, emailRows, sendState, fulfillments, completions, refunds, lines } = input;
  const lineByItem = new Map(lines.map((line) => [line.orderItemId, line] as const));
  const itemsOf = (rows: ReadonlyArray<{ orderItemId: string; quantity: number }>) =>
    rows.map((row) => ({ name: lineByItem.get(row.orderItemId)?.name ?? UNKNOWN_ITEM_NAME, quantity: row.quantity }));
  const cancelledFulfillmentIds = new Set(
    fulfillments.filter((row) => row.cancelledAt !== null).map((row) => row.fulfillmentId),
  );
  // 手の再送が送信待ちかは、種類と発送の組で見る（発送のメールは、発送ごとに別の再送を持てる）
  const resendKey = (row: OrderEmailHistoryRow) => `${row.kind}:${row.fulfillmentId ?? ''}`;
  const openManualKeys = new Set(
    emailRows.filter((row) => row.origin === 'manual' && OPEN_STATUSES.has(row.status)).map(resendKey),
  );

  const emailEntries: OrderHistoryEmailEntry[] = emailRows.map((row) => {
    const state = describeOrderEmailState(row.status, row.deliveryStatus);
    return {
      type: 'email',
      at: row.createdAt,
      emailId: row.id,
      kind: row.kind,
      kindLabel:
        row.kind === 'shipped' && row.fulfillmentNumber !== null
          ? `発送（${row.fulfillmentNumber}回目）`
          : ORDER_EMAIL_KIND_LABELS[row.kind],
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
        && !openManualKeys.has(resendKey(row))
        // 取り消した発送のメールは、もう送る意味が無い（DB の関数も断る）
        && !(row.fulfillmentId !== null && cancelledFulfillmentIds.has(row.fulfillmentId)),
      fulfillmentId: row.fulfillmentId,
      fulfillmentNumber: row.fulfillmentNumber,
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

  const fulfillmentEntries: OrderHistoryFulfillmentEntry[] = fulfillments.map((row) => {
    const cancelled = row.cancelledAt !== null;
    return {
      type: 'fulfillment',
      at: row.shippedAt,
      fulfillmentId: row.fulfillmentId,
      number: row.number,
      carrierLabel: isShippingCarrierId(row.shippingCarrier) ? SHIPPING_CARRIERS[row.shippingCarrier].label : null,
      trackingNumber: row.trackingNumber,
      items: itemsOf(row.lines),
      actorEmail: row.createdByEmail,
      notifyCustomer: row.notifyCustomer,
      completesOrder: row.completesOrder,
      cancelled,
      cancellable: !cancelled && (order.status === 'paid' || order.status === 'shipped'),
      legacy: row.legacy,
    };
  });

  const fulfillmentCancelEntries = fulfillments.flatMap((row): OrderHistoryFulfillmentCancelEntry[] =>
    row.cancelledAt === null
      ? []
      : [{ type: 'fulfillment_cancel', at: row.cancelledAt, fulfillmentId: row.fulfillmentId, number: row.number, actorEmail: row.cancelledByEmail }],
  );

  const completionEntries: OrderHistoryCompletionEntry[] = completions.map((row) => {
    const cancelled = row.cancelledAt !== null;
    const line = lineByItem.get(row.orderItemId);
    return {
      type: 'completion',
      at: row.createdAt,
      completionId: row.completionId,
      items: itemsOf([row]),
      actorEmail: row.createdByEmail,
      cancelled,
      // 取り消しても、仕上がった数が送った数を下回らない時だけ（DB の関数も同じ決まりで断る）
      cancellable: !cancelled && order.status === 'paid' && line !== undefined && line.completed - row.quantity >= line.shipped,
      legacy: row.legacy,
    };
  });

  const completionCancelEntries = completions.flatMap((row): OrderHistoryCompletionCancelEntry[] =>
    row.cancelledAt === null
      ? []
      : [{ type: 'completion_cancel', at: row.cancelledAt, completionId: row.completionId, actorEmail: row.cancelledByEmail }],
  );

  const refundEntries: OrderHistoryRefundEntry[] = refunds.map((row) => ({
    type: 'refund',
    at: row.createdAt,
    refundId: row.refundId,
    source: row.source,
    sourceLabel: REFUND_SOURCE_LABELS[row.source],
    actorEmail: row.actorEmail,
    amount: row.amount,
    shippingAmount: row.shippingAmount,
    items: row.lines.map((line) => ({
      name: lineByItem.get(line.orderItemId)?.name ?? UNKNOWN_ITEM_NAME,
      quantity: line.quantity,
      beforeShipment: line.beforeShipment,
      restockedQuantity: line.restockedQuantity,
    })),
    steps: refundSteps(row),
    failureReasonLabel: row.status === 'failed' || row.status === 'error' ? refundFailureReasonLabel(row.failureReason) : null,
    referenceNumber: row.referenceNumber,
    customerActionExpiresAt: row.customerActionExpiresAt,
    note: row.note,
    stripeReasonLabel: row.stripeReason ? STRIPE_REFUND_REASON_LABELS[row.stripeReason] : null,
    cancelReasonLabel: row.cancelReason ? CANCEL_REASON_LABELS[row.cancelReason] : null,
  }));

  // 失敗で在庫を確保し直した商品の行。確保し直しの記録が無い失敗（返事待ちから直に失敗・エラー）や、失敗していない返金には足さない
  const refundRereserveEntries = refunds.flatMap((row): OrderHistoryRefundRereserveEntry[] => {
    const items = row.lines
      .filter((line) => line.rereservedQuantity + line.rereserveShortage > 0)
      .map((line) => ({
        name: lineByItem.get(line.orderItemId)?.name ?? UNKNOWN_ITEM_NAME,
        quantity: line.rereservedQuantity,
        shortage: line.rereserveShortage,
      }));
    return row.failedAt === null || items.length === 0
      ? []
      : [{ type: 'refund_rereserve', at: row.failedAt, refundId: row.refundId, items }];
  });

  // 同じ時刻（同じ取引で書いた行）は、結果が上に来る順に置く: メール → 状態 → 取消 → 確保し直し → 発送・仕上がり・返金 → 受付
  const entries: OrderHistoryEntry[] = [
    ...emailEntries,
    ...statusEntries,
    ...fulfillmentCancelEntries,
    ...completionCancelEntries,
    ...refundRereserveEntries,
    ...fulfillmentEntries,
    ...completionEntries,
    ...refundEntries,
    { type: 'created', at: order.createdAt },
  ];
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
