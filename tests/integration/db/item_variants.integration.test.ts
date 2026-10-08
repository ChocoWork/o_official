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
    // このファイルの試験はバリアントの行を手で入れて制約を確かめる。items のトリガー（移行 C）が作った行を先に消し、
    // バリアントの無い商品から始める
    await client.query(`DELETE FROM public.item_variants WHERE item_id = $1`, [res.rows[0].id]);
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
      const variant = await client.query(
        `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
        [itemId],
      );
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 5, 'restock')`,
        [variant.rows[0].id],
      );

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

  test('anon はシーケンスを操作できない（採番の破壊を防ぐ）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT setval('public.item_variants_id_seq', 1)`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon はシーケンスの last_value を読めない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT last_value FROM public.item_variants_id_seq`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('初期在庫つきでバリアントを作れない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);

      await expect(
        client.query(
          `INSERT INTO public.item_variants (item_id, stock_quantity) VALUES ($1, 5)`,
          [itemId],
        ),
      ).rejects.toThrow(/stock_quantity must start at 0/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('service_role は stock_quantity を直接更新できないが is_active は更新できる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      const variant = await client.query(
        `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
        [itemId],
      );
      const variantId = variant.rows[0].id;

      await client.query(`SET LOCAL ROLE service_role`);
      // 権限エラーはトランザクションを abort 状態にするため、SAVEPOINT で切り離して
      // 同じトランザクション内で後続の検証を続けられるようにする。
      await client.query(`SAVEPOINT before_denied_update`);
      await expect(
        client.query(
          `UPDATE public.item_variants SET stock_quantity = 10 WHERE id = $1`,
          [variantId],
        ),
      ).rejects.toThrow(/permission denied/i);
      await client.query(`ROLLBACK TO SAVEPOINT before_denied_update`);

      await client.query(
        `UPDATE public.item_variants SET is_active = false WHERE id = $1`,
        [variantId],
      );
      const res = await client.query(
        `SELECT is_active FROM public.item_variants WHERE id = $1`,
        [variantId],
      );
      expect(res.rows[0].is_active).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('台帳経由なら service_role でも在庫が動く', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      const variant = await client.query(
        `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
        [itemId],
      );
      const variantId = variant.rows[0].id;

      await client.query(`SET LOCAL ROLE service_role`);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 6, 'restock')`,
        [variantId],
      );

      const res = await client.query(
        `SELECT stock_quantity FROM public.item_variants WHERE id = $1`,
        [variantId],
      );
      expect(res.rows[0].stock_quantity).toBe(6);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('updated_at が UPDATE で自動更新される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createItem(client);
      const variant = await client.query(
        `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id, updated_at`,
        [itemId],
      );
      const variantId = variant.rows[0].id;
      const insertedUpdatedAt = variant.rows[0].updated_at;

      // トランザクション内では now() が固定されるため経過時間では検証できない。
      // 明示的に過去日時を指定しても、トリガーが now() で上書きすることを確認する。
      const updated = await client.query(
        `UPDATE public.item_variants
         SET is_active = false, updated_at = '2000-01-01T00:00:00Z'
         WHERE id = $1
         RETURNING updated_at`,
        [variantId],
      );
      expect(new Date(updated.rows[0].updated_at).getTime()).not.toBe(
        new Date('2000-01-01T00:00:00Z').getTime(),
      );
      expect(new Date(updated.rows[0].updated_at).getTime()).toBe(
        new Date(insertedUpdatedAt).getTime(),
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
