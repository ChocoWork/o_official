import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type {
  CancelCompletionResponse,
  CancelFulfillmentResponse,
  CreateFulfillmentResponse,
  FulfillmentErrorCode,
  FulfillmentLineQuantity,
  RecordCompletionResponse,
} from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 発送と仕上がりの DB の関数を呼ぶ（グループ E-1 設計書 3〜7 章）。3つの表は service_role からも書けず、関数だけが書く。
 * 関数は断る理由を決まった言葉で止める。ここで誤りの記号（FulfillmentErrorCode）に直し、窓口が HTTP と画面の言葉にする。
 * DB の文には宛先などが混ざりうるので、ログに出さない（FulfillmentStoreError は呼び出しの名前と DB の記号だけを見せる）。
 */
export type FulfillmentStore = Pick<SupabaseClient, 'rpc'>;

type QueryError = { message?: string; code?: string } | null;

/** DB の関数が決まった言葉で断った。記号から HTTP と画面の言葉が決まる */
export class FulfillmentOperationError extends Error {
  constructor(readonly code: FulfillmentErrorCode) {
    super(`fulfillment operation refused: ${code}`);
    this.name = 'FulfillmentOperationError';
  }
}

/** DB の呼び出しが思いがけず失敗した。DB の文は cause にだけ残す */
export class FulfillmentStoreError extends Error {
  readonly code: string | null;

  constructor(
    readonly operation: string,
    cause: QueryError = null,
  ) {
    super(`fulfillment store failed: ${operation}`, { cause });
    this.name = 'FulfillmentStoreError';
    this.code = cause?.code ?? null;
  }
}

// DB の関数が RAISE EXCEPTION で止める言葉 → 誤りの記号（共通の約束 C-2）。言葉は移行の本文と同じ綴り
const DB_ERROR_WORDS: ReadonlyArray<readonly [string, FulfillmentErrorCode]> = [
  ['ORDER_NOT_FOUND', 'order_not_found'],
  ['ORDER_NOT_SHIPPABLE', 'not_shippable'],
  ['SHIPPING_ADDRESS_INCOMPLETE', 'address_incomplete'],
  ['PAYMENT_REVIEW_REQUIRED', 'payment_review_required'],
  ['LINE_NOT_IN_ORDER', 'quantity_exceeds_ready'],
  ['QUANTITY_EXCEEDS_READY', 'quantity_exceeds_ready'],
  ['FULFILLMENT_REQUEST_MISMATCH', 'fulfillment_request_mismatch'],
  ['FULFILLMENT_ARGUMENT_INVALID', 'invalid_argument'],
  ['COMPLETION_ARGUMENT_INVALID', 'invalid_argument'],
  ['FULFILLMENT_NOT_FOUND', 'fulfillment_not_found'],
  ['FULFILLMENT_CANCEL_NOT_ALLOWED', 'fulfillment_cancel_not_allowed'],
  ['ORDER_NOT_IN_PRODUCTION', 'not_in_production'],
  ['LINE_NOT_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['QUANTITY_EXCEEDS_IN_PRODUCTION', 'quantity_exceeds_in_production'],
  ['COMPLETION_REQUEST_MISMATCH', 'completion_request_mismatch'],
  ['COMPLETION_NOT_FOUND', 'completion_not_found'],
  ['COMPLETION_ALREADY_SHIPPED', 'completion_already_shipped'],
];

/** DB の誤りの文に表の言葉が含まれていれば、その記号。無ければ null */
export function toFulfillmentErrorCode(message: string | undefined): FulfillmentErrorCode | null {
  if (!message) {
    return null;
  }
  return DB_ERROR_WORDS.find(([word]) => message.includes(word))?.[1] ?? null;
}

type FulfillmentRpcName =
  | 'admin_create_fulfillment'
  | 'admin_cancel_fulfillment'
  | 'admin_record_completion'
  | 'admin_cancel_completion'
  | 'list_order_fulfillments'
  | 'list_order_completions'
  | 'list_order_line_fulfillment';

async function callRpc(store: FulfillmentStore, name: FulfillmentRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, args);
  if (error) {
    const code = toFulfillmentErrorCode(error.message);
    throw code ? new FulfillmentOperationError(code) : new FulfillmentStoreError(name, error);
  }
  return data;
}

/** PostgREST は表を返す関数の答えを配列で返す。行が1つのオブジェクトで来ても読めるようにする */
function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function outcomeOf(value: unknown): 'cancelled' | 'already_cancelled' | null {
  return value === 'cancelled' || value === 'already_cancelled' ? value : null;
}

