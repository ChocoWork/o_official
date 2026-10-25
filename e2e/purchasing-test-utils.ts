/**
 * 在庫一覧表・発注・受け取り・原本の添付（グループ G-2）の E2E の道具。FR-ADMIN-111・113・114・115・119・123 が使う。
 *
 * 画面 → 窓口の差し替え（bridge）→ 手元の DB の関数、の道で確かめる。本物の窓口（route）は通らない。
 * 本物の管理者のログインには2段階認証が要るので、画面が呼ぶ窓口を、同じ DB の公開関数（service_role 専用）へ手元の DB の接続から橋渡しする。
 * - bridge は権限を決めない。実行者（actorId）を `_actor_id` で渡すだけで、許否は DB の関数が決める（読みも同じ）。
 * - DB の誤りは、窓口と同じ表（PURCHASE_ORDER_ERRORS。import した物で、写していない）で HTTP の状態と本文にする。
 * - 窓口の認可・MFA・CSRF・回数の制限・操作の監査は bridge の範囲の外。本物の窓口の 401/403 は FR-ADMIN-123 の G-2 の節、
 *   窓口の流れは各 route の単体、DB の権限は G-2 の DB 結合が確かめる。
 * - 原本の置き場（Storage）の部分だけは、本物の手元の Storage を使う（署名つきの送り先の発行・読戻し・リンクの発行）。
 *   手元の住所だけを受け付ける見張りを付け、鍵・署名つきの URL・保存先の鍵は出力しない。
 *
 * 権限の表と役割は手元の DB の共有の状態。権限を付け外ししない試験は、その鍵（190520, 0）を共有（pg_advisory_lock_shared）で持ち、
 * 権限を付け外しする試験（changesPermissions）だけが withPermissionScenario（排他の鍵と差分の復元）を使う。共有同士は待ち合わない
 * （既定の複数 worker で流しても、権限を変えない試験どうしは止め合わない）。
 * 鍵の取る順は、14314,2（返品の設定）→ 190520,0（権限）。逆に取る所は無い。
 * 発注書・受取・書類は追記専用で消せないので、試験ごとに新しい商品（createCatalogMaterial）で作って干渉させず、
 * 終わりに、作った発注書の残りを打ち切って閉じる（置き場に置いたファイルも、製品が消す道を持たないので残る）。
 *
 * 注意: 試験の材料づくりと bridge は DB の接続を1本で共有する。材料の取引（withGroupG1Material の BEGIN/SAVEPOINT）の最中に
 * 画面の要求が bridge へ届くと、同じ取引に混ざる。材料を書く時は、画面の要求が止まっている間（描画の待ちが済んだ後）に書く。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, type Locator, type Page } from '@playwright/test';
import { calcRequiredQuantity, INVENTORY_LIST_TEXT } from '@/lib/inventory/inventory-list-types';
import {
  hasPurchaseOrderDocumentSignature,
  parsePurchaseOrderDetail,
  parsePurchaseOrderDocumentSearchRow,
  parsePurchaseOrderListRow,
  PURCHASE_ORDER_DETAIL_TEXT,
  PURCHASE_ORDER_DOCUMENT_ERRORS,
  PURCHASE_ORDER_DOCUMENT_MAX_BYTES,
  PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIST_TEXT,
  PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE,
  PURCHASE_ORDER_TEXT,
  purchaseOrderDocumentMimeOfName,
  purchaseOrderErrorBody,
  type PurchaseOrderDetail,
  type PurchaseOrderSurface,
} from '@/lib/purchase-orders/purchase-order-types';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines } from '../tests/integration/db/helpers/order-fixtures';
import {
  assertLocalE2eDb,
  localFixtureAdminId,
  lockE2eInventory,
  seedE2eRestock,
  withGroupG1Material,
} from './group-g1-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { createPermissionActor, withPermissionScenario } from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';

export { PRICE };

// ---------------------------------------------------------------------------------------------------------------------
// 試験の場面
// ---------------------------------------------------------------------------------------------------------------------

export type PurchasingContext = {
  client: PgClient;
  /** 試験の実行者（役割 admin。初期値で在庫・発注・受け取りの権限を全て持つ） */
  actorId: string;
  /** 作った発注書を、終わりに閉じる対象に足す（bridge が作った発注書は自動で足される） */
  track: (purchaseOrderId: string) => void;
};

const trackedByClient = new WeakMap<PgClient, Set<string>>();

function trackedOf(client: PgClient): Set<string> {
  let tracked = trackedByClient.get(client);
  if (!tracked) {
    tracked = new Set<string>();
    trackedByClient.set(client, tracked);
  }
  return tracked;
}

/**
 * 在庫・発注の試験の場面。手元の DB の接続1本と、役割 admin の実行者を用意し、終わりに作った発注書の残りを打ち切って閉じる。
 * 既定は、権限の鍵（190520, 0）を共有で持つ（権限を付け外しする試験が排他で動く間は待ち、権限を変えない試験どうしは待ち合わない）。
 * 権限を付け外しする試験は changesPermissions を付ける: withPermissionScenario（排他の鍵と、終わりの差分の復元）の上で動く。
 */
export async function withPurchasingScenario(
  run: (ctx: PurchasingContext) => Promise<void>,
  options: { changesPermissions?: boolean } = {},
): Promise<void> {
  const body = async (client: PgClient): Promise<void> => {
    assertLocalE2eDb(client);
    const actorId = await createPermissionActor(client, 'admin');
    const ctx: PurchasingContext = { client, actorId, track: (id) => { trackedOf(client).add(id); } };
    try {
      await run(ctx);
    } finally {
      await closeTrackedOrders(client, actorId);
    }
  };
  if (options.changesPermissions) {
    await withPermissionScenario(body);
    return;
  }
  await withLocalDb(async (client) => {
    await client.query('select pg_catalog.pg_advisory_lock_shared(190520, 0)');
    try {
      await body(client);
    } finally {
      await client.query('select pg_catalog.pg_advisory_unlock_shared(190520, 0)');
    }
  });
}

