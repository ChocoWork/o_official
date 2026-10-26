/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { readMigration } from '../../helpers/staged-supabase';

/**
 * news_articles の長さと画像の道筋の CHECK（DATA-NEWS-001、SEC-NEWS-025、ADR-0162）。
 * 4 本とも NOT VALID で入る。手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻す。
 * 移行の形（DB なしで流せる確かめ）は describeLocalDb の外に置く。
 */
const CONSTRAINTS = [
  'news_articles_title_length_check',
  'news_articles_content_length_check',
  'news_articles_detailed_content_length_check',
  'news_articles_image_url_path_check',
];

const ACCEPTED_IMAGE_URLS = [
  'news/2026-10-24/00000000-0000-4000-8000-000000000000.png',
  'news/e2e/news-1.png',
  'news/a.png',
  'news/a.b_c-d/e.webp',
];

const REJECTED_IMAGE_URLS: Array<[string, string]> = [
  ['接頭辞が news/ でない', 'e2e/news-1.png'],
  ['旧い見本の形', 'integration/news-table.png'],
  ['.. を含む', 'news/../x.png'],
  ['// を含む', 'news//x.png'],
  ['先頭が /', '/news/x.png'],
  ['. で始まる階層', 'news/.hidden/x.png'],
  ['別ホストの URL', 'https://evil.example/news/x.png'],
  ['改行を含む', 'news/a.png\nnews/b.png'],
  ['末尾に改行', 'news/a.png\n'],
  ['空の文字', ''],
  ['news/ だけ', 'news/'],
  ['空白を含む', 'news/a b.png'],
  ['接頭辞が大文字', 'NEWS/a.png'],
  ['道筋の形でない文字', 'not a storage path'],
];

describe('DATA-NEWS-001 news_articles の CHECK の移行の形（DB なし）', () => {
  const sql = readMigration('sec_rls_predicates_and_constraints');

  test.each(CONSTRAINTS)('DATA-NEWS-001 移行は %s を NOT VALID で足す', (name) => {
    expect(sql).toContain(`'${name}'`);
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
  });

  test('DATA-NEWS-001 移行は VALIDATE CONSTRAINT を書かない（既存の行の点検が先。この波の決まり）', () => {
    expect(sql).not.toMatch(/VALIDATE CONSTRAINT/i);
  });
});

