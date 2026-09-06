export {};

const { Pool } = require('pg');

// 既存の items.colors / items.sizes / items.stock_quantity からバリアントを生成する。
describe('integration: backfill_item_variants', () => {
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

  async function createLegacyItem(
    client: any,
    colors: unknown,
    sizes: string[],
    stock: number | null,
  ): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes, stock_quantity)
       VALUES ('backfill test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published', $1::jsonb, $2::text[], $3)
       RETURNING id`,
      [JSON.stringify(colors), sizes, stock],
    );
    return res.rows[0].id;
  }

  test('色 2 × サイズ 2 から 4 バリアントを作る', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['S', 'M'],
        7,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const variants = await client.query(
        `SELECT count(*)::int AS c FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(variants.rows[0].c).toBe(4);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色とサイズの position は元の配列の並び順になる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['M', 'S'],
        0,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const sizes = await client.query(
        `SELECT label, position FROM public.item_sizes WHERE item_id = $1 ORDER BY position`,
        [itemId],
      );
      expect(sizes.rows.map((r: any) => r.label)).toEqual(['M', 'S']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('在庫は position が最小の組み合わせに全量が寄せられ、台帳にも記録される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['S', 'M'],
        7,
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const rows = await client.query(
        `SELECT v.stock_quantity, c.position AS cpos, s.position AS spos
         FROM public.item_variants v
         LEFT JOIN public.item_colors c ON c.id = v.color_id
         LEFT JOIN public.item_sizes  s ON s.id = v.size_id
         WHERE v.item_id = $1
         ORDER BY c.position, s.position`,
        [itemId],
      );
      expect(rows.rows[0].stock_quantity).toBe(7);
      expect(rows.rows.slice(1).every((r: any) => r.stock_quantity === 0)).toBe(true);

      const ledger = await client.query(
        `SELECT coalesce(sum(m.delta), 0)::int AS total
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].total).toBe(7);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色もサイズも無い商品は 1 バリアントになる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [], [], 3);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT color_id, size_id, stock_quantity FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].color_id).toBeNull();
      expect(res.rows[0].size_id).toBeNull();
      expect(res.rows[0].stock_quantity).toBe(3);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('stock_quantity が NULL の商品は在庫 0 で作られ、台帳は空になる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M'], null);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT stock_quantity FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows[0].stock_quantity).toBe(0);

      const ledger = await client.query(
        `SELECT count(*)::int AS c
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].c).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('同じ商品に二度実行しても重複しない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M'], 2);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);
      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT count(*)::int AS c FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows[0].c).toBe(1);

      const ledger = await client.query(
        `SELECT coalesce(sum(m.delta), 0)::int AS total
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].total).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
