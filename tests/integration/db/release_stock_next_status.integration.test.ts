/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 在庫復元の遷移先を failed / cancelled に限る（FREQ-383、レビュー指摘⑫）。
 *
 * release_stock_for_unpaid_order は SECURITY DEFINER で、pending の注文を _next_status へ
 * 移してから在庫を戻す。以前は注文状態のどの値でも通り、'pending' なら注文は pending のまま
 * 在庫だけが戻り（呼ぶたびに増える）、'paid' / 'shipped' なら未入金の注文が入金済み・
 * 発送済みになった。許可しない値はエラーにし、注文・在庫・改訂履歴のどれも変えないことを
 * 実 DB で確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/release_stock_next_status
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;

const QUANTITY = 2;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

describe('integration: 在庫復元の遷移先', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error(
        '消せない試験注文が残るため、localhost 以外の DATABASE_URL では実行しない',
      );
    });
    return;
  }

  let client: any;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  /** 商品と、それを QUANTITY 個含む pending の注文を作る（在庫はバリアント側なので持たない）。 */
  async function createPendingOrder(): Promise<{ itemId: number; paymentIntentId: string }> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('nextstatus-' || $1::text, '在庫復元テスト', 1000, 'TOPS', 'https://example.com/item.png', 'published')
       returning id`,
      [suffix],
    );
    const itemId = Number(item.rows[0].id);

    const order = await client.query(
      `insert into public.orders
         (session_id, payment_intent_id, status, subtotal_amount, shipping_amount, total_amount, currency)
       values ($1, $2, 'pending', $3, 0, $3, 'jpy')
       returning id, payment_intent_id`,
      [`nextstatus-session-${suffix}`, `pi_nextstatus_${suffix}`, 1000 * QUANTITY],
    );

    await client.query(
      `insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total)
       values ($1, $2, '在庫復元テスト', 1000, $3, $4)`,
      [order.rows[0].id, itemId, QUANTITY, 1000 * QUANTITY],
    );

    return { itemId, paymentIntentId: order.rows[0].payment_intent_id };
  }

  async function snapshot(itemId: number, paymentIntentId: string) {
    const res = await client.query(
      `select o.status::text as status,
              (select count(*)::int from public.order_revisions r where r.order_id = o.id) as revisions
       from public.orders o
       where o.payment_intent_id = $1`,
      [paymentIntentId],
    );
    return res.rows[0];
  }

  test.each([['pending'], ['paid'], ['shipped'], [null]])(
    '遷移先 %s はエラーになり、注文・在庫・改訂履歴は変わらない',
    async (nextStatus) => {
      const { itemId, paymentIntentId } = await createPendingOrder();
      const before = await snapshot(itemId, paymentIntentId);
      expect(before).toMatchObject({ status: 'pending' });

      await expect(
        client.query(
          'select released from public.release_stock_for_unpaid_order($1::text, $2::public.order_status)',
          [paymentIntentId, nextStatus],
        ),
      ).rejects.toMatchObject({
        code: '22023',
        message: expect.stringContaining('INVALID_NEXT_STATUS'),
      });

      expect(await snapshot(itemId, paymentIntentId)).toEqual(before);
    },
  );

  test('遷移先を省くと今まで通り failed にして在庫を戻す', async () => {
    const { itemId, paymentIntentId } = await createPendingOrder();

    const res = await client.query(
      'select released from public.release_stock_for_unpaid_order($1::text)',
      [paymentIntentId],
    );

    expect(res.rows[0].released).toBe(true);
    expect(await snapshot(itemId, paymentIntentId)).toMatchObject({
      status: 'failed'
    });
  });

  test('cancelled は今まで通り cancelled にして在庫を戻す', async () => {
    const { itemId, paymentIntentId } = await createPendingOrder();

    const res = await client.query(
      'select released from public.release_stock_for_unpaid_order($1::text, $2::public.order_status)',
      [paymentIntentId, 'cancelled'],
    );

    expect(res.rows[0].released).toBe(true);
    expect(await snapshot(itemId, paymentIntentId)).toMatchObject({
      status: 'cancelled'
    });
  });
});