describeLocalDb('integration: news_articles の CHECK', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  const insertSql = `insert into public.news_articles
      (title, category, published_date, image_url, content, detailed_content, status)
    values ($1, 'EVENT', '2026-05-14', $2, $3, $4, 'private')`;

  const title = (): string => `integration news constraints ${randomUUID()}`;
  const insertWith = (overrides: { title?: string; imageUrl?: string; content?: string; detailed?: string } = {}) =>
    [overrides.title ?? title(), overrides.imageUrl ?? 'news/e2e/news-1.png', overrides.content ?? 'c', overrides.detailed ?? 'd'];

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

  test('DATA-NEWS-001 4 本の CHECK は NOT VALID（convalidated が偽）で入っている', async () => {
    const result = await db().query(
      `select conname, convalidated from pg_constraint
       where conrelid = 'public.news_articles'::regclass and conname = any($1::text[]) order by conname`,
      [CONSTRAINTS],
    );

    expect(result.rows).toEqual(
      [...CONSTRAINTS].sort().map((conname) => ({ conname, convalidated: false })),
    );
  });

  test.each(ACCEPTED_IMAGE_URLS)('DATA-NEWS-001 SEC-NEWS-025 image_url %j は入る', async (imageUrl) => {
    const result = await db().query(`${insertSql} returning image_url`, insertWith({ imageUrl }));

    expect(result.rows).toEqual([{ image_url: imageUrl }]);
  });

  test.each(REJECTED_IMAGE_URLS)('DATA-NEWS-001 SEC-NEWS-025 image_url: %s は CHECK の違反（23514）で落ちる', async (_label, imageUrl) => {
    expect(await failure(insertSql, insertWith({ imageUrl }))).toEqual({
      code: '23514',
      constraint: 'news_articles_image_url_path_check',
    });
  });

  test.each([0, 1, 200])('DATA-NEWS-001 SEC-NEWS-025 題 %i 字は入る', async (length) => {
    const result = await db().query(`${insertSql} returning char_length(title) as length`, insertWith({ title: 't'.repeat(length) }));

    expect(result.rows).toEqual([{ length }]);
  });

  test('DATA-NEWS-001 SEC-NEWS-025 題 201 字は CHECK の違反（23514）で落ちる', async () => {
    expect(await failure(insertSql, insertWith({ title: 't'.repeat(201) }))).toEqual({
      code: '23514',
      constraint: 'news_articles_title_length_check',
    });
  });

  test.each([2000])('DATA-NEWS-001 SEC-NEWS-025 概要 %i 字は入る', async (length) => {
    const result = await db().query(
      `${insertSql} returning char_length(content) as length`,
      insertWith({ content: 'c'.repeat(length) }),
    );

    expect(result.rows).toEqual([{ length }]);
  });

  test('DATA-NEWS-001 SEC-NEWS-025 概要 2001 字は CHECK の違反（23514）で落ちる', async () => {
    expect(await failure(insertSql, insertWith({ content: 'c'.repeat(2001) }))).toEqual({
      code: '23514',
      constraint: 'news_articles_content_length_check',
    });
  });

  test('DATA-NEWS-001 SEC-NEWS-025 本文 10000 字は入る', async () => {
    const result = await db().query(
      `${insertSql} returning char_length(detailed_content) as length`,
      insertWith({ detailed: 'd'.repeat(10000) }),
    );

    expect(result.rows).toEqual([{ length: 10000 }]);
  });

  test('DATA-NEWS-001 SEC-NEWS-025 本文 10001 字は CHECK の違反（23514）で落ちる', async () => {
    expect(await failure(insertSql, insertWith({ detailed: 'd'.repeat(10001) }))).toEqual({
      code: '23514',
      constraint: 'news_articles_detailed_content_length_check',
    });
  });

  test('DATA-NEWS-001 長さはコードポイントの数で数える（4 バイトの字 200 個の題は入る）', async () => {
    const result = await db().query(
      `${insertSql} returning char_length(title) as length`,
      insertWith({ title: '😀'.repeat(200) }),
    );

    expect(result.rows).toEqual([{ length: 200 }]);
  });

  test('DATA-NEWS-001 更新も同じ CHECK で検査される（入った行を外の道筋や 201 字の題には変えられない）', async () => {
    const inserted = await db().query(`${insertSql} returning id::text as id`, insertWith());
    const id = inserted.rows[0].id as string;

    expect(await failure('update public.news_articles set image_url = $2 where id = $1', [id, 'other/x.png'])).toEqual({
      code: '23514',
      constraint: 'news_articles_image_url_path_check',
    });
    expect(await failure('update public.news_articles set title = $2 where id = $1', [id, 't'.repeat(201)])).toEqual({
      code: '23514',
      constraint: 'news_articles_title_length_check',
    });
  });

  test('DATA-NEWS-001 NOT VALID の制約より前からある旧い行は残るが、関係の無い列の更新も 23514 で落ちる（VALIDATE の前に直す）', async () => {
    // E2E の補助 insertLegacyImageRow と同じ手順: 定義を読む → DROP → 旧い行を入れる → 同じ定義で NOT VALID に戻す
    const definition = (
      await db().query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'public.news_articles'::regclass and conname = 'news_articles_image_url_path_check'`,
      )
    ).rows[0].def as string;
    await db().query('alter table public.news_articles drop constraint news_articles_image_url_path_check');
    const legacy = await db().query(
      `${insertSql} returning id::text as id`,
      insertWith({ imageUrl: 'https://example.com/old.jpg' }),
    );
    await db().query(
      `alter table public.news_articles add constraint news_articles_image_url_path_check ${definition.replace(/ NOT VALID$/, '')} not valid`,
    );
    const id = legacy.rows[0].id as string;

    const stored = await db().query('select image_url from public.news_articles where id = $1', [id]);
    expect(stored.rows).toEqual([{ image_url: 'https://example.com/old.jpg' }]);
    expect(await failure("update public.news_articles set status = 'published' where id = $1", [id])).toEqual({
      code: '23514',
      constraint: 'news_articles_image_url_path_check',
    });
    const fixed = await db().query(
      'update public.news_articles set image_url = $2 where id = $1 returning image_url',
      [id, 'news/e2e/news-1.png'],
    );
    expect(fixed.rows).toEqual([{ image_url: 'news/e2e/news-1.png' }]);
  });
});
