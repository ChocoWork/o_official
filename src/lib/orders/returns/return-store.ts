import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { RefundStoreError, toRefundErrorCode } from '@/lib/orders/refund/refund-store';
import type { OrderRefundStatus, RefundErrorCode } from '@/lib/orders/refund/refund-types';
import { formatReturnNumber } from '@/lib/orders/returns/return-messages';
import {
  RETURN_DECLINE_REASONS,
  RETURN_DISPLAY_STATUSES,
  RETURN_ERROR_CODES,
  RETURN_MARKS,
  RETURN_NEXT_ACTIONS,
  type ApproveReturnInput,
  type ExchangeMethod,
  type OrderReturnDetail,
  type OrderReturnLineDetail,
  type OrderReturnSummary,
  type OutOfStockExchange,
  type ReceiptDisposition,
  type RefundChoice,
  type ReturnCarrier,
  type ReturnCreateMaterials,
  type ReturnDeclineReason,
  type ReturnDisplayStatus,
  type ReturnErrorCode,
  type ReturnMark,
  type ReturnMethod,
  type ReturnNextAction,
  type ReturnPhotoRef,
  type ReturnReason,
  type ReturnResolution,
  type ReturnStatus,
  type ShippingPayer,
  type ShopReturnSettings,
} from '@/lib/orders/returns/return-types';

/**
 * 返品の DB の関数を呼ぶ（グループ E-3 設計書 4〜7・11 章）。返品の4つの表は service_role からも書けず、関数だけが書く。
 * 関数は断る理由を決まった言葉で止める。ここで誤りの記号に直し（ReturnStoreError）、窓口が HTTP と画面の言葉にする。
 * 受け取り・返金の中で E-2 の返金が断った言葉（AWAITING_REFUND_EXISTS など）は、E-2 の記号（RefundErrorCode）のまま渡す。
 * 思いがけない失敗（記号の無い DB の誤り）は、E-2 の RefundStoreError で止める（DB の文には宛先などが混ざりうるので、
 * 呼び出しの名前と DB の記号だけを見せ、文は cause にだけ残す）。
 * DB の関数の jsonb は snake_case。camelCase への直しはこのファイルだけが行う（共通の約束 C-2）。
 * サーバーだけで使う（画面から読まない）。単体テストと DB 結合テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export type ReturnStore = Pick<SupabaseClient, 'rpc'>;

/** DB の関数が決まった言葉で断った。記号（返品の記号か、E-2 の返金の記号）から HTTP と画面の言葉が決まる */
export class ReturnStoreError extends Error {
  constructor(readonly code: ReturnErrorCode | RefundErrorCode) {
    super(`return store refused: ${code}`);
    this.name = 'ReturnStoreError';
  }
}

// DB の関数が RAISE EXCEPTION で止める返品の言葉 → 誤りの記号。C-4 の29個（段1の18個と段2の11個）は言葉と記号が同じ綴り。
// TOO_MANY_ORDERS（注文の番号を200件より多く渡した時の一覧の関数 list_order_line_return_counts・list_order_return_summaries）は、
// C-4 にも E-2 の言葉の表にも無いので RETURN_ARGUMENT_INVALID にする（store は200件ずつに分けて呼ぶので、ふつうは来ない）。
// 長い言葉から先に照らす（ある言葉が別の言葉の一部になる綴りが足されても、長い方が先に当たるようにする。E-2 の本計画 P3 と同じ）
const RETURN_DB_WORDS: Array<readonly [string, ReturnErrorCode]> = [
  ...RETURN_ERROR_CODES.map((code): readonly [string, ReturnErrorCode] => [code, code]),
  ['TOO_MANY_ORDERS', 'RETURN_ARGUMENT_INVALID'],
];
RETURN_DB_WORDS.sort((a, b) => b[0].length - a[0].length);

/**
 * DB の誤りの文に返品の言葉が含まれていれば、その記号。無ければ E-2 の言葉の表（toRefundErrorCode）で照らす
 * （ORDER_NOT_FOUND は order_not_found、SETTINGS_ARGUMENT_INVALID は invalid_argument の E-2 の記号のまま渡る）。どちらにも無ければ null。
 * 返品の言葉を先に照らすのは、受け取りの関数が返品の言葉と返金の言葉のどちらでも断りうるため
 */
export function toReturnErrorCode(message: string | undefined): ReturnErrorCode | RefundErrorCode | null {
  if (!message) {
    return null;
  }
  return RETURN_DB_WORDS.find(([word]) => message.includes(word))?.[1] ?? toRefundErrorCode(message);
}

export type ReturnRpcName =
  | 'admin_create_return'
  | 'admin_receive_return'
  | 'admin_refund_return'
  | 'admin_cancel_return'
  | 'admin_close_return_missing'
  | 'admin_reopen_return'
  | 'admin_inspect_return'
  | 'admin_record_return_fee_payment'
  | 'admin_release_return_exchange'
  | 'get_order_return_materials'
  | 'list_order_returns'
  | 'list_order_return_summaries'
  | 'count_order_return_attention'
  | 'get_shop_return_settings'
  | 'admin_update_shop_return_settings'
  | 'admin_approve_return'
  | 'admin_decline_return'
  | 'list_return_photos'
  | 'list_order_cancel_requests'
  | 'admin_decline_cancel_request'
  | 'admin_close_cancel_request'
  | 'admin_resolve_cancel_request'
  | 'get_customer_return_request_materials'
  | 'customer_create_return_photo_upload'
  | 'customer_request_return'
  | 'customer_request_cancel'
  | 'get_customer_order_returns';

/**
 * DB の関数を呼ぶ入口（断りは ReturnStoreError、思いがけない失敗は RefundStoreError）。
 * 同じ ReturnStore を使う兄弟のファイル（cancel-request-store.ts・customer-return-store.ts）も、この入口と下の読み取りの道具を使う
 */
