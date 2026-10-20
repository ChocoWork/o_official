/** @jest-environment node */
/**
 * 申し込みのメール6種類の材料（loadRequestEmailMaterial）を、実際の PostgREST（ローカル Supabase の API）に通す（グループ E-3 段2）。
 * 単体テストの偽物では確かめられない、表と列の名前（order_returns.decline_message、order_return_lines の reason・requested_*、
 * order_return_photos.return_line_id、order_cancel_requests、order_cancel_request_lines）と、item_variants から
 * item_colors(name)・item_sizes(label) を埋め込んで読む所を確かめる。
 * 後片付けはしない（ほかの PostgREST の結合テストと同じ。次の npx supabase db reset で消える）
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadRequestEmailMaterial } from '@/lib/orders/email/order-email-compose';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import {
  addItemVariant,
  createCatalogFixture,
  createShippedOrderFixture,
  insertOrderWithLines,
  insertReturnRecord,
} from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;

describeLocalDb('integration: 申し込みのメールの材料を、実際の PostgREST から読む', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('試験の行が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;

  beforeAll(() => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  });

  // 試験データの商品は、どれも同じ名前・色・サイズ（insertOrderWithLines が書く）
  const BOUGHT = { item_name: '照合テスト', color: 'BLACK', size: 'M' };

  /**
   * 返品の行を直接書く。ご希望（requested_*）は申し込んだ時の値で、解決の予定（resolution など）にも仮の値として同じ物を入れる
   * （計画 P2。お客様の詳しい内容 customer_note も入れるが、メールの材料には出ないことを下の試験が確かめる）
   */
  async function insertRequestLine(input: {
    returnId: string;
    fulfillmentId: string;
    orderItemId: string;
    quantity: number;
    reason: string;
    customerNote: string | null;
    resolution: 'refund' | 'exchange';
    exchangeVariantId: number | null;
  }): Promise<string> {
    const inserted = await db().query(
      `insert into public.order_return_lines
         (return_id, fulfillment_id, order_item_id, quantity, reason, customer_note,
          requested_resolution, requested_exchange_variant_id, resolution, exchange_variant_id, exchange_method)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8, $9)
       returning id`,
      [
        input.returnId, input.fulfillmentId, input.orderItemId, input.quantity, input.reason, input.customerNote,
        input.resolution, input.exchangeVariantId, input.resolution === 'exchange' ? 'stock' : null,
      ],
    );
    return inserted.rows[0].id as string;
  }

  /** 写真の送り先と写真を、直接書く（置き場の場所の形は計画 C-0 の CHECK のとおり） */
  async function insertPhoto(orderId: string, returnLineId: string): Promise<void> {
    const storagePath = `requests/${orderId}/${randomUUID()}`;
    const upload = await db().query(
      `insert into public.order_return_photo_uploads (order_id, customer_id, storage_path, attached_at)
       values ($1, gen_random_uuid(), $2, now())
       returning id`,
      [orderId, storagePath],
    );
    await db().query(
      `insert into public.order_return_photos (return_line_id, upload_id, storage_path, content_type, size_bytes)
       values ($1, $2, $3, 'image/jpeg', 2048)`,
      [returnLineId, upload.rows[0].id, storagePath],
    );
  }

  test('返品の申し込み: 受付・店への知らせの材料（理由・ご希望・交換の色とサイズ・写真の数）と、お断りの材料（番号とメッセージ）を読む', async () => {
    // 2つの商品を1回で発送した注文。商品ごとに別の行
    const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }, { quantity: 2 }] });
    const exchange = await addItemVariant(db(), { itemId: fx.itemIds[1], colorName: 'NAVY', sizeLabel: 'L', stock: 5 });
    const fulfillmentId = fx.fulfillments[0].id;
    const { returnId, number } = await insertReturnRecord(db(), { orderId: fx.orderId, status: 'requested', lines: [] });
    const refundLine = await insertRequestLine({
      returnId, fulfillmentId, orderItemId: fx.orderItemIds[0], quantity: 1, reason: 'defective',
      customerNote: 'この文はメールに出さない', resolution: 'refund', exchangeVariantId: null,
    });
    const exchangeLine = await insertRequestLine({
      returnId, fulfillmentId, orderItemId: fx.orderItemIds[1], quantity: 2, reason: 'size_too_small',
      customerNote: null, resolution: 'exchange', exchangeVariantId: exchange.variantId,
    });
    await insertPhoto(fx.orderId, refundLine);
    await insertPhoto(fx.orderId, refundLine);
    await insertPhoto(fx.orderId, exchangeLine);
    const lines = [
      { ...BOUGHT, quantity: 1, reason: 'defective', requestedResolution: 'refund', requestedExchange: null },
      { ...BOUGHT, quantity: 2, reason: 'size_too_small', requestedResolution: 'exchange', requestedExchange: { color: 'NAVY', size: 'L' } },
    ];

    // 同じ注文の 2 つの商品は作った時刻が近く、ミリ秒で同じになりうる（その時は商品の番号の順になる）ので、数（1・2）で並べて比べる
    const sortByQuantity = <T extends { lines: Array<{ quantity: number }> }>(request: T | null | undefined) =>
      request ? { ...request, lines: [...request.lines].sort((a, b) => a.quantity - b.quantity) } : request;

    const requested = await loadRequestEmailMaterial(client, fx.orderId, { kind: 'return_requested', returnId, cancelRequestId: null });
    const shop = await loadRequestEmailMaterial(client, fx.orderId, { kind: 'return_request_shop', returnId, cancelRequestId: null });

    expect(requested?.order).toMatchObject({ id: fx.orderId, shipping_full_name: '山田 花子' });
    expect(sortByQuantity(requested?.request)).toEqual({
      kind: 'return', number, declineMessage: null, lines: lines.map((line) => ({ ...line, photoCount: 0 })),
    });
    expect(sortByQuantity(shop?.request)).toEqual({
      kind: 'return', number, declineMessage: null, lines: lines.map((line, index) => ({ ...line, photoCount: [2, 1][index] })),
    });

    const declined = await insertReturnRecord(db(), { orderId: fx.orderId, status: 'declined', lines: [] });
    await db().query('update public.order_returns set decline_message = $2 where id = $1', [
      declined.returnId, '受付の期限を過ぎているため、お受けできませんでした。',
    ]);
    const declinedMaterial = await loadRequestEmailMaterial(client, fx.orderId, {
      kind: 'return_declined', returnId: declined.returnId, cancelRequestId: null,
    });

    expect(declinedMaterial?.request).toEqual({
      kind: 'return', number: declined.number, declineMessage: '受付の期限を過ぎているため、お受けできませんでした。', lines: [],
    });
  });

  test('キャンセルの申し込み: 受付・店への知らせの材料（品と数）と、お断りの材料（メッセージ）を読む', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
      status: 'paid',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'stock' }],
    });
    const open = await db().query(
      `insert into public.order_cancel_requests (order_id, status, request_key, request_fingerprint, customer_note, requested_by)
       values ($1, 'requested', gen_random_uuid(), 'fixture', 'この文はメールに出さない', gen_random_uuid())
       returning id`,
      [orderId],
    );
    const cancelRequestId = open.rows[0].id as string;
    await db().query(
      'insert into public.order_cancel_request_lines (cancel_request_id, order_item_id, quantity) values ($1, $2, 1)',
      [cancelRequestId, orderItemIds[0]],
    );
    const declined = await db().query(
      `insert into public.order_cancel_requests
         (order_id, status, request_key, request_fingerprint, requested_by, declined_at, declined_by, decline_reason, decline_message)
       values ($1, 'declined', gen_random_uuid(), 'fixture', gen_random_uuid(), now(), gen_random_uuid(), 'other', 'すでに発送の準備が終わっています。')
       returning id`,
      [orderId],
    );

    for (const kind of ['cancel_request_received', 'cancel_request_shop'] as const) {
      const material = await loadRequestEmailMaterial(client, orderId, { kind, returnId: null, cancelRequestId });

      expect(material?.request).toEqual({ kind: 'cancel', declineMessage: null, lines: [{ ...BOUGHT, quantity: 1 }] });
    }
    const declinedMaterial = await loadRequestEmailMaterial(client, orderId, {
      kind: 'cancel_request_declined', returnId: null, cancelRequestId: declined.rows[0].id as string,
    });

    expect(declinedMaterial?.request).toEqual({
      kind: 'cancel', declineMessage: 'すでに発送の準備が終わっています。', lines: [],
    });
  });

  test('ご希望・理由・数・写真の数は、申し込んだ時の値のまま（承認で解決の予定が変わっても、写真を消しても変わらない。Review Focus 1）', async () => {
    const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 2 }] });
    const exchange = await addItemVariant(db(), { itemId: fx.itemIds[0], colorName: 'NAVY', sizeLabel: 'L', stock: 5 });
    const { returnId } = await insertReturnRecord(db(), { orderId: fx.orderId, status: 'requested', lines: [] });
    const lineId = await insertRequestLine({
      returnId, fulfillmentId: fx.fulfillments[0].id, orderItemId: fx.orderItemIds[0], quantity: 2, reason: 'size_too_small',
      customerNote: null, resolution: 'exchange', exchangeVariantId: exchange.variantId,
    });
    await insertPhoto(fx.orderId, lineId);
    const target = { kind: 'return_request_shop', returnId, cancelRequestId: null } as const;
    const before = await loadRequestEmailMaterial(client, fx.orderId, target);

    // 承認で、解決の予定（親が requested の間だけ直せる 3 列。計画 P2）が返金に変わり、写真は置き場から消した印が付く
    await db().query(
      'update public.order_return_lines set resolution = $2, exchange_variant_id = null, exchange_method = null where id = $1',
      [lineId, 'refund'],
    );
    await db().query('update public.order_return_photos set purged_at = now() where return_line_id = $1', [lineId]);
    const after = await loadRequestEmailMaterial(client, fx.orderId, target);

    expect(after?.request).toEqual(before?.request);
    expect(after?.request).toMatchObject({
      lines: [{ requestedResolution: 'exchange', requestedExchange: { color: 'NAVY', size: 'L' }, quantity: 2, photoCount: 1 }],
    });
  });

  test('取り出しの関数 claim_order_email の答えに、キャンセルの申し込みの番号 cancel_request_id がある（worker が読む）', async () => {
    const result = await db().query("select pg_get_function_result('public.claim_order_email(integer)'::regprocedure) as columns");

    expect(result.rows[0].columns).toContain('cancel_request_id uuid');
  });
});