/** DB の関数の引数 _lines の形 */
function toDbLines(lines: readonly FulfillmentLineQuantity[]): Array<{ order_item_id: string; quantity: number }> {
  return lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity }));
}

/** list_order_fulfillments の lines（jsonb の配列。商品の行が無ければ null になりうる）を窓口の形に直す */
function fromDbLines(value: unknown): FulfillmentLineQuantity[] {
  if (!Array.isArray(value)) return [];
  return value.map((line: { order_item_id: unknown; quantity: unknown }) => ({
    orderItemId: String(line.order_item_id),
    quantity: Number(line.quantity),
  }));
}

export type OrderLineFulfillmentRow = {
  orderId: string;
  orderItemId: string;
  variantId: number | null;
  fulfillmentType: string;
  quantity: number;
  shipped: number;
  completed: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

// DB の関数 list_order_line_fulfillment が一度に受ける注文の数の上限
const LINE_FULFILLMENT_CHUNK_SIZE = 200;

// PostgREST が1回の答えで返す行の上限。値は supabase/config.toml の max_rows と本番の既定（どちらも 1000）に合わせる。
// 上限に届いた答えは切れている恐れがあり、切れたまま数えると注文の言葉を誤る（残りがあるのに「配送中」と出る、など）ので、数えずに止める
const POSTGREST_MAX_ROWS = 1000;

/**
 * 注文ごとの商品の数（発送した・仕上がった・受注生産中・発送準備中・未発送）。数え方は DB の1か所にあるので、
 * 窓口と画面は必ずこの答えを使う。渡した注文の番号は全部キーに入る（渡した文字のまま。商品の行が無ければ空の配列）。
 * 空なら DB を呼ばない。DB の関数が受ける上限に合わせて、200件ずつに分けて呼ぶ。
 * 1回の答えが PostgREST の行の上限に届いたら、切れている恐れがあるので FulfillmentStoreError で止める。
 */
export async function listOrderLineFulfillment(
  store: FulfillmentStore,
  orderIds: readonly string[],
): Promise<Map<string, OrderLineFulfillmentRow[]>> {
  // DB は uuid を小文字で返す。窓口の uuid 検証は大文字も通すので、小文字にそろえて引かないと行が合わず捨てられる
  const ids = [...new Set(orderIds.map((id) => id.toLowerCase()))];
  const rowsById = new Map<string, OrderLineFulfillmentRow[]>(ids.map((id): [string, OrderLineFulfillmentRow[]] => [id, []]));

  for (let start = 0; start < ids.length; start += LINE_FULFILLMENT_CHUNK_SIZE) {
    const data = await callRpc(store, 'list_order_line_fulfillment', {
      _order_ids: ids.slice(start, start + LINE_FULFILLMENT_CHUNK_SIZE),
    });
    const rows = rowsOf(data);
    if (rows.length >= POSTGREST_MAX_ROWS) {
      throw new FulfillmentStoreError('list_order_line_fulfillment');
    }
    for (const row of rows) {
      const orderId = String(row.order_id).toLowerCase();
      rowsById.get(orderId)?.push({
        orderId,
        orderItemId: String(row.order_item_id),
        variantId: typeof row.variant_id === 'number' ? row.variant_id : null,
        fulfillmentType: String(row.fulfillment_type),
        quantity: Number(row.quantity),
        shipped: Number(row.shipped),
        completed: Number(row.completed),
        inProduction: Number(row.in_production),
        readyUnshipped: Number(row.ready_unshipped),
        unshipped: Number(row.unshipped),
      });
    }
  }
  return new Map(
    [...new Set(orderIds)].map((id): [string, OrderLineFulfillmentRow[]] => [id, rowsById.get(id.toLowerCase()) ?? []]),
  );
}

/** 発送を1回記録する。同じ requestKey の送り直しは前の結果を返す（replayed）。断りは FulfillmentOperationError */
export async function createFulfillment(
  store: FulfillmentStore,
  input: {
    orderId: string;
    actorId: string;
    requestKey: string;
    carrier: ShippingCarrierId;
    trackingNumber: string;
    notifyCustomer: boolean;
    lines: FulfillmentLineQuantity[];
  },
): Promise<CreateFulfillmentResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_create_fulfillment', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _shipping_carrier: input.carrier,
      _tracking_number: input.trackingNumber,
      _notify_customer: input.notifyCustomer,
      _lines: toDbLines(input.lines),
    }),
  )[0];
  if (!row) {
    throw new FulfillmentStoreError('admin_create_fulfillment', null);
  }
  return {
    fulfillmentId: String(row.fulfillment_id),
    number: Number(row.number),
    completesOrder: row.completes_order === true,
    orderStatus: row.order_status as OrderStatus,
    replayed: row.replayed === true,
  };
}

