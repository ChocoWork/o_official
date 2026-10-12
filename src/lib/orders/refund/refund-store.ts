import type { SupabaseClient } from '@supabase/supabase-js';
import type { CancelReason, OrderStatus } from '@/lib/orders/order-payment-types';
import type {
  OrderRefundSource,
  OrderRefundStatus,
  RefundErrorCode,
  RefundLineRequest,
  ShopSettings,
  ShopSettingToggle,
  StripeRefundReason,
  UpdateShopSettingsRequest,
} from '@/lib/orders/refund/refund-types';

/**
 * 返金の DB の関数を呼ぶ（グループ E-2 設計書 3〜6・9 章）。返金の2つの表は service_role からも書けず、関数だけが書く。
 * 関数は断る理由を決まった言葉で止める。ここで誤りの記号（RefundErrorCode）に直し、窓口が HTTP と画面の言葉にする。
 * DB の文には宛先などが混ざりうるので、ログに出さない（RefundStoreError は呼び出しの名前と DB の記号だけを見せる）。
 * サーバーだけで使う（画面から読まない）。単体テストと DB 結合テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export type RefundStore = Pick<SupabaseClient, 'rpc'>;

type QueryError = { message?: string; code?: string } | null;

/** DB の関数が決まった言葉で断った。記号から HTTP と画面の言葉が決まる */
export class RefundOperationError extends Error {
  constructor(readonly code: RefundErrorCode) {
    super(`refund operation refused: ${code}`);
    this.name = 'RefundOperationError';
  }
}

/** DB の呼び出しが思いがけず失敗した。DB の文は cause にだけ残す */
export class RefundStoreError extends Error {
  readonly code: string | null;

  constructor(
    readonly operation: string,
    cause: QueryError = null,
  ) {
    super(`refund store failed: ${operation}`, { cause });
    this.name = 'RefundStoreError';
    this.code = cause?.code ?? null;
  }
}

// DB の関数が RAISE EXCEPTION で止める言葉 → 誤りの記号（共通の約束 C-2）。言葉は移行の本文と同じ綴り
const DB_ERROR_WORDS: Array<readonly [string, RefundErrorCode]> = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_REFUNDABLE', 'order_not_refundable'],
  ['ORDER_NOT_CANCELLABLE', 'order_not_cancellable'],
  ['AWAITING_REFUND_EXISTS', 'awaiting_refund_exists'],
  ['REFUND_REQUEST_MISMATCH', 'refund_request_mismatch'],
  ['REFUND_LINE_NOT_IN_ORDER', 'refund_line_not_in_order'],
  ['REFUND_QUANTITY_EXCEEDS_UNSHIPPED', 'quantity_exceeds_unshipped'],
  ['REFUND_QUANTITY_EXCEEDS_SHIPPED', 'quantity_exceeds_shipped'],
  ['REFUND_SHIPPING_EXCEEDS', 'shipping_exceeds'],
  ['REFUND_EXCEEDS_REFUNDABLE', 'exceeds_refundable'],
  ['REFUND_MUST_INCLUDE_UNSHIPPED', 'must_include_unshipped'],
  ['REFUND_MUST_BE_FULL', 'must_be_full'],
  ['REFUND_ARGUMENT_INVALID', 'invalid_argument'],
  ['SETTINGS_ARGUMENT_INVALID', 'invalid_argument'],
];
// 長い言葉から先に照らす。ある言葉が別の言葉の一部になる綴りが足されても、長い方が先に当たる（本計画 P3）
DB_ERROR_WORDS.sort((a, b) => b[0].length - a[0].length);

/** DB の誤りの文に表の言葉が含まれていれば、その記号。無ければ null */
export function toRefundErrorCode(message: string | undefined): RefundErrorCode | null {
  if (!message) {
    return null;
  }
  return DB_ERROR_WORDS.find(([word]) => message.includes(word))?.[1] ?? null;
}

type RefundRpcName =
  | 'begin_order_refund'
  | 'record_order_refund_result'
  | 'record_external_order_refund'
  | 'mark_order_refund_error'
  | 'record_cancelled_order_paid_amount'
  | 'get_order_refund'
  | 'list_order_refunds'
  | 'list_awaiting_order_refunds'
  | 'list_pending_refund_payment_intents'
  | 'list_order_refund_summaries'
  | 'get_shop_settings'
  | 'admin_update_shop_settings'
  | 'resolve_payment_exception_by_system';

