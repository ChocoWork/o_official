import { isLocalDatabase } from './helpers/local-db';

const { Pool } = require('pg');

// 在庫は台帳への追記だけで動く。台帳は追記専用で、在庫は負にならない。
describe('integration: stock_movements', () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    test.skip('skipping DB integration tests because DATABASE_URL is not set', () => {});
    return;
  }
  if (!isLocalDatabase(DATABASE_URL)) {
    test('localhost DB only', () => { throw new Error('LOCAL_DB_REQUIRED'); });
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
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const item = await client.query(
      `INSERT INTO public.items (name, description, price, category, image_url, status)
       VALUES ('movement test', 'desc', 1000, 'TOPS', '/images/test.jpg', 'published')
       RETURNING id`,
    );
    // 色・サイズの無い商品には、items のトリガー（移行 C）が色・サイズ無しのバリアントを1つ作る。それを使う
    const variant = await client.query(
      `SELECT id FROM public.item_variants WHERE item_id = $1 AND color_id IS NULL AND size_id IS NULL`,
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

      for (const sql of ['UPDATE public.stock_movements SET delta = 99 WHERE id = $1', 'DELETE FROM public.stock_movements WHERE id = $1']) {
        await client.query('savepoint mutation');
        await expect(client.query(sql, [movementId])).rejects.toThrow(/append-only/i);
        await client.query('rollback to savepoint mutation');
        await client.query('release savepoint mutation');
      }
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

      // G-1 で割当の履歴が、G-2 で発注書の受取行が台帳を外部キーで指すので、台帳だけの TRUNCATE はトリガーの前に外部キーで断られる。
      // 指す側の表を後ろに並べ、台帳の文のトリガーが先に断ることを確かめる。
      // 台帳の操作の外部キー（G-1）は遅延なので、追記の確かめが残っていると TRUNCATE はトリガーの前に断られる。先に流しておく
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expect(
        client.query(`TRUNCATE public.stock_movements, public.order_item_allocation_events, public.purchase_order_receipt_lines`),
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
      for (const sql of ['DELETE FROM public.stock_movements', 'UPDATE public.stock_movements SET delta = 5']) {
        await client.query('savepoint mutation');
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
        await client.query('rollback to savepoint mutation');
        await client.query('release savepoint mutation');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('service_role は読取だけで、直接 INSERT と sequence USAGE はできない', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const variantId = await createVariant(client);
      expect((await client.query(`select
        has_table_privilege('service_role','public.stock_movements','SELECT') as read,
        has_table_privilege('service_role','public.stock_movements','INSERT') as write,
        has_sequence_privilege('service_role','public.stock_movements_id_seq','USAGE') as sequence`)).rows[0])
        .toEqual({ read: true, write: false, sequence: false });
      await client.query('set local role service_role');
      await client.query('savepoint direct_insert');
      await expect(client.query(`insert into public.stock_movements(variant_id,delta,reason) values($1,1,'restock')`, [variantId]))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('rollback to savepoint direct_insert');
      await client.query('release savepoint direct_insert');
      expect((await client.query('select count(*)::int as n from public.stock_movements where variant_id=$1', [variantId])).rows[0].n).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  test('整合しているときは verify_stock_integrity が何も返さない', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 4, 'restock')`,
        [variantId],
      );

      const res = await client.query(
        `SELECT * FROM public.verify_stock_integrity() WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('キャッシュを直接書き換えるとズレとして検出される', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const variantId = await createVariant(client);
      await client.query(
        `INSERT INTO public.stock_movements (variant_id, delta, reason) VALUES ($1, 4, 'restock')`,
        [variantId],
      );
      await client.query(
        `UPDATE public.item_variants SET stock_quantity = 9 WHERE id = $1`,
        [variantId],
      );

      const res = await client.query(
        `SELECT * FROM public.verify_stock_integrity() WHERE variant_id = $1`,
        [variantId],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].cached).toBe(9);
      expect(res.rows[0].ledger).toBe(4);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('created_by に外部キーが無い', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `SELECT count(*)::int AS c FROM pg_constraint
         WHERE conrelid = 'public.stock_movements'::regclass
           AND contype = 'f'
           AND conname LIKE '%created_by%'`,
      );
      expect(res.rows[0].c).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
