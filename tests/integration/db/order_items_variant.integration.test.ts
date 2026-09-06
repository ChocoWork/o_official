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
});