/** 作った発注書の残りを打ち切る（数量確定前は全行の取消、確定後は未納のある行）。終わりの後始末なので、失敗は握りつぶす */
async function closeTrackedOrders(client: PgClient, actorId: string): Promise<void> {
  for (const id of trackedOf(client)) {
    try {
      await client.query('rollback').catch(() => undefined);
      const detail = await readPurchaseOrder(client, actorId, id);
      const lineIds = detail.stage === 'ordered'
        ? detail.lines.map((line) => line.id)
        : detail.lines.filter((line) => (line.outstandingQuantity ?? 0) > 0).map((line) => line.id);
      if (lineIds.length === 0) continue;
      await callDb(client, 'admin_short_close_purchase_order', [
        ['_purchase_order_id', id, 'uuid'], ['_expected_version', detail.version], ['_line_ids', lineIds, 'uuid[]'],
        ['_reason', 'E2E の後始末', 'text'], ['_actor_id', actorId, 'uuid'], ['_request_key', randomUUID(), 'uuid'],
      ]);
    } catch {
      // 後始末の失敗は試験の結果にしない
    }
  }
  trackedOf(client).clear();
}

// ---------------------------------------------------------------------------------------------------------------------
// 材料: 商品・注文・在庫
// ---------------------------------------------------------------------------------------------------------------------

export type CatalogMaterial = {
  itemId: number;
  variantId: number;
  itemName: string;
  colorName: string;
  sizeLabel: string;
};

/** 試験ごとの新しい商品（非公開・色1つ・サイズ1つ）。商品名は試験ごとに違うので、画面の行を名前で選べる */
export async function createCatalogMaterial(db: PgClient): Promise<CatalogMaterial> {
  assertLocalE2eDb(db);
  const fx = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
  const name = (await db.query('select name from public.items where id = $1', [fx.itemId])).rows[0].name as string;
  return { itemId: fx.itemId, variantId: fx.variantId, itemName: name, colorName: fx.colorName, sizeLabel: fx.sizeLabel };
}

/** 画面の呼び名（在庫一覧表の発注数量の欄・発注書の明細の行と同じ並び: 商品名 色 サイズ） */
export function materialLabel(material: CatalogMaterial): string {
  return `${material.itemName} ${material.colorName} ${material.sizeLabel}`;
}

/**
 * 入金済みの待ち注文（受注生産の明細1行・割当なし）。orderedAt を渡すと、その注文日で作る（注文日は後から変えられないので作る時に決める）。
 * 入荷（発注の受け取り・棚卸の増など）の FIFO は、注文日の古い順にこの注文へ割り当てる。
 */
export async function createWaitingOrder(
  db: PgClient,
  input: { catalog: Pick<CatalogMaterial, 'itemId' | 'variantId'>; quantity: number; orderedAt?: string },
): Promise<{ orderId: string; orderItemId: string }> {
  assertLocalE2eDb(db);
  return withGroupG1Material(db, async () => {
    await lockE2eInventory(db, { variantIds: [input.catalog.variantId] });
    const order = await insertOrderWithLines(db, {
      status: 'paid',
      paidAmount: PRICE * input.quantity,
      createdAt: input.orderedAt,
      shippingEmail: `e2e-g2-waiting-${randomUUID().slice(0, 8)}@example.com`,
      lines: [{ itemId: input.catalog.itemId, variantId: input.catalog.variantId, quantity: input.quantity, fulfillmentType: 'backorder' }],
    });
    return { orderId: order.orderId, orderItemId: order.orderItemIds[0] };
  });
}

export type InventoryNumbers = { free: number; paidAllocated: number; paymentHeld: number; onHand: number; waiting: number };

/** G-1 の在庫の数え方（空き・入金済みの割当・支払い前の仮確保・手元・待ち）。商品の編集画面・在庫一覧表と同じ数 */
export async function variantInventory(db: PgClient, variantId: number): Promise<InventoryNumbers> {
  const row = (await db.query(
    'select free, paid_allocated, payment_held, on_hand, waiting from public.list_group_g_variant_inventory(array[$1::bigint])',
    [variantId],
  )).rows[0];
  return {
    free: Number(row.free), paidAllocated: Number(row.paid_allocated), paymentHeld: Number(row.payment_held),
    onHand: Number(row.on_hand), waiting: Number(row.waiting),
  };
}

export type InventoryListNumbers = { orderQuantity: number; onHand: number; onOrder: number; required: number };

/** 在庫一覧表の1行の数（DB の関数 list_admin_inventory。画面と同じ元）。行が無ければ null */
export async function readInventoryRow(db: PgClient, actorId: string, variantId: number): Promise<InventoryListNumbers | null> {
  const found = await db.query(
    'select to_jsonb(s) as row from public.list_admin_inventory(_actor_id => $1::uuid) as s where s.variant_id = $2',
    [actorId, variantId],
  );
  const row = found.rows[0]?.row as Record<string, number> | undefined;
  if (!row) return null;
  return { orderQuantity: row.order_quantity, onHand: row.on_hand, onOrder: row.on_order, required: row.required };
}

/** 注文の明細の、入金済みの割当（A）の残り */
export async function paidAllocationOf(db: PgClient, orderItemId: string): Promise<number> {
  return Number((await db.query(
    `select coalesce(sum(remaining_quantity), 0)::int as n from public.order_item_allocations where order_item_id = $1 and kind = 'paid'`,
    [orderItemId],
  )).rows[0].n);
}

/**
 * 棚卸の増減（本物の入口 admin_record_stock_movement。理由 adjustment）。減らす時に外す割当があれば、入口が返す確認の点数で
 * 送り直す（画面と同じ約束）。外した点数を返す。
 */
export async function adjustStock(
  db: PgClient,
  input: { itemId: number; variantId: number; quantity: number },
): Promise<{ releasedQuantity: number }> {
  assertLocalE2eDb(db);
  return withGroupG1Material(db, async () => {
    const actorId = await localFixtureAdminId(db);
    const call = async (expected: number | null): Promise<{ releasedQuantity: number }> => {
      const result = (await db.query(
        `select public.admin_record_stock_movement($1::bigint, $2::bigint, $3::integer, 'adjustment', 'E2E', $4::uuid, $5::uuid, $6::integer) as result`,
        [input.itemId, input.variantId, input.quantity, actorId, randomUUID(), expected],
      )).rows[0].result as { releasedQuantity?: number };
      return { releasedQuantity: Number(result.releasedQuantity ?? 0) };
    };
    await db.query('savepoint adjust_stock_first');
    try {
      return await call(null);
    } catch (error) {
      await db.query('rollback to savepoint adjust_stock_first');
      const released = releasedQuantityOf((error as { detail?: unknown }).detail);
      if (released === null) throw error;
      return call(released);
    }
  });
}

