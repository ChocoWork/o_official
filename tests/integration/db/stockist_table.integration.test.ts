/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * 取扱店の表 stockists の列・制約・索引・トリガー（DATA-STOCKIST-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
const STORE_TYPES = ['FLAGSHIP STORE', 'STORE', 'SELECT SHOP'];
const REQUIRED_COLUMNS = ['name', 'address', 'phone', 'time', 'holiday', 'status'];

type Stockist = {
  type: string | null;
  name: string | null;
  address: string | null;
  phone: string | null;
  time: string | null;
  holiday: string | null;
  status: string | null;
};

const baseStockist = (overrides: Partial<Stockist> = {}): Stockist => ({
  type: 'STORE',
  name: `integration stockist table ${randomUUID()}`,
  address: '東京都渋谷区1-1-1',
  phone: '03-0000-0000',
  time: '11:00-19:00',
  holiday: '水曜',
  status: 'private',
  ...overrides,
});

describeLocalDb('integration: 取扱店の表 stockists', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  const insertSql = `insert into public.stockists (type, name, address, phone, "time", holiday, status)
    values ($1, $2, $3, $4, $5, $6, $7)`;

  const values = (stockist: Stockist): unknown[] => [
    stockist.type, stockist.name, stockist.address, stockist.phone, stockist.time, stockist.holiday, stockist.status,
  ];

  async function insertStockist(stockist: Stockist): Promise<{ id: string; created_at: Date; updated_at: Date }> {
    const result = await db().query(
      `${insertSql} returning id::text as id, created_at, updated_at`,
      values(stockist),
    );
    return result.rows[0];
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

  test('DATA-STOCKIST-001 列の名前・型・NULL の可否・初めの値が設計の表と一致する', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, column_default, is_identity
       from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists'
       order by ordinal_position`,
    );

    const rows = result.rows as Array<{
      column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string;
    }>;
    const idColumn = rows[0];
    expect(idColumn).toMatchObject({ column_name: 'id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'NO' });
    expect(idColumn.column_default).toMatch(/^nextval\('(public\.)?stockists_id_seq'::regclass\)$/);
    expect(rows.slice(1).map(({ column_name, data_type, is_nullable, column_default }) => ({
      column_name, data_type, is_nullable, column_default,
    }))).toEqual([
      { column_name: 'type', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'name', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'address', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'phone', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'time', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'holiday', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO', column_default: "'private'::text" },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
    ]);
  });

  test('DATA-STOCKIST-001 主キーは id の1列だけで、連番 stockists_id_seq が id の持ち主になっている', async () => {
    const primaryKey = await db().query(
      `select a.attname as column_name
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = 'public.stockists'::regclass and c.contype = 'p'`,
    );
    expect(primaryKey.rows).toEqual([{ column_name: 'id' }]);

    const sequence = await db().query("select pg_get_serial_sequence('public.stockists', 'id') as sequence");
    expect(sequence.rows).toEqual([{ sequence: 'public.stockists_id_seq' }]);
  });

  test('DATA-STOCKIST-001 id を省くと連番が振られ、同じ id の2行目は主キーの違反で落ちる', async () => {
    const first = await insertStockist(baseStockist());
    const second = await insertStockist(baseStockist());
    expect(first.id).toMatch(/^\d+$/);
    expect(Number(second.id)).toBeGreaterThan(Number(first.id));

    const duplicate = await failure(
      `insert into public.stockists (id, type, name, address, phone, "time", holiday)
       values ($1, 'STORE', 'dup', 'a', 'p', 't', 'h')`,
      [first.id],
    );

    expect(duplicate).toEqual({ code: '23505', constraint: 'stockists_pkey' });
  });

  test.each(STORE_TYPES)('DATA-STOCKIST-001 種別 %s は入る', async (type) => {
    const row = await insertStockist(baseStockist({ type }));

    const stored = await db().query('select type from public.stockists where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ type }]);
  });

  test.each(['store', 'STORE ', 'POP UP', ''])('DATA-STOCKIST-001 種別 "%s" は CHECK の違反で落ちる', async (type) => {
    const result = await failure(insertSql, values(baseStockist({ type })));

    expect(result).toEqual({ code: '23514', constraint: 'stockists_type_check' });
  });

  test.each(REQUIRED_COLUMNS)('DATA-STOCKIST-001 %s が NULL の行は NOT NULL の違反で落ちる', async (column) => {
    const result = await failure(insertSql, values(baseStockist({ [column]: null } as Partial<Stockist>)));

    expect(result.code).toBe('23502');
  });

  test('DATA-STOCKIST-001 種別を省いた作成は通り、種別は NULL になる（管理の作成の窓口は種別を送らない。移行 stockists_type_optional）', async () => {
    const inserted = await db().query(
      `insert into public.stockists (name, address, phone, "time", holiday, status)
       values ('no type', 'a', 'p', 't', 'h', 'private')
       returning type`,
    );

    expect(inserted.rows).toEqual([{ type: null }]);
  });

  test('DATA-STOCKIST-001 状態を省くと private が入る', async () => {
    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, "time", holiday)
       values ('STORE', 'integration defaults', 'a', 'p', 't', 'h')
       returning status`,
    );

    expect(inserted.rows).toEqual([{ status: 'private' }]);
  });

  test('DATA-STOCKIST-001 各列に長さの上限は無い', async () => {
    const long = 'x'.repeat(10001);
    const row = await insertStockist(baseStockist({
      name: long, address: long, phone: long, time: long, holiday: long,
    }));

    const stored = await db().query(
      `select length(name) as name, length(address) as address, length(phone) as phone,
              length("time") as time, length(holiday) as holiday
       from public.stockists where id = $1`,
      [row.id],
    );
    expect(stored.rows).toEqual([{ name: 10001, address: 10001, phone: 10001, time: 10001, holiday: 10001 }]);
  });

  test('DATA-STOCKIST-001 特集の印・並び順・県の列は無い', async () => {
    const result = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists'
         and column_name ~ '(featured|sort|order|position|prefecture|region|pref)'`,
    );

    expect(result.rows).toEqual([]);
  });

  test('DATA-STOCKIST-001 created_at・updated_at を省くと今の時刻が入る', async () => {
    const row = await insertStockist(baseStockist());
    const now = (await db().query('select now() as now')).rows[0].now as Date;

    expect(row.created_at.toISOString()).toBe(now.toISOString());
    expect(row.updated_at.toISOString()).toBe(now.toISOString());
  });

  test('DATA-STOCKIST-001 更新するとトリガーが updated_at を今にし、created_at は変えない', async () => {
    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, "time", holiday, created_at, updated_at)
       values ('STORE', 'integration trigger', 'a', 'p', 't', 'h', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
       returning id::text as id`,
    );
    const id = inserted.rows[0].id as string;

    // 取引の中の now() は取引の始まりの時刻で動かないので、送った値ではなく now() と比べる
    const updated = await db().query(
      `update public.stockists set name = 'integration trigger updated', updated_at = '2021-01-01T00:00:00Z'
       where id = $1
       returning created_at, updated_at, now() as now`,
      [id],
    );

    const row = updated.rows[0];
    expect(row.created_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(row.updated_at.toISOString()).toBe(row.now.toISOString());
  });

  test('DATA-STOCKIST-001 更新の前のトリガー trigger_stockists_updated_at が行ごとに付いている', async () => {
    const result = await db().query(
      `select t.tgname, p.proname,
              (t.tgtype & 1) <> 0 as for_each_row,
              (t.tgtype & 2) <> 0 as before,
              (t.tgtype & 16) <> 0 as on_update,
              (t.tgtype & 4) <> 0 as on_insert
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.stockists'::regclass and not t.tgisinternal`,
    );

    expect(result.rows).toEqual([{
      tgname: 'trigger_stockists_updated_at',
      proname: 'update_stockists_updated_at',
      for_each_row: true,
      before: true,
      on_update: true,
      on_insert: false,
    }]);
  });

  test('DATA-STOCKIST-001 索引は主キーと status だけ', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'stockists'`,
    );
    const byName = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef as string]));

    expect(Object.keys(byName).sort()).toEqual(['idx_stockists_status', 'stockists_pkey']);
    expect(byName.idx_stockists_status).toContain('(status)');
  });
});