/** 発送を取り消す。もう取り消してあれば already_cancelled（何度押しても同じ結果） */
export async function cancelFulfillment(
  store: FulfillmentStore,
  input: { orderId: string; fulfillmentId: string; actorId: string },
): Promise<CancelFulfillmentResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_cancel_fulfillment', {
      _order_id: input.orderId,
      _fulfillment_id: input.fulfillmentId,
      _actor_id: input.actorId,
    }),
  )[0];
  const outcome = outcomeOf(row?.outcome);
  if (!outcome) {
    throw new FulfillmentStoreError('admin_cancel_fulfillment', null);
  }
  return { outcome, orderStatus: row.order_status as OrderStatus };
}

/** 受注生産の品の仕上がりを記録する。1回の操作で複数の商品を記録でき、行ごとに番号が付く */
export async function recordCompletion(
  store: FulfillmentStore,
  input: { orderId: string; actorId: string; requestKey: string; lines: FulfillmentLineQuantity[] },
): Promise<RecordCompletionResponse> {
  const rows = rowsOf(
    await callRpc(store, 'admin_record_completion', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _lines: toDbLines(input.lines),
    }),
  );
  if (rows.length === 0) {
    throw new FulfillmentStoreError('admin_record_completion', null);
  }
  return {
    completionIds: rows.map((row) => String(row.completion_id)),
    replayed: rows.every((row) => row.replayed === true),
  };
}

/** 仕上がりを取り消す。送った数を下回る取消は DB が断る（completion_already_shipped） */
export async function cancelCompletion(
  store: FulfillmentStore,
  input: { orderId: string; completionId: string; actorId: string },
): Promise<CancelCompletionResponse> {
  const row = rowsOf(
    await callRpc(store, 'admin_cancel_completion', {
      _order_id: input.orderId,
      _completion_id: input.completionId,
      _actor_id: input.actorId,
    }),
  )[0];
  const outcome = outcomeOf(row?.outcome);
  if (!outcome) {
    throw new FulfillmentStoreError('admin_cancel_completion', null);
  }
  return { outcome };
}

export type OrderFulfillmentHistoryRow = {
  fulfillmentId: string;
  number: number;
  shippingCarrier: string | null;
  trackingNumber: string | null;
  notifyCustomer: boolean;
  completesOrder: boolean;
  shippedAt: string;
  createdByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  legacy: boolean;
  lines: FulfillmentLineQuantity[];
};

/**
 * 注文の発送の一覧（取り消した分も含む。何回目の新しい順）。操作した人のメールを含むので、答えをそのまま返さない。
 * 管理画面の窓口のほか、お客様の窓口（src/app/api/orders/[id]/route.ts）も使う。お客様の答えに管理者のメールが出ないのは、
 * 呼ぶ側の toShipments が項目を名指しで選ぶから。新しく呼ぶ所も、項目を名指しで選んでから返すこと。
 */
export async function listOrderFulfillments(store: FulfillmentStore, orderId: string): Promise<OrderFulfillmentHistoryRow[]> {
  const data = await callRpc(store, 'list_order_fulfillments', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    fulfillmentId: String(row.fulfillment_id),
    number: Number(row.number),
    shippingCarrier: textOrNull(row.shipping_carrier),
    trackingNumber: textOrNull(row.tracking_number),
    notifyCustomer: row.notify_customer === true,
    completesOrder: row.completes_order === true,
    shippedAt: String(row.shipped_at),
    createdByEmail: textOrNull(row.created_by_email),
    cancelledAt: textOrNull(row.cancelled_at),
    cancelledByEmail: textOrNull(row.cancelled_by_email),
    legacy: row.legacy === true,
    lines: fromDbLines(row.lines),
  }));
}

export type OrderCompletionHistoryRow = {
  completionId: string;
  orderItemId: string;
  quantity: number;
  createdAt: string;
  createdByEmail: string | null;
  cancelledAt: string | null;
  cancelledByEmail: string | null;
  legacy: boolean;
};

/** 注文の仕上がりの一覧（取り消した分も含む。新しい順） */
export async function listOrderCompletions(store: FulfillmentStore, orderId: string): Promise<OrderCompletionHistoryRow[]> {
  const data = await callRpc(store, 'list_order_completions', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    completionId: String(row.completion_id),
    orderItemId: String(row.order_item_id),
    quantity: Number(row.quantity),
    createdAt: String(row.created_at),
    createdByEmail: textOrNull(row.created_by_email),
    cancelledAt: textOrNull(row.cancelled_at),
    cancelledByEmail: textOrNull(row.cancelled_by_email),
    legacy: row.legacy === true,
  }));
}