async function callRpc(store: RefundStore, name: RefundRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, args);
  if (error) {
    const code = toRefundErrorCode(error.message);
    throw code ? new RefundOperationError(code) : new RefundStoreError(name, error);
  }
  return data;
}

/** PostgREST は表を返す関数の答えを配列で返す。行が1つのオブジェクトで来ても読めるようにする */
function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

// PostgREST が1回の答えで返す行の上限。値は supabase/config.toml の max_rows と本番の既定（どちらも 1000）に合わせる
// （fulfillment-store.ts と同じ値）。上限に届いた答えは切れている恐れがあり、切れたまま使うと一覧や判定を誤るので、使わずに止める
const POSTGREST_MAX_ROWS = 1000;

/** 一覧を返す関数の答えの行。上限に届いていたら RefundStoreError で止める */
function listRowsOf(data: unknown, operation: RefundRpcName): Record<string, unknown>[] {
  const rows = rowsOf(data);
  if (rows.length >= POSTGREST_MAX_ROWS) {
    throw new RefundStoreError(operation);
  }
  return rows;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export type BeginRefundInput = {
  orderId: string;
  // 返品の返金（return）は、返品の受け取り・額を決めて返金の DB の関数が始める。ここ（公開の begin_order_refund）の道ではない
  source: Exclude<OrderRefundSource, 'stripe_dashboard' | 'legacy' | 'return'>;
  requestKey: string | null;
  lines: RefundLineRequest[];
  restock: boolean;
  shippingAmount: number;
  amount: number;
  note: string | null;
  stripeReason: StripeRefundReason | null;
  cancelReason: CancelReason | null;
  notifyCustomer: boolean;
  actorId: string | null;
  receivedAmount?: number | null;
};

export type BeganRefund = { refundId: string; amount: number; status: OrderRefundStatus; replayed: boolean };

/**
 * 返金の記録を「返事待ち」で始める（Stripe に頼む前）。同じ requestKey の送り直しは前の記録を返す（replayed）。
 * 道 admin・order_cancel は requestKey が要り、自動の返金（auto_*）は空。断りは RefundOperationError
 */
export async function beginOrderRefund(store: RefundStore, input: BeginRefundInput): Promise<BeganRefund> {
  const row = rowsOf(
    await callRpc(store, 'begin_order_refund', {
      _order_id: input.orderId,
      _source: input.source,
      _request_key: input.requestKey,
      _lines: input.lines.map((line) => ({
        order_item_id: line.orderItemId,
        quantity: line.quantity,
        before_shipment: line.beforeShipment,
      })),
      _restock: input.restock,
      _shipping_amount: input.shippingAmount,
      _amount: input.amount,
      _note: input.note,
      _stripe_reason: input.stripeReason,
      _cancel_reason: input.cancelReason,
      _notify_customer: input.notifyCustomer,
      _actor_id: input.actorId,
      _received_amount: input.receivedAmount ?? null,
    }),
  )[0];
  if (!row) {
    throw new RefundStoreError('begin_order_refund', null);
  }
  return {
    refundId: String(row.refund_id),
    amount: Number(row.amount),
    status: row.status as OrderRefundStatus,
    replayed: row.replayed === true,
  };
}

/** Stripe の返金から読んだ値（結果を書く関数に渡す） */
export type StripeRefundFields = {
  stripeRefundId: string;
  stripeStatus: string;
  pendingReason: string | null;
  failureReason: string | null;
  customerActionExpiresAt: string | null;
  paymentMethodType: string | null;
  referenceNumber: string | null;
  referenceType: string | null;
};

export type RefundResultRow = {
  refundId: string;
  orderId: string;
  status: OrderRefundStatus;
  newlyAccepted: boolean;
  newlyFailed: boolean;
  orderStatus: OrderStatus;
  refundedAmount: number;
  rereserveShortage: number;
  emailEnqueued: boolean;
  exceptionId: string | null;
};

/** 結果を書く関数に渡す Stripe の返金の値。引数名は DB の関数のとおり */
function stripeFieldArgs(fields: StripeRefundFields) {
  return {
    _stripe_refund_id: fields.stripeRefundId,
    _stripe_status: fields.stripeStatus,
    _stripe_pending_reason: fields.pendingReason,
    _stripe_failure_reason: fields.failureReason,
    _customer_action_expires_at: fields.customerActionExpiresAt,
    _payment_method_type: fields.paymentMethodType,
    _reference_number: fields.referenceNumber,
    _reference_type: fields.referenceType,
  };
}

/** 結果を書く2つの関数の答えの行。注文の番号は呼ぶ側が渡す（外からの返金の関数は注文の番号の列を返さない） */
function toResultRow(row: Record<string, unknown>, orderId: string): RefundResultRow {
  return {
    refundId: String(row.refund_id),
    orderId,
    status: row.status as OrderRefundStatus,
    newlyAccepted: row.newly_accepted === true,
    newlyFailed: row.newly_failed === true,
    orderStatus: row.order_status as OrderStatus,
    refundedAmount: Number(row.refunded_amount),
    rereserveShortage: Number(row.rereserve_shortage),
    emailEnqueued: row.email_enqueued === true,
    exceptionId: textOrNull(row.exception_id),
  };
}

/**
 * Stripe の返金の値で、記録の状態を進める。在庫・メールの予定・要対応・注文の額と状態を DB が1回の取引で書く。
 * 前の状態に戻る知らせ（成功の後の保留など）は、DB が何もせずに今の値を返す
 */
export async function recordOrderRefundResult(
  store: RefundStore,
  refundId: string,
  fields: StripeRefundFields,
): Promise<RefundResultRow> {
  const row = rowsOf(
    await callRpc(store, 'record_order_refund_result', { _refund_id: refundId, ...stripeFieldArgs(fields) }),
  )[0];
  if (!row) {
    throw new RefundStoreError('record_order_refund_result', null);
  }
  return toResultRow(row, String(row.order_id));
}

export type ExternalRefundResultRow = RefundResultRow & { created: boolean; source: OrderRefundSource };

/**
 * こちらの印の無い返金（Stripe の画面からの返金・切り替えの前の写し）を記録する。同じ Stripe の返金の番号は何度呼んでも1行
 * （created が false）。DB の関数は注文の番号を返さないので、答えの orderId は入力の値を写す
 */
export async function recordExternalOrderRefund(
  store: RefundStore,
  input: {
    orderId: string;
    amount: number;
    stripeReason: string | null;
    stripeCreatedAt: string;
  } & StripeRefundFields,
): Promise<ExternalRefundResultRow> {
  const row = rowsOf(
    await callRpc(store, 'record_external_order_refund', {
      _order_id: input.orderId,
      _amount: input.amount,
      _stripe_reason: input.stripeReason,
      _stripe_created_at: input.stripeCreatedAt,
      ...stripeFieldArgs(input),
    }),
  )[0];
  if (!row) {
    throw new RefundStoreError('record_external_order_refund', null);
  }
  return { ...toResultRow(row, input.orderId), created: row.created === true, source: row.source as OrderRefundSource };
}

function markOutcomeOf(value: unknown): 'errored' | 'not_awaiting' | null {
  return value === 'errored' || value === 'not_awaiting' ? value : null;
}

/**
 * 返事待ちの返金をエラーにする（Stripe の断り・見回りで見つからない）。raiseException が true なら要対応「返金の失敗」も作る。
 * もう返事待ちでなければ not_awaiting（何度呼んでも同じ結果）
 */
export async function markOrderRefundError(
  store: RefundStore,
  refundId: string,
  reason: string,
  raiseException: boolean,
): Promise<{ outcome: 'errored' | 'not_awaiting'; orderId: string; exceptionId: string | null }> {
  const row = rowsOf(
    await callRpc(store, 'mark_order_refund_error', {
      _refund_id: refundId,
      _reason: reason,
      _raise_exception: raiseException,
    }),
  )[0];
  const outcome = markOutcomeOf(row?.outcome);
  if (!outcome) {
    throw new RefundStoreError('mark_order_refund_error', null);
  }
  return { outcome, orderId: String(row.order_id), exceptionId: textOrNull(row.exception_id) };
}

/**
 * 取り消した注文への入金の受け取った額を書く（本計画 P27）。照合が要対応「取り消した注文への入金」を記録するたびに、
 * 自動の返金①より先に呼ぶ（①のオン・オフに依らず、店が管理画面から返金できるように）。
 * 書いたら true。取り消していない注文・書き済みの注文・注文に別の支払いの番号がある時は、何も書かずに false（何度呼んでも同じ）。
 * DB の決まった言葉（REFUND_ARGUMENT_INVALID・ORDER_NOT_FOUND）は RefundOperationError、ほかの DB の誤りは RefundStoreError。
 * boolean を返す関数なので、PostgREST の答えは行の配列ではなく true か false そのもの
 */
export async function recordCancelledOrderPaidAmount(
  store: RefundStore,
  input: { orderId: string; paymentIntentId: string; receivedAmount: number },
): Promise<boolean> {
  const data = await callRpc(store, 'record_cancelled_order_paid_amount', {
    _order_id: input.orderId,
    _payment_intent_id: input.paymentIntentId,
    _received_amount: input.receivedAmount,
  });
  return data === true;
}

export type OrderRefundRef = {
  refundId: string;
  orderId: string;
  source: OrderRefundSource;
  status: OrderRefundStatus;
  stripeRefundId: string | null;
  amount: number;
  paymentIntentId: string | null;
  createdAt: string;
  stripeReason: StripeRefundReason | null;
  actorId: string | null;
  failureReason: string | null;
};

/**
 * 返金1件の要点。Stripe の返金の印が、この注文の記録に当たるかを調べる時と、返事待ちの記録を送り直す・確かめ直す時に使う。
 * 送り直しと確かめ直しは記録と同じ中身で Stripe に頼むので、額のほかに、Stripe に伝える理由と実行した人（印 actor_id 用）も返す。
 * failureReason は、エラー・失敗の記録の理由（こちらの理由 stripe_rejected か Stripe の記号）。無ければ null
 */
export async function getOrderRefund(store: RefundStore, refundId: string): Promise<OrderRefundRef | null> {
  const row = rowsOf(await callRpc(store, 'get_order_refund', { _refund_id: refundId }))[0];
  if (!row) {
    return null;
  }
  return {
    refundId: String(row.refund_id),
    orderId: String(row.order_id),
    source: row.source as OrderRefundSource,
    status: row.status as OrderRefundStatus,
    stripeRefundId: textOrNull(row.stripe_refund_id),
    amount: Number(row.amount),
    paymentIntentId: textOrNull(row.payment_intent_id),
    createdAt: String(row.created_at),
    stripeReason: textOrNull(row.stripe_reason) as StripeRefundReason | null,
    actorId: textOrNull(row.actor_id),
    failureReason: textOrNull(row.stripe_failure_reason),
  };
}

export type OrderRefundLineRow = {
  orderItemId: string;
  quantity: number;
  beforeShipment: boolean;
  restockType: 'cancel' | 'no_restock' | 'return';
  amount: number;
  releasedQuantity: number;
  restockedQuantity: number;
  rereservedQuantity: number;
  rereserveShortage: number;
};

export type OrderRefundRow = {
  refundId: string;
  source: OrderRefundSource;
  status: OrderRefundStatus;
  stripeStatus: string | null;
  pendingReason: string | null;
  failureReason: string | null;
  customerActionExpiresAt: string | null;
  paymentMethodType: string | null;
  amount: number;
  shippingAmount: number;
  adjustmentAmount: number;
  note: string | null;
  stripeReason: StripeRefundReason | null;
  cancelReason: CancelReason | null;
  notifyCustomer: boolean;
  actorEmail: string | null;
  referenceNumber: string | null;
  referenceType: string | null;
  createdAt: string;
  acceptedAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  erroredAt: string | null;
  lines: OrderRefundLineRow[];
};

/** list_order_refunds の lines（jsonb の配列。商品の行が無ければ null になりうる）を窓口の形に直す */
function fromDbLines(value: unknown): OrderRefundLineRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((line: Record<string, unknown>) => ({
    orderItemId: String(line.order_item_id),
    quantity: Number(line.quantity),
    beforeShipment: line.before_shipment === true,
    // 返品の返金の行（restock_type = 'return'）は、発送後の行だけ。在庫は受け取りで動かし済みなので、返金では動かさない
    restockType: line.restock_type === 'cancel' ? 'cancel' : line.restock_type === 'return' ? 'return' : 'no_restock',
    amount: Number(line.amount),
    releasedQuantity: Number(line.released_quantity),
    restockedQuantity: Number(line.restocked_quantity),
    rereservedQuantity: Number(line.rereserved_quantity),
    rereserveShortage: Number(line.rereserve_shortage),
  }));
}