/** 入荷（本物の入口。待ち注文があれば、古い順に FIFO で割り当てる） */
export async function restockStock(db: PgClient, input: { itemId: number; variantId: number; quantity: number }): Promise<void> {
  await seedE2eRestock(db, input);
}

// ---------------------------------------------------------------------------------------------------------------------
// DB の関数の呼び出し（試験の材料づくりと、bridge が共有する）
// ---------------------------------------------------------------------------------------------------------------------

type DbArg = readonly [name: string, value: unknown, cast?: string];

/**
 * `select public.<fn>(_name => $1, …) as result` を1回流して result を返す。引数は名前で渡す（順番の取り違えを避ける）。
 * 型を付けない引数は DB の関数の宣言の型で解決される。誤りは pg の誤りのまま投げる。
 */
export async function callDb(db: PgClient, fn: string, args: readonly DbArg[]): Promise<Record<string, unknown>> {
  const list = args.map(([name, , cast], index) => `${name} => $${index + 1}${cast ? `::${cast}` : ''}`).join(', ');
  const result = await db.query(
    `select public.${fn}(${list}) as result`,
    args.map(([, value, cast]) => (cast === 'jsonb' ? JSON.stringify(value) : value)),
  );
  return result.rows[0].result as Record<string, unknown>;
}

/** 発注書の詳細（DB の関数 get_admin_purchase_order。画面と同じ元）を検査した形で読む */
export async function readPurchaseOrder(db: PgClient, actorId: string, purchaseOrderId: string): Promise<PurchaseOrderDetail> {
  const result = await db.query(
    'select public.get_admin_purchase_order(_purchase_order_id => $1::uuid, _actor_id => $2::uuid) as result',
    [purchaseOrderId, actorId],
  );
  return parsePurchaseOrderDetail(result.rows[0].result);
}

export type CreatedPurchaseOrder = { id: string; number: string; version: number };

/** 発注書を DB の関数で作る（数量確定待ち）。画面の操作を確かめない試験の材料 */
export async function createPurchaseOrderInDb(
  ctx: PurchasingContext,
  input: { lines: Array<{ variantId: number; quantity: number }>; supplierName?: string; memo?: string | null },
): Promise<CreatedPurchaseOrder> {
  const result = await callDb(ctx.client, 'admin_create_purchase_order', [
    ['_supplier_name', input.supplierName ?? `E2E 発注先 ${randomUUID().slice(0, 8)}`, 'text'],
    ['_memo', input.memo ?? null, 'text'],
    ['_lines', input.lines, 'jsonb'],
    ['_actor_id', ctx.actorId, 'uuid'],
    ['_request_key', randomUUID(), 'uuid'],
  ]);
  const created = { id: result.id as string, number: result.number as string, version: Number(result.version) };
  ctx.track(created.id);
  return created;
}

/** 数量を確定する（DB の関数）。quantities を省くと、全行を仮数量のまま・単価は未登録で確定する */
export async function confirmPurchaseOrderInDb(
  ctx: PurchasingContext,
  purchaseOrderId: string,
  quantities?: Array<{ quantity: number; unitPriceYen?: number | null }>,
): Promise<PurchaseOrderDetail> {
  const detail = await readPurchaseOrder(ctx.client, ctx.actorId, purchaseOrderId);
  await callDb(ctx.client, 'admin_confirm_purchase_order_quantities', [
    ['_purchase_order_id', purchaseOrderId, 'uuid'],
    ['_expected_version', detail.version],
    ['_lines', detail.lines.map((line, index) => ({
      lineId: line.id,
      quantity: quantities?.[index]?.quantity ?? line.provisionalQuantity,
      unitPriceYen: quantities?.[index]?.unitPriceYen ?? null,
    })), 'jsonb'],
    ['_reason', null, 'text'],
    ['_actor_id', ctx.actorId, 'uuid'],
    ['_request_key', randomUUID(), 'uuid'],
  ]);
  return readPurchaseOrder(ctx.client, ctx.actorId, purchaseOrderId);
}

/** 受け取る（DB の関数）。lines は発注書の行の並びの番号と数。受取日は日本時間の今日 */
export async function receivePurchaseOrderInDb(
  ctx: PurchasingContext,
  purchaseOrderId: string,
  lines: Array<{ lineIndex: number; quantity: number }>,
): Promise<{ receiptId: string; allocatedQuantity: number }> {
  const detail = await readPurchaseOrder(ctx.client, ctx.actorId, purchaseOrderId);
  const result = await callDb(ctx.client, 'admin_receive_purchase_order', [
    ['_purchase_order_id', purchaseOrderId, 'uuid'],
    ['_expected_version', detail.version],
    ['_received_on', jstToday(), 'date'],
    ['_memo', null, 'text'],
    ['_lines', lines.map((line) => ({ lineId: detail.lines[line.lineIndex].id, quantity: line.quantity })), 'jsonb'],
    ['_actor_id', ctx.actorId, 'uuid'],
    ['_request_key', randomUUID(), 'uuid'],
  ]);
  return { receiptId: result.receiptId as string, allocatedQuantity: Number(result.allocatedQuantity) };
}

/** 日本時間の今日（YYYY-MM-DD） */
export function jstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 窓口の約束（外す割当の確認）の DETAIL `{"releasedQuantity": n}` から点数を取る。形が違えば null */
function releasedQuantityOf(detail: unknown): number | null {
  if (typeof detail !== 'string') return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1) return null;
    const { releasedQuantity } = parsed as { releasedQuantity?: unknown };
    return typeof releasedQuantity === 'number' && Number.isInteger(releasedQuantity) && releasedQuantity >= 0 ? releasedQuantity : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 原本の置き場（手元の Storage）
// ---------------------------------------------------------------------------------------------------------------------

const DOCUMENT_BUCKET = 'purchase-order-documents';
const STORAGE_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|jpg|jpeg|png))$/;

/** 手元の Storage の接続。手元でなければ何も送らずに止める（鍵・住所は出力しない） */
function documentStorage(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('PURCHASING_E2E_LOCAL_STORAGE_REQUIRED');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 署名つきの URL が手元の Storage の物か（手元でなければ止める。URL は出力しない） */
function assertLocalSignedUrl(signedUrl: string): void {
  if (!isLocalUrl(signedUrl)) throw new Error('PURCHASING_E2E_LOCAL_STORAGE_REQUIRED');
}

class DocumentError extends Error {
  constructor(public readonly documentCode: keyof typeof PURCHASE_ORDER_DOCUMENT_ERRORS) {
    super(documentCode);
  }
}

/** 試験で使う小さな本物の PDF（先頭の印は `%PDF-`）。label を変えると中身（ハッシュ）が変わる */
export function pdfBytes(label: string = randomUUID()): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'utf8');
}

