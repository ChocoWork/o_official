import { toOrderNumber } from '@/lib/orders/order-number';
import { CANCEL_REASON_LABELS, CANCEL_REASONS, type CancelReason, type OrderStatus } from '@/lib/orders/order-payment-types';
import {
  formatYen,
  refundFailureReasonLabel,
  REFUND_SOURCE_LABELS,
  REFUND_STATUS_LABELS,
  STRIPE_REFUND_REASON_LABELS,
} from '@/lib/orders/refund/refund-messages';
import type { OrderRefundSource, OrderRefundStatus } from '@/lib/orders/refund/refund-types';
import type { AdminCancelRequest, OrderReturnDetail } from '@/lib/orders/returns/return-types';
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
import type { DeliveryEvent, FulfillmentDeliveryDetail, OrderDeliveryDetail, TrackingChange } from '@/lib/orders/tracking/delivery-types';

/**
 * 管理画面の「この注文の履歴」（グループ D 設計書 5-1、グループ E-1・E-2・E-3 設計書 9-2・8-1）。窓口と画面の両方が使うので、
 * サーバーだけの物を import しない。注文の状態の変化・メール・発送・仕上がり・返金・返品とその取消を新しい順に並べる。
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
  /** 返品のメール4種類と、返品の返金のお知らせ（書き分け return）だけ、どの返品のメールかを示す。ほかの種類は null（グループ E-3 設計書 9 章） */
  returnId: string | null;
  /** 返品の受け取りのお知らせ・品物のお返しのお知らせ・店への知らせ（返金待ち）と、受け取りと一緒の返金のお知らせだけ、どの受け取りのメールかを示す。ほかの種類は null */
  returnReceiptId: string | null;
};

/**
 * 注文の商品ごとの名前（商品名（色 / サイズ））と、発送した数・仕上がった数。取り消せるかの判断に使う。
 * exchange は、返品の交換で足した交換の品の行だけが持つ（数と足した時刻。履歴の「交換の品を足した」の行になる。グループ E-3）
 */
export type OrderHistoryLine = {
  orderItemId: string;
  name: string;
  shipped: number;
  completed: number;
  exchange?: { quantity: number; createdAt: string };
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
  delivery?: FulfillmentDeliveryDetail;
};