export async function callRpc(store: ReturnStore, name: ReturnRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, args);
  if (error) {
    const code = toReturnErrorCode(error.message);
    throw code ? new ReturnStoreError(code) : new RefundStoreError(name, error);
  }
  return data;
}

export type JsonObject = Record<string, unknown>;

/** PostgREST は表を返す関数の答えを配列で返す。行が1つのオブジェクトで来ても読めるようにする */
function rowsOf(data: unknown): JsonObject[] {
  if (Array.isArray(data)) return data as JsonObject[];
  return data && typeof data === 'object' ? [data as JsonObject] : [];
}

/** 1行を返すはずの関数の答えの行。行が無ければ RefundStoreError */
export function firstRowOf(data: unknown, operation: ReturnRpcName): JsonObject {
  const row = rowsOf(data)[0];
  if (!row) {
    throw new RefundStoreError(operation, null);
  }
  return row;
}

// PostgREST が1回の答えで返す行の上限。値は supabase/config.toml の max_rows と本番の既定（どちらも 1000）に合わせる
// （refund-store.ts・fulfillment-store.ts と同じ値）。上限に届いた答えは切れている恐れがあり、切れたまま使うと一覧や判定を誤るので、使わずに止める
const POSTGREST_MAX_ROWS = 1000;

/** 一覧を返す関数の答えの行。上限に届いていたら RefundStoreError で止める */
function listRowsOf(data: unknown, operation: ReturnRpcName): JsonObject[] {
  const rows = rowsOf(data);
  if (rows.length >= POSTGREST_MAX_ROWS) {
    throw new RefundStoreError(operation);
  }
  return rows;
}

// DB の関数 list_order_return_summaries が一度に受ける注文の数の上限
const ORDER_IDS_CHUNK_SIZE = 200;

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** jsonb の値（オブジェクト）。配列に包まれて来ても読める。オブジェクトでなければ null */
export function jsonObjectOf(data: unknown): JsonObject | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function objectOf(value: unknown): JsonObject {
  return jsonObjectOf(value) ?? {};
}

export function objectsOf(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonObject => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** 解決の方法の記号。表に無い記号は null（お客様のご希望は、お店が作った行には無い） */
export function resolutionOrNull(value: unknown): ReturnResolution | null {
  return value === 'refund' || value === 'exchange' ? value : null;
}

/** お断りの理由の記号。表に無い記号は null（画面が言葉の表を引いて undefined にならないように） */
export function declineReasonOf(value: unknown): ReturnDeclineReason | null {
  return (RETURN_DECLINE_REASONS as readonly unknown[]).includes(value) ? (value as ReturnDeclineReason) : null;
}

/**
 * 表の値でなければ、思いがけない失敗（RefundStoreError）にする。DB の CHECK が守る値で、型に null の逃げが無い欄に使う
 * （黙って別の値にすると、画面が違う状態を見せてしまう）
 */
export function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], operation: ReturnRpcName): T {
  if ((allowed as readonly unknown[]).includes(value)) {
    return value as T;
  }
  throw new RefundStoreError(operation, null);
}

// ---- 操作（作る・受け取り・返金・取消・開き直し・届かない・検品・手数料・支払いを待たずに送る） ----

export type CreateReturnLineInput = {
  fulfillmentId: string;
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  reasonNote: string | null;
  resolution: ReturnResolution;
  /** 交換の時だけ（返金の行は null） */
  exchangeVariantId: number | null;
  exchangeMethod: ExchangeMethod | null;
};

export type CreateReturnInput = {
  orderId: string;
  actorId: string;
  requestKey: string;
  lines: CreateReturnLineInput[];
  returnMethod: ReturnMethod;
  returnShippingPayer: ShippingPayer;
  returnCarrier: ReturnCarrier | null;
  returnTrackingNumber: string | null;
  /** 手数料は、null ならショップの設定の値（設定で使わない手数料は 0）を DB が入れる */
  returnShippingFee: number | null;
  restockingFeePercent: number | null;
  exchangeFee: number | null;
  exchangeShippingFee: number | null;
  shopNote: string | null;
  notifyCustomer: boolean;
};

export type CreatedReturn = { returnId: string; number: number; status: ReturnStatus; replayed: boolean };

/** 返品を作る（お店が作る返品）。同じ requestKey の送り直しは前の結果を返す（replayed）。断りは ReturnStoreError */
export async function createReturn(store: ReturnStore, input: CreateReturnInput): Promise<CreatedReturn> {
  const row = firstRowOf(
    await callRpc(store, 'admin_create_return', {
      _order_id: input.orderId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _lines: input.lines.map((line) => ({
        fulfillment_id: line.fulfillmentId,
        order_item_id: line.orderItemId,
        quantity: line.quantity,
        reason: line.reason,
        reason_note: line.reasonNote,
        resolution: line.resolution,
        exchange_variant_id: line.exchangeVariantId,
        exchange_method: line.exchangeMethod,
      })),
      _return_method: input.returnMethod,
      _return_shipping_payer: input.returnShippingPayer,
      _return_carrier: input.returnCarrier,
      _return_tracking_number: input.returnTrackingNumber,
      _return_shipping_fee: input.returnShippingFee,
      _restocking_fee_percent: input.restockingFeePercent,
      _exchange_fee: input.exchangeFee,
      _exchange_shipping_fee: input.exchangeShippingFee,
      _shop_note: input.shopNote,
      _notify_customer: input.notifyCustomer,
    }),
    'admin_create_return',
  );
  return {
    returnId: String(row.return_id),
    number: Number(row.number),
    status: row.status as ReturnStatus,
    replayed: row.replayed === true,
  };
}

