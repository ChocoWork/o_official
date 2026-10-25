/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { createCatalogFixture } from './helpers/order-fixtures';
import { listAdminInventory, AdminInventoryError } from '@/lib/inventory/inventory-list-store';
import {
  attachPurchaseOrderDocument,
  createPurchaseOrderDocumentUrl,
  issueDocumentUploadUrl,
  reservePurchaseOrderDocument,
  revisePurchaseOrderDocument,
  searchPurchaseOrderDocuments,
} from '@/lib/purchase-orders/purchase-order-documents';
import {
  confirmPurchaseOrderQuantities,
  createPurchaseOrder,
  getAdminPurchaseOrder,
  listAdminPurchaseOrderLines,
  PurchaseOrderError,
  receivePurchaseOrder,
  reversePurchaseOrderReceipt,
  shortClosePurchaseOrder,
  updatePurchaseOrderHeader,
} from '@/lib/purchase-orders/purchase-order-store';
import {
  parsePurchaseOrderDetail,
  parsePurchaseOrderDocumentSearchRow,
  parsePurchaseOrderListRow,
  type PurchaseOrderDetail,
  type PurchaseOrderListRow,
} from '@/lib/purchase-orders/purchase-order-types';

/**
 * G-2 最終レビュー M3: 窓口の store から PostgREST の RPC を通って DB の関数に届く道を、1回ずつ本物で通す。
 *
 * ほかの G-2 の試験は、store の `client.rpc` を差し替える（単体）か、pg で関数を直に呼ぶ（DB 結合）か、画面の要求を DB へ橋渡しする（E2E）。
 * どれも `uuid[]` の `_line_ids`・`date`・`jsonb`・`bigint`・STABLE の読取・誤りの形（message / SQLSTATE / details）が PostgREST を通る道は通らない。
 * ここでは service_role の supabase-js で、本物の store の関数（作成・発注先の訂正・数量の確定・受け取り・取消・打切り・原本の予約と確定と訂正・
 * 在庫一覧・発注一覧・発注書の詳細・書類検索）を1回ずつ呼び、戻りを画面と同じ検査（parse*）に通す。
 *
 * 実行の前提: 手元の Supabase（db reset の後）。次の3つの環境変数が要る（鍵・署名つきの URL は出力しない）。
 * - DATABASE_URL: 手元の DB（材料づくり用。localhost 以外は動かさない）
 * - LOCAL_SUPABASE_URL: 手元の API の住所（localhost / 127.0.0.1 以外は動かさない）
 * - LOCAL_SUPABASE_SERVICE_ROLE_KEY: 手元の service_role の鍵
 * 未設定なら、理由を示して skip する。
 *
 * 発注書・受取・書類は追記専用で消せない。試験ごとに新しい商品・実行者を作り、終わりに発注書の残りを打ち切って閉じる（置き場のファイルは残る）。
 */
