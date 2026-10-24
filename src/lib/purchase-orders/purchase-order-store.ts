import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_READ_FAILED,
  PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE,
  PURCHASE_ORDER_TEXT,
  parsePurchaseOrderDetail,
  parsePurchaseOrderListRow,
  purchaseOrderErrorBody,
  type PurchaseOrderCreateInput,
  type PurchaseOrderCreated,
  type PurchaseOrderDetail,
  type PurchaseOrderHeaderUpdated,
  type PurchaseOrderHeaderUpdateInput,
  type PurchaseOrderListRow,
  type PurchaseOrderQuantitiesConfirmed,
  type PurchaseOrderQuantitiesInput,
  type PurchaseOrderReceived,
  type PurchaseOrderReceiptReversed,
  type PurchaseOrderReceiptReverseInput,
  type PurchaseOrderReceiveInput,
  type PurchaseOrderShortClosed,
  type PurchaseOrderShortCloseInput,
  type PurchaseOrderSurface,
} from './purchase-order-types';

/**
 * 固定の文と番号だけを持つ。DB の生の文も cause も持たない（status は表の状態、表に無い失敗は 500）。
 * 表に無い code（継承した名前を含む）は、落とさずに code 無しの固定の失敗の文にする。
 * surface が receipt（受け取りとその取消・数量訂正）の時だけ、権限の文が受け取り用になる。
 * releasedQuantity は GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED の時だけ持つ（外す割当の点数。窓口の 409 の本文に入る）。
 */
export class PurchaseOrderError extends Error {
  readonly code?: string;
  readonly releasedQuantity?: number;

