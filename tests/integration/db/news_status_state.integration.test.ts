/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * 記事の公開の状態 private・published の値と行き来（STATE-NEWS-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: 記事の公開の状態', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-news-state-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertArticle(status: string): Promise<string> {
    const result = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'COLLECTION', '2026-05-10', 'integration/news-state.png', 'summary', 'body', $2)
       returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function article(id: string): Promise<{ status: string; published_date: string } | undefined> {
    const result = await db().query(
      `select status, published_date::text as published_date from public.news_articles where id = $1`, [id],
    );
    return result.rows[0];
  }

  async function setStatus(id: string, status: string): Promise<number> {
    return (await db().query('update public.news_articles set status = $2 where id = $1', [id, status])).rowCount;
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

  /** anon は RLS で公開済みだけを見るので、公開の道に出るかを anon の役で確かめる。 */
  async function visibleToAnon(id: string): Promise<boolean> {
    await db().query('savepoint as_anon');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query('set local role anon');
      const result = await db().query('select 1 from public.news_articles where id = $1', [id]);
      return result.rowCount === 1;
    } finally {
      await db().query('rollback to savepoint as_anon');
    }
  }

  test('STATE-NEWS-001 状態の CHECK は private と published の2つだけを許す', async () => {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.news_articles'::regclass and conname = 'news_articles_status_check'`,
    );

    expect(result.rows).toHaveLength(1);
    const allowed = [...(result.rows[0].definition as string).matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(allowed.sort()).toEqual(['private', 'published']);
  });

  test.each(['private', 'published'])('STATE-NEWS-001 作成で %s を入れられる', async (status) => {
    const id = await insertArticle(status);

    expect((await article(id))?.status).toBe(status);
  });

  test.each(['draft', 'PUBLISHED', 'archived', ''])('STATE-NEWS-001 状態 "%s" の作成は CHECK の違反で落ちる', async (status) => {
    const result = await failure(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'COLLECTION', '2026-05-10', 'integration/news-state.png', 'summary', 'body', $2)`,
      [`${marker} invalid`, status],
    );

    expect(result).toEqual({ code: '23514', constraint: 'news_articles_status_check' });
  });

  test('STATE-NEWS-001 DB の初めの値は draft で、状態を省いた作成は CHECK の違反で落ちる', async () => {
    const defaults = await db().query(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'news_articles' and column_name = 'status'`,
    );
    expect(defaults.rows).toEqual([{ column_default: "'draft'::text" }]);

    const result = await failure(
      `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content)
       values ($1, 'COLLECTION', '2026-05-10', 'integration/news-state.png', 'summary', 'body')`,
      [`${marker} default`],
    );

    expect(result).toEqual({ code: '23514', constraint: 'news_articles_status_check' });
  });

  test('STATE-NEWS-001 private から published へ変えると公開の道に出る', async () => {
    const id = await insertArticle('private');
    expect(await visibleToAnon(id)).toBe(false);

    expect(await setStatus(id, 'published')).toBe(1);

    expect((await article(id))?.status).toBe('published');
    expect(await visibleToAnon(id)).toBe(true);
  });

  test('STATE-NEWS-001 published から private へ変えると公開の道から消える', async () => {
    const id = await insertArticle('published');
    expect(await visibleToAnon(id)).toBe(true);

    expect(await setStatus(id, 'private')).toBe(1);

    expect((await article(id))?.status).toBe('private');
    expect(await visibleToAnon(id)).toBe(false);
  });

  test.each(['private', 'published'])('STATE-NEWS-001 同じ状態 %s への変更も1行の更新として通る', async (status) => {
    const id = await insertArticle(status);

    expect(await setStatus(id, status)).toBe(1);
    expect((await article(id))?.status).toBe(status);
  });

  test.each(['private', 'published'])('STATE-NEWS-001 %s から CHECK に無い値へは変えられない', async (status) => {
    const id = await insertArticle(status);

    const result = await failure("update public.news_articles set status = 'draft' where id = $1", [id]);

    expect(result).toEqual({ code: '23514', constraint: 'news_articles_status_check' });
    expect((await article(id))?.status).toBe(status);
  });

  test('STATE-NEWS-001 公開の日時の列は無く、状態を変えても published_date は変わらない', async () => {
    const columns = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'news_articles' and column_name like 'published%'`,
    );
    expect(columns.rows).toEqual([{ column_name: 'published_date' }]);

    const id = await insertArticle('private');
    await setStatus(id, 'published');
    expect((await article(id))?.published_date).toBe('2026-05-10');
    await setStatus(id, 'private');
    expect((await article(id))?.published_date).toBe('2026-05-10');
  });

  test('STATE-NEWS-001 未来の公開日でも published にした時点で公開の道に出る', async () => {
    const inserted = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'EVENT', current_date + 30, 'integration/news-state.png', 'summary', 'body', 'private')
       returning id::text as id`,
      [`${marker} future`],
    );
    const id = inserted.rows[0].id as string;

    await setStatus(id, 'published');

    expect(await visibleToAnon(id)).toBe(true);
  });

  test.each(['private', 'published'])('STATE-NEWS-001 %s の記事も削除で行が消える', async (status) => {
    const id = await insertArticle(status);

    const deleted = await db().query('delete from public.news_articles where id = $1', [id]);

    expect(deleted.rowCount).toBe(1);
    expect(await article(id)).toBeUndefined();
  });
});