jest.setTimeout(120000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_OPTIONS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** 日本時間の今日（YYYY-MM-DD） */
const jstToday = (): string => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** 窓口が返す JSON を画面が読む形（JSON の往復） */
const overTheWire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describeLocalDb('integration: G-2 の store から PostgREST を通って DB の関数に届く道', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ（手元の Supabase の API の住所と service_role の鍵が要る）', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('G2_POSTGREST_LOCAL_API_REQUIRED');
    });
    return;
  }
  const client: SupabaseClient = createClient(LOCAL_API_URL, LOCAL_SERVICE_ROLE_KEY, CLIENT_OPTIONS);
  const tag = randomUUID().slice(0, 8);

  const state: {
    actorId?: string;
    itemId?: number;
    variantId?: number;
    purchaseOrderId?: string;
    purchaseOrderNumber?: string;
    lineId?: string;
    receiptId?: string;
    attachmentId?: string;
    pdf?: Buffer;
    counterparty?: string;
  } = {};
  const need = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) throw new Error(`前の手順が終わっていない: ${name}`);
    return value;
  };
  const actor = (): string => need(state.actorId, 'actor');
  const orderId = (): string => need(state.purchaseOrderId, 'purchaseOrderId');
  const readDetail = async (): Promise<PurchaseOrderDetail> => {
    const detail = await getAdminPurchaseOrder(client, actor(), orderId());
    if (detail === null) throw new Error('発注書が読めない');
    return detail;
  };

  /** G-1 の数え方の空き在庫（別の道で読む: 窓口の store ではなく DB の接続から） */
  const freeStock = async (): Promise<number> => {
    const found = await db().query('select free from public.list_group_g_variant_inventory(array[$1::bigint])', [state.variantId]);
    return Number(found.rows[0].free);
  };

  beforeAll(async () => {
    // 材料は DB の接続で作って確定させる（PostgREST は別の取引）。役割 admin は初期のまま在庫・発注・受け取りの権限を全て持つ
    const actorId = randomUUID();
    await db().query(
      `insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1::uuid, $2, jsonb_build_object('role', 'admin'), '{}'::jsonb, now(), now())`,
      [actorId, `g2-postgrest-${tag}@example.com`],
    );
    const assigned = await db().query(
      `insert into public.user_roles (user_id, role_id, active, expires_at)
       select $1::uuid, r.id, true, null from public.roles r where r.code = 'admin'`,
      [actorId],
    );
    expect(assigned.rowCount).toBe(1);
    const catalog = await createCatalogFixture(db(), { stock: 0, itemStatus: 'private' });
    state.actorId = actorId;
    state.itemId = catalog.itemId;
    state.variantId = catalog.variantId;
  });

  afterAll(async () => {
    // 発注書の残りを打ち切って閉じる（後始末の失敗は試験の結果にしない）
    if (!state.actorId || !state.purchaseOrderId) return;
    try {
      const detail = await readDetail();
      const open = detail.lines.filter((line) => (line.outstandingQuantity ?? 0) > 0).map((line) => line.id);
      if (open.length > 0) {
        await shortClosePurchaseOrder(client, actor(), {
          purchaseOrderId: detail.id, expectedVersion: detail.version, lineIds: open, reason: 'PostgREST の試験の後始末', requestKey: randomUUID(),
        });
      }
    } catch {
      // 後始末の失敗は握りつぶす
    }
  });

  // ---- 書込み: 発注 ----

  test('FREQ-526-AC-02: 作成 — admin_create_purchase_order（_lines の jsonb）が通り、番号と版を返す', async () => {
    const created = await createPurchaseOrder(client, actor(), {
      supplierName: `PostgREST 発注先 ${tag}`,
      memo: null,
      lines: [{ variantId: need(state.variantId, 'variantId'), quantity: 5 }],
      requestKey: randomUUID(),
    });
    expect(created).toMatchObject({ number: expect.stringMatching(/^PO-[0-9]{8}-[0-9]{4}$/), version: 1, replayed: false });
    state.purchaseOrderId = created.id;
    state.purchaseOrderNumber = created.number;
  });

  test('FREQ-526-AC-04: 発注書の詳細（読取。STABLE の get_admin_purchase_order）が画面と同じ検査に通り、作った内容が読める', async () => {
    const detail = await readDetail();
    expect(parsePurchaseOrderDetail(overTheWire(detail))).toEqual(detail);
    expect(detail).toMatchObject({ id: orderId(), number: state.purchaseOrderNumber, stage: 'ordered', displayStage: 'ordered', version: 1 });
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ variantId: state.variantId, provisionalQuantity: 5, orderQuantity: null });
    state.lineId = detail.lines[0].id;
  });

  test('FREQ-527-AC-01: 発注先の訂正 — admin_update_purchase_order_header が通り、版が1つ進む。古い版は GROUP_G_PO_VERSION_CONFLICT（409）に分類される', async () => {
    const before = await readDetail();
    const updated = await updatePurchaseOrderHeader(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version, supplierName: `訂正後の発注先 ${tag}`, memo: 'PostgREST の試験', reason: '発注先の訂正',
      requestKey: randomUUID(),
    });
    expect(updated).toEqual({ version: before.version + 1, replayed: false });
    // 古い版で送ると、DB の誤り（message と SQLSTATE 55000）が PostgREST を通って、窓口と同じ分類になる
    await expect(updatePurchaseOrderHeader(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version, supplierName: `別の発注先 ${tag}`, memo: null, reason: '古い版', requestKey: randomUUID(),
    })).rejects.toMatchObject({ status: 409, code: 'GROUP_G_PO_VERSION_CONFLICT' });
    const after = await readDetail();
    expect(after).toMatchObject({ version: before.version + 1, supplierName: `訂正後の発注先 ${tag}`, memo: 'PostgREST の試験' });
  });

  test('FREQ-527-AC-01: 数量の確定 — admin_confirm_purchase_order_quantities（lineId・数量・単価の jsonb）が通り、段階が数量確定済みになる', async () => {
    const before = await readDetail();
    const confirmed = await confirmPurchaseOrderQuantities(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version,
      lines: [{ lineId: need(state.lineId, 'lineId'), quantity: 4, unitPriceYen: 1200 }], reason: null, requestKey: randomUUID(),
    });
    expect(confirmed).toMatchObject({ version: before.version + 1, changedLines: 1, replayed: false });
    const after = await readDetail();
    expect(after).toMatchObject({ stage: 'quantity_confirmed', displayStage: 'quantity_confirmed' });
    expect(after.lines[0]).toMatchObject({ orderQuantity: 4, outstandingQuantity: 4, unitPriceYen: 1200 });
  });

  // ---- 書込み: 受け取り ----

  test('FREQ-529-AC-01: 受け取り — admin_receive_purchase_order（date・jsonb の行）が通り、良品が空き在庫に入る', async () => {
    const before = await readDetail();
    const received = await receivePurchaseOrder(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version, receivedOn: jstToday(), memo: null,
      lines: [{ lineId: need(state.lineId, 'lineId'), quantity: 3 }], requestKey: randomUUID(),
    });
    expect(received).toMatchObject({ version: before.version + 1, allocatedQuantity: 0, replayed: false });
    state.receiptId = received.receiptId;
    const after = await readDetail();
    expect(after.displayStage).toBe('partially_received');
    expect(after.lines[0]).toMatchObject({ receivedQuantity: 3, outstandingQuantity: 1 });
    expect(after.receipts).toHaveLength(1);
    expect(await freeStock()).toBe(3);
  });

  test('FREQ-529-AC-04: 受け取りの取消 — admin_reverse_purchase_order_receipt（受取行の jsonb・expectedReleaseQuantity の null）が通り、空き在庫が減る', async () => {
    const before = await readDetail();
    const receipt = before.receipts.find((entry) => entry.id === state.receiptId);
    const receiptLine = receipt?.lines[0];
    if (!receipt || !receiptLine) throw new Error('受取が読めない');
    const reversed = await reversePurchaseOrderReceipt(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version, receiptId: receipt.id,
      lines: [{ receiptLineId: receiptLine.id, quantity: 1 }], reason: '数量の訂正', expectedReleaseQuantity: null, requestKey: randomUUID(),
    });
    expect(reversed).toMatchObject({ version: before.version + 1, releasedQuantity: 0, replayed: false });
    const after = await readDetail();
    expect(after.lines[0]).toMatchObject({ receivedQuantity: 2, outstandingQuantity: 2 });
    expect(await freeStock()).toBe(2);
  });

  // ---- 書込み: 原本 ----

  test('FREQ-530-AC-02: 原本の予約 → 置き場へ置く → 確定 → 訂正 — 本物の署名つきの送り先へ PUT し、置き場から読み戻して確定し、次の版を足す', async () => {
    const purchaseOrderId = orderId();
    const pdf = Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'utf8');
    const counterparty = `PostgREST 工場 ${tag}`;
    state.pdf = pdf;
    state.counterparty = counterparty;

    const reserved = await reservePurchaseOrderDocument(client, actor(), {
      purchaseOrderId, kind: 'invoice', fileName: `invoice-${tag}.pdf`, replacesAttachmentId: null, requestKey: randomUUID(),
    });
    expect(reserved.replayed).toBe(false);
    expect(isLocalDatabase(reserved.signedUrl)).toBe(true);

    // 置く前は未保存（署名つきの送り先を出し直す）、置いた後は保存済み
    const beforeUpload = await issueDocumentUploadUrl(client, actor(), { purchaseOrderId, reservationId: reserved.reservationId });
    expect(beforeUpload.uploaded).toBe(false);
    if (beforeUpload.uploaded) throw new Error('置く前に保存済みと読めた');
    expect(isLocalDatabase(beforeUpload.signedUrl)).toBe(true);

    const put = await fetch(reserved.signedUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: new Uint8Array(pdf) });
    expect(put.ok).toBe(true);
    // 失敗した時に署名つきの送り先を出力しないよう、値ではなく鍵の名前と真偽だけを比べる
    const afterUpload = await issueDocumentUploadUrl(client, actor(), { purchaseOrderId, reservationId: reserved.reservationId });
    expect(Object.keys(afterUpload)).toEqual(['uploaded']);
    expect(afterUpload.uploaded).toBe(true);

    const attached = await attachPurchaseOrderDocument(client, actor(), {
      purchaseOrderId, reservationId: reserved.reservationId, sha256: sha256Of(pdf), transactionDate: jstToday(), amountYen: 6000,
      currency: 'JPY', counterparty, requestKey: randomUUID(),
    });
    expect(attached).toMatchObject({ revisionNo: 1, replayed: false });
    state.attachmentId = attached.attachmentId;

    const revised = await revisePurchaseOrderDocument(client, actor(), {
      purchaseOrderId, attachmentId: attached.attachmentId, transactionDate: jstToday(), amountYen: 6500, currency: 'JPY',
      counterparty, voided: false, reason: '金額の訂正', requestKey: randomUUID(),
    });
    expect(revised).toMatchObject({ attachmentId: attached.attachmentId, revisionNo: 2, replayed: false });
  });

  test('FREQ-530-AC-02: 原本の署名つきリンク（60秒）が通り、リンクが予約したファイルそのものを返す。詳細は添付を保存キーなしで読む', async () => {
    const link = await createPurchaseOrderDocumentUrl(client, actor(), {
      purchaseOrderId: orderId(), attachmentId: need(state.attachmentId, 'attachmentId'), download: false,
    });
    expect(link.expiresInSeconds).toBe(60);
    expect(isLocalDatabase(link.url)).toBe(true);
    const response = await fetch(link.url);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(sha256Of(bytes)).toBe(sha256Of(need(state.pdf, 'pdf')));

    const detail = await readDetail();
    expect(parsePurchaseOrderDetail(overTheWire(detail))).toEqual(detail);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({
      id: state.attachmentId, kind: 'invoice', revisionCount: 2, sha256: sha256Of(need(state.pdf, 'pdf')),
      current: { revisionNo: 2, amountYen: 6500, counterparty: state.counterparty, voided: false },
    });
    expect(detail.pendingUploads).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('storage_path');
  });

  // ---- 読取 ----

  test('FREQ-530-AC-02: 書類検索（読取。date・bigint の条件を含む search_purchase_order_documents）が画面と同じ検査に通り、訂正前の版は条件で出し分ける', async () => {
    const filters = {
      dateFrom: null, dateTo: null, amountMin: null, amountMax: null, counterparty: tag, number: state.purchaseOrderNumber ?? null, kind: null,
    } as const;
    const current = await searchPurchaseOrderDocuments(client, actor(), { filters: { ...filters, includeHistory: false }, page: 1 });
    expect(current.total).toBe(1);
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]).toMatchObject({ attachmentId: state.attachmentId, purchaseOrderId: orderId(), revisionNo: 2, isCurrent: true, amountYen: 6500, voided: false });
    expect(parsePurchaseOrderDocumentSearchRow(overTheWire(current.rows[0]))).toEqual(current.rows[0]);

    const history = await searchPurchaseOrderDocuments(client, actor(), { filters: { ...filters, includeHistory: true }, page: 1 });
    expect(history.total).toBe(2);
    expect(history.rows.map((row) => [row.revisionNo, row.isCurrent, row.amountYen])).toEqual(expect.arrayContaining([[1, false, 6000], [2, true, 6500]]));
    for (const row of history.rows) expect(parsePurchaseOrderDocumentSearchRow(overTheWire(row))).toEqual(row);
  });

  test('FREQ-525-AC-01: 在庫一覧表（読取。bigint の variant を含む list_admin_inventory）が画面の検査に通り、手元の数と発注済みの数が出る', async () => {
    const rows = await listAdminInventory(client, actor());
    const row = rows.find((entry) => entry.variantId === state.variantId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ itemId: state.itemId, free: 2, paidAllocated: 0, paymentHeld: 0, onHand: 2, orderQuantity: 0, onOrder: 2, required: 0 });
    expect(overTheWire(rows)).toEqual(rows);
  });

  test('FREQ-526-AC-04: 発注一覧表（読取。limit・offset を含む list_admin_purchase_order_lines）が画面と同じ検査に通り、作った明細の数が出る', async () => {
    let found: PurchaseOrderListRow | undefined;
    for (let page = 1; page <= 3 && !found; page += 1) {
      const { rows, total } = await listAdminPurchaseOrderLines(client, actor(), { limit: 100, page });
      expect(total).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(parsePurchaseOrderListRow(overTheWire(row))).toEqual(row);
      found = rows.find((row) => row.purchaseOrderId === orderId());
    }
    expect(found).toMatchObject({
      number: state.purchaseOrderNumber, displayStage: 'partially_received', lineId: state.lineId, orderQuantity: 4, receivedQuantity: 2, outstandingQuantity: 2,
    });
  });

  test('FREQ-540-AC-07: 実行者に権限が無い読取は、PostgREST を通っても 42501 と GROUP_G_FORBIDDEN の組で権限の拒否（403）に分類される', async () => {
    const stranger = randomUUID();
    await expect(listAdminInventory(client, stranger)).rejects.toBeInstanceOf(AdminInventoryError);
    await expect(listAdminPurchaseOrderLines(client, stranger, { limit: 20, page: 1 })).rejects.toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    await expect(getAdminPurchaseOrder(client, stranger, orderId())).rejects.toBeInstanceOf(PurchaseOrderError);
  });

  // ---- 書込み: 打切り（最後。残りを閉じる） ----

  test('FREQ-527-AC-01: 残りの打切り — admin_short_close_purchase_order（uuid[] の _line_ids）が通り、未納の2点が閉じて完了になる', async () => {
    const before = await readDetail();
    const closed = await shortClosePurchaseOrder(client, actor(), {
      purchaseOrderId: before.id, expectedVersion: before.version, lineIds: [need(state.lineId, 'lineId')], reason: '残りは作らない', requestKey: randomUUID(),
    });
    expect(closed).toMatchObject({ version: before.version + 1, closedQuantity: 2, replayed: false });
    const after = await readDetail();
    expect(after.displayStage).toBe('closed');
    expect(after.lines[0]).toMatchObject({ orderQuantity: 2, receivedQuantity: 2, outstandingQuantity: 0 });
    expect(after.shortClosures).toHaveLength(1);
  });
});
