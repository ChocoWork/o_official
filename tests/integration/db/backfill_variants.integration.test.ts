export {};

const { Pool } = require('pg');

// 既存の items.colors / items.sizes から色・サイズ・バリアントを生成する（在庫は移さない: FREQ-401）。
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
    sizes: (string | null)[],
  ): Promise<string> {
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes)
       VALUES ('backfill test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published', $1::jsonb, $2::text[])
       RETURNING id`,
      [JSON.stringify(colors), sizes],
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

  // FREQ-401: 旧 items.stock_quantity からの移し替えは廃止した。在庫は台帳でだけ動かす。
  test('在庫は移さない。作られたバリアントは在庫 0 で台帳も空', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Black', hex: '#000000' }, { name: 'Ivory', hex: '#f5f5f5' }],
        ['S', 'M'],
      );

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const rows = await client.query(
        `SELECT v.stock_quantity FROM public.item_variants v WHERE v.item_id = $1`,
        [itemId],
      );
      expect(rows.rows).toHaveLength(4);
      expect(rows.rows.every((r: any) => r.stock_quantity === 0)).toBe(true);

      const ledger = await client.query(
        `SELECT count(*)::int AS total
         FROM public.stock_movements m
         JOIN public.item_variants v ON v.id = m.variant_id
         WHERE v.item_id = $1`,
        [itemId],
      );
      expect(ledger.rows[0].total).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色もサイズも無い商品は 1 バリアントになる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [], []);

      await client.query(`SELECT public.backfill_item_variants($1)`, [itemId]);

      const res = await client.query(
        `SELECT color_id, size_id, stock_quantity FROM public.item_variants WHERE item_id = $1`,
        [itemId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].color_id).toBeNull();
      expect(res.rows[0].size_id).toBeNull();
      expect(res.rows[0].stock_quantity).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('バリアントは在庫 0 で作られ、台帳は空になる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M']);

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
      const itemId = await createLegacyItem(client, [{ name: 'Black', hex: '#000000' }], ['M']);

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
      // 在庫は移さないので、何度実行しても台帳は空のまま（FREQ-401）
      expect(ledger.rows[0].total).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('colors が jsonb 配列でない商品は移行が止まる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, { not: 'an array' }, ['M']);

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/colors is not a jsonb array/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('色要素が bare string の商品は移行が止まる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, ['Red'], ['M']);

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/colors has an invalid element/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('hex が # 無しの商品は移行が止まる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Red', hex: 'FF0000' }],
        ['M'],
      );

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/colors has an invalid element/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('同名の色が重複する商品は移行が止まる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(
        client,
        [{ name: 'Red', hex: '#FF0000' }, { name: 'Red', hex: '#00FF00' }],
        ['M'],
      );

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/colors has a duplicate name/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('sizes に NULL 要素がある商品は移行が止まる', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemId = await createLegacyItem(client, [], ['S', null, 'M']);

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/sizes contains a NULL element/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
