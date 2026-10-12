/** @jest-environment node */
/**
 * 返金のお知らせの材料（loadOrderEmailMaterial の返金の番号）を、実際の PostgREST（ローカル Supabase の API）に通す。
 * order_refund_lines から order_items を埋め込んで読む所と、service_role で list_order_line_fulfillment を呼ぶ所は、
 * 単体テストの偽物では確かめられない。後片付けはしない（ほかの PostgREST の結合テストと同じ。次の npx supabase db reset で消える）。
 * グループ E-3: 返品のメールの材料（返品・受け取り・受け取りの行・交換の色とサイズ・お届けの目安・返送先・返金待ちの関数・
 * 受け取りと一緒に始めた返金の状態・返金が0円になった数）と、
 * 発送の商品の交換の印も、同じように通す。返品の記録は、返品を作る・受け取る関数を通さず、計画 C-0 の表に直接書く。
 * ショップの設定の返送先は、書いて使い終わったら元に戻す（ほかの試験が、返送先の無い状態を前提にしても邪魔しない）
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadOrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, insertRefundRecord } from './helpers/order-fixtures';

jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;

describeLocalDb('integration: 返金のお知らせの材料を、実際の PostgREST から読む', (db) => {
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

  test('返金の番号で、返金の商品の行（名前・色・サイズ）と、まだ送る商品があるかを読む', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
      status: 'paid',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'stock' }],
    });
    // 2点のうち1点を発送前に返金した保留の記録。もう1点はまだ送る
    const { refundId } = await insertRefundRecord(db(), {
      orderId, status: 'pending', amount: 1000, lines: [{ orderItemId: orderItemIds[0], quantity: 1 }],
    });

    const material = await loadOrderEmailMaterial(client, orderId, null, refundId);

    expect(material?.refund).toEqual({
      // status は、送る前に返金が失敗・エラーになっていないかを worker が見る材料
      status: 'pending', amount: 1000, shippingAmount: 0, paymentMethodType: null, customerActionExpiresAt: null, cancelReason: null,
      lines: [{ item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true }],
      stillShipping: true,
    });
  });

  /**
   * 返品の記録を直接書く（グループ E-3）。返品を作る・受け取る関数（移行 B・C）を通さずに、材料の読み込みが欲しい状態を作る。
   * 注文の商品を3点（返金の解決1点・交換の解決1点・お返しにする1点）返品し、受け取りは「額を相談・サポートの受け取り」にする。
   * 交換の色・サイズ（NAVY / L）は同じ商品の別の組み合わせとして作る。返送先は、ショップの設定に入れて、使い終わったら元に戻す
   */
  async function insertReturnRecords(options: { fee?: boolean } = {}) {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const color = await db().query(
      `insert into public.item_colors (item_id, name, hex, position) values ($1, 'NAVY', '#000080', 1) returning id`,
      [fx.itemId],
    );
    const size = await db().query(`insert into public.item_sizes (item_id, label, position) values ($1, 'L', 1) returning id`, [fx.itemId]);
    const variant = await db().query(
      `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, true) returning id`,
      [fx.itemId, color.rows[0].id, size.rows[0].id],
    );
    const exchangeVariantId = Number(variant.rows[0].id);
    // 作って送る交換の品に書くお届けの目安
    await db().query('update public.items set made_to_order_lead_days = 14 where id = $1', [fx.itemId]);

    const { orderId, orderItemIds } = await insertOrderWithLines(db(), {
      status: 'shipped',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 3, fulfillmentType: 'stock' }],
    });
    const orderItemId = orderItemIds[0];
    const fulfillment = await db().query(
      `insert into public.order_fulfillments
         (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order)
       values ($1, 1, gen_random_uuid(), 'yamato', '1234-5678', true, true)
       returning id`,
      [orderId],
    );
    const fulfillmentId = fulfillment.rows[0].id as string;
    await db().query('insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 3)', [fulfillmentId, orderItemId]);

    const returned = await db().query(
      `insert into public.order_returns
         (order_id, number, source, status, request_key, request_fingerprint, approved_at, return_method, return_shipping_payer,
          return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee, notify_customer)
       values ($1, 1, 'shop', 'open', gen_random_uuid(), 'fixture', now(), 'shop_label', 'customer', 800, $2, $3, $4, true)
       returning id`,
      [orderId, options.fee ? 10 : 0, options.fee ? 500 : 0, options.fee ? 600 : 0],
    );
    const returnId = returned.rows[0].id as string;
    const lineSql = `insert into public.order_return_lines
         (return_id, fulfillment_id, order_item_id, quantity, reason, resolution, exchange_variant_id, exchange_method)
       values ($1, $2, $3, 1, $4, $5, $6, $7) returning id`;
    const refundLine = (await db().query(lineSql, [returnId, fulfillmentId, orderItemId, 'unwanted', 'refund', null, null])).rows[0].id as string;
    const exchangeLine = (await db().query(lineSql, [returnId, fulfillmentId, orderItemId, 'size_too_small', 'exchange', exchangeVariantId, 'stock'])).rows[0].id as string;
    const sentBackLine = (await db().query(lineSql, [returnId, fulfillmentId, orderItemId, 'color', 'refund', null, null])).rows[0].id as string;

    const receipt = await db().query(
      `insert into public.order_return_receipts
         (return_id, request_key, request_fingerprint, kind, refund_choice, notify_customer,
          sent_back_message, sent_back_carrier, sent_back_tracking_number, actor_can_refund)
       values ($1, gen_random_uuid(), 'fixture', 'receive', 'consult', true,
               '使用の跡があり、お返しいたします。', 'yamato', '4321-8765', false)
       returning id`,
      [returnId],
    );
    const receiptId = receipt.rows[0].id as string;
    // 実際に決まった解決で書く。交換にした行は、在庫が足りず作って送るに変わった
    const receiptLineSql = `insert into public.order_return_receipt_lines
         (receipt_id, return_line_id, disposition, quantity, resolution, exchange_method)
       values ($1, $2, $3, 1, $4, $5)`;
    await db().query(receiptLineSql, [receiptId, refundLine, 'restocked', 'refund', null]);
    await db().query(receiptLineSql, [receiptId, exchangeLine, 'restocked', 'exchange', 'make']);
    await db().query(receiptLineSql, [receiptId, sentBackLine, 'sent_back', null, null]);

    return { orderId, orderItemId, itemId: fx.itemId, exchangeVariantId, fulfillmentId, returnId, receiptId };
  }

  const ADDRESS_COLUMNS = 'return_address_name, return_address_postal_code, return_address_line, return_address_phone';

  /** ショップの設定の返送先を入れて処理を流し、終わったら元の値に戻す（ほかの試験が返送先の無い状態を前提にしても邪魔しない） */
  async function withReturnAddress(run: () => Promise<void>) {
    const before = (await db().query(`select ${ADDRESS_COLUMNS} from public.shop_return_settings where id = 1`)).rows[0];
    await db().query(
      `update public.shop_return_settings
         set return_address_name = 'Le Fil des Heures 返品係', return_address_postal_code = '150-0001',
             return_address_line = '東京都渋谷区神宮前1-2-3', return_address_phone = '03-1234-5678'
       where id = 1`,
    );
    try {
      await run();
    } finally {
      await db().query(
        `update public.shop_return_settings
           set return_address_name = $1, return_address_postal_code = $2, return_address_line = $3, return_address_phone = $4
         where id = 1`,
        [before.return_address_name, before.return_address_postal_code, before.return_address_line, before.return_address_phone],
      );
    }
  }

  const BOUGHT = { item_name: '照合テスト', color: 'BLACK', size: 'M' };

  test('返品の番号で、返品の受付のお知らせの材料（返品の品・交換の色とサイズ・手数料・返送先）を読む', async () => {
    const { orderId, returnId } = await insertReturnRecords({ fee: true });

    await withReturnAddress(async () => {
      const material = await loadOrderEmailMaterial(client, orderId, null, null, returnId, null);

      expect(material?.orderReturn).toEqual({
        number: 1,
        returnMethod: 'shop_label',
        returnShippingPayer: 'customer',
        returnShippingFee: 800,
        restockingFeePercent: 10,
        exchangeFee: 500,
        exchangeShippingFee: 600,
        feeWaitingAmount: 0,
        returnAddress: { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
        // 同じ商品の3つの行は、3点の1行にまとめる
        items: [{ ...BOUGHT, quantity: 3 }],
        exchangePlan: [{ item_name: '照合テスト', color: 'NAVY', size: 'L', quantity: 1, method: 'stock', leadDays: null }],
        hasRefundLines: true,
        receipt: null,
      });
    });
  });

  test('受け取りの番号で、受け取った品・お返しの品とメッセージ・実際に決まった交換の品とお届けの目安・返金待ちの品と額を読む', async () => {
    const { orderId, returnId, receiptId } = await insertReturnRecords();
    // 相談の受け取りで付いた手数料（fee_pending_deduction）。店への知らせの額は、商品の額からこれを引く
    await db().query('update public.order_returns set fee_pending_deduction = 800 where id = $1', [returnId]);

    const material = await loadOrderEmailMaterial(client, orderId, null, null, returnId, receiptId);

    expect(material?.orderReturn?.receipt).toEqual({
      refundChoice: 'consult',
      received: [{ ...BOUGHT, quantity: 2 }],
      sentBack: [{ ...BOUGHT, quantity: 1 }],
      sentBackMessage: '使用の跡があり、お返しいたします。',
      sentBackCarrier: 'yamato',
      sentBackTrackingNumber: '4321-8765',
      exchanges: [{ item_name: '照合テスト', color: 'NAVY', size: 'L', quantity: 1, method: 'make', leadDays: 14 }],
      // サポートの受け取り（返金できない人）: 返金の解決で受け取った1点が返金待ち。商品の額は DB の数え方（1点 5000円）から、手数料 800円を引いた額
      pendingRefund: { items: [{ ...BOUGHT, quantity: 1 }], amount: 4200 },
      refundWaived: false,
      refundNotAccepted: false,
    });
    // 受け取りの材料では、受付のお知らせの中身は読まない
    expect(material?.orderReturn).toMatchObject({ number: 1, items: [], exchangePlan: [], returnAddress: null });
  });

  test('返品の返金のお知らせの材料: 受け取りの番号があれば受け取りの中身まで、無ければ（額を決めて後で返した返金）返品の番号だけを読む', async () => {
    const { orderId, returnId, receiptId } = await insertReturnRecords();
    const { refundId } = await insertRefundRecord(db(), { orderId, status: 'pending', amount: 5000 });

    const withReceipt = await loadOrderEmailMaterial(client, orderId, null, refundId, returnId, receiptId);
    const later = await loadOrderEmailMaterial(client, orderId, null, refundId, returnId, null);

    expect(withReceipt?.refund).toMatchObject({ status: 'pending', amount: 5000 });
    expect(withReceipt?.orderReturn?.receipt?.exchanges).toHaveLength(1);
    expect(later?.refund).toMatchObject({ status: 'pending', amount: 5000 });
    expect(later?.orderReturn).toMatchObject({ number: 1, items: [], exchangePlan: [], receipt: null });
  });

  test('受け取りの記録の返金の番号から返金の状態を読み（本計画 P25）、受け取りの行から返金が0円になった数を読む（本計画 P24）', async () => {
    const { orderId, returnId } = await insertReturnRecords();
    const refundLine = (
      await db().query("select id from public.order_return_lines where return_id = $1 and reason = 'unwanted'", [returnId])
    ).rows[0].id as string;
    // 受け取りと一緒に始めて、Stripe に受け付けられなかった返金
    const { refundId } = await insertRefundRecord(db(), { orderId, status: 'error', amount: 5000 });
    const receiptSql = `insert into public.order_return_receipts
         (return_id, request_key, request_fingerprint, kind, refund_choice, refund_id, notify_customer, actor_can_refund)
       values ($1, gen_random_uuid(), 'fixture', 'receive', 'now', $2, true, true)
       returning id`;
    const notAccepted = (await db().query(receiptSql, [returnId, refundId])).rows[0].id as string;
    const waived = (await db().query(receiptSql, [returnId, null])).rows[0].id as string;
    const lineSql = `insert into public.order_return_receipt_lines
         (receipt_id, return_line_id, disposition, quantity, resolution, exchange_method)
       values ($1, $2, $3, 1, $4, null)`;
    await db().query(lineSql, [notAccepted, refundLine, 'restocked', 'refund']);
    await db().query(lineSql, [waived, refundLine, 'not_restocked', 'refund']);
    await db().query(lineSql, [waived, refundLine, 'refund_waived', null]);

    const first = await loadOrderEmailMaterial(client, orderId, null, null, returnId, notAccepted);
    const second = await loadOrderEmailMaterial(client, orderId, null, null, returnId, waived);

    expect(first?.orderReturn?.receipt).toMatchObject({
      refundChoice: 'now', received: [{ ...BOUGHT, quantity: 1 }], refundNotAccepted: true, refundWaived: false,
    });
    expect(second?.orderReturn?.receipt).toMatchObject({
      refundChoice: 'now', received: [{ ...BOUGHT, quantity: 1 }], refundNotAccepted: false, refundWaived: true,
    });
  });

  test('発送の商品の交換の印（line_kind）を読む。交換の品の行は true、ふつうの行は false', async () => {
    const { orderId, itemId, exchangeVariantId, fulfillmentId, returnId } = await insertReturnRecords();
    const exchangeLine = (
      await db().query('select id from public.order_return_lines where return_id = $1 and resolution = $2', [returnId, 'exchange'])
    ).rows[0].id as string;
    // 受け取りで足す交換の品の行（値段は0、元の品の支払額を持つ）を、直接書いて2回目の発送で送る
    const exchangeItem = await db().query(
      `insert into public.order_items
         (order_id, item_id, variant_id, item_name, item_price, color, size, quantity, line_total, fulfillment_type,
          line_kind, exchange_return_line_id, exchange_paid_amount)
       values ($1, $2, $3, '照合テスト', 0, 'NAVY', 'L', 1, 0, 'stock', 'exchange', $4, 5000)
       returning id`,
      [orderId, itemId, exchangeVariantId, exchangeLine],
    );
    const second = await db().query(
      `insert into public.order_fulfillments
         (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer, completes_order)
       values ($1, 2, gen_random_uuid(), 'yamato', '9999-0000', true, true)
       returning id`,
      [orderId],
    );
    await db().query('insert into public.order_fulfillment_lines (fulfillment_id, order_item_id, quantity) values ($1, $2, 1)', [
      second.rows[0].id,
      exchangeItem.rows[0].id,
    ]);

    const first = await loadOrderEmailMaterial(client, orderId, fulfillmentId, null);
    const exchange = await loadOrderEmailMaterial(client, orderId, second.rows[0].id as string, null);

    // 同じ注文に交換の品があっても、注文確認の材料は注文した3点だけ。発送の材料は交換の品を別に読む。
    expect(first?.items).toEqual([{ ...BOUGHT, quantity: 3, line_total: 15000, fulfillment_type: 'stock' }]);
    expect(exchange?.items).toEqual(first?.items);
    expect(first?.fulfillment?.lines).toEqual([{ ...BOUGHT, quantity: 3, exchange: false }]);
    expect(exchange?.fulfillment?.lines).toEqual([{ item_name: '照合テスト', color: 'NAVY', size: 'L', quantity: 1, exchange: true }]);
  });
});
