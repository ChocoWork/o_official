export {};

const { Pool } = require('pg');

// 在庫は台帳への追記だけで動く。台帳は追記専用で、在庫は負にならない。
describe('integration: stock_movements', () => {
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

  async function createVariant(client: any): Promise<string> {
    const item = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('movement test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    const variant = await client.query(
      `INSERT INTO public.item_variants (item_id) VALUES ($1) RETURNING id`,
      [item.rows[0].id],
    );
    return variant.rows[0].id;
  }

  async function stockOf(client: any, variantId: string): Promise<number> {
    const res = await client.query(
      `SELECT stock_quantity FROM public.item_variants WHERE id = $1`,
      [variantId],
    );
    return res.rows[0].stock_quantity;
  }

  test('入庫を追記すると在庫が増える', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);

      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 3, 'restock')`,
        [variantId],
      );

      expect(await stockOf(client, variantId)).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('販売を追記すると在庫が減る', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 5, 'restock')`,
        [variantId],
      );

      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, -2, 'purchase')`,
        [variantId],
      );

      expect(await stockOf(client, variantId)).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('在庫を超える出庫は CHECK 制約で拒否される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 1, 'restock')`,
        [variantId],
      );

      await expect(
        client.query(
          `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, -2, 'purchase')`,
          [variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('delta = 0 は登録できない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);

      await expect(
        client.query(
          `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 0, 'adjustment')`,
          [variantId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('台帳は追記専用で、更新も削除もできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      const inserted = await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason)
         VALUES ($1, 2, 'restock') RETURNING id`,
        [variantId],
      );
      const movementId = inserted.rows[0].id;

      await expect(
        client.query(`UPDATE public.stock_movements SET delta = 99 WHERE id = $1`, [movementId]),
      ).rejects.toThrow();

      await expect(
        client.query(`DELETE FROM public.stock_movements WHERE id = $1`, [movementId]),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('anon は台帳を読めない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 1, 'restock')`,
        [variantId],
      );

      // anon には SELECT 権限自体を与えていないため、0 行ではなく権限エラーになる
      await client.query(`SET LOCAL ROLE anon`);
      await expect(
        client.query(`SELECT count(*)::int AS c FROM public.stock_movements`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('台帳は TRUNCATE でも消せない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 2, 'restock')`,
        [variantId],
      );

      await expect(
        client.query(`TRUNCATE public.stock_movements`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('service_role は台帳を更新・削除できない（権限側でも閉じている）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 1, 'restock')`,
        [variantId],
      );

      await client.query(`SET LOCAL ROLE service_role`);
      await expect(
        client.query(`DELETE FROM public.stock_movements`),
      ).rejects.toThrow();
      await expect(
        client.query(`UPDATE public.stock_movements SET delta = 5`),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