export type ReceiveUnitInput = { returnLineId: string; disposition: ReceiptDisposition; quantity: number };
/** 在庫不足の交換の行に、店長が選ぶ扱い。decline の理由の行は作って送る・返金に変える、make の理由の行は返金に変えるだけ（C-1） */
export type ExchangeOverrideInput = { returnLineId: string; action: 'make' | 'refund' };

export type ReceiveReturnInput = {
  returnId: string;
  actorId: string;
  /** 窓口が権限（admin.orders.refund）から決める。偽（サポート）の今返金は、DB がお客様の申し込みの返品（返送不要でない）だけに許す（P9）。額・送料・交換の選び直しは偽なら窓口も DB も断る */
  actorCanRefund: boolean;
  requestKey: string;
  units: ReceiveUnitInput[];
  exchangeOverrides: ExchangeOverrideInput[];
  refundChoice: RefundChoice;
  /** null は計算どおり。店長だけが直せる */
  refundAmount: number | null;
  refundShippingAmount: number;
  note: string | null;
  notifyCustomer: boolean;
  sentBackMessage: string | null;
  sentBackCarrier: ReturnCarrier | null;
  sentBackTrackingNumber: string | null;
};

export type ReceivedReturn = {
  receiptId: string;
  returnStatus: ReturnStatus;
  /** この受け取りで始めた返金。返金が無い受け取り（相談・返金の品なし）と、返金しないで終えた受け取り（waived）は null */
  refundId: string | null;
  refundAmount: number | null;
  /** 返金の記録の状態。返金額が0円になった受け取り（P20）は waived、返金が無い受け取りは null */
  refundStatus: OrderRefundStatus | 'waived' | null;
  /** 足した交換の品の行 */
  exchangeOrderItemIds: string[];
  feeDueAmount: number;
  shopNoticeEnqueued: boolean;
  replayed: boolean;
};

/**
 * 受け取りを記録する（今返金なら E-2 の返金の記録も「返事待ち」で作る。Stripe に頼むのは呼ぶ側）。
 * 返金額が0円になる受け取り（手数料が商品の額以上など。P20）は、返金の記録を作らず refundId が null・refundStatus が waived で返る
 * （Stripe に頼まない）。同じ requestKey の送り直しは前の受け取りと返金の記録を返す（replayed。Review Focus 1）。
 * 断りは ReturnStoreError（返品の記号か、E-2 の返金が断った記号）
 */
export async function receiveReturn(store: ReturnStore, input: ReceiveReturnInput): Promise<ReceivedReturn> {
  const row = firstRowOf(
    await callRpc(store, 'admin_receive_return', {
      _return_id: input.returnId,
      _actor_id: input.actorId,
      _actor_can_refund: input.actorCanRefund,
      _request_key: input.requestKey,
      _units: input.units.map((unit) => ({
        return_line_id: unit.returnLineId,
        disposition: unit.disposition,
        quantity: unit.quantity,
      })),
      _exchange_overrides: input.exchangeOverrides.map((override) => ({
        return_line_id: override.returnLineId,
        action: override.action,
      })),
      _refund_choice: input.refundChoice,
      _refund_amount: input.refundAmount,
      _refund_shipping_amount: input.refundShippingAmount,
      _note: input.note,
      _notify_customer: input.notifyCustomer,
      _sent_back_message: input.sentBackMessage,
      _sent_back_carrier: input.sentBackCarrier,
      _sent_back_tracking_number: input.sentBackTrackingNumber,
    }),
    'admin_receive_return',
  );
  return {
    receiptId: String(row.receipt_id),
    returnStatus: row.return_status as ReturnStatus,
    refundId: textOrNull(row.refund_id),
    refundAmount: numberOrNull(row.refund_amount),
    refundStatus: textOrNull(row.refund_status) as OrderRefundStatus | 'waived' | null,
    exchangeOrderItemIds: stringsOf(row.exchange_order_item_ids),
    feeDueAmount: Number(row.fee_due_amount),
    shopNoticeEnqueued: row.shop_notice_enqueued === true,
    replayed: row.replayed === true,
  };
}

export type RefundReturnInput = {
  returnId: string;
  actorId: string;
  requestKey: string;
  /** null は計算どおり。0 は返金しないで終える（P20） */
  amount: number | null;
  shippingAmount: number;
  note: string | null;
  notifyCustomer: boolean;
};

/** 返金しないで終えた時（amount を 0 にして渡した時。P20）は、返金の記録が無いので refundId が null、status が waived */
export type RefundedReturn = {
  refundId: string | null;
  amount: number;
  status: OrderRefundStatus | 'waived';
  replayed: boolean;
};

/**
 * 額を決めて返金する（受け取った返金の品のうち、まだ返金していない物）。返金は「返事待ち」で記録される（Stripe に頼むのは呼ぶ側）。
 * amount を 0 にすると返金しないで終える: 返金の記録を作らず、Stripe にも頼まない（refundId が null・status が waived。P20）
 */
export async function refundReturn(store: ReturnStore, input: RefundReturnInput): Promise<RefundedReturn> {
  const row = firstRowOf(
    await callRpc(store, 'admin_refund_return', {
      _return_id: input.returnId,
      _actor_id: input.actorId,
      _request_key: input.requestKey,
      _amount: input.amount,
      _shipping_amount: input.shippingAmount,
      _note: input.note,
      _notify_customer: input.notifyCustomer,
    }),
    'admin_refund_return',
  );
  return {
    refundId: textOrNull(row.refund_id),
    amount: Number(row.amount),
    status: row.status as OrderRefundStatus | 'waived',
    replayed: row.replayed === true,
  };
}

export type CancelledReturn = { returnId: string; status: ReturnStatus };

