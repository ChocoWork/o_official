/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * LOOK と商品の関連の表 look_items の列・主キー・外部キー・削除の連鎖（DATA-LOOK-002）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: LOOK と商品の関連の表 look_items', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-look-items-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertLook(): Promise<string> {
    const result = await db().query(
      `insert into public.looks (season_year, season_type, theme, status)
       values (2026, 'SS', $1, 'private') returning id::text as id`,
      [marker],
    );
    return result.rows[0].id;
  }

  async function insertItem(status: 'private' | 'published' = 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'integration item', 1000, 'TOPS', 'integration/look-items.png', $2)
       returning id::text as id`,
      [`${marker} item`, status],
    );
    return result.rows[0].id;
  }

  async function link(lookId: string, itemId: string): Promise<void> {
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [lookId, itemId]);
  }

  async function itemsOf(lookId: string): Promise<string[]> {
    const result = await db().query(
      'select item_id::text as item_id from public.look_items where look_id = $1 order by item_id',
      [lookId],
    );
    return result.rows.map((row) => row.item_id as string);
  }

  async function exists(table: 'looks' | 'items', id: string): Promise<boolean> {
    const result = await db().query(`select 1 from public.${table} where id = $1`, [id]);
    return result.rowCount === 1;
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で流して SQLSTATE と制約名を返す。 */
  async function failure(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
    await db().query('savepoint expected_failure');
    try {
      await db().query(sql, params);
      return {};
    } catch (caught) {
      const error = caught as { code?: string; constraint?: string };
      return { code: error.code, constraint: error.constraint };
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  test('DATA-LOOK-002 列の名前・型・NULL の可否が設計の表と一致し、並びの列は無い', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, is_identity
       from information_schema.columns
       where table_schema = 'public' and table_name = 'look_items'
       order by ordinal_position`,
    );

    expect(result.rows).toEqual([
      { column_name: 'look_id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'item_id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO' },
    ]);
  });

  test('DATA-LOOK-002 主キーは (look_id, item_id) の2列', async () => {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.look_items'::regclass and contype = 'p'`,
    );

    expect(result.rows).toEqual([{ definition: 'PRIMARY KEY (look_id, item_id)' }]);
  });

  test('DATA-LOOK-002 同じ商品を同じ LOOK に2回つなぐと主キーの違反で落ちる', async () => {
    const lookId = await insertLook();
    const itemId = await insertItem();
    await link(lookId, itemId);

    const result = await failure('insert into public.look_items (look_id, item_id) values ($1, $2)', [lookId, itemId]);

    expect(result).toEqual({ code: '23505', constraint: 'look_items_pkey' });
    expect(await itemsOf(lookId)).toEqual([itemId]);
  });

  test('DATA-LOOK-002 1つの LOOK に複数の商品を、1つの商品を複数の LOOK につなげる', async () => {
    const firstLook = await insertLook();
    const secondLook = await insertLook();
    const firstItem = await insertItem();
    const secondItem = await insertItem();

    await link(firstLook, firstItem);
    await link(firstLook, secondItem);
    await link(secondLook, firstItem);

    expect(await itemsOf(firstLook)).toEqual([firstItem, secondItem].sort((a, b) => Number(a) - Number(b)));
    expect(await itemsOf(secondLook)).toEqual([firstItem]);
  });

  test('DATA-LOOK-002 外部キーは looks・items への ON DELETE CASCADE', async () => {
    const result = await db().query(
      `select conname, pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.look_items'::regclass and contype = 'f'
       order by conname`,
    );

    const byName = Object.fromEntries(result.rows.map((row) => [row.conname, row.definition as string]));
    expect(Object.keys(byName)).toEqual(['look_items_item_id_fkey', 'look_items_look_id_fkey']);
    expect(byName.look_items_item_id_fkey)
      .toMatch(/^FOREIGN KEY \(item_id\) REFERENCES (public\.)?items\(id\) ON DELETE CASCADE$/);
    expect(byName.look_items_look_id_fkey)
      .toMatch(/^FOREIGN KEY \(look_id\) REFERENCES (public\.)?looks\(id\) ON DELETE CASCADE$/);
  });

  test('DATA-LOOK-002 無い LOOK へのつなぎは外部キーの違反で落ちる', async () => {
    const itemId = await insertItem();

    const result = await failure('insert into public.look_items (look_id, item_id) values (-1, $1)', [itemId]);

    expect(result).toEqual({ code: '23503', constraint: 'look_items_look_id_fkey' });
  });

  test('DATA-LOOK-002 無い商品へのつなぎは外部キーの違反で落ちる', async () => {
    const lookId = await insertLook();

    const result = await failure('insert into public.look_items (look_id, item_id) values ($1, -1)', [lookId]);

    expect(result).toEqual({ code: '23503', constraint: 'look_items_item_id_fkey' });
  });

  test.each(['look_id', 'item_id'])('DATA-LOOK-002 %s が NULL の行は NOT NULL の違反で落ちる', async (column) => {
    const lookId = await insertLook();
    const itemId = await insertItem();
    const params = column === 'look_id' ? [null, itemId] : [lookId, null];

    const result = await failure('insert into public.look_items (look_id, item_id) values ($1, $2)', params);

    expect(result.code).toBe('23502');
  });

  test('DATA-LOOK-002 非公開の商品も、非公開の LOOK につなげる', async () => {
    const lookId = await insertLook();
    const privateItem = await insertItem('private');

    await link(lookId, privateItem);

    expect(await itemsOf(lookId)).toEqual([privateItem]);
  });

  test('DATA-LOOK-002 created_at を省くと今の時刻が入る', async () => {
    const lookId = await insertLook();
    const itemId = await insertItem();

    const inserted = await db().query(
      'insert into public.look_items (look_id, item_id) values ($1, $2) returning created_at',
      [lookId, itemId],
    );
    const now = (await db().query('select now() as now')).rows[0].now as Date;

    expect((inserted.rows[0].created_at as Date).toISOString()).toBe(now.toISOString());
  });

  test('DATA-LOOK-002 LOOK を消すと関連の行も消え、商品は残る', async () => {
    const lookId = await insertLook();
    const otherLook = await insertLook();
    const itemId = await insertItem();
    await link(lookId, itemId);
    await link(otherLook, itemId);

    const deleted = await db().query('delete from public.looks where id = $1', [lookId]);

    expect(deleted.rowCount).toBe(1);
    expect(await itemsOf(lookId)).toEqual([]);
    expect(await itemsOf(otherLook)).toEqual([itemId]);
    expect(await exists('items', itemId)).toBe(true);
  });

  test('DATA-LOOK-002 商品を消すと関連の行も消え、LOOK は残る', async () => {
    const lookId = await insertLook();
    const keptItem = await insertItem();
    const removedItem = await insertItem();
    await link(lookId, keptItem);
    await link(lookId, removedItem);

    const deleted = await db().query('delete from public.items where id = $1', [removedItem]);

    expect(deleted.rowCount).toBe(1);
    expect(await itemsOf(lookId)).toEqual([keptItem]);
    expect(await exists('looks', lookId)).toBe(true);
  });

  test('DATA-LOOK-002 商品の側の検索用に item_id の索引がある', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'look_items'`,
    );
    const byName = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef as string]));

    expect(Object.keys(byName).sort()).toEqual(['look_items_item_id_idx', 'look_items_pkey']);
    expect(byName.look_items_item_id_idx).toContain('(item_id)');
  });
});
