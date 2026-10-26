/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { readMigration } from '../../helpers/staged-supabase';

/**
 * looks の長さと画像の道筋の CHECK（DATA-LOOK-001、SEC-LOOK-023、ADR-0162）。
 * 3 本とも NOT VALID で入る。手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻す。
 * 移行の形（DB なしで流せる確かめ）は describeLocalDb の外に置く。
 */
const CONSTRAINTS = ['looks_theme_length_check', 'looks_theme_description_length_check', 'looks_image_urls_path_check'];

const ACCEPTED_IMAGE_URLS: Array<[string, string[]]> = [
  ['日付と uuid の道筋', ['looks/2026-10-24/00000000-0000-4000-8000-000000000000.png']],
  ['見本の道筋', ['looks/e2e/look-1-1.png']],
  ['最小の道筋', ['looks/a.png']],
  ['空の配列', []],
  ['2 つの道筋', ['looks/a.png', 'looks/b/c.webp']],
  ['記号 . _ - を含む名前', ['looks/a.b_c-d.png']],
];

const REJECTED_IMAGE_URLS: Array<[string, Array<string | null>]> = [
  ['接頭辞が looks/ でない', ['other/x.png']],
  ['.. を含む', ['looks/../y.png']],
  ['// を含む', ['looks//y.png']],
  ['先頭が /', ['/looks/y.png']],
  ['. で始まる階層', ['looks/.hidden/y.png']],
  ['別ホストの URL', ['https://evil.example/looks/x.png']],
  ['改行で 2 つ目が外の道筋', ['looks/a.png\nother/b.png']],
  ['1 つの要素に 2 つの有効な道筋を改行で並べた', ['looks/a.png\nlooks/b.png']],
  ['末尾に改行', ['looks/a.png\n']],
  ['空の文字', ['']],
  ['有効な道筋の後ろに空の文字', ['looks/a.png', '']],
  ['NULL の要素だけ', [null]],
  ['有効な道筋の後ろに NULL の要素', ['looks/a.png', null]],
  ['looks/ だけ', ['looks/']],
  ['looks だけ', ['looks']],
  ['空白を含む', ['looks/a b.png']],
  ['末尾が空白', ['looks/a.png ']],
  ['接頭辞が大文字', ['LOOKS/a.png']],
];

describe('DATA-LOOK-001 looks の CHECK の移行の形（DB なし）', () => {
  const sql = readMigration('sec_rls_predicates_and_constraints');

  test.each(CONSTRAINTS)('DATA-LOOK-001 移行は %s を NOT VALID で足す', (name) => {
    expect(sql).toContain(`'${name}'`);
  });

  test('DATA-LOOK-001 移行は ADD CONSTRAINT を NOT VALID で足し、VALIDATE CONSTRAINT は書かない（この波の決まり）', () => {
    expect(sql).toMatch(/ADD CONSTRAINT %I %s NOT VALID/);
    expect(sql).not.toMatch(/VALIDATE CONSTRAINT/i);
  });

  test('DATA-LOOK-001 画像の道筋は補助関数を作らず式で直に書く（ADR-0162）', () => {
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION (private|public)\.look_image_paths_ok/);
    expect(sql).toContain("array_position(image_urls, NULL) IS NULL");
    expect(sql).toContain("array_to_string(image_urls, E'\\n')");
  });

  test('DATA-LOOK-001 移行のヘッダーに対のロールバックの文が 3 本の DROP CONSTRAINT 付きである', () => {
    for (const name of CONSTRAINTS) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
    }
  });
});

