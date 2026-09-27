/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 在庫の単位をバリアント（色 × サイズ）へ寄せる第1段（FREQ-398）。
 *
 * ブランドの前提は受注生産。在庫の有無は「買えるか」ではなく「納期」を分けるので、
 * 在庫が無い組み合わせも backorder として受ける。在庫で賄える分だけを台帳
 * （stock_movements）への追記で引き当て、未入金の取り消しで戻す。
 *
 * 本番は全商品 items.stock_quantity が NULL なので、ここでも NULL にして
 * 商品単位の在庫検査が邪魔をしない状態で確かめる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/variant_stock_on_order
 *
 * 注意: 試験用の注文は削除禁止トリガーで消せない。使い捨てのローカル DB でだけ動かす。
 */

const DATABASE_URL = process.env.DATABASE_URL;
const PRICE = 5000;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

type Line = { color: string | null; size: string | null; quantity: number };

describe('integration: バリアント在庫の引き当て', () => {
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

  /**
   * 商品・色・サイズ・バリアントと、その在庫を持つ下書きを作る。
   * バリアントは初期在庫を持てない（トリガーが拒否する）ので、在庫は台帳の restock で入れる。
   */
  async function createFixture(options: {
    stock: number;
    lines: Line[];
    colorName?: string;
    sizeLabel?: string;
    isActive?: boolean;
  }) {
    const { stock, lines, colorName = 'BLACK', sizeLabel = 'M', isActive = true } = options;
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const item = await client.query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ('variant-' || $1::text, 'バリアント在庫テスト', $2, 'TOPS',
               'https://example.com/item.png', 'published')
       returning id`,
      [suffix, PRICE],
    );
    const itemId = Number(item.rows[0].id);

    const color = await client.query(
      `insert into public.item_colors (item_id, name, hex, position) values ($1, $2, '#000000', 0) returning id`,
      [itemId, colorName],
    );
    const size = await client.query(
      `insert into public.item_sizes (item_id, label, position) values ($1, $2, 0) returning id`,
      [itemId, sizeLabel],
    );

    const variant = await client.query(
      `insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, $4) returning id`,
      [itemId, color.rows[0].id, size.rows[0].id, isActive],
    );
    const variantId = Number(variant.rows[0].id);

    if (stock > 0) {
      await client.query(
        `insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
        [variantId, stock],
      );
    }

    const totalAmount = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);
    const draft = await client.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, discount_amount,
          total_amount, currency, shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', $2, 0, 0, $2, 'jpy', $3::jsonb, $4::jsonb)
       returning id`,
      [
        `variant-session-${suffix}`,
        totalAmount,
        JSON.stringify({
          email: 'variant@example.com',
          fullName: '山田 花子',
          postalCode: '1500001',
          prefecture: '東京都',
          city: '渋谷区',
          address: '神宮前1-1-1',
          building: null,
          phone: '0311112222',
        }),
        JSON.stringify(
          lines.map((line) => ({
            item_id: itemId,
            item_name: 'バリアント在庫テスト',
            item_price: PRICE,
            item_image_url: 'https://example.com/item.png',
            color: line.color,
            size: line.size,
            quantity: line.quantity,
            line_total: PRICE * line.quantity,
          })),
        ),
      ],
    );

    return {
      itemId,
      variantId,
      draftId: draft.rows[0].id as string,
      paymentIntentId: `pi_variant_${suffix}`,
      totalAmount,
    };
  }

  function finalize(draftId: string, paymentIntentId: string, expectedTotal: number, status = 'paid') {
    return client.query(
      `select order_id from public.finalize_order_from_checkout_draft(
         $1::uuid, $2::text, $3::text, $4::public.order_status, $5::integer, $6::text)`,
      [draftId, paymentIntentId, `cs_${paymentIntentId}`, status, expectedTotal, 'jpy'],
    );
  }

  async function orderItemsOf(orderId: string) {
    const res = await client.query(
      `select variant_id, fulfillment_type, quantity from public.order_items
        where order_id = $1 order by created_at, id`,
      [orderId],
    );
    return res.rows;
  }

  async function movementsOf(variantId: number) {
    const res = await client.query(
      `select delta, reason from public.stock_movements where variant_id = $1 order by id`,
      [variantId],
    );
    return res.rows.map((row: any) => ({ delta: Number(row.delta), reason: row.reason }));
  }

  async function variantStock(variantId: number): Promise<number> {
    const res = await client.query(
      `select stock_quantity from public.item_variants where id = $1`,
      [variantId],
    );
    return Number(res.rows[0].stock_quantity);
  }

  test('在庫で賄える明細は stock になり、台帳へ purchase が入って在庫が減る', async () => {
    const fx = await createFixture({ stock: 5, lines: [{ color: 'BLACK', size: 'M', quantity: 2 }] });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);
    const orderId = res.rows[0].order_id;

    expect(await orderItemsOf(orderId)).toEqual([
      { variant_id: String(fx.variantId), fulfillment_type: 'stock', quantity: 2 },
    ]);
    expect(await movementsOf(fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
    ]);
    expect(await variantStock(fx.variantId)).toBe(3);
  });

  test('在庫が足りない明細は backorder になり、台帳も在庫も動かない', async () => {
    const fx = await createFixture({ stock: 1, lines: [{ color: 'BLACK', size: 'M', quantity: 2 }] });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);
    const orderId = res.rows[0].order_id;

    expect(await orderItemsOf(orderId)).toEqual([
      { variant_id: String(fx.variantId), fulfillment_type: 'backorder', quantity: 2 },
    ]);
    expect(await movementsOf(fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }]);
    expect(await variantStock(fx.variantId)).toBe(1);
  });

  test('在庫が無くても注文は成立する（受注生産として受ける）', async () => {
    const fx = await createFixture({ stock: 0, lines: [{ color: 'BLACK', size: 'M', quantity: 1 }] });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);

    expect(res.rows[0].order_id).toBeTruthy();
    expect(await orderItemsOf(res.rows[0].order_id)).toEqual([
      { variant_id: String(fx.variantId), fulfillment_type: 'backorder', quantity: 1 },
    ]);
  });

  test('同じバリアントが複数明細に分かれていても、合算で引き当てを判定する', async () => {
    const fx = await createFixture({
      stock: 2,
      lines: [
        { color: 'BLACK', size: 'M', quantity: 1 },
        { color: 'BLACK', size: 'M', quantity: 2 },
      ],
    });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);

    // 合計 3 > 在庫 2 なので、明細を分割せず両方 backorder
    expect((await orderItemsOf(res.rows[0].order_id)).map((row: any) => row.fulfillment_type)).toEqual([
      'backorder',
      'backorder',
    ]);
    expect(await variantStock(fx.variantId)).toBe(2);
  });

  test('停止中のバリアントは在庫があっても backorder にする', async () => {
    const fx = await createFixture({
      stock: 5,
      lines: [{ color: 'BLACK', size: 'M', quantity: 1 }],
      isActive: false,
    });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);

    expect((await orderItemsOf(res.rows[0].order_id))[0].fulfillment_type).toBe('backorder');
    expect(await variantStock(fx.variantId)).toBe(5);
  });

  test('対応するバリアントが無い色・サイズは variant_id が空のまま注文になる', async () => {
    const fx = await createFixture({
      stock: 5,
      lines: [{ color: 'WHITE', size: 'L', quantity: 1 }],
    });

    const res = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);

    expect(await orderItemsOf(res.rows[0].order_id)).toEqual([
      { variant_id: null, fulfillment_type: 'backorder', quantity: 1 },
    ]);
  });

  test('未入金の取り消しで、引き当てた分が cancel として戻る', async () => {
    const fx = await createFixture({ stock: 5, lines: [{ color: 'BLACK', size: 'M', quantity: 2 }] });
    await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount, 'pending');
    expect(await variantStock(fx.variantId)).toBe(3);

    const released = await client.query(
      `select released from public.release_stock_for_unpaid_order($1::text)`,
      [fx.paymentIntentId],
    );

    expect(released.rows[0].released).toBe(true);
    expect(await movementsOf(fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
      { delta: 2, reason: 'cancel' },
    ]);
    expect(await variantStock(fx.variantId)).toBe(5);
  });

  test('backorder の注文を取り消しても、台帳には何も書かない', async () => {
    const fx = await createFixture({ stock: 0, lines: [{ color: 'BLACK', size: 'M', quantity: 1 }] });
    await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount, 'pending');

    await client.query(`select released from public.release_stock_for_unpaid_order($1::text)`, [
      fx.paymentIntentId,
    ]);

    expect(await movementsOf(fx.variantId)).toEqual([]);
    expect(await variantStock(fx.variantId)).toBe(0);
  });

  test('同じ支払いで確定を2回呼んでも、台帳は二重に入らない', async () => {
    const fx = await createFixture({ stock: 5, lines: [{ color: 'BLACK', size: 'M', quantity: 2 }] });

    const first = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);
    const second = await finalize(fx.draftId, fx.paymentIntentId, fx.totalAmount);

    expect(second.rows[0].order_id).toBe(first.rows[0].order_id);
    expect(await movementsOf(fx.variantId)).toEqual([
      { delta: 5, reason: 'restock' },
      { delta: -2, reason: 'purchase' },
    ]);
    expect(await variantStock(fx.variantId)).toBe(3);
  });

  test('台帳の合計とバリアントの在庫がずれていない', async () => {
    const res = await client.query(`select count(*)::int as mismatches from public.verify_stock_integrity()`);
    expect(res.rows[0].mismatches).toBe(0);
  });
});
