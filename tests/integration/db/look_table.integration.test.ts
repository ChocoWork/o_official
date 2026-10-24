/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * LOOK の表 looks の列・制約・索引・トリガー（DATA-LOOK-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
const SEASON_TYPES = ['SS', 'AW'];
const REQUIRED_COLUMNS = ['season_year', 'season_type', 'theme', 'theme_description', 'image_urls', 'status'];

type Look = {
  season_year: number | null;
  season_type: string | null;
  theme: string | null;
  theme_description: string | null;
  image_urls: string[] | null;
  status: string | null;
};

const baseLook = (overrides: Partial<Look> = {}): Look => ({
  season_year: 2026,
  season_type: 'SS',
  theme: `integration look table ${Date.now()}`,
  theme_description: 'integration description',
  image_urls: ['looks/2026-01-01/integration.png'],
  status: 'private',
  ...overrides,
});

describeLocalDb('integration: LOOK の表 looks', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  const insertSql = `insert into public.looks
      (season_year, season_type, theme, theme_description, image_urls, status)
    values ($1, $2, $3, $4, $5, $6)`;

  const values = (look: Look): unknown[] => [
    look.season_year, look.season_type, look.theme, look.theme_description, look.image_urls, look.status,
  ];

  async function insertLook(look: Look): Promise<{ id: string; created_at: Date; updated_at: Date }> {
    const result = await db().query(
      `${insertSql} returning id::text as id, created_at, updated_at`,
      values(look),
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

  test('DATA-LOOK-001 列の名前・型・NULL の可否が設計の表と一致する', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, is_identity, identity_generation
       from information_schema.columns
       where table_schema = 'public' and table_name = 'looks'
       order by ordinal_position`,
    );

    expect(result.rows).toEqual([
      { column_name: 'id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'YES', identity_generation: 'BY DEFAULT' },
      { column_name: 'season_year', data_type: 'integer', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'season_type', data_type: 'text', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'theme', data_type: 'text', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'theme_description', data_type: 'text', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'image_urls', data_type: 'ARRAY', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
    ]);
  });

  test('DATA-LOOK-001 image_urls は text の配列で、既定値は空の配列', async () => {
    const result = await db().query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as type, pg_get_expr(d.adbin, d.adrelid) as default_expr
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = 'public.looks'::regclass and a.attname = 'image_urls'`,
    );

    expect(result.rows).toEqual([{ attname: 'image_urls', type: 'text[]', default_expr: "'{}'::text[]" }]);
  });

  test('DATA-LOOK-001 主キーは id の1列だけ', async () => {
    const result = await db().query(
      `select a.attname as column_name
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = 'public.looks'::regclass and c.contype = 'p'`,
    );

    expect(result.rows).toEqual([{ column_name: 'id' }]);
  });

  test('DATA-LOOK-001 id を省くと番号が振られ、同じ id の2行目は主キーの違反で落ちる', async () => {
    const first = await insertLook(baseLook());
    expect(first.id).toMatch(/^\d+$/);

    const duplicate = await failure(
      `insert into public.looks (id, season_year, season_type, theme) values ($1, 2026, 'AW', 'dup')`,
      [first.id],
    );

    expect(duplicate).toEqual({ code: '23505', constraint: 'looks_pkey' });
  });

  test.each(SEASON_TYPES)('DATA-LOOK-001 シーズン %s は入る', async (seasonType) => {
    const row = await insertLook(baseLook({ season_type: seasonType }));

    const stored = await db().query('select season_type from public.looks where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ season_type: seasonType }]);
  });

  test.each(['FW', 'ss', 'SS ', ''])('DATA-LOOK-001 シーズン "%s" は CHECK の違反で落ちる', async (seasonType) => {
    const result = await failure(insertSql, values(baseLook({ season_type: seasonType })));

    expect(result).toEqual({ code: '23514', constraint: 'looks_season_type_check' });
  });

  test.each([2000, 2026, 2100])('DATA-LOOK-001 年 %i は入る', async (year) => {
    const row = await insertLook(baseLook({ season_year: year }));

    const stored = await db().query('select season_year from public.looks where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ season_year: year }]);
  });

  test.each([1999, 2101, 0, -1])('DATA-LOOK-001 年 %i は CHECK の違反で落ちる', async (year) => {
    const result = await failure(insertSql, values(baseLook({ season_year: year })));

    expect(result).toEqual({ code: '23514', constraint: 'looks_season_year_check' });
  });

  test.each(REQUIRED_COLUMNS)('DATA-LOOK-001 %s が NULL の行は NOT NULL の違反で落ちる', async (column) => {
    const result = await failure(insertSql, values(baseLook({ [column]: null } as Partial<Look>)));

    expect(result.code).toBe('23502');
  });

  test('DATA-LOOK-001 説明文・画像・状態を省くと、空の文字・空の配列・private が入る', async () => {
    const inserted = await db().query(
      `insert into public.looks (season_year, season_type, theme) values (2026, 'AW', 'integration defaults')
       returning theme_description, image_urls, status`,
    );

    expect(inserted.rows).toEqual([{ theme_description: '', image_urls: [], status: 'private' }]);
  });

  test('DATA-LOOK-001 テーマ・説明文に長さの上限は無い', async () => {
    const long = 'x'.repeat(10001);
    const row = await insertLook(baseLook({ theme: long, theme_description: long }));

    const stored = await db().query(
      `select length(theme) as theme, length(theme_description) as description
       from public.looks where id = $1`,
      [row.id],
    );
    expect(stored.rows).toEqual([{ theme: 10001, description: 10001 }]);
  });

  test('DATA-LOOK-001 image_urls の枚数と道筋の形は表では確かめない', async () => {
    const urls = Array.from({ length: 50 }, (_, index) => `not a storage path ${index}`);
    const row = await insertLook(baseLook({ image_urls: urls }));

    const stored = await db().query('select image_urls from public.looks where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ image_urls: urls }]);
  });

  test('DATA-LOOK-001 公開日の列は無い', async () => {
    const result = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'looks'
         and column_name ~ '(publish|_date$)'`,
    );

    expect(result.rows).toEqual([]);
  });

  test('DATA-LOOK-001 created_at・updated_at を省くと今の時刻が入る', async () => {
    const row = await insertLook(baseLook());
    const now = (await db().query('select now() as now')).rows[0].now as Date;

    expect(row.created_at.toISOString()).toBe(now.toISOString());
    expect(row.updated_at.toISOString()).toBe(now.toISOString());
  });

  test('DATA-LOOK-001 更新するとトリガーが updated_at を今にし、created_at は変えない', async () => {
    const inserted = await db().query(
      `insert into public.looks (season_year, season_type, theme, created_at, updated_at)
       values (2026, 'SS', 'integration trigger', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
       returning id::text as id`,
    );
    const id = inserted.rows[0].id as string;

    // 取引の中の now() は取引の始まりの時刻で動かないので、送った値ではなく now() と比べる
    const updated = await db().query(
      `update public.looks set theme = 'integration trigger updated', updated_at = '2021-01-01T00:00:00Z'
       where id = $1
       returning created_at, updated_at, now() as now`,
      [id],
    );

    const row = updated.rows[0];
    expect(row.created_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(row.updated_at.toISOString()).toBe(row.now.toISOString());
  });

  test('DATA-LOOK-001 更新の前のトリガー trg_looks_updated_at が行ごとに付いている', async () => {
    const result = await db().query(
      `select t.tgname, p.proname,
              (t.tgtype & 1) <> 0 as for_each_row,
              (t.tgtype & 2) <> 0 as before,
              (t.tgtype & 16) <> 0 as on_update,
              (t.tgtype & 4) <> 0 as on_insert
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.looks'::regclass and not t.tgisinternal`,
    );

    expect(result.rows).toEqual([{
      tgname: 'trg_looks_updated_at',
      proname: 'set_looks_updated_at',
      for_each_row: true,
      before: true,
      on_update: true,
      on_insert: false,
    }]);
  });

  test('DATA-LOOK-001 索引は主キーと created_at の降順・status', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'looks'`,
    );
    const byName = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef as string]));

    expect(Object.keys(byName).sort()).toEqual(['looks_created_at_idx', 'looks_pkey', 'looks_status_idx']);
    expect(byName.looks_created_at_idx).toContain('(created_at DESC)');
    expect(byName.looks_status_idx).toContain('(status)');
  });
});
