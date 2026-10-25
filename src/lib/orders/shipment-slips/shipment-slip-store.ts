import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isShipmentSlipErrorCode,
  parsePackingRow,
  parseShipmentSlipCancelled,
  parseShipmentSlipConfirmed,
  parseShipmentSlipDetail,
  parseShipmentSlipLink,
  parseShipmentSlipListRow,
  parseShipmentSlipSaved,
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_READ_FAILED,
  SHIPMENT_SLIP_TEXT,
  type PackingRow,
  type ShipmentSlipCancelled,
  type ShipmentSlipConfirmed,
  type ShipmentSlipConfirmInput,
  type ShipmentSlipDetail,
  type ShipmentSlipDraftLine,
  type ShipmentSlipLink,
  type ShipmentSlipListRow,
  type ShipmentSlipSaved,
  type ShipmentSlipStage,
} from './shipment-slip-types';

/**
 * 固定の文と番号だけを持つ。DB の生の文も cause も持たない（status は表の状態、表に無い失敗は 500）。
 * 表に無い code（継承した名前を含む）は、落とさずに code 無しの固定の失敗の文にする。
 */
export class ShipmentSlipError extends Error {
  readonly code?: string;

  constructor(public readonly status = 500, code?: string) {
    const known = code !== undefined && isShipmentSlipErrorCode(code);
    super(known ? SHIPMENT_SLIP_ERRORS[code][2] : SHIPMENT_SLIP_TEXT.failed);
    this.name = 'ShipmentSlipError';
    if (known) this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * message と SQLSTATE が両方そろい、表と完全に一致した時だけ分類する（片方だけの一致は信用しない）。
 * 表に無い誤り・読めない誤りは、生の文を持たない固定の500にする。
 */
export function classify(error: unknown): ShipmentSlipError {
  if (!isObject(error) || typeof error.message !== 'string' || !Object.hasOwn(SHIPMENT_SLIP_ERRORS, error.message)) {
    return new ShipmentSlipError();
  }
  const [sqlstate, status] = SHIPMENT_SLIP_ERRORS[error.message];
  return error.code === sqlstate ? new ShipmentSlipError(status, error.message) : new ShipmentSlipError();
}

/** RPC を1回呼び、DB の誤りは表で分類し、通信の失敗は固定の500にする。戻りの検査は呼び手が行う。読取にも書込みにも使う。 */
async function callRpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response;
  try {
    response = await client.rpc(name, args);
  } catch {
    throw new ShipmentSlipError();
  }
  if (response.error) throw classify(response.error);
  return response.data as unknown;
}

/** 戻りの検査で崩れを見つけたら、中身を持たない固定の500にする（崩れの印の Error 以外は握りつぶさず投げ直す） */
function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && error.message === SHIPMENT_SLIP_READ_FAILED) throw new ShipmentSlipError();
    throw error;
  }
}

/** 行ごとに同じ total_count が入る。決まった形でなければ読み違い */
function readTotal(raw: Record<string, unknown>): number {
  if (typeof raw.total_count !== 'number' || !Number.isSafeInteger(raw.total_count) || raw.total_count < 0) {
    throw new ShipmentSlipError();
  }
  return raw.total_count;
}

/** 頁の行と全件数を取る。全行の total_count が同じで、行数が全件数以下であること */
function readPage<T>(data: unknown, toRow: (raw: Record<string, unknown>) => T, keyOf: (row: T) => string): { rows: T[]; total: number } {
  if (!Array.isArray(data)) throw new ShipmentSlipError();
  const rows: T[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of data) {
    if (!isObject(raw)) throw new ShipmentSlipError();
    const rowTotal = readTotal(raw);
    // 行ごとに同じ total が入る。違えば別々の読み取りが混ざった形なので読み違いとして止める
    if (rows.length > 0 && rowTotal !== total) throw new ShipmentSlipError();
    const row = guarded(() => toRow(raw));
    const key = keyOf(row);
    if (seen.has(key)) throw new ShipmentSlipError();
    seen.add(key);
    total = rowTotal;
    rows.push(row);
  }
  if (total < rows.length) throw new ShipmentSlipError();
  return { rows, total };
}

