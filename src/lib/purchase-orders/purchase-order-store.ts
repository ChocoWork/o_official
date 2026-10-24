import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_TEXT,
  type PurchaseOrderCreateInput,
  type PurchaseOrderCreated,
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