/** 返品を取り消す（何も処理していない受付中の返品だけ。メールは送らない） */
export async function cancelReturn(
  store: ReturnStore,
  input: { returnId: string; actorId: string },
): Promise<CancelledReturn> {
  const row = firstRowOf(
    await callRpc(store, 'admin_cancel_return', { _return_id: input.returnId, _actor_id: input.actorId }),
    'admin_cancel_return',
  );
  return { returnId: String(row.return_id), status: row.status as ReturnStatus };
}

/** 受け取りの記録を1つ書く操作（届かないで終える・開き直し・検品）の答え */
export type ReturnReceiptResult = { receiptId: string; returnStatus: ReturnStatus; replayed: boolean };

function toReceiptResult(row: JsonObject): ReturnReceiptResult {
  return {
    receiptId: String(row.receipt_id),
    returnStatus: row.return_status as ReturnStatus,
    replayed: row.replayed === true,
  };
}

/** 未処理の残りを「届かない」として返品を終える。同じ requestKey の送り直しは前の結果を返す */
export async function closeReturnMissing(
  store: ReturnStore,
  input: { returnId: string; actorId: string; requestKey: string },
): Promise<ReturnReceiptResult> {
  return toReceiptResult(
    firstRowOf(
      await callRpc(store, 'admin_close_return_missing', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _request_key: input.requestKey,
      }),
      'admin_close_return_missing',
    ),
  );
}

/** 閉じた返品を開き直す（「届かない」で終えた品がある時だけ） */
export async function reopenReturn(
  store: ReturnStore,
  input: { returnId: string; actorId: string; requestKey: string },
): Promise<ReturnReceiptResult> {
  return toReceiptResult(
    firstRowOf(
      await callRpc(store, 'admin_reopen_return', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _request_key: input.requestKey,
      }),
      'admin_reopen_return',
    ),
  );
}

export type InspectLineInput = { returnLineId: string; restocked: number; notRestocked: number };

/** 検品待ちの品を、在庫に戻す／戻さないに決める */
export async function inspectReturn(
  store: ReturnStore,
  input: { returnId: string; actorId: string; requestKey: string; lines: InspectLineInput[] },
): Promise<ReturnReceiptResult> {
  return toReceiptResult(
    firstRowOf(
      await callRpc(store, 'admin_inspect_return', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _request_key: input.requestKey,
        _lines: input.lines.map((line) => ({
          return_line_id: line.returnLineId,
          restocked: line.restocked,
          not_restocked: line.notRestocked,
        })),
      }),
      'admin_inspect_return',
    ),
  );
}

/** 手数料の記録と支払いを待たずに送る操作の答え */
export type ReturnStatusResult = { returnId: string; returnStatus: ReturnStatus };

function toStatusResult(row: JsonObject): ReturnStatusResult {
  return { returnId: String(row.return_id), returnStatus: row.return_status as ReturnStatus };
}

/**
 * 手数料の受け取りを記録する（店長だけ。窓口が権限を確かめる）。メモはお客様に見えない。
 * waive が真なら、受け取りではなく「いただかないで終える」（P27）: DB が fee_waived を真にする。
 * どちらの操作も、その時の fee_due_amount を order_returns.fee_settled_amount に足して fee_due_amount を0にする。
 * fee_due_amount はまだ決着していない手数料なので、決着した額を履歴に残す列とは分ける。
 * waive は省略できない真偽にして、偽でも必ず _waive に渡す（省略を許すと、いただかないで終える操作が黙って受け取りの記録になる）
 */
export async function recordReturnFeePayment(
  store: ReturnStore,
  input: { returnId: string; actorId: string; note: string | null; waive: boolean },
): Promise<ReturnStatusResult> {
  return toStatusResult(
    firstRowOf(
      await callRpc(store, 'admin_record_return_fee_payment', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _note: input.note,
        _waive: input.waive,
      }),
      'admin_record_return_fee_payment',
    ),
  );
}

/** 手数料のお支払いを待たずに、交換の品を送れるようにする（店長だけ。窓口が権限を確かめる） */
export async function releaseReturnExchange(
  store: ReturnStore,
  input: { returnId: string; actorId: string },
): Promise<ReturnStatusResult> {
  return toStatusResult(
    firstRowOf(
      await callRpc(store, 'admin_release_return_exchange', { _return_id: input.returnId, _actor_id: input.actorId }),
      'admin_release_return_exchange',
    ),
  );
}

// ---- 申し込みの承認・お断り（段2。お客様の申し込みは、状態 requested の返品として入っている） ----

/** 承認・お断りの答え。DB の列は return_id と status（手数料の記録などの return_status とは列の名前が違う） */
function toDecisionResult(row: JsonObject): ReturnStatusResult {
  return { returnId: String(row.return_id), returnStatus: row.status as ReturnStatus };
}

/**
 * 申し込みを承認する（requested → open）。行ごとの解決（返金／交換の色・サイズと送り方）と、返送・手数料・メモ・お知らせを一度に決める。
 * 手数料はどれも必須（範囲は DB が確かめる）。二重防止の番号は持たず、2回目は状態に合わない断り（RETURN_STATE_CONFLICT）になる。
 * DB は行の4つのキーが全部あることを求める（移行 F の ?&）ので、返金の行でも色・サイズと送り方を null で必ず送る
 * （JSON にすると undefined のキーは消えるので、渡し忘れも null にする）
 */
export async function approveReturn(store: ReturnStore, input: ApproveReturnInput): Promise<ReturnStatusResult> {
  return toDecisionResult(
    firstRowOf(
      await callRpc(store, 'admin_approve_return', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _lines: input.lines.map((line) => ({
          return_line_id: line.returnLineId,
          resolution: line.resolution,
          exchange_variant_id: line.exchangeVariantId ?? null,
          exchange_method: line.exchangeMethod ?? null,
        })),
        _return_method: input.returnMethod,
        _return_shipping_payer: input.returnShippingPayer,
        _return_carrier: input.returnCarrier,
        _return_tracking_number: input.returnTrackingNumber,
        _return_shipping_fee: input.returnShippingFee,
        _restocking_fee_percent: input.restockingFeePercent,
        _exchange_fee: input.exchangeFee,
        _exchange_shipping_fee: input.exchangeShippingFee,
        _shop_note: input.shopNote,
        _notify_customer: input.notifyCustomer,
      }),
      'admin_approve_return',
    ),
  );
}

