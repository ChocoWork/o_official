export {};

const { Pool } = require('pg');

// item_variants の一意性と公開範囲を検証する。BEGIN / ROLLBACK で囲むためデータは残らない。
describe('integration: item_variants', () => {
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

  async function createItem(client: any): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('variant test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    return res.rows[0].id;
  }

  test('同じ item_id / color_id / size_id の組み合わせは二重に登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      const color = await client.query(
        `INSERT INTO public.item_colors (item_id, name, hex, position)
         VALUES ($1, 'Black', '#000000', 0) RETURNING id`,
        [itemId],
      );
      const size = await client.query(
        `INSERT INTO public.item_sizes (item_id, label, position)
         VALUES ($1, 'M', 1) RETURNING id`,
        [itemId],
      );

      await client.query(
        `INSERT INTO public.item_variants (item_id, color_id, size_id) VALUES ($1, $2, $3)`,
        [itemId, color.rows[0].id, size.rows[0].id],
      );

      await expect(
        client.query(
          `INSERT INTO public.item_variants (item_id, color_id, size_id) VALUES ($1, $2, $3)`,
          [itemId, color.rows[0].id, size.rows[0].id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('color_id / size_id が NULL の組み合わせも二重に登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await client.query(`INSERT INTO public.item_variants (item_id) VALUES ($1)`, [itemId]);

      await expect(
        client.query(`INSERT INTO public.item_variants (item_id) VALUES ($1)`, [itemId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('stock_quantity は負にできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await expect(
        client.query(
          `INSERT INTO public.item_variants (item_id, stock_quantity) VALUES ($1, -1)`,
          [itemId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は item_variants を読めない（在庫の実数を公開しない）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      await client.query(`INSERT INTO public.item_variants (item_id, stock_quantity) VALUES ($1, 5)`, [itemId]);

      // anon には SELECT 権限自体を与えていないため、0 行ではなく権限エラーになる
      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT count(*)::int AS c FROM public.item_variants`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('items に made_to_order_lead_days があり、既定は NULL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      const res = await client.query(
        `SELECT made_to_order_lead_days FROM public.items WHERE id = $1`,
        [itemId],
      );
      expect(res.rows[0].made_to_order_lead_days).toBeNull();

      await client.query(
        `UPDATE public.items SET made_to_order_lead_days = 21 WHERE id = $1`,
        [itemId],
      );
      const updated = await client.query(
        `SELECT made_to_order_lead_days FROM public.items WHERE id = $1`,
        [itemId],
      );
      expect(updated.rows[0].made_to_order_lead_days).toBe(21);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('made_to_order_lead_days は負にできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await expect(
        client.query(
          `UPDATE public.items SET made_to_order_lead_days = -1 WHERE id = $1`,
          [itemId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は published 商品の色とサイズを読める', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      await client.query(
        `INSERT INTO public.item_colors (item_id, name, hex, position) VALUES ($1, 'Ivory', '#f5f5f5', 0)`,
        [itemId],
      );
      await client.query(
        `INSERT INTO public.item_sizes (item_id, label, position) VALUES ($1, 'L', 2)`,
        [itemId],
      );

      await client.query(`SET LOCAL ROLE anon`);
      const colors = await client.query(
        `SELECT count(*)::int AS c FROM public.item_colors WHERE item_id = $1`,
        [itemId],
      );
      const sizes = await client.query(
        `SELECT count(*)::int AS c FROM public.item_sizes WHERE item_id = $1`,
        [itemId],
      );
      expect(colors.rows[0].c).toBe(1);
      expect(sizes.rows[0].c).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
