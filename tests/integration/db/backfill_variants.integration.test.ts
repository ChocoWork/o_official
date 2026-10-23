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
    options: { bypassVariantTrigger?: boolean } = {},
  ): Promise<string> {
    // 形の壊れた古い商品は、今は items のトリガー（移行 C）が INSERT の時点で断る。
    // トリガーより前に入った古い行を再現するため、この取引の間だけトリガーを止めて入れる（試験の DB の postgres でだけ使える）
    if (options.bypassVariantTrigger) {
      await client.query(`SET LOCAL session_replication_role = replica`);
    }
    const res = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status, colors, sizes)
       VALUES ('backfill test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published', $1::jsonb, $2::text[])
       RETURNING id`,
      [JSON.stringify(colors), sizes],
    );
    if (options.bypassVariantTrigger) {
      await client.query(`SET LOCAL session_replication_role = origin`);
    }
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
      const itemId = await createLegacyItem(client, { not: 'an array' }, ['M'], { bypassVariantTrigger: true });

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
      const itemId = await createLegacyItem(client, ['Red'], ['M'], { bypassVariantTrigger: true });

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
        { bypassVariantTrigger: true },
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
        { bypassVariantTrigger: true },
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
      const itemId = await createLegacyItem(client, [], ['S', null, 'M'], { bypassVariantTrigger: true });

      await expect(
        client.query(`SELECT public.backfill_item_variants($1)`, [itemId]),
      ).rejects.toThrow(/sizes contains a NULL element/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  // FREQ-517: 商品から外した色・サイズの組み合わせは止め、戻すと同じ組み合わせ（同じ番号・同じ在庫）が有効に戻る。
  // 色・サイズの行と組み合わせは消さない。items.colors・items.sizes を書き換えると items のトリガーが同じ関数を呼ぶ。
  describe('外した色・サイズの組み合わせを止める（FREQ-517）', () => {
    type VariantState = { id: string; key: string; isActive: boolean; stock: number; ctid: string };

    async function variantsOf(client: any, itemId: string): Promise<VariantState[]> {
      const res = await client.query(
        `SELECT v.id, coalesce(c.name, '-') || '/' || coalesce(z.label, '-') AS key,
                v.is_active, v.stock_quantity, v.ctid::text AS ctid
         FROM public.item_variants v
         LEFT JOIN public.item_colors c ON c.id = v.color_id
         LEFT JOIN public.item_sizes z ON z.id = v.size_id
         WHERE v.item_id = $1
         ORDER BY v.id`,
        [itemId],
      );
      return res.rows.map((r: any) => ({
        id: String(r.id),
        key: r.key,
        isActive: r.is_active,
        stock: r.stock_quantity,
        ctid: r.ctid,
      }));
    }

    function activeByKey(rows: VariantState[]): Record<string, boolean> {
      return Object.fromEntries(rows.map((r) => [r.key, r.isActive]));
    }

    function byKey(rows: VariantState[], key: string): VariantState {
      const row = rows.find((r) => r.key === key);
      if (!row) throw new Error(`組み合わせ ${key} が無い`);
      return row;
    }

    async function setColors(client: any, itemId: string, colors: unknown) {
      await client.query(`UPDATE public.items SET colors = $2::jsonb WHERE id = $1`, [itemId, JSON.stringify(colors)]);
    }

    async function setSizes(client: any, itemId: string, sizes: string[]) {
      await client.query(`UPDATE public.items SET sizes = $2::text[] WHERE id = $1`, [itemId, sizes]);
    }

    const BLACK = { name: 'Black', hex: '#000000' };
    const IVORY = { name: 'Ivory', hex: '#f5f5f5' };

    test('色を外すとその色の組み合わせが止まり、戻すと同じ番号・同じ在庫で有効に戻る', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const itemId = await createLegacyItem(client, [BLACK, IVORY], ['S', 'M']);
        const before = await variantsOf(client, itemId);
        await client.query(
          `INSERT INTO public.stock_movements (variant_id, delta, reason, note) VALUES ($1, 3, 'restock', 'fixture')`,
          [byKey(before, 'Ivory/S').id],
        );

        await setColors(client, itemId, [BLACK]);
        const removed = await variantsOf(client, itemId);
        expect(activeByKey(removed)).toEqual({
          'Black/S': true,
          'Black/M': true,
          'Ivory/S': false,
          'Ivory/M': false,
        });
        // 行は消さない（在庫・番号・履歴を残す）
        expect(byKey(removed, 'Ivory/S').stock).toBe(3);
        const colorRows = await client.query(`SELECT name FROM public.item_colors WHERE item_id = $1 ORDER BY name`, [itemId]);
        expect(colorRows.rows.map((r: any) => r.name)).toEqual(['Black', 'Ivory']);

        await setColors(client, itemId, [BLACK, IVORY]);
        const restored = await variantsOf(client, itemId);
        expect(restored.every((r) => r.isActive)).toBe(true);
        expect(restored.map((r) => r.id)).toEqual(before.map((r) => r.id));
        expect(byKey(restored, 'Ivory/S').stock).toBe(3);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    test('色の名前を変えると、古い名前の組み合わせが止まり、新しい名前の組み合わせが有効になる', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const itemId = await createLegacyItem(client, [BLACK], ['M']);

        await setColors(client, itemId, [{ name: 'Noir', hex: '#000000' }]);

        expect(activeByKey(await variantsOf(client, itemId))).toEqual({ 'Black/M': false, 'Noir/M': true });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    test('サイズを外すとそのサイズの組み合わせが止まり、戻すと同じ番号で有効に戻る', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const itemId = await createLegacyItem(client, [BLACK], ['S', 'M']);
        const before = await variantsOf(client, itemId);

        await setSizes(client, itemId, ['S']);
        expect(activeByKey(await variantsOf(client, itemId))).toEqual({ 'Black/S': true, 'Black/M': false });

        await setSizes(client, itemId, ['S', 'M']);
        const restored = await variantsOf(client, itemId);
        expect(activeByKey(restored)).toEqual({ 'Black/S': true, 'Black/M': true });
        expect(restored.map((r) => r.id)).toEqual(before.map((r) => r.id));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    test('色の無い昔の商品に色を足すと色の空いた組み合わせが止まり、色を全部外すと戻る', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const itemId = await createLegacyItem(client, [], ['M']);
        expect(activeByKey(await variantsOf(client, itemId))).toEqual({ '-/M': true });

        await setColors(client, itemId, [BLACK]);
        expect(activeByKey(await variantsOf(client, itemId))).toEqual({ '-/M': false, 'Black/M': true });

        await setColors(client, itemId, []);
        expect(activeByKey(await variantsOf(client, itemId))).toEqual({ '-/M': true, 'Black/M': false });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    test('関係ない組み合わせは書き換えない（値が変わる行だけ更新する）', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const itemId = await createLegacyItem(client, [BLACK, IVORY], ['S']);
        const before = await variantsOf(client, itemId);

        await setColors(client, itemId, [BLACK]);
        const afterColor = await variantsOf(client, itemId);
        // 行を書き換えると ctid（行の置き場所）が変わる。有効のままの行は書き換えない
        expect(byKey(afterColor, 'Black/S')).toMatchObject({ isActive: true, ctid: byKey(before, 'Black/S').ctid });
        expect(byKey(afterColor, 'Ivory/S').isActive).toBe(false);
        expect(byKey(afterColor, 'Ivory/S').ctid).not.toBe(byKey(before, 'Ivory/S').ctid);

        // サイズだけを足しても、前からある組み合わせは書き換えない。外した色の新しい組み合わせは止まった形で並ぶ
        await setSizes(client, itemId, ['S', 'M']);
        const afterSize = await variantsOf(client, itemId);
        expect(byKey(afterSize, 'Black/S').ctid).toBe(byKey(before, 'Black/S').ctid);
        expect(byKey(afterSize, 'Ivory/S').ctid).toBe(byKey(afterColor, 'Ivory/S').ctid);
        expect(activeByKey(afterSize)).toEqual({
          'Black/S': true,
          'Ivory/S': false,
          'Black/M': true,
          'Ivory/M': false,
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  test('形の壊れた色・サイズは、商品を入れる時点で items のトリガーが断る（移行 C）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        createLegacyItem(client, [{ name: 'Red', hex: '#FF0000' }, { name: 'Red', hex: '#00FF00' }], ['M']),
      ).rejects.toThrow(/colors has a duplicate name/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