/**
 * 申し込みをお断りする（requested → declined）。メッセージはお客様に届く（前後の空白を外して1〜1000字かは DB が確かめる）。
 * 二重防止の番号は持たず、2回目は状態に合わない断り（RETURN_STATE_CONFLICT）になる
 */
export async function declineReturn(
  store: ReturnStore,
  input: { returnId: string; actorId: string; declineReason: ReturnDeclineReason; declineMessage: string },
): Promise<ReturnStatusResult> {
  return toDecisionResult(
    firstRowOf(
      await callRpc(store, 'admin_decline_return', {
        _return_id: input.returnId,
        _actor_id: input.actorId,
        _decline_reason: input.declineReason,
        _decline_message: input.declineMessage,
      }),
      'admin_decline_return',
    ),
  );
}

// ---- 読み出し（作る画面の材料・返品の中身・一覧の要約・数） ----

type ShipmentMaterial = ReturnCreateMaterials['shipments'][number];
type ShipmentLineMaterial = ShipmentMaterial['lines'][number];
type ExchangeOptionMaterial = ReturnCreateMaterials['exchangeOptions'][number];
type ExchangeVariantMaterial = ExchangeOptionMaterial['variants'][number];

function toShipmentLine(line: JsonObject): ShipmentLineMaterial {
  return {
    orderItemId: String(line.order_item_id),
    itemId: Number(line.item_id),
    variantId: numberOrNull(line.variant_id),
    itemName: String(line.item_name),
    color: textOrNull(line.color),
    size: textOrNull(line.size),
    lineKind: line.line_kind === 'exchange' ? 'exchange' : 'order',
    quantity: Number(line.quantity),
    returnable: Number(line.returnable),
    returnIneligible: line.return_ineligible === true,
  };
}

function toShipment(shipment: JsonObject): ShipmentMaterial {
  return {
    fulfillmentId: String(shipment.fulfillment_id),
    number: Number(shipment.number),
    shippedAt: String(shipment.shipped_at),
    deadlineDate: textOrNull(shipment.deadline_date),
    pastDeadline: shipment.past_deadline === true,
    lines: objectsOf(shipment.lines).map(toShipmentLine),
  };
}

function toExchangeVariant(variant: JsonObject): ExchangeVariantMaterial {
  return {
    variantId: Number(variant.variant_id),
    color: textOrNull(variant.color),
    size: textOrNull(variant.size),
    isActive: variant.is_active === true,
    stockQuantity: Number(variant.stock_quantity),
    madeToOrderLeadDays: numberOrNull(variant.made_to_order_lead_days),
  };
}

/** 理由ごとの設定の表（キーは理由の記号そのもの。キーは camelCase に直さない）。文字の値だけ写す */
function recordOfStrings<T extends string>(value: unknown): Record<ReturnReason, T> {
  return Object.fromEntries(
    Object.entries(objectOf(value)).filter((entry): entry is [string, T] => typeof entry[1] === 'string'),
  ) as Record<ReturnReason, T>;
}

function toCreateMaterials(root: JsonObject): ReturnCreateMaterials {
  const order = objectOf(root.order);
  const settings = objectOf(root.settings);
  return {
    order: {
      id: String(order.id),
      status: order.status as OrderStatus,
      hasAwaitingRefund: order.has_awaiting_refund === true,
    },
    shipments: objectsOf(root.shipments).map(toShipment),
    exchangeOptions: objectsOf(root.exchange_options).map(
      (option): ExchangeOptionMaterial => ({
        itemId: Number(option.item_id),
        variants: objectsOf(option.variants).map(toExchangeVariant),
      }),
    ),
    settings: {
      returnAddressSet: settings.return_address_set === true,
      noReturnNeededEnabled: settings.no_return_needed_enabled === true,
      customerPaidMethod: settings.customer_paid_method === 'shop_label' ? 'shop_label' : 'customer_ships',
      shopLabelFee: Number(settings.shop_label_fee),
      restockingFeeEnabled: settings.restocking_fee_enabled === true,
      restockingFeePercent: Number(settings.restocking_fee_percent),
      exchangeFeesEnabled: settings.exchange_fees_enabled === true,
      exchangeFee: Number(settings.exchange_fee),
      exchangeShippingFee: Number(settings.exchange_shipping_fee),
      reasonShippingPayers: recordOfStrings<ShippingPayer>(settings.reason_shipping_payers),
      reasonOutOfStockExchange: recordOfStrings<OutOfStockExchange>(settings.reason_out_of_stock_exchange),
    },
  };
}

/**
 * 返品を作る画面の材料（発送ごとの返品できる数と期限・交換で選べる色とサイズ・設定の写し）。
 * 注文が無い時は DB が NULL を返すので、E-2 の記号 order_not_found（ReturnStoreError。窓口は 404「注文が見つかりません。」）で断る
 */
export async function loadReturnCreateMaterials(store: ReturnStore, orderId: string): Promise<ReturnCreateMaterials> {
  const root = jsonObjectOf(await callRpc(store, 'get_order_return_materials', { _order_id: orderId }));
  if (!root) {
    throw new ReturnStoreError('order_not_found');
  }
  return toCreateMaterials(root);
}

function displayStatusOf(value: unknown): ReturnDisplayStatus | null {
  return (RETURN_DISPLAY_STATUSES as readonly unknown[]).includes(value) ? (value as ReturnDisplayStatus) : null;
}

