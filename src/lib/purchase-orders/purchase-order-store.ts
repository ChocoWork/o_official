import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_READ_FAILED,
  PURCHASE_ORDER_TEXT,
  parsePurchaseOrderDetail,
  parsePurchaseOrderListRow,
  type PurchaseOrderCreateInput,
  type PurchaseOrderCreated,
  type PurchaseOrderDetail,
  type PurchaseOrderHeaderUpdated,
  type PurchaseOrderHeaderUpdateInput,
  type PurchaseOrderListRow,
  type PurchaseOrderQuantitiesConfirmed,
  type PurchaseOrderQuantitiesInput,
  type PurchaseOrderShortClosed,
  type PurchaseOrderShortCloseInput,
} from './purchase-order-types';

/**
 * 固定の文と番号だけを持つ。DB の生の文も cause も持たない（status は表の状態、表に無い失敗は 500）。
 * 表に無い code（継承した名前を含む）は、落とさずに code 無しの固定の失敗の文にする。
 */
export class PurchaseOrderError extends Error {
  readonly code?: string;

  constructor(public readonly status = 500, code?: string) {
    const known = code !== undefined && Object.hasOwn(PURCHASE_ORDER_ERRORS, code);
    super(known ? PURCHASE_ORDER_ERRORS[code][2] : PURCHASE_ORDER_TEXT.failed);
    this.name = 'PurchaseOrderError';
    if (known) this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** message と SQLSTATE が両方そろい、表と完全に一致した時だけ分類する（片方だけの一致は信用しない） */
function classify(error: unknown): PurchaseOrderError {
  if (!isObject(error) || typeof error.message !== 'string' || !Object.hasOwn(PURCHASE_ORDER_ERRORS, error.message)) {
    return new PurchaseOrderError();
  }
  const [sqlstate, status] = PURCHASE_ORDER_ERRORS[error.message];
  return error.code === sqlstate ? new PurchaseOrderError(status, error.message) : new PurchaseOrderError();
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
async function callWriter(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response;
  try {
    response = await client.rpc(name, args);
  } catch {
    throw new PurchaseOrderError();
  }
  if (response.error) throw classify(response.error);
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
