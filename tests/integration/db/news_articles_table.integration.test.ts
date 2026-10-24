/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';

/**
 * 記事の表 news_articles の列・制約・索引・トリガー（DATA-NEWS-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
const CATEGORIES = ['COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE'];
const REQUIRED_TEXT_COLUMNS = ['title', 'category', 'published_date', 'image_url', 'content', 'detailed_content'];

type Article = {
  title: string;
  category: string | null;
  published_date: string | null;
  image_url: string | null;
  content: string | null;
  detailed_content: string | null;
  status: string;
};

const baseArticle = (overrides: Partial<Article> = {}): Article => ({
  title: `integration news table ${Date.now()}`,
  category: 'COLLECTION',
  published_date: '2026-05-14',
  image_url: 'integration/news-table.png',
  content: 'integration summary',
  detailed_content: 'integration body',
  status: 'private',
  ...overrides,
});

describeLocalDb('integration: 記事の表 news_articles', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertArticle(article: Article): Promise<{ id: string; created_at: Date; updated_at: Date }> {
    const result = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id::text as id, created_at, updated_at`,
      [article.title, article.category, article.published_date, article.image_url,
        article.content, article.detailed_content, article.status],
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

  function insertSql(article: Article): [string, unknown[]] {
    return [
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [article.title, article.category, article.published_date, article.image_url,
        article.content, article.detailed_content, article.status],
    ];
  }

  test('DATA-NEWS-001 列の名前・型・NULL の可否が設計の表と一致する', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, is_identity
       from information_schema.columns
       where table_schema = 'public' and table_name = 'news_articles'
       order by ordinal_position`,
    );

    expect(result.rows).toEqual([
      { column_name: 'id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'YES' },
      { column_name: 'title', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'category', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'published_date', data_type: 'date', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'image_url', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'content', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'detailed_content', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO' },
    ]);
  });

  test('DATA-NEWS-001 主キーは id の1列だけ', async () => {
    const result = await db().query(
      `select a.attname as column_name
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = 'public.news_articles'::regclass and c.contype = 'p'`,
    );

    expect(result.rows).toEqual([{ column_name: 'id' }]);
  });

  test('DATA-NEWS-001 id を省くと番号が振られ、同じ id の2行目は主キーの違反で落ちる', async () => {
    const first = await insertArticle(baseArticle());
    expect(first.id).toMatch(/^\d+$/);

    const duplicate = await failure(
      `insert into public.news_articles
         (id, title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'dup', 'EVENT', '2026-01-01', 'integration/dup.png', 'c', 'd', 'private')`,
      [first.id],
    );

    expect(duplicate).toEqual({ code: '23505', constraint: 'news_articles_pkey' });
  });

  test.each(CATEGORIES)('DATA-NEWS-001 分類 %s は入る', async (category) => {
    const row = await insertArticle(baseArticle({ category }));

    const stored = await db().query('select category from public.news_articles where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ category }]);
  });

  test.each(['BLOG', 'collection', ''])('DATA-NEWS-001 分類 "%s" は CHECK の違反で落ちる', async (category) => {
    const [sql, params] = insertSql(baseArticle({ category }));

    expect(await failure(sql, params)).toEqual({ code: '23514', constraint: 'news_articles_category_check' });
  });

  test.each(REQUIRED_TEXT_COLUMNS)('DATA-NEWS-001 %s が NULL の行は NOT NULL の違反で落ちる', async (column) => {
    const [sql, params] = insertSql(baseArticle({ [column]: null } as Partial<Article>));

    expect((await failure(sql, params)).code).toBe('23502');
  });

  test('DATA-NEWS-001 公開日は date の型なので、ありえない日付は落ちる', async () => {
    const [sql, params] = insertSql(baseArticle({ published_date: '2026-02-30' }));

    expect((await failure(sql, params)).code).toBe('22008');
  });

  test('DATA-NEWS-001 題・概要・本文に長さの上限は無い', async () => {
    const long = 'x'.repeat(10001);
    const row = await insertArticle(baseArticle({ title: long, content: long, detailed_content: long }));

    const stored = await db().query(
      `select length(title) as title, length(content) as content, length(detailed_content) as body
       from public.news_articles where id = $1`,
      [row.id],
    );
    expect(stored.rows).toEqual([{ title: 10001, content: 10001, body: 10001 }]);
  });

  test('DATA-NEWS-001 image_url の形は表では確かめない', async () => {
    const row = await insertArticle(baseArticle({ image_url: 'not a storage path' }));

    const stored = await db().query('select image_url from public.news_articles where id = $1', [row.id]);
    expect(stored.rows).toEqual([{ image_url: 'not a storage path' }]);
  });

  test('DATA-NEWS-001 created_at・updated_at を省くと今の時刻が入る', async () => {
    const row = await insertArticle(baseArticle());
    const now = (await db().query('select now() as now')).rows[0].now as Date;

    expect(row.created_at.toISOString()).toBe(now.toISOString());
    expect(row.updated_at.toISOString()).toBe(now.toISOString());
  });

  test('DATA-NEWS-001 更新するとトリガーが updated_at を今にし、created_at は変えない', async () => {
    const inserted = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status, created_at, updated_at)
       values ('integration trigger', 'STORE', '2026-01-01', 'integration/trigger.png', 'c', 'd', 'private',
               '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
       returning id::text as id`,
    );
    const id = inserted.rows[0].id as string;

    // 取引の中の now() は取引の始まりの時刻で動かないので、送った値ではなく now() と比べる
    const updated = await db().query(
      `update public.news_articles set title = 'integration trigger updated', updated_at = '2021-01-01T00:00:00Z'
       where id = $1
       returning created_at, updated_at, now() as now`,
      [id],
    );

    const row = updated.rows[0];
    expect(row.created_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(row.updated_at.toISOString()).toBe(row.now.toISOString());
  });

  test('DATA-NEWS-001 更新の前のトリガー trg_news_articles_updated_at が行ごとに付いている', async () => {
    const result = await db().query(
      `select t.tgname, p.proname,
              (t.tgtype & 1) <> 0 as for_each_row,
              (t.tgtype & 2) <> 0 as before,
              (t.tgtype & 16) <> 0 as on_update,
              (t.tgtype & 4) <> 0 as on_insert
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.news_articles'::regclass and not t.tgisinternal`,
    );

    expect(result.rows).toEqual([{
      tgname: 'trg_news_articles_updated_at',
      proname: 'set_news_articles_updated_at',
      for_each_row: true,
      before: true,
      on_update: true,
      on_insert: false,
    }]);
  });

  test('DATA-NEWS-001 索引は主キーと category・published_date の降順・status', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'news_articles'
       order by indexname`,
    );
    const byName = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef as string]));

    expect(Object.keys(byName)).toEqual([
      'news_articles_category_idx',
      'news_articles_pkey',
      'news_articles_published_date_idx',
      'news_articles_status_idx',
    ]);
    expect(byName.news_articles_category_idx).toContain('(category)');
    expect(byName.news_articles_published_date_idx).toContain('(published_date DESC)');
    expect(byName.news_articles_status_idx).toContain('(status)');
  });
});