/** 小さな印の表に無い記号は捨てる（画面が言葉の表を引いて undefined にならないように） */
function marksOf(value: unknown): ReturnMark[] {
  return stringsOf(value).filter((mark): mark is ReturnMark => (RETURN_MARKS as readonly string[]).includes(mark));
}

function nextActionOf(value: unknown): ReturnNextAction {
  return (RETURN_NEXT_ACTIONS as readonly unknown[]).includes(value) ? (value as ReturnNextAction) : 'none';
}

type ReturnLineExchange = NonNullable<OrderReturnLineDetail['exchange']>;

function toLineExchange(exchange: JsonObject): ReturnLineExchange {
  return {
    variantId: Number(exchange.variant_id),
    color: textOrNull(exchange.color),
    size: textOrNull(exchange.size),
    method: exchange.method as ExchangeMethod,
    stockQuantity: Number(exchange.stock_quantity),
    madeToOrderLeadDays: numberOrNull(exchange.made_to_order_lead_days),
    outOfStockExchange: exchange.out_of_stock_exchange as OutOfStockExchange,
  };
}

function toReturnLine(line: JsonObject): OrderReturnLineDetail {
  const exchange = jsonObjectOf(line.exchange);
  const progress = objectOf(line.progress);
  const requestedExchange = jsonObjectOf(line.requested_exchange);
  return {
    id: String(line.id),
    fulfillmentId: String(line.fulfillment_id),
    fulfillmentNumber: Number(line.fulfillment_number),
    orderItemId: String(line.order_item_id),
    itemName: String(line.item_name),
    color: textOrNull(line.color),
    size: textOrNull(line.size),
    quantity: Number(line.quantity),
    reason: line.reason as ReturnReason,
    reasonNote: textOrNull(line.reason_note),
    resolution: line.resolution as ReturnResolution,
    exchange: exchange ? toLineExchange(exchange) : null,
    progress: {
      restocked: Number(progress.restocked),
      notRestocked: Number(progress.not_restocked),
      pendingInspection: Number(progress.pending_inspection),
      sentBack: Number(progress.sent_back),
      missing: Number(progress.missing),
      processed: Number(progress.processed),
      unprocessed: Number(progress.unprocessed),
      exchanged: Number(progress.exchanged),
      refundCovered: Number(progress.refund_covered),
      refundWaived: Number(progress.refund_waived),
      refundWaiting: Number(progress.refund_waiting),
    },
    refundAmountsByCount: Array.isArray(line.refund_amounts_by_count) ? line.refund_amounts_by_count.map(Number) : [],
    refundWaitingAmount: Number(line.refund_waiting_amount),
    customerNote: textOrNull(line.customer_note),
    requestedResolution: resolutionOrNull(line.requested_resolution),
    requestedExchange: requestedExchange
      ? {
          variantId: Number(requestedExchange.variant_id),
          color: textOrNull(requestedExchange.color),
          size: textOrNull(requestedExchange.size),
        }
      : null,
    photos: objectsOf(line.photos).map((photo) => ({ id: String(photo.id), purged: photo.purged === true })),
    returnIneligible: line.return_ineligible === true,
  };
}

function toReturnDetail(row: JsonObject, orderId: string): OrderReturnDetail {
  const fees = objectOf(row.fees);
  const number = Number(row.number);
  return {
    id: String(row.id),
    number,
    // 番号の文字は DB が作らず、ここで付ける（共通の約束 C-2）
    label: formatReturnNumber(orderId, number),
    status: row.status as ReturnStatus,
    source: row.source === 'customer_request' ? 'customer_request' : 'shop',
    displayStatus: displayStatusOf(row.display_status),
    marks: marksOf(row.marks),
    returnMethod: row.return_method as ReturnMethod,
    returnShippingPayer: row.return_shipping_payer as ShippingPayer,
    returnCarrier: textOrNull(row.return_carrier) as ReturnCarrier | null,
    returnTrackingNumber: textOrNull(row.return_tracking_number),
    fees: {
      returnShippingFee: Number(fees.return_shipping_fee),
      restockingFeePercent: Number(fees.restocking_fee_percent),
      exchangeFee: Number(fees.exchange_fee),
      exchangeShippingFee: Number(fees.exchange_shipping_fee),
      feeDueAmount: Number(fees.fee_due_amount),
      feePendingDeduction: Number(fees.fee_pending_deduction),
      feeReceivedAt: textOrNull(fees.fee_received_at),
      exchangeReleasedAt: textOrNull(fees.exchange_released_at),
    },
    firstReceiptDone: row.first_receipt_done === true,
    firstExchangeReceiptDone: row.first_exchange_receipt_done === true,
    shopNote: textOrNull(row.shop_note),
    notifyCustomer: row.notify_customer === true,
    createdAt: String(row.created_at),
    createdByEmail: textOrNull(row.created_by_email),
    closedAt: textOrNull(row.closed_at),
    cancelledAt: textOrNull(row.cancelled_at),
    requestedAt: textOrNull(row.requested_at),
    approvedAt: textOrNull(row.approved_at),
    approvedByEmail: textOrNull(row.approved_by_email),
    declinedAt: textOrNull(row.declined_at),
    declineReason: declineReasonOf(row.decline_reason),
    declineMessage: textOrNull(row.decline_message),
    lines: objectsOf(row.lines).map(toReturnLine),
    refunds: objectsOf(row.refunds).map((refund) => ({
      id: String(refund.id),
      amount: Number(refund.amount),
      status: refund.status as OrderRefundStatus,
      createdAt: String(refund.created_at),
    })),
    receipts: objectsOf(row.receipts).map((receipt) => ({
      id: String(receipt.id),
      kind: receipt.kind as OrderReturnDetail['receipts'][number]['kind'],
      refundChoice: textOrNull(receipt.refund_choice) as RefundChoice | null,
      createdAt: String(receipt.created_at),
      actorEmail: textOrNull(receipt.actor_email),
    })),
    exchangeItems: objectsOf(row.exchange_items).map(
      (item): OrderReturnDetail['exchangeItems'][number] => ({
        orderItemId: String(item.order_item_id),
        itemName: String(item.item_name),
        color: textOrNull(item.color),
        size: textOrNull(item.size),
        quantity: Number(item.quantity),
        fulfillmentType: item.fulfillment_type === 'backorder' ? 'backorder' : 'stock',
        shipped: Number(item.shipped),
      }),
    ),
  };
}