/**
 * 注文の返金の一覧（失敗・エラーも含む。新しい順）。操作した人のメールを含むので、答えをそのまま返さない。
 * 管理画面の履歴の窓口が使う。お客様の窓口が使う時は、項目を名指しで選んでから返すこと（失敗とエラーの返金は返さない）
 */
export async function listOrderRefunds(store: RefundStore, orderId: string): Promise<OrderRefundRow[]> {
  const data = await callRpc(store, 'list_order_refunds', { _order_id: orderId });
  return listRowsOf(data, 'list_order_refunds').map((row) => ({
    refundId: String(row.refund_id),
    source: row.source as OrderRefundSource,
    status: row.status as OrderRefundStatus,
    stripeStatus: textOrNull(row.stripe_status),
    pendingReason: textOrNull(row.stripe_pending_reason),
    failureReason: textOrNull(row.stripe_failure_reason),
    customerActionExpiresAt: textOrNull(row.customer_action_expires_at),
    paymentMethodType: textOrNull(row.payment_method_type),
    amount: Number(row.amount),
    shippingAmount: Number(row.shipping_amount),
    adjustmentAmount: Number(row.adjustment_amount),
    note: textOrNull(row.note),
    stripeReason: textOrNull(row.stripe_reason) as StripeRefundReason | null,
    cancelReason: textOrNull(row.cancel_reason) as CancelReason | null,
    notifyCustomer: row.notify_customer === true,
    actorEmail: textOrNull(row.actor_email),
    referenceNumber: textOrNull(row.reference_number),
    referenceType: textOrNull(row.reference_type),
    createdAt: String(row.created_at),
    acceptedAt: textOrNull(row.accepted_at),
    succeededAt: textOrNull(row.succeeded_at),
    failedAt: textOrNull(row.failed_at),
    erroredAt: textOrNull(row.errored_at),
    lines: fromDbLines(row.lines),
  }));
}