/** 試験で使う本物の PNG（1x1。先頭の印は PNG の8バイト）。label は中身を変えない（ファイル名で区別する） */
export function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type StoredDocument = { attachmentId: string; reservationId: string; fileName: string; bytes: Buffer };

/**
 * 書類を DB と置き場へ直に付ける（画面の保存の道は FR-ADMIN-119 の①④⑦が確かめる）。予約 → 置き場へ置く → 確定（bridge と同じ道）。
 * 差し替えなら replacesAttachmentId を予約に残す。
 */
export async function attachDocumentInDb(
  ctx: PurchasingContext,
  input: {
    purchaseOrderId: string;
    kind?: 'quote' | 'invoice';
    fileName: string;
    bytes: Buffer;
    contentType: string;
    transactionDate: string;
    amountYen: number;
    counterparty: string;
    replacesAttachmentId?: string | null;
  },
): Promise<StoredDocument> {
  const reserved = await callDb(ctx.client, 'admin_reserve_purchase_order_attachment', [
    ['_purchase_order_id', input.purchaseOrderId, 'uuid'], ['_kind', input.kind ?? 'quote', 'text'], ['_file_name', input.fileName, 'text'],
    ['_replaces_attachment_id', input.replacesAttachmentId ?? null, 'uuid'], ['_actor_id', ctx.actorId, 'uuid'],
    ['_request_key', randomUUID(), 'uuid'],
  ]);
  const storagePath = reserved.storagePath as string;
  if (!STORAGE_PATH.test(storagePath)) throw new Error('PURCHASING_E2E_STORAGE_PATH_INVALID');
  const uploaded = await documentStorage().storage.from(DOCUMENT_BUCKET).upload(storagePath, input.bytes, {
    contentType: input.contentType, upsert: false,
  });
  if (uploaded.error) throw new Error('PURCHASING_E2E_STORAGE_UPLOAD_FAILED');
  const attached = await attachFromStorage(ctx.client, ctx.actorId, input.purchaseOrderId, {
    reservationId: reserved.reservationId as string,
    sha256: sha256Of(input.bytes),
    transactionDate: input.transactionDate,
    amountYen: input.amountYen,
    currency: 'JPY',
    counterparty: input.counterparty,
    requestKey: randomUUID(),
  });
  return { attachmentId: attached.attachmentId, reservationId: reserved.reservationId as string, fileName: input.fileName, bytes: input.bytes };
}

type AttachBody = {
  reservationId: string;
  sha256: string | null;
  transactionDate: string;
  amountYen: number;
  currency: string;
  counterparty: string;
  requestKey: string;
};