function toPackingRow(raw: Record<string, unknown>): PackingRow {
  return parsePackingRow({
    orderId: raw.order_id,
    orderItemId: raw.order_item_id,
    orderCreatedAt: raw.order_created_at,
    customerName: raw.customer_name,
    customerEmail: raw.customer_email,
    itemName: raw.item_name,
    color: raw.color,
    size: raw.size,
    readyQuantity: raw.ready_quantity,
    shippableQuantity: raw.shippable_quantity,
    unitPrice: raw.unit_price,
    isExchange: raw.is_exchange,
    blockedReasons: raw.blocked_reasons,
    otherSlipNumbers: raw.other_slip_numbers,
    selectedQuantity: raw.selected_quantity,
    bundleOk: raw.bundle_ok,
    bundleKey: raw.bundle_key,
  });
}

function toSlipListRow(raw: Record<string, unknown>): ShipmentSlipListRow {
  return parseShipmentSlipListRow({
    id: raw.id,
    number: raw.number,
    stage: raw.stage,
    version: raw.version,
    expired: raw.expired,
    shipmentDate: raw.shipment_date,
    shippingCarrier: raw.shipping_carrier,
    trackingNumber: raw.tracking_number,
    orderCount: raw.order_count,
    itemQuantity: raw.item_quantity,
    updatedAt: raw.updated_at,
  });
}

/**
 * 荷作り表（発送準備中の品物の行）を DB の関数 list_admin_packing から1回で読む（読むだけ）。
 * 並びは DB が決めた順（古い注文から）。total は全行の数。slipId を渡すと、その下書きが選んでいる数と、同梱できるかも付く。
 * 実行者は呼び手が認可結果から渡す。権限の拒否は 403 の ShipmentSlipError、他の失敗は固定の500。
 */
export async function listAdminPacking(
  client: SupabaseClient,
  actorId: string,
  { slipId, limit, page }: { slipId: string | null; limit: number; page: number },
): Promise<{ rows: PackingRow[]; total: number }> {
  const data = await callRpc(client, 'list_admin_packing', {
    _slip_id: slipId, _limit: limit, _offset: (page - 1) * limit, _actor_id: actorId,
  });
  return readPage(data, toPackingRow, (row) => row.orderItemId);
}

/** 発送票の一覧を DB の関数 list_admin_shipment_slips から1回で読む（読むだけ）。stage が null なら全段階。新しく更新した順。 */
export async function listAdminShipmentSlips(
  client: SupabaseClient,
  actorId: string,
  { stage, limit, page }: { stage: ShipmentSlipStage | null; limit: number; page: number },
): Promise<{ rows: ShipmentSlipListRow[]; total: number }> {
  const data = await callRpc(client, 'list_admin_shipment_slips', {
    _stage: stage, _limit: limit, _offset: (page - 1) * limit, _actor_id: actorId,
  });
  return readPage(data, toSlipListRow, (row) => row.id);
}

/**
 * 発送票1件の詳細を DB の関数 get_admin_shipment_slip から1回で読む（読むだけ）。無ければ 404 の ShipmentSlipError。
 * 戻りは検査して決まった項目だけにする。頼んだ票以外が返ったら読み違い。
 */
export async function getAdminShipmentSlip(client: SupabaseClient, actorId: string, slipId: string): Promise<ShipmentSlipDetail> {
  const data = await callRpc(client, 'get_admin_shipment_slip', { _slip_id: slipId, _actor_id: actorId });
  const detail = guarded(() => parseShipmentSlipDetail(data));
  if (detail.id !== slipId.toLowerCase()) throw new ShipmentSlipError();
  return detail;
}

/**
 * 注文が属する発送票を DB の関数 list_admin_order_shipment_slips から1回で読む（読むだけ）。
 * キーは発送の ID。注文の履歴の発送の行に、その発送が属する票を付けるのに使う。
 */
export async function listAdminOrderShipmentSlips(
  client: SupabaseClient,
  actorId: string,
  orderId: string,
): Promise<Map<string, ShipmentSlipLink>> {
  const data = await callRpc(client, 'list_admin_order_shipment_slips', { _order_id: orderId, _actor_id: actorId });
  if (!Array.isArray(data)) throw new ShipmentSlipError();
  const slips = new Map<string, ShipmentSlipLink>();
  for (const raw of data) {
    if (!isObject(raw)) throw new ShipmentSlipError();
    const { fulfillmentId, ...link } = guarded(() => parseShipmentSlipLink({
      fulfillmentId: raw.fulfillment_id, slipId: raw.slip_id, number: raw.number, stage: raw.stage,
    }));
    // 1つの発送が属する票は1つだけ
    if (slips.has(fulfillmentId)) throw new ShipmentSlipError();
    slips.set(fulfillmentId, link);
  }
  return slips;
}