/**
 * 注文の返品の一覧（取消・お断りの返品も含む。並びは DB が決める）。操作した人のメールを含むので、答えをそのまま
 * お客様の窓口に返さない。番号の文字（label）はここで付ける
 */
export async function listOrderReturns(store: ReturnStore, orderId: string): Promise<OrderReturnDetail[]> {
  const data = await callRpc(store, 'list_order_returns', { _order_id: orderId });
  return objectsOf(data).map((row) => toReturnDetail(row, orderId));
}

/**
 * 返品の写真の一覧（返品の行の作った順 → 写真の作った順。並びは DB が決める）。置き場の場所を含むので、答えをそのまま画面に返さない
 * （署名つきの10分のリンクにして返す。return-photo-storage.ts の signReturnPhotoUrls）
 */
export async function listReturnPhotos(store: ReturnStore, returnId: string): Promise<ReturnPhotoRef[]> {
  const data = await callRpc(store, 'list_return_photos', { _return_id: returnId });
  return rowsOf(data).map((row) => ({
    photoId: String(row.photo_id),
    returnLineId: String(row.return_line_id),
    storagePath: String(row.storage_path),
    purged: row.purged === true,
  }));
}

/** DB が行を返さなかった注文の要約。返品は無く、返品できる品の有無は分からない（false） */
function emptyReturnSummary(orderId: string): OrderReturnSummary {
  return {
    orderId,
    displayStatus: null,
    marks: [],
    nextAction: 'none',
    hasReturnable: false,
    refundWaitingReturns: 0,
    requestedReturns: 0,
  };
}

/**
 * 注文ごとの返品の要約（一覧の返品の列・印・ボタンの名前に使う）。渡した番号は全部キーに入る
 * （渡した文字のまま。DB が行を返さなかった注文は空の要約）。空なら DB を呼ばない。
 * DB の関数が受ける上限に合わせて、200件ずつに分けて呼ぶ。
 */
export async function listOrderReturnSummaries(
  store: ReturnStore,
  orderIds: readonly string[],
): Promise<Map<string, OrderReturnSummary>> {
  // DB は uuid を小文字で返す。窓口の uuid 検証は大文字も通すので、小文字にそろえて引かないと行が合わず捨てられる
  const ids = [...new Set(orderIds.map((id) => id.toLowerCase()))];
  const summaryById = new Map<string, OrderReturnSummary>();

  for (let start = 0; start < ids.length; start += ORDER_IDS_CHUNK_SIZE) {
    const data = await callRpc(store, 'list_order_return_summaries', {
      _order_ids: ids.slice(start, start + ORDER_IDS_CHUNK_SIZE),
    });
    for (const row of listRowsOf(data, 'list_order_return_summaries')) {
      const orderId = String(row.order_id).toLowerCase();
      summaryById.set(orderId, {
        orderId,
        displayStatus: displayStatusOf(row.display_status),
        marks: marksOf(row.marks),
        nextAction: nextActionOf(row.next_action),
        hasReturnable: row.has_returnable === true,
        refundWaitingReturns: Number(row.refund_waiting_returns),
        requestedReturns: Number(row.requested_returns),
      });
    }
  }
  return new Map(
    [...new Set(orderIds)].map((id): [string, OrderReturnSummary] => [
      id,
      summaryById.get(id.toLowerCase()) ?? emptyReturnSummary(id.toLowerCase()),
    ]),
  );
}

/** 一覧の上の一行の数（返品の申し込み・返金待ち）。何を数えるかは DB が決める */
export async function countReturnAttention(store: ReturnStore): Promise<{ requested: number; refundWaiting: number }> {
  const row = firstRowOf(await callRpc(store, 'count_order_return_attention', {}), 'count_order_return_attention');
  return { requested: Number(row.requested), refundWaiting: Number(row.refund_waiting) };
}

// ---- ショップの設定の「返品」の欄 ----

type ReasonSetting = ShopReturnSettings['reasons'][number];
type SettingsGroup = ShopReturnSettings['updated'][keyof ShopReturnSettings['updated']];

function toReasonSetting(reason: JsonObject): ReasonSetting {
  return {
    reason: reason.reason as ReturnReason,
    shown: reason.shown === true,
    resolutions: reason.resolutions as ReasonSetting['resolutions'],
    outOfStockExchange: reason.out_of_stock_exchange as OutOfStockExchange,
    photo: reason.photo as ReasonSetting['photo'],
    photoInstructions: String(reason.photo_instructions ?? ''),
    shippingPayer: reason.shipping_payer as ShippingPayer,
  };
}

function toSettingsGroup(value: unknown): SettingsGroup {
  const group = objectOf(value);
  return { at: textOrNull(group.at), byEmail: textOrNull(group.by_email) };
}