/** 見回りが Stripe で確かめる、olderThan より前から返事待ちの返金（古い順）。limit は DB が 1〜200 に丸める */
export async function listAwaitingOrderRefunds(
  store: RefundStore,
  olderThan: Date,
  limit: number,
): Promise<Array<{ refundId: string; orderId: string; paymentIntentId: string | null; createdAt: string }>> {
  const data = await callRpc(store, 'list_awaiting_order_refunds', { _older_than: olderThan.toISOString(), _limit: limit });
  return listRowsOf(data, 'list_awaiting_order_refunds').map((row) => ({
    refundId: String(row.refund_id),
    orderId: String(row.order_id),
    paymentIntentId: textOrNull(row.payment_intent_id),
    createdAt: String(row.created_at),
  }));
}

/** 保留の返金がある注文の支払いの番号（重複なし）。毎晩の照合が合わせる。limit は DB が 1〜500 に丸める */
export async function listPendingRefundPaymentIntents(store: RefundStore, limit: number): Promise<string[]> {
  const data = await callRpc(store, 'list_pending_refund_payment_intents', { _limit: limit });
  return listRowsOf(data, 'list_pending_refund_payment_intents').map((row) => String(row.payment_intent_id));
}

export type OrderRefundSummary = {
  orderId: string;
  paidAmount: number | null;
  succeededAmount: number;
  openAmount: number;
  refundableAmount: number;
  hasOpenRefund: boolean;
  hasUnresolvedRefundFailure: boolean;
};