export type OrderHistoryDeliveryEventEntry = {
  type: 'delivery_event'; at: string; fulfillmentId: string; number: number; event: DeliveryEvent;
};
export type OrderHistoryTrackingChangeEntry = {
  type: 'tracking_change'; at: string; fulfillmentId: string; number: number; change: TrackingChange;
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

/** 受け取りの行ごとの数（order_return_receipt_lines）。履歴の「返品の受け取り」の細目と「届かない」「返金しない」の数に使う。disposition は restocked・missing・refund_waived など */
export type OrderHistoryReturnReceiptLine = { receiptId: string; disposition: string; quantity: number };

/**
 * 返品の記録（order_returns）に直に残っていて、返品の一覧（list_order_returns。共通の約束 C-2）が持たない欄。
 * 取消・手数料の受け取り・支払いを待たずに送るをした人のメール（設計書 8-1「日時とした人つき」）と、手数料をいただかないことにした印
 * （fee_waived。本計画 P27）。履歴の窓口が order_returns から引いて渡す。メールが引けない人（消えた利用者など）は null
 */
export type OrderHistoryReturnRecord = {
  returnId: string;
  cancelledByEmail: string | null;
  feeReceivedByEmail: string | null;
  exchangeReleasedByEmail: string | null;
  /** 申し込みの返品をお断りした人（order_returns.declined_by のメール）。返品の一覧（OrderReturnDetail）は持たない（グループ E-3 段2） */
  declinedByEmail: string | null;
  feeWaived: boolean;
  /** 決着で fee_due_amount から移した額の合計（Task 3 の I-2）。履歴は未決着額ではなく、この額を出す */
  feeSettledAmount: number;
};

export type OrderHistoryReturnEntryKind =
  | 'created'
  | 'receive'
  | 'refund_waived'
  | 'close_missing'
  | 'inspect'
  | 'cancel'
  | 'reopen'
  | 'exchange_added'
  | 'fee_received'
  | 'exchange_released'
  | 'request'
  | 'approve'
  | 'decline'
  | 'cancel_request'
  | 'cancel_request_decline'
  | 'cancel_request_close'
  | 'cancel_request_resolve';

/**
 * 返品の行（グループ E-3 設計書 8-1）。文は共通の約束 C-5 のとおりここで組み立て済みで、画面は title と details をそのまま出す。
 * id は画面の一覧の key（返品の行どうしで重ならない）。returnId は、交換の品を足した行と、キャンセルの申し込みの行だけ null。
 * した人（actorEmail）は、作った・受け取りの記録の行は返品の一覧から、取消・手数料の受け取り・支払いを待たずに送るは窓口が
 * order_returns から引いた物（OrderHistoryReturnRecord）、交換の品を足したは同じ時刻の受け取りをした人。分からない時（消えた利用者など）は null
 */
export type OrderHistoryReturnEntry = {
  type: 'return';
  kind: OrderHistoryReturnEntryKind;
  id: string;
  at: string;
  returnId: string | null;
  title: string;
  details: string[];
  actorEmail: string | null;
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
  | OrderHistoryRefundRereserveEntry
  | OrderHistoryReturnEntry
  | OrderHistoryDeliveryEventEntry
  | OrderHistoryTrackingChangeEntry;

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
  returns: OrderReturnDetail[];
  returnReceiptLines: OrderHistoryReturnReceiptLine[];
  returnRecords: OrderHistoryReturnRecord[];
  /** キャンセルの申し込み（Task 4 の listOrderCancelRequests の答え）。申し込み・お断り・解決済み・解決の行に使う（グループ E-3 段2） */
  cancelRequests: AdminCancelRequest[];
  lines: OrderHistoryLine[];
  delivery?: OrderDeliveryDetail;
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

/** 受け取りの品の状態ごとの数の言葉。順番は C-5 のとおり: 在庫に戻す → 戻さない → お返し → 検品待ち */
const RECEIVE_DETAIL_WORDS = [
  ['在庫に戻す', 'restocked'],
  ['戻さない', 'not_restocked'],
  ['お返し', 'sent_back'],
  ['検品待ち', 'pending_inspection'],
] as const;

/** ある受け取りの、ある品の状態の数の合計（同じ状態の行は、返品の行や解決ごとに分かれている） */
function receiptQuantity(lines: readonly OrderHistoryReturnReceiptLine[], receiptId: string, disposition: string): number {
  return lines
    .filter((line) => line.receiptId === receiptId && line.disposition === disposition)
    .reduce((total, line) => total + line.quantity, 0);
}

/**
 * 返品1件の履歴の行（グループ E-3 設計書 8-1、文は共通の約束 C-5）。受け取りの記録（receipts）から、受け取り・検品・届かない・
 * 開き直し・返金しないで終えた、を出す。取消・手数料の受け取り・支払いを待たずに送るは、返品の記録の時刻と、窓口が引いた
 * 返品の記録（record。した人のメールと、手数料をいただかない印 feeWaived）から出す。
 * 金額は E-2 の「金額の書き方」（全角の ￥ と桁区切り）。同じ時刻の行は、結果が上に来る順（返金しないで終えた → 受け取り）に並べる
 */
function returnHistoryEntries(
  detail: OrderReturnDetail,
  receiptLines: readonly OrderHistoryReturnReceiptLine[],
  record: OrderHistoryReturnRecord | undefined,
): OrderHistoryReturnEntry[] {
  const entry = (
    kind: OrderHistoryReturnEntryKind,
    id: string,
    at: string,
    title: string,
    actorEmail: string | null,
    details: string[] = [],
  ): OrderHistoryReturnEntry => ({ type: 'return', kind, id, at, returnId: detail.id, title, details, actorEmail });
  const waivedEntry = (receipt: OrderReturnDetail['receipts'][number]) =>
    entry(
      'refund_waived',
      `waived:${receipt.id}`,
      receipt.createdAt,
      `返金しないで終えた（${detail.label}・${receiptQuantity(receiptLines, receipt.id, 'refund_waived')}点）`,
      receipt.actorEmail,
    );

  const entries: OrderHistoryReturnEntry[] = [];
  // お店が作った返品は「返品を作った」の1行。お客様の申し込みの返品は、作った行を出さず、申し込み・承認・お断りの行を、時刻があれば出す（下）
  if (detail.source === 'shop') {
    entries.push(entry('created', `created:${detail.id}`, detail.createdAt, `返品を作った（${detail.label}）`, detail.createdByEmail));
  }
  // お客様の申し込みの返品（グループ E-3 段2、決め事 P17）。申し込みはお客様がするので、した人は出さない。
  // お断りをした人は返品の一覧（OrderReturnDetail）に無いので、窓口が order_returns から引いた物（record）から出す
  if (detail.requestedAt !== null) {
    entries.push(entry('request', `request:${detail.id}`, detail.requestedAt, `返品の申し込み（${detail.label}）`, null));
  }
  // 承認の行は、お客様の申し込みの返品だけ。お店が作った返品は、段1の admin_create_return が approved_at・approved_by に作った時刻と人を入れるので、source で絞る
  if (detail.source === 'customer_request' && detail.approvedAt !== null) {
    entries.push(
      entry('approve', `approve:${detail.id}`, detail.approvedAt, `返品の申し込みを承認した（${detail.label}）`, detail.approvedByEmail),
    );
  }
  if (detail.declinedAt !== null) {
    entries.push(
      entry('decline', `decline:${detail.id}`, detail.declinedAt, `返品の申し込みをお断りした（${detail.label}）`, record?.declinedByEmail ?? null),
    );
  }
  for (const receipt of detail.receipts) {
    const id = `receipt:${receipt.id}`;
    if (receipt.kind === 'receive') {
      // 返金額が0円になって返金しなかった数（refund_waived）があれば、受け取りの行の上に「返金しないで終えた」を足す（本計画 P20）
      if (receiptQuantity(receiptLines, receipt.id, 'refund_waived') > 0) {
        entries.push(waivedEntry(receipt));
      }
      const details = RECEIVE_DETAIL_WORDS.flatMap(([word, disposition]) => {
        const quantity = receiptQuantity(receiptLines, receipt.id, disposition);
        return quantity > 0 ? [`${word} ${quantity}点`] : [];
      });
      entries.push(entry('receive', id, receipt.createdAt, `返品の受け取り（${detail.label}）`, receipt.actorEmail, details));
    } else if (receipt.kind === 'waive_refund') {
      entries.push(waivedEntry(receipt));
    } else if (receipt.kind === 'close_missing') {
      const missing = receiptQuantity(receiptLines, receipt.id, 'missing');
      entries.push(
        entry('close_missing', id, receipt.createdAt, `「届かない」として返品を終えた（${detail.label}・${missing}点）`, receipt.actorEmail),
      );
    } else if (receipt.kind === 'inspect') {
      entries.push(entry('inspect', id, receipt.createdAt, `検品を終えた（${detail.label}）`, receipt.actorEmail));
    } else {
      entries.push(entry('reopen', id, receipt.createdAt, `返品を開き直した（${detail.label}）`, receipt.actorEmail));
    }
  }
  if (detail.cancelledAt !== null) {
    entries.push(
      entry('cancel', `cancel:${detail.id}`, detail.cancelledAt, `返品を取り消した（${detail.label}）`, record?.cancelledByEmail ?? null),
    );
  }
  if (detail.fees.feeReceivedAt !== null) {
    // 手数料をいただかないことにした時（fee_waived。本計画 P27）は、受け取りとは別の言葉で出す。額は決着で fee_settled_amount に移した合計（fee_due_amount は0になる。Task 3 の I-2）
    const feeWord = record?.feeWaived === true ? '手数料をいただかないことにした' : '手数料の受け取りを記録した';
    entries.push(
      entry(
        'fee_received',
        `fee:${detail.id}`,
        detail.fees.feeReceivedAt,
        `${feeWord}（${formatYen(record?.feeSettledAmount ?? detail.fees.feeDueAmount)}）`,
        record?.feeReceivedByEmail ?? null,
      ),
    );
  }
  if (detail.fees.exchangeReleasedAt !== null) {
    entries.push(
      entry(
        'exchange_released',
        `release:${detail.id}`,
        detail.fees.exchangeReleasedAt,
        `支払いを待たずに送れるようにした（${detail.label}）`,
        record?.exchangeReleasedByEmail ?? null,
      ),
    );
  }
  return entries;
}

/**
 * キャンセルの申し込みの行（グループ E-3 段2、決め事 P17）。申し込みごとに、申し込み・お断り・解決済み・解決の、時刻のある物を出す。
 * Task 4 の listOrderCancelRequests の答え（AdminCancelRequest）が、時刻とした人のメールを全部持つ。申し込みはお客様がするので、した人は出さない。
 * 返品の行と同じ type: 'return' の形（題 title・細目 details・した人 actorEmail）で出し、返品の番号は持たない（returnId は null）。
 * お断りのメッセージ・ご連絡事項は出さない（細目は空）。解決は、品を外した返金の番号があれば（返金）、無ければ（キャンセル）
 */
function cancelRequestHistoryEntries(cancelRequests: readonly AdminCancelRequest[]): OrderHistoryReturnEntry[] {
  const entry = (
    kind: OrderHistoryReturnEntryKind,
    idPrefix: string,
    request: AdminCancelRequest,
    at: string,
    title: string,
    actorEmail: string | null,
  ): OrderHistoryReturnEntry => ({
    type: 'return', kind, id: `${idPrefix}:${request.id}`, at, returnId: null, title, details: [], actorEmail,
  });

  return cancelRequests.flatMap((request) => {
    const entries = [entry('cancel_request', 'cancel-request', request, request.requestedAt, 'キャンセルの申し込み', null)];
    if (request.declinedAt !== null) {
      entries.push(
        entry('cancel_request_decline', 'cancel-request-decline', request, request.declinedAt, 'キャンセルの申し込みをお断りした', request.declinedByEmail),
      );
    }
    if (request.closedAt !== null) {
      entries.push(
        entry('cancel_request_close', 'cancel-request-close', request, request.closedAt, 'キャンセルの申し込みを解決済みにした', request.closedByEmail),
      );
    }
    if (request.resolvedAt !== null) {
      const how = request.resolvedRefundId !== null ? '返金' : 'キャンセル';
      entries.push(
        entry('cancel_request_resolve', 'cancel-request-resolve', request, request.resolvedAt, `キャンセルの申し込みを解決した（${how}）`, request.resolvedByEmail),
      );
    }
    return entries;
  });
}

export function buildOrderHistory(input: BuildOrderHistoryInput): OrderHistoryResponse {
  const {
    order, statusRows, emailRows, sendState, fulfillments, completions, refunds, returns, returnReceiptLines, returnRecords, cancelRequests, lines,
  } = input;
  const deliveryById = new Map(input.delivery?.fulfillments.map((row) => [row.fulfillmentId, row] as const));
  const lineByItem = new Map(lines.map((line) => [line.orderItemId, line] as const));
  // 返品の返金の行の「どこから」に返品の番号を出すため、返金の番号から返品の番号を引けるようにする（返金の一覧は返品の番号を持たない）
  const returnLabelByRefundId = new Map(returns.flatMap((detail) => detail.refunds.map((refundOf) => [refundOf.id, detail.label] as const)));
  const itemsOf = (rows: ReadonlyArray<{ orderItemId: string; quantity: number }>) =>
    rows.map((row) => ({ name: lineByItem.get(row.orderItemId)?.name ?? UNKNOWN_ITEM_NAME, quantity: row.quantity }));
  const cancelledFulfillmentIds = new Set(
    fulfillments.filter((row) => {
      const delivery = deliveryById.get(row.fulfillmentId);
      return (delivery ? delivery.cancelledAt : row.cancelledAt) !== null;
    }).map((row) => row.fulfillmentId),
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
    const delivery = deliveryById.get(row.fulfillmentId);
    const cancelled = (delivery ? delivery.cancelledAt : row.cancelledAt) !== null;
    const carrier = delivery ? delivery.carrier : row.shippingCarrier;
    return {
      type: 'fulfillment',
      at: row.shippedAt,
      fulfillmentId: row.fulfillmentId,
      number: row.number,
      carrierLabel: isShippingCarrierId(carrier) ? SHIPPING_CARRIERS[carrier].label : null,
      trackingNumber: delivery ? delivery.trackingNumber : row.trackingNumber,
      items: itemsOf(row.lines),
      actorEmail: row.createdByEmail,
      notifyCustomer: delivery ? delivery.notifyCustomer : row.notifyCustomer,
      completesOrder: row.completesOrder,
      cancelled,
      cancellable: !cancelled && (order.status === 'paid' || order.status === 'shipped'),
      legacy: row.legacy,
      ...(delivery ? { delivery } : {}),
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
    // 返品の返金は「返品（{番号}）」。番号が引けない時は、道の言葉（返品）のまま
    sourceLabel:
      row.source === 'return' && returnLabelByRefundId.has(row.refundId)
        ? `返品（${returnLabelByRefundId.get(row.refundId)}）`
        : REFUND_SOURCE_LABELS[row.source],
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

  // 返品の交換で足した交換の品の行。足した時刻（受け取りと同じ取引なので受け取りと同じ時刻）で「交換の品を足した」を出す。
  // 足した人は、その品を持つ返品の、同じ時刻の受け取りをした人（足した時刻と受け取りの時刻は、同じ取引の now() で同じになる）
  const exchangeAdderOf = (orderItemId: string, createdAt: string): string | null => {
    const detail = returns.find((candidate) => candidate.exchangeItems.some((item) => item.orderItemId === orderItemId));
    const receipt = detail?.receipts.find(
      (candidate) => candidate.kind === 'receive' && Date.parse(candidate.createdAt) === Date.parse(createdAt),
    );
    return receipt?.actorEmail ?? null;
  };
  const exchangeAddedEntries = lines.flatMap((line): OrderHistoryReturnEntry[] =>
    line.exchange
      ? [{
          type: 'return',
          kind: 'exchange_added',
          id: `exchange:${line.orderItemId}`,
          at: line.exchange.createdAt,
          returnId: null,
          title: `交換の品を足した（${line.name} × ${line.exchange.quantity}）`,
          details: [],
          actorEmail: exchangeAdderOf(line.orderItemId, line.exchange.createdAt),
        }]
      : []);
  const recordByReturn = new Map(returnRecords.map((row) => [row.returnId, row] as const));
  const returnEntries = returns.flatMap((detail) => returnHistoryEntries(detail, returnReceiptLines, recordByReturn.get(detail.id)));
  const cancelRequestEntries = cancelRequestHistoryEntries(cancelRequests);
  const deliveryEvents: OrderHistoryDeliveryEventEntry[] = (input.delivery?.fulfillments ?? []).flatMap((row) =>
    row.events.map((event) => ({ type: 'delivery_event', at: event.happenedAt, fulfillmentId: row.fulfillmentId, number: row.number, event })));
  const trackingChanges: OrderHistoryTrackingChangeEntry[] = (input.delivery?.fulfillments ?? []).flatMap((row) =>
    row.trackingChanges.map((change) => ({ type: 'tracking_change', at: change.changedAt, fulfillmentId: row.fulfillmentId, number: row.number, change })));

  // 同じ時刻（同じ取引で書いた行）は、結果が上に来る順に置く:
  // メール → 状態 → 取消 → 確保し直し → 交換の品を足した → 発送・仕上がり → 返金 → 返品の行（返金しないで終えた → 受け取り）→ 受付
  const entries: OrderHistoryEntry[] = [
    ...emailEntries,
    ...statusEntries,
    ...fulfillmentCancelEntries,
    ...completionCancelEntries,
    ...refundRereserveEntries,
    ...exchangeAddedEntries,
    ...fulfillmentEntries,
    ...completionEntries,
    ...refundEntries,
    ...returnEntries,
    ...cancelRequestEntries,
    ...deliveryEvents,
    ...trackingChanges,
    { type: 'created', at: order.createdAt },
  ];
  const typeOrder: Record<OrderHistoryEntry['type'], number> = {
    email: 0, status: 1, fulfillment_cancel: 2, completion_cancel: 3, refund_rereserve: 4,
    delivery_event: 5, tracking_change: 6, fulfillment: 7, completion: 8, refund: 9, return: 10, created: 11,
  };
  const deliveryEntryId = (entry: OrderHistoryEntry) => entry.type === 'delivery_event' ? entry.event.id
    : entry.type === 'tracking_change' ? entry.change.id : '';
  const priority = (entry: OrderHistoryEntry) => entry.type === 'return' && entry.kind === 'exchange_added' ? 4.5 : typeOrder[entry.type];
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)
    || priority(a) - priority(b) || deliveryEntryId(a).localeCompare(deliveryEntryId(b)));

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