describeLocalDb('integration: looks の CHECK', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  const theme = (): string => `integration look constraints ${randomUUID()}`;

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

  const insertSql =
    "insert into public.looks (season_year, season_type, theme, theme_description, image_urls) values (2026, 'SS', $1, $2, $3::text[])";

  test('DATA-LOOK-001 3 本の CHECK は NOT VALID（convalidated が偽）で入っている', async () => {
    const result = await db().query(
      `select conname, convalidated from pg_constraint
       where conrelid = 'public.looks'::regclass and conname = any($1::text[]) order by conname`,
      [CONSTRAINTS],
    );

    expect(result.rows).toEqual(
      [...CONSTRAINTS].sort().map((conname) => ({ conname, convalidated: false })),
    );
  });

  test.each(ACCEPTED_IMAGE_URLS)('DATA-LOOK-001 SEC-LOOK-023 image_urls: %s は入る', async (_label, urls) => {
    const result = await db().query(`${insertSql} returning image_urls`, [theme(), '', urls]);

    expect(result.rows).toEqual([{ image_urls: urls }]);
  });

  test.each(REJECTED_IMAGE_URLS)('DATA-LOOK-001 SEC-LOOK-023 image_urls: %s は CHECK の違反（23514）で落ちる', async (_label, urls) => {
    expect(await failure(insertSql, [theme(), '', urls])).toEqual({
      code: '23514',
      constraint: 'looks_image_urls_path_check',
    });
  });

  test('DATA-LOOK-001 image_urls の枚数に上限は無い（50 枚）', async () => {
    const urls = Array.from({ length: 50 }, (_, index) => `looks/2026-01-01/n-${index}.png`);

    const result = await db().query(`${insertSql} returning cardinality(image_urls) as count`, [theme(), '', urls]);

    expect(result.rows).toEqual([{ count: 50 }]);
  });

  test.each([1, 200])('DATA-LOOK-001 SEC-LOOK-023 テーマ %i 字は入る', async (length) => {
    const result = await db().query(`${insertSql} returning char_length(theme) as length`, ['t'.repeat(length), '', []]);

    expect(result.rows).toEqual([{ length }]);
  });

  test.each([0, 201, 10001])('DATA-LOOK-001 SEC-LOOK-023 テーマ %i 字は CHECK の違反（23514）で落ちる', async (length) => {
    expect(await failure(insertSql, ['t'.repeat(length), '', []])).toEqual({
      code: '23514',
      constraint: 'looks_theme_length_check',
    });
  });

  test.each([0, 4000])('DATA-LOOK-001 SEC-LOOK-023 説明 %i 字は入る', async (length) => {
    const result = await db().query(
      `${insertSql} returning char_length(theme_description) as length`,
      [theme(), 'd'.repeat(length), []],
    );

    expect(result.rows).toEqual([{ length }]);
  });

  test('DATA-LOOK-001 SEC-LOOK-023 説明 4001 字は CHECK の違反（23514）で落ちる', async () => {
    expect(await failure(insertSql, [theme(), 'd'.repeat(4001), []])).toEqual({
      code: '23514',
      constraint: 'looks_theme_description_length_check',
    });
  });

  test('DATA-LOOK-001 長さはコードポイントの数で数える（4 バイトの字 200 個のテーマは入る）', async () => {
    const result = await db().query(`${insertSql} returning char_length(theme) as length`, ['😀'.repeat(200), '', []]);

    expect(result.rows).toEqual([{ length: 200 }]);
  });

  test('DATA-LOOK-001 更新も同じ CHECK で検査される（入った行を 201 字のテーマや外の道筋には変えられない）', async () => {
    const inserted = await db().query(`${insertSql} returning id::text as id`, [theme(), '', ['looks/a.png']]);
    const id = inserted.rows[0].id as string;

    expect(await failure('update public.looks set theme = $2 where id = $1', [id, 't'.repeat(201)])).toEqual({
      code: '23514',
      constraint: 'looks_theme_length_check',
    });
    expect(await failure('update public.looks set image_urls = $2::text[] where id = $1', [id, ['other/x.png']])).toEqual({
      code: '23514',
      constraint: 'looks_image_urls_path_check',
    });
  });

  test('DATA-LOOK-001 NOT VALID の制約より前からある旧い行は残るが、関係の無い列の更新も 23514 で落ちる（VALIDATE の前に直す）', async () => {
    // E2E の補助 insertLegacyImageRow と同じ手順: 定義を読む → DROP → 旧い行を入れる → 同じ定義で NOT VALID に戻す
    const definition = (
      await db().query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'public.looks'::regclass and conname = 'looks_image_urls_path_check'`,
      )
    ).rows[0].def as string;
    await db().query('alter table public.looks drop constraint looks_image_urls_path_check');
    const legacy = await db().query(
      `${insertSql} returning id::text as id`,
      [theme(), '', ['https://example.com/old.jpg']],
    );
    await db().query(`alter table public.looks add constraint looks_image_urls_path_check ${definition.replace(/ NOT VALID$/, '')} not valid`);
    const id = legacy.rows[0].id as string;

    const stored = await db().query('select image_urls from public.looks where id = $1', [id]);
    expect(stored.rows).toEqual([{ image_urls: ['https://example.com/old.jpg'] }]);
    expect(await failure("update public.looks set status = 'published' where id = $1", [id])).toEqual({
      code: '23514',
      constraint: 'looks_image_urls_path_check',
    });
    // 道筋を直す更新は通る
    const fixed = await db().query(
      'update public.looks set image_urls = $2::text[] where id = $1 returning image_urls',
      [id, ['looks/e2e/look-1-1.png']],
    );
    expect(fixed.rows).toEqual([{ image_urls: ['looks/e2e/look-1-1.png'] }]);
  });
});