// DB の関数 list_order_refund_summaries が一度に受ける注文の数の上限
const SUMMARY_CHUNK_SIZE = 200;

/** DB が行を返さなかった注文の要約。受け取った額は無く、返金の手続きも失敗も無い */
function emptySummary(orderId: string): OrderRefundSummary {
  return {
    orderId,
    paidAmount: null,
    succeededAmount: 0,
    openAmount: 0,
    refundableAmount: 0,
    hasOpenRefund: false,
    hasUnresolvedRefundFailure: false,
  };
}

/**
 * 注文ごとの返金の要約（一覧の支払いの列・返金とキャンセルのボタンの判定に使う）。渡した番号は全部キーに入る
 * （渡した文字のまま。DB が行を返さなかった注文は空の要約）。空なら DB を呼ばない。
 * DB の関数が受ける上限に合わせて、200件ずつに分けて呼ぶ。
 */
export async function listOrderRefundSummaries(
  store: RefundStore,
  orderIds: readonly string[],
): Promise<Map<string, OrderRefundSummary>> {
  // DB は uuid を小文字で返す。窓口の uuid 検証は大文字も通すので、小文字にそろえて引かないと行が合わず捨てられる
  const ids = [...new Set(orderIds.map((id) => id.toLowerCase()))];
  const summaryById = new Map<string, OrderRefundSummary>();

  for (let start = 0; start < ids.length; start += SUMMARY_CHUNK_SIZE) {
    const data = await callRpc(store, 'list_order_refund_summaries', {
      _order_ids: ids.slice(start, start + SUMMARY_CHUNK_SIZE),
    });
    for (const row of listRowsOf(data, 'list_order_refund_summaries')) {
      const orderId = String(row.order_id).toLowerCase();
      summaryById.set(orderId, {
        orderId,
        paidAmount: typeof row.paid_amount === 'number' ? row.paid_amount : null,
        succeededAmount: Number(row.succeeded_amount),
        openAmount: Number(row.open_amount),
        refundableAmount: Number(row.refundable_amount),
        hasOpenRefund: row.has_open_refund === true,
        hasUnresolvedRefundFailure: row.has_unresolved_refund_failure === true,
      });
    }
  }
  return new Map(
    [...new Set(orderIds)].map((id): [string, OrderRefundSummary] => [
      id,
      summaryById.get(id.toLowerCase()) ?? emptySummary(id.toLowerCase()),
    ]),
  );
}