  constructor(
    public readonly status = 500,
    code?: string,
    extra: { surface?: PurchaseOrderSurface; releasedQuantity?: number } = {},
  ) {
    const known = code !== undefined && Object.hasOwn(PURCHASE_ORDER_ERRORS, code);
    super(known ? purchaseOrderErrorBody(code, extra.surface) : PURCHASE_ORDER_TEXT.failed);
    this.name = 'PurchaseOrderError';
    if (known) this.code = code;
    if (known && extra.releasedQuantity !== undefined) this.releasedQuantity = extra.releasedQuantity;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 外す割当の点数: 0 以上 2147483647 以下の整数 */
const isReleasedQuantity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;

/**
 * message と SQLSTATE が両方そろい、表と完全に一致した時だけ分類する（片方だけの一致は信用しない）。
 * 外す割当の確認（55000）は DETAIL が {"releasedQuantity":n} のキー1つだけの時だけ受け入れる（G-1 の stockError と同じ）。
 */
function classify(error: unknown, surface: PurchaseOrderSurface = 'order'): PurchaseOrderError {
  if (!isObject(error) || typeof error.message !== 'string' || !Object.hasOwn(PURCHASE_ORDER_ERRORS, error.message)) {
    return new PurchaseOrderError();
  }
  const [sqlstate, status] = PURCHASE_ORDER_ERRORS[error.message];
  if (error.code !== sqlstate) return new PurchaseOrderError();
  if (error.message === PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE) {
    let detail: unknown;
    try {
      detail = JSON.parse(typeof error.details === 'string' ? error.details : 'null');
    } catch {
      return new PurchaseOrderError();
    }
    if (!isObject(detail) || Object.keys(detail).length !== 1 || !isReleasedQuantity(detail.releasedQuantity)) return new PurchaseOrderError();
    return new PurchaseOrderError(status, error.message, { surface, releasedQuantity: detail.releasedQuantity });
  }
  return new PurchaseOrderError(status, error.message, { surface });
}

/**
 * 発注書を1件作る（DB の関数 admin_create_purchase_order を1回呼ぶ。在庫・割当・台帳・注文は動かさない）。
 * 同じ requestKey と同じ内容の再送は同じ発注書を replayed: true で返す。実行者は呼び手が認可結果から渡す。
 */
export async function createPurchaseOrder(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderCreateInput,
): Promise<PurchaseOrderCreated> {
  let response;
  try {
    response = await client.rpc('admin_create_purchase_order', {
      _supplier_name: input.supplierName,
      _memo: input.memo,
      _lines: input.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      _actor_id: actorId,
      _request_key: input.requestKey,
    });
  } catch {
    throw new PurchaseOrderError();
  }
  if (response.error) throw classify(response.error);

  const data: unknown = response.data;
  if (!isObject(data) || typeof data.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.id)
    || typeof data.number !== 'string' || !/^PO-[0-9]{8}-[0-9]{4}$/.test(data.number)
    || typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1
    || typeof data.replayed !== 'boolean') {
    throw new PurchaseOrderError();
  }
  return { id: data.id, number: data.number, version: data.version, replayed: data.replayed };
}

const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * 発注書の書込み（Task 6 の3つ）が共通で使う呼び出し。RPC を1回呼び、DB の誤りは表で分類し、戻りがオブジェクトでなければ固定の失敗にする。
 * 戻りの項目の検査は呼び手が行う。
 */
async function callWriter(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  surface: PurchaseOrderSurface = 'order',
): Promise<Record<string, unknown>> {
  let response;
  try {
    response = await client.rpc(name, args);
  } catch {
    throw new PurchaseOrderError();
  }
  if (response.error) throw classify(response.error, surface);
  const data: unknown = response.data;
  if (!isObject(data)) throw new PurchaseOrderError();
  return data;
}

/**
 * 発注先・メモを訂正する（DB の関数 admin_update_purchase_order_header を1回呼ぶ。理由が必須で、版が違えば GROUP_G_PO_VERSION_CONFLICT）。
 * 発注書の版が1つ進み、履歴（kind header）に前後の発注先とメモが残る。同じ requestKey と同じ内容の再送は同じ結果を replayed: true で返す。
 */
export async function updatePurchaseOrderHeader(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderHeaderUpdateInput,
): Promise<PurchaseOrderHeaderUpdated> {
  const data = await callWriter(client, 'admin_update_purchase_order_header', {
    _purchase_order_id: input.purchaseOrderId,
    _expected_version: input.expectedVersion,
    _supplier_name: input.supplierName,
    _memo: input.memo,
    _reason: input.reason,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  if (!isVersion(data.version) || typeof data.replayed !== 'boolean') throw new PurchaseOrderError();
  return { version: data.version, replayed: data.replayed };
}

/**
 * 数量と単価を確定・訂正する（DB の関数 admin_confirm_purchase_order_quantities を1回呼ぶ）。lines は発注書の全行をちょうど1回ずつ。
 * 数量確定待ちなら最初の確定（reason は任意）、確定後なら訂正（reason 必須。納品済み未満は GROUP_G_PO_QUANTITY_BELOW_RECEIVED）。
 * unitPriceYen の null は「単価未登録」、0 は 0 円。在庫・台帳・受取は動かさない。
 */
export async function confirmPurchaseOrderQuantities(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderQuantitiesInput,
): Promise<PurchaseOrderQuantitiesConfirmed> {
  const data = await callWriter(client, 'admin_confirm_purchase_order_quantities', {
    _purchase_order_id: input.purchaseOrderId,
    _expected_version: input.expectedVersion,
    _lines: input.lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity, unitPriceYen: line.unitPriceYen })),
    _reason: input.reason,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  if (!isVersion(data.version) || !isCount(data.changedLines) || typeof data.replayed !== 'boolean') throw new PurchaseOrderError();
  return { version: data.version, changedLines: data.changedLines, replayed: data.replayed };
}

/**
 * 残りを打ち切る（DB の関数 admin_short_close_purchase_order を1回呼ぶ。理由が必須）。数量確定後は選んだ行の確定数量を納品済みまで下げ、
 * 数量確定前は全行を渡した時だけ、全行の確定数量を 0 にして取り消す。入庫・台帳・割当は動かさない。
 */
export async function shortClosePurchaseOrder(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderShortCloseInput,
): Promise<PurchaseOrderShortClosed> {
  const data = await callWriter(client, 'admin_short_close_purchase_order', {
    _purchase_order_id: input.purchaseOrderId,
    _expected_version: input.expectedVersion,
    _line_ids: input.lineIds,
    _reason: input.reason,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  if (!isVersion(data.version) || !isCount(data.closedQuantity) || typeof data.replayed !== 'boolean') throw new PurchaseOrderError();
  return { version: data.version, closedQuantity: data.closedQuantity, replayed: data.replayed };
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuidText = (value: unknown): value is string => typeof value === 'string' && UUID_TEXT.test(value);

/**
 * 発注書の受け取り（DB の関数 admin_receive_purchase_order を1回呼ぶ）。数量確定済みの発注書の未納の範囲で、行ごとの良品の数を受け取る。
 * 1つの DB 取引で、台帳の入庫（restock・無タグ）・受取・受取行・納品済み・未納・空き在庫を保存し、続けて古い注文から FIFO で割り当てる
 * （買い手本人の仮確保は奪わない）。allocatedQuantity はその FIFO で割り当てた点数。
 * 同じ requestKey と同じ内容の再送は、在庫を増やさず同じ結果を replayed: true で返す。1行でも不正なら何も保存しない。
 * 権限は admin.receiving.manage + admin.purchase_orders.read（実行者は呼び手が認可結果から渡す）。権限の文は受け取り用。
 */
export async function receivePurchaseOrder(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderReceiveInput,
): Promise<PurchaseOrderReceived> {
  const data = await callWriter(client, 'admin_receive_purchase_order', {
    _purchase_order_id: input.purchaseOrderId,
    _expected_version: input.expectedVersion,
    _received_on: input.receivedOn,
    _memo: input.memo,
    _lines: input.lines.map((line) => ({ lineId: line.lineId, quantity: line.quantity })),
    _actor_id: actorId,
    _request_key: input.requestKey,
  }, 'receipt');
  if (!isUuidText(data.receiptId) || !isVersion(data.version) || !isCount(data.allocatedQuantity) || typeof data.replayed !== 'boolean') {
    throw new PurchaseOrderError();
  }
  return { receiptId: data.receiptId, version: data.version, allocatedQuantity: data.allocatedQuantity, replayed: data.replayed };
}

/**
 * 受け取りの取消・数量訂正（DB の関数 admin_reverse_purchase_order_receipt を1回呼ぶ。同じ操作）。相殺の受取を追記し、納品済みと未納を戻し、
 * 在庫は G-1 の減らし方（空き在庫 → 足りなければ支払い済みの割当を新しい注文から外す）で減らす。
 * 外す割当があるのに expectedReleaseQuantity が無い・違う時は、PurchaseOrderError の code が
 * GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED（status 409）で、releasedQuantity にその点数が入る（何も書かれていない）。
 * 利用者が確認したら、新しい requestKey と expectedReleaseQuantity = その点数で送り直す。
 */
export async function reversePurchaseOrderReceipt(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderReceiptReverseInput,
): Promise<PurchaseOrderReceiptReversed> {
  const data = await callWriter(client, 'admin_reverse_purchase_order_receipt', {
    _purchase_order_id: input.purchaseOrderId,
    _expected_version: input.expectedVersion,
    _receipt_id: input.receiptId,
    _lines: input.lines.map((line) => ({ receiptLineId: line.receiptLineId, quantity: line.quantity })),
    _reason: input.reason,
    _expected_release_quantity: input.expectedReleaseQuantity,
    _actor_id: actorId,
    _request_key: input.requestKey,
  }, 'receipt');
  if (!isUuidText(data.receiptId) || !isVersion(data.version) || !isCount(data.releasedQuantity) || typeof data.replayed !== 'boolean') {
    throw new PurchaseOrderError();
  }
  return { receiptId: data.receiptId, version: data.version, releasedQuantity: data.releasedQuantity, replayed: data.replayed };
}

/** 読取の内部の失敗。DB の生の文も cause も持たない（窓口は固定の500にする）。 */
const readFailed = () => new Error(PURCHASE_ORDER_READ_FAILED);

/** DB が実行者の権限（admin.purchase_orders.read）で断った時だけ。message と SQLSTATE が両方そろった時に限る */
function readFailure(error: unknown): Error {
  return isObject(error) && error.message === 'GROUP_G_FORBIDDEN' && error.code === '42501'
    ? new PurchaseOrderError(403, 'GROUP_G_FORBIDDEN')
    : readFailed();
}

/** DB の1行（snake_case）を検査した camelCase の行にする。決まった列だけを取る */
function toListRow(raw: unknown): { total: number; row: PurchaseOrderListRow } {
  if (!isObject(raw) || typeof raw.total !== 'number' || !Number.isSafeInteger(raw.total) || raw.total < 0) throw readFailed();
  return {
    total: raw.total,
    row: parsePurchaseOrderListRow({
      purchaseOrderId: raw.purchase_order_id,
      number: raw.number,
      displayStage: raw.display_stage,
      lineId: raw.line_id,
      lineNo: raw.line_no,
      itemName: raw.item_name,
      colorName: raw.color_name,
      sizeLabel: raw.size_label,
      provisionalQuantity: raw.provisional_quantity,
      orderQuantity: raw.order_quantity,
      receivedQuantity: raw.received_quantity,
      outstandingQuantity: raw.outstanding_quantity,
    }),
  };
}

/**
 * 発注一覧表（明細ごとの行）を DB の関数 list_admin_purchase_order_lines から1回で読む（読むだけ）。
 * 並びは DB が決めた順（発注書番号の降順・明細番号順）。total は全明細の数で、行ごとに同じ値が入る。
 * 実行者は呼び手が認可結果から渡す。権限の拒否は 403 の PurchaseOrderError、他の失敗は PURCHASE_ORDER_READ_FAILED。
 */
export async function listAdminPurchaseOrderLines(
  client: SupabaseClient,
  actorId: string,
  { limit, page }: { limit: number; page: number },
): Promise<{ rows: PurchaseOrderListRow[]; total: number }> {
  let response;
  try {
    response = await client.rpc('list_admin_purchase_order_lines', { _limit: limit, _offset: (page - 1) * limit, _actor_id: actorId });
  } catch {
    throw readFailed();
  }
  if (response.error) throw readFailure(response.error);
  const data: unknown = response.data;
  if (!Array.isArray(data)) throw readFailed();

  const rows: PurchaseOrderListRow[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of data) {
    const parsed = toListRow(raw);
    // 行ごとに同じ total が入る。違えば別々の読み取りが混ざった形なので読み違いとして止める
    if (rows.length > 0 && parsed.total !== total) throw readFailed();
    if (seen.has(parsed.row.lineId)) throw readFailed();
    seen.add(parsed.row.lineId);
    total = parsed.total;
    rows.push(parsed.row);
  }
  if (total < rows.length) throw readFailed();
  return { rows, total };
}

/**
 * 発注書1件の詳細を DB の関数 get_admin_purchase_order から1回で読む（読むだけ）。無ければ null。
 * 戻りは検査して決まった項目だけにする（保存先の鍵や内部の操作 ID は DB も返さない）。
 */
export async function getAdminPurchaseOrder(client: SupabaseClient, actorId: string, id: string): Promise<PurchaseOrderDetail | null> {
  let response;
  try {
    response = await client.rpc('get_admin_purchase_order', { _purchase_order_id: id, _actor_id: actorId });
  } catch {
    throw readFailed();
  }
  if (response.error) throw readFailure(response.error);
  if (response.data === null) return null;
  const detail = parsePurchaseOrderDetail(response.data);
  // 頼んだ発注書以外が返ったら読み違い
  if (detail.id !== id.toLowerCase()) throw readFailed();
  return detail;
}