/** 予約を置き場から読み戻して検査し、DB の確定の関数を1回呼ぶ（窓口 attachPurchaseOrderDocument と同じ順。署名つきの URL は使わない） */
async function attachFromStorage(
  db: PgClient, actorId: string, purchaseOrderId: string, body: AttachBody,
): Promise<{ attachmentId: string; revisionNo: number; replayed: boolean }> {
  const reservation = (await db.query(
    'select storage_path from public.purchase_order_attachment_reservations where id = $1::uuid and purchase_order_id = $2::uuid',
    [body.reservationId, purchaseOrderId],
  )).rows[0] as { storage_path?: string } | undefined;
  if (!reservation?.storage_path || !STORAGE_PATH.test(reservation.storage_path)) {
    throw Object.assign(new Error('GROUP_G_PO_DOCUMENT_RESERVATION_INVALID'), { code: '55000' });
  }
  const downloaded = await documentStorage().storage.from(DOCUMENT_BUCKET).download(reservation.storage_path);
  if (downloaded.error || !downloaded.data) {
    const { status, statusCode } = (downloaded.error ?? {}) as { status?: unknown; statusCode?: unknown };
    throw new DocumentError(status === 404 || statusCode === '404' || statusCode === 404 ? 'DOCUMENT_NOT_UPLOADED' : 'DOCUMENT_STORAGE_UNAVAILABLE');
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const mimeType = purchaseOrderDocumentMimeOfName(reservation.storage_path);
  if (mimeType === null || !hasPurchaseOrderDocumentSignature(bytes, mimeType)) throw new DocumentError('DOCUMENT_TYPE_UNSUPPORTED');
  const recorded = downloaded.data.type.split(';')[0].trim().toLowerCase();
  if (recorded !== '' && recorded !== mimeType) throw new DocumentError('DOCUMENT_TYPE_UNSUPPORTED');
  if (bytes.length > PURCHASE_ORDER_DOCUMENT_MAX_BYTES) throw new DocumentError('DOCUMENT_TOO_LARGE');
  const sha256 = sha256Of(bytes);
  if (body.sha256 !== null && body.sha256 !== sha256) throw new DocumentError('DOCUMENT_HASH_MISMATCH');

  const result = await callDb(db, 'admin_attach_purchase_order_document', [
    ['_reservation_id', body.reservationId, 'uuid'], ['_purchase_order_id', purchaseOrderId, 'uuid'], ['_mime_type', mimeType, 'text'],
    ['_size_bytes', bytes.length], ['_sha256', sha256, 'text'], ['_sha256_source', body.sha256 === null ? 'server' : 'browser', 'text'],
    ['_transaction_date', body.transactionDate], ['_amount_yen', body.amountYen], ['_currency', body.currency, 'text'],
    ['_counterparty', body.counterparty.trim(), 'text'], ['_actor_id', actorId, 'uuid'], ['_request_key', body.requestKey, 'uuid'],
  ]);
  return { attachmentId: result.attachmentId as string, revisionNo: Number(result.revisionNo), replayed: Boolean(result.replayed) };
}

/** 置き場に、その予約のファイルが置かれているか（保存済みでも DB が未確定の予約を作る試験の確認用） */
export async function reservationObjectExists(db: PgClient, reservationId: string): Promise<boolean> {
  const row = (await db.query('select storage_path from public.purchase_order_attachment_reservations where id = $1::uuid', [reservationId]))
    .rows[0] as { storage_path?: string } | undefined;
  const match = row?.storage_path ? STORAGE_PATH.exec(row.storage_path) : null;
  if (!match) return false;
  const listed = await documentStorage().storage.from(DOCUMENT_BUCKET).list(match[1], { search: match[2] });
  return !listed.error && (listed.data ?? []).some((entry) => entry.name === match[2]);
}

/** 発注書の予約（添付に結ばれていない物）と添付の数。画面を介さず DB を直に数える */
export async function documentCountsOf(db: PgClient, purchaseOrderId: string): Promise<{ reservations: number; attachments: number }> {
  const row = (await db.query(
    `select (select count(*)::int from public.purchase_order_attachment_reservations where purchase_order_id = $1::uuid) as reservations,
            (select count(*)::int from public.purchase_order_attachments where purchase_order_id = $1::uuid) as attachments`,
    [purchaseOrderId],
  )).rows[0];
  return { reservations: row.reservations as number, attachments: row.attachments as number };
}

// ---------------------------------------------------------------------------------------------------------------------
// bridge: 画面が呼ぶ窓口 → DB の公開関数
// ---------------------------------------------------------------------------------------------------------------------

type Reply = { status: number; body: unknown };

const GENERIC_FAILURE: Reply = { status: 500, body: { error: PURCHASE_ORDER_TEXT.failed } };

/** DB の拒否を、窓口と同じ { code, error }（外す割当の確認は releasedQuantity つき）と HTTP の状態にする。決まった組でなければ固定の500 */
function dbErrorReply(error: unknown, surface: PurchaseOrderSurface = 'order'): Reply {
  if (error instanceof DocumentError) {
    const [status, text] = PURCHASE_ORDER_DOCUMENT_ERRORS[error.documentCode];
    return { status, body: { code: error.documentCode, error: text } };
  }
  const { message, code, detail } = (error ?? {}) as { message?: unknown; code?: unknown; detail?: unknown };
  if (typeof message !== 'string' || !Object.hasOwn(PURCHASE_ORDER_ERRORS, message)) return GENERIC_FAILURE;
  const [sqlstate, status] = PURCHASE_ORDER_ERRORS[message];
  if (code !== sqlstate) return GENERIC_FAILURE;
  const body: Record<string, unknown> = { code: message, error: purchaseOrderErrorBody(message, surface) };
  if (message === PURCHASE_ORDER_RELEASE_CONFIRMATION_CODE) {
    const released = releasedQuantityOf(detail);
    if (released === null) return GENERIC_FAILURE;
    body.releasedQuantity = released;
  }
  return { status, body };
}

/**
 * 読み取りの窓口の失敗。route と同じく、権限の拒否（message と SQLSTATE がそろった GROUP_G_FORBIDDEN）だけを 403 にし、
 * 表の他の code も、形の崩れも、その画面の固定の文（apiFailed）の 500 にする（DB の文は出さない）。
 */
function readErrorReply(error: unknown, apiFailed: string, forbiddenBody?: unknown): Reply {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  if (message === 'GROUP_G_FORBIDDEN' && code === '42501') {
    return { status: 403, body: forbiddenBody ?? dbErrorReply(error).body };
  }
  return { status: 500, body: { error: apiFailed } };
}

/** 窓口の store と同じ整数の見方（0 以上 2147483647 以下） */
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;

/** 在庫一覧表の1行を、窓口の store と同じ整合で検査して camelCase にする。崩れていれば投げる（窓口は固定の500にする） */
function checkInventoryRow(raw: Record<string, unknown>, seen: Set<number>): Record<string, unknown> {
  const { variant_id: variantId, item_id: itemId } = raw;
  const numbers = [raw.free, raw.paid_allocated, raw.payment_held, raw.on_hand, raw.order_quantity, raw.on_order, raw.required];
  if (typeof variantId !== 'number' || !Number.isSafeInteger(variantId) || variantId <= 0 || seen.has(variantId)
    || typeof itemId !== 'number' || !Number.isSafeInteger(itemId) || itemId <= 0
    || typeof raw.item_name !== 'string' || typeof raw.is_active !== 'boolean'
    || !(raw.color_name === null || typeof raw.color_name === 'string') || !(raw.size_label === null || typeof raw.size_label === 'string')
    || !numbers.every(isCount)) {
    throw new Error('INVENTORY_READ_FAILED');
  }
  const [free, paidAllocated, paymentHeld, onHand, orderQuantity, onOrder, required] = numbers as number[];
  if (onHand !== free + paidAllocated + paymentHeld || required !== calcRequiredQuantity(orderQuantity, onHand, onOrder)) {
    throw new Error('INVENTORY_READ_FAILED');
  }
  seen.add(variantId);
  return camelKeys(raw);
}

const camel = (key: string): string => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** 列名を camelCase にする（omit に挙げた列は落とす。行ごとの total や、名前を替える列） */
function camelKeys(row: Record<string, unknown>, omit: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omit.includes(key)).map(([key, value]) => [camel(key), value]));
}

const ID = '([0-9a-fA-F-]{36})';
const ROUTES = {
  inventory: /^\/api\/admin\/inventory$/,
  orders: /^\/api\/admin\/purchase-orders$/,
  order: new RegExp(`^/api/admin/purchase-orders/${ID}$`),
  quantities: new RegExp(`^/api/admin/purchase-orders/${ID}/quantities$`),
  shortClosures: new RegExp(`^/api/admin/purchase-orders/${ID}/short-closures$`),
  receipts: new RegExp(`^/api/admin/purchase-orders/${ID}/receipts$`),
  reversals: new RegExp(`^/api/admin/purchase-orders/${ID}/receipts/${ID}/reversals$`),
  attachments: new RegExp(`^/api/admin/purchase-orders/${ID}/attachments$`),
  reservations: new RegExp(`^/api/admin/purchase-orders/${ID}/attachments/reservations$`),
  uploadUrl: new RegExp(`^/api/admin/purchase-orders/${ID}/attachments/reservations/${ID}/upload-url$`),
  revisions: new RegExp(`^/api/admin/purchase-orders/${ID}/attachments/${ID}/revisions$`),
  documentUrl: new RegExp(`^/api/admin/purchase-orders/${ID}/attachments/${ID}/url$`),
  documents: /^\/api\/admin\/purchase-order-documents$/,
} as const;

type Body = Record<string, any>;

const trimmedOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** 書き込みの窓口の呼び出し。成功の本文は窓口と同じ形で、必要な項目だけを取る */
async function runWriter(
  db: PgClient, actorId: string, fn: string, args: readonly DbArg[], pick: readonly string[], status: number, surface: PurchaseOrderSurface = 'order',
): Promise<Reply> {
  try {
    const result = await callDb(db, fn, [...args, ['_actor_id', actorId, 'uuid']]);
    return { status, body: Object.fromEntries(pick.map((key) => [key, result[key]])) };
  } catch (error) {
    return dbErrorReply(error, surface);
  }
}

/**
 * 発注書を読める権限（DB の関数が確かめる）。書き込みの無い照会の最初の確かめ（窓口 assertCanReadOrder と同じ）。
 * 権限の拒否は 403、発注書が無ければ 404、他の失敗は窓口ごとの固定の文（failedText）の 500。
 */
async function assertCanRead(db: PgClient, actorId: string, purchaseOrderId: string, failedText: string): Promise<Reply | null> {
  try {
    const result = await db.query(
      'select public.get_admin_purchase_order(_purchase_order_id => $1::uuid, _actor_id => $2::uuid) as result', [purchaseOrderId, actorId],
    );
    return result.rows[0].result === null ? dbErrorReply({ message: 'GROUP_G_PO_NOT_FOUND', code: 'P0002' }) : null;
  } catch (error) {
    return readErrorReply(error, failedText);
  }
}