export type ShopSettingsRow = ShopSettings & { refundLedgerStartedAt: string };

function toggleOf(enabled: unknown, updatedAt: unknown, updatedByEmail: unknown): ShopSettingToggle {
  return { enabled: enabled === true, updatedAt: textOrNull(updatedAt), updatedByEmail: textOrNull(updatedByEmail) };
}

function toShopSettings(row: Record<string, unknown>): ShopSettingsRow {
  return {
    autoRefundCancelledOrderPayment: toggleOf(
      row.auto_refund_cancelled_order_payment,
      row.auto_refund_cancelled_order_payment_updated_at,
      row.auto_refund_cancelled_order_payment_updated_by_email,
    ),
    autoCancelAmountMismatch: toggleOf(
      row.auto_cancel_amount_mismatch,
      row.auto_cancel_amount_mismatch_updated_at,
      row.auto_cancel_amount_mismatch_updated_by_email,
    ),
    refundLedgerStartedAt: String(row.refund_ledger_started_at),
  };
}

/** ショップの設定（1行だけ）。最後に変えた人のメールを含むので、管理画面の窓口だけが使う */
export async function getShopSettings(store: RefundStore): Promise<ShopSettingsRow> {
  const row = rowsOf(await callRpc(store, 'get_shop_settings', {}))[0];
  if (!row) {
    throw new RefundStoreError('get_shop_settings', null);
  }
  return toShopSettings(row);
}

/** ショップの設定を変える。変わったトグルだけ、その更新者と時刻が書き換わる。変えた後の設定を返す */
export async function updateShopSettings(
  store: RefundStore,
  input: UpdateShopSettingsRequest & { actorId: string },
): Promise<ShopSettingsRow> {
  const row = rowsOf(
    await callRpc(store, 'admin_update_shop_settings', {
      _auto_refund_cancelled_order_payment: input.autoRefundCancelledOrderPayment,
      _auto_cancel_amount_mismatch: input.autoCancelAmountMismatch,
      _actor_id: input.actorId,
    }),
  )[0];
  if (!row) {
    throw new RefundStoreError('admin_update_shop_settings', null);
  }
  return toShopSettings(row);
}

/**
 * 要対応を「システムが自動で解決した」と閉じる（解決した人は空）。閉じたら true、もう閉じていれば false。
 * boolean を返す関数なので、PostgREST の答えは行の配列ではなく true か false そのもの
 */
export async function resolvePaymentExceptionBySystem(
  store: RefundStore,
  exceptionId: string,
  note: string,
): Promise<boolean> {
  const data = await callRpc(store, 'resolve_payment_exception_by_system', { _exception_id: exceptionId, _note: note });
  return data === true;
}
