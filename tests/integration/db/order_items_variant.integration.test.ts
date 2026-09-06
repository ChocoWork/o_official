export {};

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
    const variant = await client.query(
      `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
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

  test('受注の集計ビューが backorder の数量だけを合計する', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderId = await createOrder(client);
      const { itemId, variantId } = await createVariant(client);
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 1, 1000, 'stock')`,
        [orderId, itemId, variantId],
      );
      await client.query(
        `INSERT INTO public.order_items
           (order_id, item_id, variant_id, item_name, item_price, quantity, line_total, fulfillment_type)
         VALUES ($1, $2, $3, 'x', 1000, 2, 2000, 'backorder')`,
        [orderId, itemId, variantId],
      );

      const res = await client.query(
        `SELECT backorder_quantity FROM public.variant_backorder_summary WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows[0].backorder_quantity).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('移行後も不変性トリガーは有効に戻っている', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `SELECT tgenabled FROM pg_trigger
         WHERE tgrelid = 'public.order_items'::regclass
           AND tgname = 'protect_legal_order_item_immutable_fields'`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].tgenabled).toBe('O');
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
        `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes, stock_quantity)
         VALUES ('backfill link test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published',
                 '[{"name":"Black","hex":"#000000"}]'::jsonb, ARRAY['M']::text[], 0)
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