async function dispatch(db: PgClient, actorId: string, method: string, url: URL, readBody: () => Body): Promise<Reply | null> {
  const { pathname } = url;
  const match = (route: RegExp): RegExpExecArray | null => route.exec(pathname);

  if (match(ROUTES.inventory)) {
    if (method !== 'GET') return null;
    try {
      const result = await db.query('select to_jsonb(s) as row from public.list_admin_inventory(_actor_id => $1::uuid) as s', [actorId]);
      const seen = new Set<number>();
      return { status: 200, body: { rows: result.rows.map((row) => checkInventoryRow(row.row as Record<string, unknown>, seen)) } };
    } catch (error) {
      return readErrorReply(error, INVENTORY_LIST_TEXT.apiFailed, { error: INVENTORY_LIST_TEXT.forbidden, code: 'GROUP_G_FORBIDDEN' });
    }
  }

  if (match(ROUTES.orders)) {
    if (method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const page = Number(url.searchParams.get('page') ?? 1);
      try {
        const result = await db.query(
          'select to_jsonb(s) as row from public.list_admin_purchase_order_lines(_limit => $1, _offset => $2, _actor_id => $3::uuid) as s',
          [limit, (page - 1) * limit, actorId],
        );
        const total = result.rows.length > 0 ? Number(result.rows[0].row.total) : 0;
        // 窓口の store と同じ純粋な検査を通して、決まった列だけを返す（崩れていれば投げて固定の500にする）
        const rows = result.rows.map((row) => parsePurchaseOrderListRow(camelKeys(row.row as Record<string, unknown>, ['total'])));
        return { status: 200, body: { rows, total, page, limit } };
      } catch (error) {
        return readErrorReply(error, PURCHASE_ORDER_LIST_TEXT.apiFailed);
      }
    }
    if (method !== 'POST') return null;
    const body = readBody();
    const reply = await runWriter(db, actorId, 'admin_create_purchase_order', [
      ['_supplier_name', typeof body.supplierName === 'string' ? body.supplierName.trim() : body.supplierName, 'text'],
      ['_memo', trimmedOrNull(body.memo), 'text'],
      ['_lines', body.lines, 'jsonb'],
      ['_request_key', body.requestKey, 'uuid'],
    ], ['id', 'number', 'version', 'replayed'], 201);
    if (reply.status === 201) trackedOf(db).add((reply.body as { id: string }).id);
    return reply;
  }

  const order = match(ROUTES.order);
  if (order) {
    const [, id] = order;
    if (method === 'GET') {
      try {
        const result = await db.query(
          'select public.get_admin_purchase_order(_purchase_order_id => $1::uuid, _actor_id => $2::uuid) as result', [id, actorId],
        );
        if (result.rows[0].result === null) return { status: 404, body: { error: PURCHASE_ORDER_DETAIL_TEXT.notFound } };
        // 窓口の store と同じ純粋な検査と id の照合（頼んだ発注書以外が返ったら読み違いの500）
        const purchaseOrder = parsePurchaseOrderDetail(result.rows[0].result);
        if (purchaseOrder.id !== id.toLowerCase()) throw new Error('PURCHASE_ORDER_READ_FAILED');
        return { status: 200, body: { purchaseOrder } };
      } catch (error) {
        return readErrorReply(error, PURCHASE_ORDER_DETAIL_TEXT.apiFailed);
      }
    }
    if (method !== 'PATCH') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_update_purchase_order_header', [
      ['_purchase_order_id', id, 'uuid'], ['_expected_version', body.expectedVersion],
      ['_supplier_name', typeof body.supplierName === 'string' ? body.supplierName.trim() : body.supplierName, 'text'],
      ['_memo', trimmedOrNull(body.memo), 'text'], ['_reason', typeof body.reason === 'string' ? body.reason.trim() : body.reason, 'text'],
      ['_request_key', body.requestKey, 'uuid'],
    ], ['version', 'replayed'], 200);
  }

  const quantities = match(ROUTES.quantities);
  if (quantities) {
    if (method !== 'POST') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_confirm_purchase_order_quantities', [
      ['_purchase_order_id', quantities[1], 'uuid'], ['_expected_version', body.expectedVersion], ['_lines', body.lines, 'jsonb'],
      ['_reason', trimmedOrNull(body.reason), 'text'], ['_request_key', body.requestKey, 'uuid'],
    ], ['version', 'changedLines', 'replayed'], 201);
  }

  const shortClosures = match(ROUTES.shortClosures);
  if (shortClosures) {
    if (method !== 'POST') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_short_close_purchase_order', [
      ['_purchase_order_id', shortClosures[1], 'uuid'], ['_expected_version', body.expectedVersion], ['_line_ids', body.lineIds, 'uuid[]'],
      ['_reason', typeof body.reason === 'string' ? body.reason.trim() : body.reason, 'text'], ['_request_key', body.requestKey, 'uuid'],
    ], ['version', 'closedQuantity', 'replayed'], 201);
  }

  const receipts = match(ROUTES.receipts);
  if (receipts) {
    if (method !== 'POST') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_receive_purchase_order', [
      ['_purchase_order_id', receipts[1], 'uuid'], ['_expected_version', body.expectedVersion], ['_received_on', body.receivedOn],
      ['_memo', trimmedOrNull(body.memo), 'text'], ['_lines', body.lines, 'jsonb'], ['_request_key', body.requestKey, 'uuid'],
    ], ['receiptId', 'version', 'allocatedQuantity', 'replayed'], 201, 'receipt');
  }

  const reversals = match(ROUTES.reversals);
  if (reversals) {
    if (method !== 'POST') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_reverse_purchase_order_receipt', [
      ['_purchase_order_id', reversals[1], 'uuid'], ['_expected_version', body.expectedVersion], ['_receipt_id', reversals[2], 'uuid'],
      ['_lines', body.lines, 'jsonb'], ['_reason', typeof body.reason === 'string' ? body.reason.trim() : body.reason, 'text'],
      ['_expected_release_quantity', body.expectedReleaseQuantity ?? null], ['_request_key', body.requestKey, 'uuid'],
    ], ['receiptId', 'version', 'releasedQuantity', 'replayed'], 201, 'receipt');
  }

  const reservations = match(ROUTES.reservations);
  if (reservations) {
    if (method !== 'POST') return null;
    const body = readBody();
    const reserved = await runWriter(db, actorId, 'admin_reserve_purchase_order_attachment', [
      ['_purchase_order_id', reservations[1], 'uuid'], ['_kind', body.kind, 'text'],
      ['_file_name', typeof body.fileName === 'string' ? body.fileName.trim() : body.fileName, 'text'],
      ['_replaces_attachment_id', body.replacesAttachmentId ?? null, 'uuid'], ['_request_key', body.requestKey, 'uuid'],
    ], ['reservationId', 'storagePath', 'expiresAt', 'replayed'], 201);
    if (reserved.status !== 201) return reserved;
    const { reservationId, storagePath, expiresAt, replayed } = reserved.body as Record<string, string | boolean>;
    const signed = await documentStorage().storage.from(DOCUMENT_BUCKET).createSignedUploadUrl(storagePath as string, { upsert: false });
    const signedUrl = signed.data?.signedUrl;
    if (signed.error || typeof signedUrl !== 'string' || signedUrl === '') return dbErrorReply(new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE'));
    assertLocalSignedUrl(signedUrl);
    return { status: 201, body: { reservationId, signedUrl, expiresAt, replayed } };
  }

  const uploadUrl = match(ROUTES.uploadUrl);
  if (uploadUrl) {
    if (method !== 'POST') return null;
    const denied = await assertCanRead(db, actorId, uploadUrl[1], PURCHASE_ORDER_TEXT.failed);
    if (denied) return denied;
    const reservation = (await db.query(
      'select storage_path from public.purchase_order_attachment_reservations where id = $1::uuid and purchase_order_id = $2::uuid',
      [uploadUrl[2], uploadUrl[1]],
    )).rows[0] as { storage_path?: string } | undefined;
    if (!reservation?.storage_path || !STORAGE_PATH.test(reservation.storage_path)) {
      return dbErrorReply({ message: 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID', code: '55000' });
    }
    const attached = await db.query('select 1 from public.purchase_order_attachments where reservation_id = $1::uuid', [uploadUrl[2]]);
    if (attached.rowCount > 0) return dbErrorReply({ message: 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', code: '55000' });
    const [, folder, objectName] = STORAGE_PATH.exec(reservation.storage_path) as RegExpExecArray;
    const storage = documentStorage().storage.from(DOCUMENT_BUCKET);
    const listed = await storage.list(folder, { search: objectName });
    if (listed.error || !Array.isArray(listed.data)) return dbErrorReply(new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE'));
    if (listed.data.some((entry) => entry.name === objectName)) return { status: 200, body: { uploaded: true } };
    const signed = await storage.createSignedUploadUrl(reservation.storage_path, { upsert: false });
    const signedUrl = signed.data?.signedUrl;
    if (signed.error || typeof signedUrl !== 'string' || signedUrl === '') return dbErrorReply(new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE'));
    assertLocalSignedUrl(signedUrl);
    return { status: 200, body: { uploaded: false, signedUrl } };
  }

  const attachments = match(ROUTES.attachments);
  if (attachments) {
    if (method !== 'POST') return null;
    try {
      const attached = await attachFromStorage(db, actorId, attachments[1], readBody() as AttachBody);
      return { status: 201, body: { attachmentId: attached.attachmentId, revisionNo: attached.revisionNo, replayed: attached.replayed } };
    } catch (error) {
      return dbErrorReply(error);
    }
  }

  const revisions = match(ROUTES.revisions);
  if (revisions) {
    if (method !== 'POST') return null;
    const body = readBody();
    return runWriter(db, actorId, 'admin_revise_purchase_order_document', [
      ['_attachment_id', revisions[2], 'uuid'], ['_purchase_order_id', revisions[1], 'uuid'],
      ['_transaction_date', body.transactionDate], ['_amount_yen', body.amountYen], ['_currency', body.currency, 'text'],
      ['_counterparty', typeof body.counterparty === 'string' ? body.counterparty.trim() : body.counterparty, 'text'],
      ['_voided', body.voided, 'boolean'], ['_reason', typeof body.reason === 'string' ? body.reason.trim() : body.reason, 'text'],
      ['_request_key', body.requestKey, 'uuid'],
    ], ['attachmentId', 'revisionNo', 'replayed'], 201);
  }

  const documentUrl = match(ROUTES.documentUrl);
  if (documentUrl) {
    if (method !== 'GET') return null;
    const denied = await assertCanRead(db, actorId, documentUrl[1], PURCHASE_ORDER_DOCUMENT_TEXT.openFailed);
    if (denied) return denied;
    try {
      const attachment = (await db.query(
        'select storage_path, original_file_name from public.purchase_order_attachments where id = $1::uuid and purchase_order_id = $2::uuid',
        [documentUrl[2], documentUrl[1]],
      )).rows[0] as { storage_path?: string; original_file_name?: string } | undefined;
      if (!attachment?.storage_path || !STORAGE_PATH.test(attachment.storage_path)) return dbErrorReply(new DocumentError('DOCUMENT_NOT_FOUND'));
      const download = url.searchParams.get('download') === '1';
      const bucket = documentStorage().storage.from(DOCUMENT_BUCKET);
      const signed = download
        ? await bucket.createSignedUrl(attachment.storage_path, 60, { download: attachment.original_file_name })
        : await bucket.createSignedUrl(attachment.storage_path, 60);
      if (signed.error) {
        // 置き場に無い（404）は route と同じく 404「原本を取得できません。」、他は置き場の不調（503）
        const { status, statusCode } = signed.error as { status?: unknown; statusCode?: unknown };
        const missing = status === 404 || statusCode === '404' || statusCode === 404;
        return dbErrorReply(new DocumentError(missing ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_STORAGE_UNAVAILABLE'));
      }
      const link = signed.data?.signedUrl;
      if (typeof link !== 'string' || link === '') return dbErrorReply(new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE'));
      assertLocalSignedUrl(link);
      return { status: 200, body: { url: link, expiresInSeconds: 60 } };
    } catch {
      return { status: 500, body: { error: PURCHASE_ORDER_DOCUMENT_TEXT.openFailed } };
    }
  }

  if (match(ROUTES.documents)) {
    if (method !== 'GET') return null;
    const q = url.searchParams;
    const text = (name: string): string | null => trimmedOrNull(q.get(name));
    const page = Number(q.get('page') ?? 1);
    const limit = PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT;
    try {
      const result = await db.query(
        `select to_jsonb(s) as row from public.search_purchase_order_documents(
           _date_from => $1, _date_to => $2, _amount_min => $3, _amount_max => $4, _counterparty => $5,
           _purchase_order_number => $6, _kind => $7, _include_history => $8::boolean, _limit => $9, _offset => $10, _actor_id => $11::uuid) as s`,
        [text('dateFrom'), text('dateTo'), text('amountMin'), text('amountMax'), text('counterparty'), text('number'), text('kind'),
          q.get('includeHistory') === '1', limit, (page - 1) * limit, actorId],
      );
      const total = result.rows.length > 0 ? Number(result.rows[0].row.total) : 0;
      // 窓口の store と同じ純粋な検査を通して、決まった列だけを返す（崩れていれば投げて固定の500にする）
      const rows = result.rows.map((row) => {
        const source = row.row as Record<string, unknown>;
        return parsePurchaseOrderDocumentSearchRow({ ...camelKeys(source, ['total', 'original_file_name']), fileName: source.original_file_name });
      });
      return { status: 200, body: { rows, total, page, limit: PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT } };
    } catch (error) {
      return readErrorReply(error, PURCHASE_ORDER_DOCUMENT_TEXT.searchApiFailed);
    }
  }

  return null;
}

/**
 * 在庫・発注・書類の窓口（/api/admin/inventory・/api/admin/purchase-orders**・/api/admin/purchase-order-documents）への画面の要求を、
 * 実行者 actorId で DB の公開関数へ橋渡しする。権限の許否は DB の関数が決める。決めていない方法（DELETE・PUT など）は本物の窓口へ渡す。
 * 後から登録した page.route が先に効くので、試験が答えを止めたり失敗させたりする時は、これより後に登録して route.fallback() で渡す。
 */
export async function mockPurchasingUiBridge(page: Page, client: PgClient, actorId: string): Promise<void> {
  assertLocalE2eDb(client);
  await page.route(
    (url) => url.pathname === '/api/admin/inventory' || url.pathname.startsWith('/api/admin/purchase-order'),
    async (route) => {
      const request = route.request();
      const readBody = (): Body => {
        try {
          return (request.postDataJSON() ?? {}) as Body;
        } catch {
          return {};
        }
      };
      let reply: Reply | null;
      try {
        reply = await dispatch(client, actorId, request.method(), new URL(request.url()), readBody);
      } catch (error) {
        reply = dbErrorReply(error);
      }
      if (reply === null) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: reply.status,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(reply.body),
      });
    },
  );
}

/** 管理者のログインの差し替え（役割 admin）と bridge を、画面を開く前に用意する */
export async function preparePurchasingPage(page: Page, ctx: PurchasingContext, role: 'admin' | 'supporter' = 'admin'): Promise<void> {
  await mockAdminSessionAs(page, role);
  await mockPurchasingUiBridge(page, ctx.client, ctx.actorId);
}

// ---------------------------------------------------------------------------------------------------------------------
// 画面の読み方
// ---------------------------------------------------------------------------------------------------------------------

/**
 * 頁自身の role=alert（画面が出す誤りの文）。Next の経路の読み上げ（`#__next-route-announcer__`。どの頁にも1つあり、移動の直後は新しい頁の題を載せる）は
 * 数えない。「誤りの alert が無い」の確かめに使う（文字の有無では分けないので、本物の誤りの alert は必ず数える）。
 */
export function contentAlerts(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/** 頁全体が横にはみ出さない（表は見出しを保ったスクロール領域の中で動く） */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
}

/** 在庫一覧表の、その商品（色・サイズ）の行 */
export function inventoryRowOf(page: Page, material: CatalogMaterial): Locator {
  return page.getByTestId('inventory-row').filter({ hasText: material.itemName }).filter({ hasText: material.colorName });
}

/** 在庫一覧表の行の数（注文数・在庫・発注済み・発注必要数）。行が出るまで待つ */
export async function readInventoryRowOnScreen(row: Locator): Promise<InventoryListNumbers> {
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  const cells = row.getByRole('cell');
  const number = async (cell: Locator): Promise<number> => Number((await cell.innerText()).replace(/[^0-9]/g, ''));
  return {
    orderQuantity: await number(cells.nth(3)),
    onHand: Number(await cells.nth(4).locator('span').first().innerText()),
    onOrder: await number(cells.nth(5)),
    required: await number(cells.nth(6)),
  };
}

/** 発注書の詳細の明細の行（商品名を含む行） */
export function lineRowOf(page: Page, material: CatalogMaterial): Locator {
  return page.getByTestId('purchase-order-line').filter({ hasText: material.itemName });
}

/** 発注書の詳細の明細の行から、数量の列（仮数量・発注数量・納品済み・未納）を読む。数量未確定の列は null */
export async function readLineQuantities(row: Locator): Promise<{ provisional: number; ordered: number | null; received: number; outstanding: number | null; unitPrice: string }> {
  await expect(row).toHaveCount(1);
  const cells = row.getByRole('cell');
  const asNumber = async (index: number): Promise<number | null> => {
    const text = (await cells.nth(index).innerText()).trim();
    return /^[0-9,]+$/.test(text) ? Number(text.replace(/,/g, '')) : null;
  };
  return {
    provisional: (await asNumber(3)) as number,
    ordered: await asNumber(4),
    received: (await asNumber(5)) as number,
    outstanding: await asNumber(6),
    unitPrice: (await cells.nth(7).innerText()).trim(),
  };
}
