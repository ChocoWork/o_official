/** @jest-environment node */
/**
 * 返金のお知らせの材料（loadOrderEmailMaterial の返金の番号）を、実際の PostgREST（ローカル Supabase の API）に通す。
 * order_refund_lines から order_items を埋め込んで読む所と、service_role で list_order_line_fulfillment を呼ぶ所は、
 * 単体テストの偽物では確かめられない。後片付けはしない（ほかの PostgREST の結合テストと同じ。次の npx supabase db reset で消える）
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
      amount: 1000, shippingAmount: 0, paymentMethodType: null, customerActionExpiresAt: null, cancelReason: null,
      lines: [{ item_name: '照合テスト', color: 'BLACK', size: 'M', quantity: 1, before_shipment: true }],
      stillShipping: true,
    });
  });
});
