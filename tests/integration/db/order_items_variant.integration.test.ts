import { seedGroupG1Allocation } from './helpers/group-g1-fixtures';

const { Pool } = require('pg');

// order_items に受注の区分とバリアント参照を持たせる。
describe('integration: order_items variant columns', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }

  let pool: any;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function createOrder(client: any): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.orders (session_id, payment_intent_id, subtotal_amount, total_amount)
       VALUES ($1, $2, 1000, 1500)
       RETURNING id`,
      [`sess-${Date.now()}`, `pi_${Date.now()}`],
    );
    return res.rows[0].id;
  }

  async function createVariant(client: any): Promise<{ itemId: string; variantId: string }> {
    const item = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('order item test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    // 色・サイズの無い商品には、items のトリガー（移行 C）が色・サイズ無しのバリアントを1つ作る。それを使う
    const variant = await client.query(
      `SELECT id FROM public.item_variants WHERE item_id = $1 AND color_id IS NULL AND size_id IS NULL`,
      [item.rows[0].id],
    );
    return { itemId: item.rows[0].id, variantId: variant.rows[0].id };
  }

  test('fulfillment_type の既定は stock で、backorder も入れられる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);

      const inserted = await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total)
         VALUES ($1, $2, $3, 'order item test', 1000, 1, 1000)
         RETURNING fulfillment_type`,
        [orderId, itemId, variantId],
      );
      expect(inserted.rows[0].fulfillment_type).toBe('stock');

      const backorder = await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'order item test', 1000, 2, 2000, 'backorder')
         RETURNING fulfillment_type`,
        [orderId, itemId, variantId],
      );
      expect(backorder.rows[0].fulfillment_type).toBe('backorder');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('fulfillment_type に想定外の値は入れられない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);

      await expect(
        client.query(
          `INSERT INTO public.order_items
             (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
           VALUES ($1, $2, $3, 'x', 1000, 1, 1000, 'preorder')`,
          [orderId, itemId, variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('販売実績のあるバリアントは削除できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total)
         VALUES ($1, $2, $3, 'x', 1000, 1, 1000)`,
        [orderId, itemId, variantId],
      );

      await expect(
        client.query(`DELETE FROM public.item_variants WHERE id = $1`, [variantId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('受注生産の数は backorder の数量だけを数える（グループ E-1 で view から関数に替えた）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // G-1: 共通の在庫の押さえを最初に取る（割当の材料を同じ取引で作るため）
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(190521, 1)');
      // G-1 の受注生産の数は、入金済みでまだ割り当てのない数（管理の「受注生産中」）。未入金の注文は数えない
      const order = await client.query(
        `INSERT INTO public.orders (session_id, payment_intent_id, subtotal_amount, total_amount, status)
         VALUES ($1, $2, 3000, 3000, 'paid')
         RETURNING id`,
        [`sess-${Date.now()}`, `pi_${Date.now()}`],
      );
      const orderId = order.rows[0].id;
      const { itemId, variantId } = await createVariant(client);
      const stockLine = await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 1, 1000, 'stock')
         RETURNING id`,
        [orderId, itemId, variantId],
      );
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 2, 2000, 'backorder')`,
        [orderId, itemId, variantId],
      );
      // 在庫の明細は入荷した1点を割り当て済み（A）。受注生産の明細だけが待っている
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason, note) VALUES ($1, 1, 'restock', 'fixture')`,
        [variantId],
      );
      await seedGroupG1Allocation(client, { orderItemId: stockLine.rows[0].id, quantity: 1, kind: 'paid' });

      const res = await client.query(
        'SELECT committed, backorder FROM public.list_variant_stock_states($1::bigint[])',
        [[variantId]],
      );
      expect(res.rows[0]).toEqual({ committed: 1, backorder: 2 });

      // G-1 Task 5 の決め事: 未入金（pending）の注文の数は「未払い」で、受注生産には数えない
      const unpaid = await client.query(
        `INSERT INTO public.orders (session_id, payment_intent_id, subtotal_amount, total_amount, status)
         VALUES ($1, $2, 2000, 2000, 'pending')
         RETURNING id`,
        [`sess-unpaid-${Date.now()}`, `pi_unpaid_${Date.now()}`],
      );
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 2, 2000, 'backorder')`,
        [unpaid.rows[0].id, itemId, variantId],
      );
      const afterUnpaid = await client.query(
        'SELECT committed, backorder FROM public.list_variant_stock_states($1::bigint[])',
        [[variantId]],
      );
      expect(afterUnpaid.rows[0]).toEqual({ committed: 1, backorder: 2 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('既存明細の color / size に一致するバリアントが後埋めされる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);

      // 色とサイズを持つ商品を作り、backfill でバリアントを生成する
      const item = await client.query(
        `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes)
         VALUES ('backfill link test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published',
                 '[{"name":"Black","hex":"#000000"}]'::jsonb, ARRAY['M']::text[])
         RETURNING id`,
      );
      const itemId = item.rows[0].id;
      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, item_name, item_price, color, size, quantity, line_total)
         VALUES ($1, $2, 'backfill link test', 1000, 'Black', 'M', 1, 1000)`,
        [orderId, itemId],
      );

      // マイグレーション本体と同じ後埋めを再現する
      await client.query(
        `ALTER TABLE public.order_items DISABLE TRIGGER protect_legal_order_item_immutable_fields`,
      );
      await client.query(
        `UPDATE public.order_items oi
         SET variant_id = v.id
         FROM public.item_variants v
         LEFT JOIN public.item_colors c ON c.id = v.color_id
         LEFT JOIN public.item_sizes  s ON s.id = v.size_id
         WHERE oi.variant_id IS NULL
           AND v.item_id = oi.item_id
           AND coalesce(c.name, '')  = coalesce(oi.color, '')
           AND coalesce(s.label, '') = coalesce(oi.size, '')`,
      );
      await client.query(
        `ALTER TABLE public.order_items ENABLE TRIGGER protect_legal_order_item_immutable_fields`,
      );

      const linked = await client.query(
        `SELECT variant_id FROM public.order_items WHERE item_id = $1`,
        [itemId],
      );
      expect(linked.rows[0].variant_id).not.toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