/**
 * 発送票の下書きを保存する（DB の関数 admin_save_shipment_slip_draft を1回呼ぶ。在庫・割当・台帳・注文・発送は動かさない）。
 * slipId が null なら新しい下書きを作り（expectedVersion は null）、あれば下書きの選択を丸ごと入れ替える（expectedVersion が要る）。
 * 同じ requestKey と同じ内容の再送は同じ票を replayed: true で返す。実行者は呼び手が認可結果から渡す。
 * 権限・同梱・数量などの拒否は表で分類した ShipmentSlipError、他の失敗・崩れた戻りは固定の500。
 */
export async function saveShipmentSlipDraft(
  client: SupabaseClient,
  actorId: string,
  input: { slipId: string | null; expectedVersion: number | null; lines: ShipmentSlipDraftLine[]; requestKey: string },
): Promise<ShipmentSlipSaved> {
  const data = await callRpc(client, 'admin_save_shipment_slip_draft', {
    _slip_id: input.slipId,
    _expected_version: input.expectedVersion,
    _lines: input.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  return guarded(() => parseShipmentSlipSaved(data));
}

/**
 * 発送票の下書きを破棄する（DB の関数 admin_discard_shipment_slip_draft を1回呼ぶ）。下書きでなければ GROUP_G_SLIP_NOT_DRAFT（409）。
 * 版が違えば GROUP_G_SLIP_VERSION_CONFLICT。同じ requestKey と同じ内容の再送は同じ結果を replayed: true で返す。
 */
export async function discardShipmentSlipDraft(
  client: SupabaseClient,
  actorId: string,
  input: { slipId: string; expectedVersion: number; requestKey: string },
): Promise<ShipmentSlipSaved> {
  const data = await callRpc(client, 'admin_discard_shipment_slip_draft', {
    _slip_id: input.slipId,
    _expected_version: input.expectedVersion,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  return guarded(() => parseShipmentSlipSaved(data));
}

/** 票の全注文を1取引で確定する。actorは認可結果から渡し、崩れた成功の答えは固定の500にする。 */
export async function confirmShipmentSlip(
  client: SupabaseClient, actorId: string, input: ShipmentSlipConfirmInput & { slipId: string },
): Promise<ShipmentSlipConfirmed> {
  const data = await callRpc(client, 'admin_confirm_shipment_slip', {
    _slip_id: input.slipId, _expected_version: input.expectedVersion, _carrier: input.carrier,
    _tracking_number: input.trackingNumber, _shipment_date: input.shipmentDate, _notify_customer: input.notifyCustomer,
    _actor_id: actorId, _request_key: input.requestKey,
  });
  const result = guarded(() => parseShipmentSlipConfirmed(data));
  if (result.id !== input.slipId.toLowerCase()) throw new ShipmentSlipError();
  return result;
}

/**
 * 確定済みの票を全体で取り消す（DB の関数 admin_cancel_shipment_slip を1回呼ぶ）。注文ごとの発送を取り消し、割当の消費を1回だけ戻す。
 * 返品・発送後の返金・取り消せない状態の注文が1つでもあれば、DB が全体を断る（409、何も変えない）。
 * actor は認可結果から渡し、崩れた成功の答えや別の票の答えは固定の500にする。
 */
export async function cancelShipmentSlip(
  client: SupabaseClient, actorId: string, input: { slipId: string; expectedVersion: number; requestKey: string },
): Promise<ShipmentSlipCancelled> {
  const data = await callRpc(client, 'admin_cancel_shipment_slip', {
    _slip_id: input.slipId, _expected_version: input.expectedVersion, _actor_id: actorId, _request_key: input.requestKey,
  });
  const result = guarded(() => parseShipmentSlipCancelled(data));
  if (result.id !== input.slipId.toLowerCase()) throw new ShipmentSlipError();
  return result;
}