function toShopReturnSettings(root: JsonObject): ShopReturnSettings {
  const address = jsonObjectOf(root.return_address);
  const updated = objectOf(root.updated);
  return {
    requestsEnabled: root.requests_enabled === true,
    requestTypes: root.request_types as ShopReturnSettings['requestTypes'],
    noticeText: String(root.notice_text ?? ''),
    windowDays: numberOrNull(root.window_days),
    windowStart: root.window_start === 'last_item' ? 'last_item' : 'each_item',
    deliveryBufferDays: Number(root.delivery_buffer_days),
    returnAddress: address
      ? {
          name: String(address.name),
          postalCode: String(address.postal_code),
          address: String(address.address),
          phone: String(address.phone),
        }
      : null,
    customerPaidMethod: root.customer_paid_method === 'shop_label' ? 'shop_label' : 'customer_ships',
    shopLabelFee: Number(root.shop_label_fee),
    noReturnNeededEnabled: root.no_return_needed_enabled === true,
    restockingFeeEnabled: root.restocking_fee_enabled === true,
    restockingFeePercent: Number(root.restocking_fee_percent),
    exchangeFeesEnabled: root.exchange_fees_enabled === true,
    exchangeFee: Number(root.exchange_fee),
    exchangeShippingFee: Number(root.exchange_shipping_fee),
    inspectionEnabled: root.inspection_enabled === true,
    reasons: objectsOf(root.reasons).map(toReasonSetting),
    updated: {
      requests: toSettingsGroup(updated.requests),
      window: toSettingsGroup(updated.window),
      shipping: toSettingsGroup(updated.shipping),
      reasons: toSettingsGroup(updated.reasons),
      fees: toSettingsGroup(updated.fees),
      receiving: toSettingsGroup(updated.receiving),
    },
  };
}

/** ショップの設定の返品の欄（1行だけ）。最後に変えた人のメールを含むので、管理画面の窓口だけが使う */
export async function getShopReturnSettings(store: ReturnStore): Promise<ShopReturnSettings> {
  const root = jsonObjectOf(await callRpc(store, 'get_shop_return_settings', {}));
  if (!root) {
    throw new RefundStoreError('get_shop_return_settings', null);
  }
  return toShopReturnSettings(root);
}

/** 理由ごとの設定の行。理由の記号と、変える欄だけを渡す */
type ReasonSettingPatch = Pick<ReasonSetting, 'reason'> & Partial<Omit<ReasonSetting, 'reason'>>;

/**
 * 変える欄だけを渡す（渡さない欄は DB が今の値のままにする）。理由ごとの設定は、理由の記号と変える欄だけの行で渡す。
 * 設定の画面が送る ShopReturnSettingsUpdate（return-types.ts）は、そのまま渡せる。最後に変えた人と時刻は、DB が変えたまとまりに書く
 */
export type ShopReturnSettingsPatch = Partial<Omit<ShopReturnSettings, 'updated' | 'reasons'>> & {
  reasons?: ReasonSettingPatch[];
};

// 値をそのまま渡す欄（camelCase → DB の jsonb の snake_case）。返送先と理由ごとの設定は中身を直すので別に扱う
const SETTINGS_SCALAR_KEYS = [
  ['requestsEnabled', 'requests_enabled'],
  ['requestTypes', 'request_types'],
  ['noticeText', 'notice_text'],
  ['windowDays', 'window_days'],
  ['windowStart', 'window_start'],
  ['deliveryBufferDays', 'delivery_buffer_days'],
  ['customerPaidMethod', 'customer_paid_method'],
  ['shopLabelFee', 'shop_label_fee'],
  ['noReturnNeededEnabled', 'no_return_needed_enabled'],
  ['restockingFeeEnabled', 'restocking_fee_enabled'],
  ['restockingFeePercent', 'restocking_fee_percent'],
  ['exchangeFeesEnabled', 'exchange_fees_enabled'],
  ['exchangeFee', 'exchange_fee'],
  ['exchangeShippingFee', 'exchange_shipping_fee'],
  ['inspectionEnabled', 'inspection_enabled'],
] as const satisfies ReadonlyArray<readonly [keyof ShopReturnSettingsPatch, string]>;

// 理由ごとの設定の行の欄（reason は必ず渡すので、ここには入れない）
const REASON_SCALAR_KEYS = [
  ['shown', 'shown'],
  ['resolutions', 'resolutions'],
  ['outOfStockExchange', 'out_of_stock_exchange'],
  ['photo', 'photo'],
  ['photoInstructions', 'photo_instructions'],
  ['shippingPayer', 'shipping_payer'],
] as const satisfies ReadonlyArray<readonly [keyof Omit<ReasonSetting, 'reason'>, string]>;

function toDbReason(reason: ReasonSettingPatch): JsonObject {
  const row: JsonObject = { reason: reason.reason };
  for (const [key, dbKey] of REASON_SCALAR_KEYS) {
    if (reason[key] !== undefined) {
      row[dbKey] = reason[key];
    }
  }
  return row;
}

function toDbSettings(patch: ShopReturnSettingsPatch): JsonObject {
  const settings: JsonObject = {};
  for (const [key, dbKey] of SETTINGS_SCALAR_KEYS) {
    if (patch[key] !== undefined) {
      settings[dbKey] = patch[key];
    }
  }
  if (patch.returnAddress !== undefined) {
    settings.return_address = patch.returnAddress
      ? {
          name: patch.returnAddress.name,
          postal_code: patch.returnAddress.postalCode,
          address: patch.returnAddress.address,
          phone: patch.returnAddress.phone,
        }
      : null;
  }
  if (patch.reasons !== undefined) {
    settings.reasons = patch.reasons.map(toDbReason);
  }
  return settings;
}

/** ショップの設定の返品の欄を変える（店長だけ。窓口が権限を確かめる）。変えた後の設定を返す */
export async function updateShopReturnSettings(
  store: ReturnStore,
  input: { settings: ShopReturnSettingsPatch; actorId: string },
): Promise<ShopReturnSettings> {
  const root = jsonObjectOf(
    await callRpc(store, 'admin_update_shop_return_settings', {
      _settings: toDbSettings(input.settings),
      _actor_id: input.actorId,
    }),
  );
  if (!root) {
    throw new RefundStoreError('admin_update_shop_return_settings', null);
  }
  return toShopReturnSettings(root);
}
