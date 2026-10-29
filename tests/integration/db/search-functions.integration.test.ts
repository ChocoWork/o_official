/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createLiveAppSession, jwtClaims } from './helpers/app-session';
import { describeLocalDb } from './helpers/local-db';
import { readMigration } from '../../helpers/staged-supabase';

/**
 * 検索の関数 search_news・search_public_news（DATA-SEARCH-003）。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した記事と利用者は残らない。
 * search_public_news は anon・authenticated に閉じた（ADR-0315）ので、所有者の接続でだけ呼ぶ。
 */

type Claims = Record<string, unknown>;
type Outcome = { rows: any[]; rowCount: number } | { code: string };
type Role = 'anon' | 'authenticated';

const FUNCTIONS = ['search_news', 'search_public_news'] as const;

/** 検索語の LIKE の印（\ % _）を字として探すための 4 行の題。x は目印の token の後ろに付ける */
const ESCAPE_TITLES = {
  percentThenBackslash: ' 100%\\off',
  backslashThenPercent: ' a\\%b',
  backslashThenUnderscore: ' a\\_b',
  plain: ' plain ab',
} as const;

/**
 * \ を先に逃がし、そのあとで % と _ を逃がす（ADR-0315）ことを 3 本の関数で同じ形で確かめる。
 * insert は「token + 題の後ろ」の行を足して id を返す。run は検索語で探して id の並びを返す。
 * 行の並びは新しい順なので、足した行だけを取り出して比べる（見本の行が \ % _ を持っていても影響しない）。
 */
async function expectBackslashFirstEscape(
  token: string,
  insert: (title: string, rank: number) => Promise<number>,
  run: (term: string) => Promise<number[]>,
): Promise<void> {
  const percentThenBackslash = await insert(`${token}${ESCAPE_TITLES.percentThenBackslash}`, 4);
  const backslashThenPercent = await insert(`${token}${ESCAPE_TITLES.backslashThenPercent}`, 3);
  const backslashThenUnderscore = await insert(`${token}${ESCAPE_TITLES.backslashThenUnderscore}`, 2);
  const plain = await insert(`${token}${ESCAPE_TITLES.plain}`, 1);
  const ours = new Set([percentThenBackslash, backslashThenPercent, backslashThenUnderscore, plain]);
  const mine = async (term: string): Promise<number[]> => (await run(term)).filter((id) => ours.has(id));

  // 語 \ は \ を含む行だけに当たる
  expect(await mine('\\')).toEqual([percentThenBackslash, backslashThenPercent, backslashThenUnderscore]);
  // 語 \% は文字 \% を含む行だけ。「\ のあとに何でも」（\\% の生きたワイルドカード）にはならない
  expect(await mine('\\%')).toEqual([backslashThenPercent]);
  // 語 % は % を含む行だけ
  expect(await mine('%')).toEqual([percentThenBackslash, backslashThenPercent]);
  // 語 _ は _ を含む行だけ（plain の空白も、他の字も _ に当たらない）
  expect(await mine('_')).toEqual([backslashThenUnderscore]);
  // 語の終わりが \ でも、パターンの末尾の % が字にならず、続きの字がある行に当たる
  expect(await mine(`${token} 100%\\`)).toEqual([percentThenBackslash]);
  expect(await mine(`${token} a\\_b`)).toEqual([backslashThenUnderscore]);
}

/** 100 字ちょうどの接頭辞と、そのあとに 10 字足した語。語の先頭 100 字だけで比べることの確かめに使う */
function longTermFor(token: string): { exactTitle: string; longTerm: string } {
  const exactTitle = `${token}${'b'.repeat(100 - token.length)}`;
  return { exactTitle, longTerm: `${exactTitle}zzzzzzzzzz` };
}

describeLocalDb('integration: search_news / search_public_news', (db) => {
  let token: string;

  beforeEach(async () => {
    await db().query('begin');
    token = `nwsrch${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertArticle(article: {
    title: string;
    status?: 'published' | 'private';
    content?: string;
    category?: string;
    date?: string;
  }): Promise<number> {
    const res = await db().query(
      `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, $2, $3::date, 'news/2026-01-01/search-test.png', $4, 'detail', $5)
       returning id`,
      [article.title, article.category ?? 'EVENT', article.date ?? '2026-01-01', article.content ?? 'body', article.status ?? 'published'],
    );
    return Number(res.rows[0].id);
  }

  async function insertMany(count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      ids.push(await insertArticle({ title: `${token} many ${i}`, date: `2026-05-${day}` }));
    }
    return ids;
  }

  async function adminUser(): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', 'admin'), '{}', now(), now())`,
      [id],
    );
    await db().query(
      `insert into public.user_roles (user_id, role_id)
       select $1, id from public.roles where code = 'admin'
       on conflict do nothing`,
      [id],
    );
    return id;
  }

  // PostgREST が取引ごとに入れる役と JWT のクレームを再現する。失敗しても取引を壊さないよう savepoint で包む
  async function attempt(role: Role, claims: Claims | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint search_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (claims) await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint search_attempt');
      await db().query('release savepoint search_attempt');
    }
  }

  async function rowsAs(role: Role, claims: Claims | null, sql: string, params: unknown[] = []): Promise<any[]> {
    const outcome = await attempt(role, claims, sql, params);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows;
  }

  async function search(
    fn: (typeof FUNCTIONS)[number],
    query: string,
    limit?: number | null,
    as: { role: Role; claims: Claims | null } | null = null,
  ): Promise<number[]> {
    const sql = limit === undefined
      ? `select id from public.${fn}($1)`
      : `select id from public.${fn}($1, $2::integer)`;
    const params = limit === undefined ? [query] : [query, limit];
    const rows = as ? await rowsAs(as.role, as.claims, sql, params) : (await db().query(sql, params)).rows;
    return rows.map((row) => Number(row.id));
  }

  test.each(FUNCTIONS)('DATA-SEARCH-003 %s は公開の記事だけを返し、非公開の記事は anon・ログイン中の人・閲覧の権限を持つ店長のどれにも返さない', async (fn) => {
    const published = await insertArticle({ title: `${token} published` });
    const hidden = await insertArticle({ title: `${token} hidden`, status: 'private' });
    const admin = await adminUser();
    // has_permission は aal2 と、アプリに結び付いた生きた session を求める（SEC-AUTH-010-AC-03）
    const adminClaims = jwtClaims(admin, await createLiveAppSession(db(), admin));

    // 店長は RLS では非公開の行を読めるので、返さないのは関数の中の絞り込みによる
    expect(await rowsAs('authenticated', adminClaims, 'select id from public.news_articles where id = $1', [hidden]))
      .toHaveLength(1);

    expect(await search(fn, token, 20)).toEqual([published]);
    // search_public_news は anon・authenticated に閉じたので、役を切り替えた呼び出しは search_news だけ
    if (fn === 'search_news') {
      expect(await search(fn, token, 20, { role: 'anon', claims: null })).toEqual([published]);
      expect(await search(fn, token, 20, { role: 'authenticated', claims: { sub: randomUUID(), role: 'authenticated' } }))
        .toEqual([published]);
      expect(await search(fn, token, 20, { role: 'authenticated', claims: adminClaims })).toEqual([published]);
    }
  });

  test.each(FUNCTIONS)('DATA-SEARCH-003 %s は題・中身のどちらに当たっても大小の字を区別せずに返し、公開日の新しい順に並べる', async (fn) => {
    const byTitle = await insertArticle({ title: `${token} title`, date: '2026-01-01' });
    const byContent = await insertArticle({ title: 'no match in title', content: `see ${token.toUpperCase()} here`, date: '2026-03-01' });
    await insertArticle({ title: 'unrelated', content: 'unrelated', date: '2026-02-01' });

    expect(await search(fn, token, 20)).toEqual([byContent, byTitle]);
  });

  test.each(FUNCTIONS)('DATA-SEARCH-003 %s は分類に当たった公開の記事も返す', async (fn) => {
    const byCategory = await insertArticle({ title: 'category only', category: 'SUSTAINABILITY', date: '2099-12-31' });
    const other = await insertArticle({ title: 'other category', category: 'EVENT', date: '2099-12-31' });

    const ids = await search(fn, 'sustainab', 20);
    expect(ids[0]).toBe(byCategory);
    expect(ids).not.toContain(other);
  });

  test('DATA-SEARCH-003 search_news は % と _ を字として探す', async () => {
    const percent = await insertArticle({ title: `${token}%x`, date: '2026-01-03' });
    const underscore = await insertArticle({ title: `${token}_x`, date: '2026-01-02' });
    await insertArticle({ title: `${token}ax`, date: '2026-01-01' });

    expect(await search('search_news', `${token}%`, 20)).toEqual([percent]);
    expect(await search('search_news', `${token}_`, 20)).toEqual([underscore]);
  });

  test('DATA-SEARCH-003 search_news は \\ を先に逃がし、語の \\ \\% % _ をそれぞれ字として探す', async () => {
    await expectBackslashFirstEscape(
      token,
      (title, rank) => insertArticle({ title, date: `2099-12-0${rank}` }),
      (term) => search('search_news', term, 8, { role: 'anon', claims: null }),
    );
  });

  test('DATA-SEARCH-003 search_public_news は % と _ を逃がさず、どんな字にも当たる印として扱う', async () => {
    const percent = await insertArticle({ title: `${token}%x`, date: '2026-01-03' });
    const underscore = await insertArticle({ title: `${token}_x`, date: '2026-01-02' });
    const plain = await insertArticle({ title: `${token}ax`, date: '2026-01-01' });

    expect(await search('search_public_news', `${token}%`, 20)).toEqual([percent, underscore, plain]);
    expect(await search('search_public_news', `${token}_`, 20)).toEqual([percent, underscore, plain]);
  });

  test('DATA-SEARCH-003 search_news は件数を既定で 8 にし、渡された数が 8 を超えても NULL でも 8 件までに丸める', async () => {
    const ids = await insertMany(22);
    const newestFirst = [...ids].reverse();
    const anon = { role: 'anon' as const, claims: null };

    expect(await search('search_news', token, undefined, anon)).toEqual(newestFirst.slice(0, 8));
    expect(await search('search_news', token, 3, anon)).toEqual(newestFirst.slice(0, 3));
    for (const requested of [9, 21, 100, 10000, null]) {
      // 公開の行を 22 件入れてあるので、丸めが無ければ 22 件返る。並びは公開日の新しい順のまま
      expect(await search('search_news', token, requested, anon)).toEqual(newestFirst.slice(0, 8));
    }
    // 0 と負の数は誤りにせず 1 件に丸める
    expect(await search('search_news', token, 0, anon)).toEqual(newestFirst.slice(0, 1));
    expect(await search('search_news', token, -5, anon)).toEqual(newestFirst.slice(0, 1));
  });

  test('DATA-SEARCH-003 search_news は検索語の先頭 100 字だけで比べる', async () => {
    const { exactTitle, longTerm } = longTermFor(token);
    const hit = await insertArticle({ title: exactTitle });

    expect(longTerm).toHaveLength(110);
    expect(await search('search_news', longTerm, 8, { role: 'anon', claims: null })).toEqual([hit]);
  });

  test('DATA-SEARCH-003 search_public_news は件数を既定で 6 にし、1〜20 に丸める', async () => {
    const ids = await insertMany(22);
    const newestFirst = [...ids].reverse();

    expect(await search('search_public_news', token)).toEqual(newestFirst.slice(0, 6));
    expect(await search('search_public_news', token, null)).toEqual(newestFirst.slice(0, 6));
    expect(await search('search_public_news', token, 3)).toEqual(newestFirst.slice(0, 3));
    expect(await search('search_public_news', token, 100)).toEqual(newestFirst.slice(0, 20));
    expect(await search('search_public_news', token, 0)).toEqual(newestFirst.slice(0, 1));
    expect(await search('search_public_news', token, -5)).toEqual(newestFirst.slice(0, 1));
  });

  test('DATA-SEARCH-003 2つの関数は呼び手の権限で動き（SECURITY DEFINER にしない）、search_path を固定する', async () => {
    const res = await db().query(
      `select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.proname`,
      [[...FUNCTIONS]],
    );
    expect(res.rows).toEqual([
      { name: 'search_news', definer: false, volatility: 's', config: ['search_path=public, public, pg_temp'] },
      { name: 'search_public_news', definer: false, volatility: 's', config: ['search_path=public'] },
    ]);
  });

  test('DATA-SEARCH-003 search_news は PUBLIC から外して anon・authenticated・service_role に実行を許し、search_public_news は PUBLIC・anon・authenticated から外して postgres・service_role にだけ残す', async () => {
    const res = await db().query(
      `select p.proname as name,
              exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) as public_execute,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
              has_function_privilege('postgres', p.oid, 'EXECUTE') as postgres_execute,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.proname`,
      [[...FUNCTIONS]],
    );
    expect(res.rows).toEqual([
      { name: 'search_news', public_execute: false, anon_execute: true, authenticated_execute: true, postgres_execute: true, service_role_execute: true },
      { name: 'search_public_news', public_execute: false, anon_execute: false, authenticated_execute: false, postgres_execute: true, service_role_execute: true },
    ]);
  });

  test('DATA-SEARCH-003 search_public_news を anon・ログイン中の人が呼ぶと権限が無い誤り（42501）になり、search_news は呼べる', async () => {
    await insertArticle({ title: `${token} acl` });
    const logged = { sub: randomUUID(), role: 'authenticated' };

    expect(await attempt('anon', null, 'select id from public.search_public_news($1)', [token])).toEqual({ code: '42501' });
    expect(await attempt('authenticated', logged, 'select id from public.search_public_news($1)', [token])).toEqual({ code: '42501' });
    expect(await attempt('anon', null, 'select id from public.search_news($1)', [token])).toMatchObject({ rowCount: 1 });
    expect(await attempt('authenticated', logged, 'select id from public.search_news($1)', [token])).toMatchObject({ rowCount: 1 });
  });
});

/**
 * 検索の関数 search_items・search_looks と、未使用の search_public_items・search_public_looks（DATA-SEARCH-001）。
 * 商品とルックは返す列と件数の既定が違うだけで探し方は同じなので、共通の検査は2つをまとめて回す。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した商品・ルックと利用者は残らない。
 * search_public_ の2つは anon・authenticated に閉じた（ADR-0315）ので、所有者の接続でだけ呼ぶ。
 */

type SubjectName = 'items' | 'looks';
type Subject = {
  strict: string;
  loose: string;
  /** 名前（商品）・テーマ（ルック）と説明文を指定して行を足す */
  insert: (row: { title: string; body?: string; status?: 'published' | 'private'; createdAt?: string }) => Promise<number>;
};

const SUBJECT_NAMES: SubjectName[] = ['items', 'looks'];
const SEARCH_FUNCTIONS = ['search_items', 'search_looks', 'search_public_items', 'search_public_looks'] as const;

describeLocalDb('integration: search_items / search_looks / search_public_items / search_public_looks', (db) => {
  let token: string;

  beforeEach(async () => {
    await db().query('begin');
    token = `srch${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  // 並びは created_at の新しい順なので、同じ取引の中で値が重ならないよう日時を明示する
  async function insertItem(row: {
    title: string;
    body?: string;
    status?: 'published' | 'private';
    category?: string;
    createdAt?: string;
  }): Promise<number> {
    const res = await db().query(
      `insert into public.items (name, description, price, category, image_url, status, created_at)
       values ($1, $2, 12800, $3, 'items/search-test.png', $4, $5::timestamptz)
       returning id`,
      [row.title, row.body ?? 'description', row.category ?? 'TOPS', row.status ?? 'published', row.createdAt ?? '2026-01-01T00:00:00Z'],
    );
    return Number(res.rows[0].id);
  }

  async function insertLook(row: {
    title: string;
    body?: string;
    status?: 'published' | 'private';
    createdAt?: string;
    imageUrls?: string[];
  }): Promise<number> {
    const res = await db().query(
      `insert into public.looks (season_year, season_type, theme, theme_description, image_urls, status, created_at)
       values (2026, 'SS', $1, $2, $3, $4, $5::timestamptz)
       returning id`,
      [
        row.title,
        row.body ?? 'description',
        row.imageUrls ?? ['looks/2026-01-01/search-test.png'],
        row.status ?? 'published',
        row.createdAt ?? '2026-01-01T00:00:00Z',
      ],
    );
    return Number(res.rows[0].id);
  }

  const subjects: Record<SubjectName, Subject> = {
    items: { strict: 'search_items', loose: 'search_public_items', insert: insertItem },
    looks: { strict: 'search_looks', loose: 'search_public_looks', insert: insertLook },
  };

  async function insertMany(subject: Subject, count: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      ids.push(await subject.insert({ title: `${token} many ${i}`, createdAt: `2026-05-${day}T00:00:00Z` }));
    }
    return ids;
  }

  async function adminUser(): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', 'admin'), '{}', now(), now())`,
      [id],
    );
    await db().query(
      `insert into public.user_roles (user_id, role_id)
       select $1, id from public.roles where code = 'admin'
       on conflict do nothing`,
      [id],
    );
    return id;
  }

  // PostgREST が取引ごとに入れる役と JWT のクレームを再現する。失敗しても取引を壊さないよう savepoint で包む
  async function attempt(role: Role, claims: Claims | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint search_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (claims) await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint search_attempt');
      await db().query('release savepoint search_attempt');
    }
  }

  async function rowsAs(role: Role, claims: Claims | null, sql: string, params: unknown[] = []): Promise<any[]> {
    const outcome = await attempt(role, claims, sql, params);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows;
  }

  async function searchRows(
    fn: string,
    query: string,
    limit?: number | null,
    as: { role: Role; claims: Claims | null } | null = null,
  ): Promise<any[]> {
    const sql = limit === undefined
      ? `select * from public.${fn}($1)`
      : `select * from public.${fn}($1, $2::integer)`;
    const params = limit === undefined ? [query] : [query, limit];
    return as ? rowsAs(as.role, as.claims, sql, params) : (await db().query(sql, params)).rows;
  }

  async function search(
    fn: string,
    query: string,
    limit?: number | null,
    as: { role: Role; claims: Claims | null } | null = null,
  ): Promise<number[]> {
    return (await searchRows(fn, query, limit, as)).map((row) => Number(row.id));
  }

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の2つの検索の関数は公開の行だけを返し、非公開の行は anon・ログイン中の人・閲覧の権限を持つ店長のどれにも返さない', async (name) => {
    const subject = subjects[name];
    const published = await subject.insert({ title: `${token} published` });
    const hidden = await subject.insert({ title: `${token} hidden`, status: 'private' });
    const admin = await adminUser();
    // has_permission は aal2 と、アプリに結び付いた生きた session を求める（SEC-AUTH-010-AC-03）
    const adminClaims = jwtClaims(admin, await createLiveAppSession(db(), admin));

    // 店長は RLS では非公開の行を読めるので、返さないのは関数の中の絞り込みによる
    expect(await rowsAs('authenticated', adminClaims, `select id from public.${name} where id = $1`, [hidden]))
      .toHaveLength(1);

    for (const fn of [subject.strict, subject.loose]) {
      expect(await search(fn, token, 20)).toEqual([published]);
    }
    // 緩い方（search_public_）は anon・authenticated に閉じたので、役を切り替えた呼び出しは厳しい方だけ
    expect(await search(subject.strict, token, 20, { role: 'anon', claims: null })).toEqual([published]);
    expect(await search(subject.strict, token, 20, { role: 'authenticated', claims: { sub: randomUUID(), role: 'authenticated' } }))
      .toEqual([published]);
    expect(await search(subject.strict, token, 20, { role: 'authenticated', claims: adminClaims })).toEqual([published]);
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の2つの検索の関数は名前・説明文のどちらに当たっても大小の字を区別せずに返し、作った日時の新しい順に並べ、何にも当たらない言葉には 0 件を返す', async (name) => {
    const subject = subjects[name];
    const byTitle = await subject.insert({ title: `${token} title`, createdAt: '2026-01-01T00:00:00Z' });
    const byBody = await subject.insert({
      title: 'no match in title',
      body: `see ${token.toUpperCase()} here`,
      createdAt: '2026-03-01T00:00:00Z',
    });
    await subject.insert({ title: 'unrelated', body: 'unrelated', createdAt: '2026-02-01T00:00:00Z' });

    for (const fn of [subject.strict, subject.loose]) {
      expect(await search(fn, token, 20)).toEqual([byBody, byTitle]);
      expect(await search(fn, `${token}-no-such-row`, 20)).toEqual([]);
    }
  });

  test.each(['search_items', 'search_public_items'])('DATA-SEARCH-001 %s は分類に当たった公開の商品も返す', async (fn) => {
    const byCategory = await insertItem({ title: 'category only', category: 'ACCESSORIES', createdAt: '2099-12-31T00:00:00Z' });
    const other = await insertItem({ title: 'other category', category: 'TOPS', createdAt: '2099-12-31T00:00:00Z' });

    const ids = await search(fn, 'accessor', 20);
    expect(ids[0]).toBe(byCategory);
    expect(ids).not.toContain(other);
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方（search_items・search_looks）は % と _ を字として探し、緩い方（search_public_）は逃がさずどんな字にも当たる印として扱う', async (name) => {
    const subject = subjects[name];
    const percent = await subject.insert({ title: `${token}%x`, createdAt: '2026-01-03T00:00:00Z' });
    const underscore = await subject.insert({ title: `${token}_x`, createdAt: '2026-01-02T00:00:00Z' });
    const plain = await subject.insert({ title: `${token}ax`, createdAt: '2026-01-01T00:00:00Z' });

    expect(await search(subject.strict, `${token}%`, 20)).toEqual([percent]);
    expect(await search(subject.strict, `${token}_`, 20)).toEqual([underscore]);
    expect(await search(subject.loose, `${token}%`, 20)).toEqual([percent, underscore, plain]);
    expect(await search(subject.loose, `${token}_`, 20)).toEqual([percent, underscore, plain]);
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方は \\ を先に逃がし、語の \\ \\% % _ をそれぞれ字として探す', async (name) => {
    const subject = subjects[name];
    await expectBackslashFirstEscape(
      token,
      (title, rank) => subject.insert({ title, createdAt: `2099-12-0${rank}T00:00:00Z` }),
      (term) => search(subject.strict, term, 8, { role: 'anon', claims: null }),
    );
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方は件数を既定で 8 にし、渡された数が 8 を超えても NULL でも 8 件までに丸める', async (name) => {
    const subject = subjects[name];
    const newestFirst = [...(await insertMany(subject, 22))].reverse();
    const anon = { role: 'anon' as const, claims: null };

    expect(await search(subject.strict, token, undefined, anon)).toEqual(newestFirst.slice(0, 8));
    expect(await search(subject.strict, token, 3, anon)).toEqual(newestFirst.slice(0, 3));
    for (const requested of [9, 21, 100, 10000, null]) {
      // 公開の行を 22 件入れてあるので、丸めが無ければ 22 件返る。並びは新しい順のまま
      expect(await search(subject.strict, token, requested, anon)).toEqual(newestFirst.slice(0, 8));
    }
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方は件数に 0 や負の数を渡しても誤りにせず 1 件に丸める', async (name) => {
    const subject = subjects[name];
    const newestFirst = [...(await insertMany(subject, 22))].reverse();
    const anon = { role: 'anon' as const, claims: null };

    expect(await search(subject.strict, token, 0, anon)).toEqual(newestFirst.slice(0, 1));
    expect(await search(subject.strict, token, -1, anon)).toEqual(newestFirst.slice(0, 1));
    expect(await search(subject.strict, token, -5, anon)).toEqual(newestFirst.slice(0, 1));
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方は検索語の先頭 100 字だけで比べる', async (name) => {
    const subject = subjects[name];
    const { exactTitle, longTerm } = longTermFor(token);
    const hit = await subject.insert({ title: exactTitle });

    expect(longTerm).toHaveLength(110);
    expect(await search(subject.strict, longTerm, 8, { role: 'anon', claims: null })).toEqual([hit]);
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の緩い方（search_public_）は件数を既定で 6 にし、1〜20 に丸める', async (name) => {
    const subject = subjects[name];
    const newestFirst = [...(await insertMany(subject, 22))].reverse();

    expect(await search(subject.loose, token)).toEqual(newestFirst.slice(0, 6));
    expect(await search(subject.loose, token, null)).toEqual(newestFirst.slice(0, 6));
    expect(await search(subject.loose, token, 3)).toEqual(newestFirst.slice(0, 3));
    expect(await search(subject.loose, token, 100)).toEqual(newestFirst.slice(0, 20));
    expect(await search(subject.loose, token, 0)).toEqual(newestFirst.slice(0, 1));
    expect(await search(subject.loose, token, -5)).toEqual(newestFirst.slice(0, 1));
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の厳しい方は空の言葉に全部の公開の行を当て、非公開の行は混ぜない', async (name) => {
    const subject = subjects[name];
    const published = await subject.insert({ title: `${token} published`, createdAt: '2099-12-31T00:00:00Z' });
    const hidden = await subject.insert({ title: `${token} hidden`, status: 'private', createdAt: '2099-12-31T00:00:00Z' });

    const ids = await search(subject.strict, '', 100);
    expect(ids).toContain(published);
    expect(ids).not.toContain(hidden);
  });

  test('DATA-SEARCH-001 search_items は検索の部品が読む6つの列を返し、価格を数で返す', async () => {
    const id = await insertItem({ title: `${token} columns`, body: 'columns description', category: 'OUTERWEAR' });

    expect(await searchRows('search_items', token, 20)).toEqual([{
      id: String(id),
      name: `${token} columns`,
      description: 'columns description',
      category: 'OUTERWEAR',
      image_url: 'items/search-test.png',
      price: 12800,
    }]);
  });

  test('DATA-SEARCH-001 search_public_items は価格を返さず、5つの列を返す', async () => {
    const id = await insertItem({ title: `${token} columns`, body: 'columns description', category: 'OUTERWEAR' });

    expect(await searchRows('search_public_items', token, 20)).toEqual([{
      id,
      name: `${token} columns`,
      description: 'columns description',
      category: 'OUTERWEAR',
      image_url: 'items/search-test.png',
    }]);
  });

  test('DATA-SEARCH-001 search_looks は検索の部品が読む6つの列を返し、画像の道筋を文字の並びで返す', async () => {
    const id = await insertLook({
      title: `${token} columns`,
      body: 'columns description',
      imageUrls: ['looks/2026-01-01/a.png', 'looks/2026-01-01/b.png'],
    });

    expect(await searchRows('search_looks', token, 20)).toEqual([{
      id: String(id),
      season_year: 2026,
      season_type: 'SS',
      theme: `${token} columns`,
      theme_description: 'columns description',
      image_urls: ['looks/2026-01-01/a.png', 'looks/2026-01-01/b.png'],
    }]);
  });

  test('DATA-SEARCH-001 search_public_looks は画像の道筋を JSON の配列で返し、説明文が空でも空の文字を返す', async () => {
    const id = await insertLook({ title: `${token} columns`, body: '', imageUrls: ['looks/2026-01-01/a.png'] });

    expect(await searchRows('search_public_looks', token, 20)).toEqual([{
      id,
      season_year: 2026,
      season_type: 'SS',
      theme: `${token} columns`,
      theme_description: '',
      image_urls: ['looks/2026-01-01/a.png'],
    }]);
  });

  test('DATA-SEARCH-001 4つの関数は呼び手の権限で動き（SECURITY DEFINER にしない）、search_path を固定する', async () => {
    const res = await db().query(
      `select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.proname`,
      [[...SEARCH_FUNCTIONS]],
    );
    expect(res.rows).toEqual([
      { name: 'search_items', definer: false, volatility: 's', config: ['search_path=public, public, pg_temp'] },
      { name: 'search_looks', definer: false, volatility: 's', config: ['search_path=public, public, pg_temp'] },
      { name: 'search_public_items', definer: false, volatility: 's', config: ['search_path=public'] },
      { name: 'search_public_looks', definer: false, volatility: 's', config: ['search_path=public'] },
    ]);
  });

  test('DATA-SEARCH-001 search_items・search_looks は PUBLIC から外して anon・authenticated・service_role に実行を許し、search_public_ の2つは PUBLIC・anon・authenticated から外して postgres・service_role にだけ残す', async () => {
    const res = await db().query(
      `select p.proname as name,
              exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ) as public_execute,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
              has_function_privilege('postgres', p.oid, 'EXECUTE') as postgres_execute,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.proname`,
      [[...SEARCH_FUNCTIONS]],
    );
    const open = { public_execute: false, anon_execute: true, authenticated_execute: true, postgres_execute: true, service_role_execute: true };
    const closed = { public_execute: false, anon_execute: false, authenticated_execute: false, postgres_execute: true, service_role_execute: true };
    expect(res.rows).toEqual([
      { name: 'search_items', ...open },
      { name: 'search_looks', ...open },
      { name: 'search_public_items', ...closed },
      { name: 'search_public_looks', ...closed },
    ]);
  });

  test.each(SUBJECT_NAMES)('DATA-SEARCH-001 %s の緩い方（search_public_）を anon・ログイン中の人が呼ぶと権限が無い誤り（42501）になり、厳しい方は呼べる', async (name) => {
    const subject = subjects[name];
    await subject.insert({ title: `${token} acl` });
    const logged = { sub: randomUUID(), role: 'authenticated' };

    for (const [role, claims] of [['anon', null], ['authenticated', logged]] as const) {
      expect(await attempt(role, claims, `select id from public.${subject.loose}($1)`, [token])).toEqual({ code: '42501' });
      expect(await attempt(role, claims, `select id from public.${subject.strict}($1)`, [token])).toMatchObject({ rowCount: 1 });
    }
  });

  test('DATA-SEARCH-001 search_items・search_looks は戻りの列と型を変えず、本体に上限 8 と 100 字の切り詰めを持つ', async () => {
    const res = await db().query(
      `select p.proname as name,
              pg_get_function_result(p.oid) as result,
              position('LEAST(COALESCE(limit_count, 8), 8)' in p.prosrc) > 0 as has_cap,
              position('left(search_query, 100)' in p.prosrc) > 0 as has_cut
       from pg_proc as p
       join pg_namespace as n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1::text[])
       order by p.proname`,
      [['search_items', 'search_looks']],
    );
    expect(res.rows).toEqual([
      {
        name: 'search_items',
        result: 'TABLE(id bigint, name text, description text, category text, image_url text, price integer)',
        has_cap: true,
        has_cut: true,
      },
      {
        name: 'search_looks',
        result: 'TABLE(id bigint, season_year integer, season_type text, theme text, theme_description text, image_urls text[])',
        has_cap: true,
        has_cut: true,
      },
    ]);
  });
});

/**
 * 移行 sec_search_functions の形（DB なしで読む）。ステージング中は supabase/pending-wave2 を読む。
 * ヘッダーの旧い本体は戻すときの正本なので、3 本分の `LIMIT limit_count;` が残っていることを確かめる。
 */
describe('migration form: sec_search_functions', () => {
  const sql = readMigration('sec_search_functions');
  const header = sql.slice(0, sql.indexOf('\nBEGIN;'));
  const body = sql.slice(sql.indexOf('\nBEGIN;'));

  test('DATA-SEARCH-001 移行は DROP FUNCTION を含まず、3 本の CREATE OR REPLACE FUNCTION と search_public_ の REVOKE ALL ON FUNCTION を持つ', () => {
    expect(sql).not.toMatch(/DROP\s+FUNCTION/i);
    expect(body.match(/^CREATE OR REPLACE FUNCTION public\.search_(items|looks|news) /gm)).toHaveLength(3);
    expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.search_public_items\(text, integer\), public\.search_public_looks\(text, integer\),\s+public\.search_public_news\(text, integer\) FROM PUBLIC, anon, authenticated;/);
  });

  test('DATA-SEARCH-001 3 本とも上限 8・検索語 100 字・\\ を先に逃がす式を持つ', () => {
    expect(body.match(/LIMIT GREATEST\(1, LEAST\(COALESCE\(limit_count, 8\), 8\)\);/g)).toHaveLength(3);
    expect(body.match(/replace\(replace\(replace\(left\(search_query, 100\), '\\', '\\\\'\), '%', '\\%'\), '_', '\\_'\)/g)).toHaveLength(3);
    expect(body).not.toMatch(/LIMIT limit_count;/);
  });

  test('DATA-SEARCH-001 ヘッダーに ROLLBACK の節と、旧い本体（LIMIT limit_count; が 3 回）と、search_public_ を戻す GRANT がある', () => {
    expect(header).toMatch(/^-- ROLLBACK \(Task 6\)/m);
    expect(header.match(/LIMIT limit_count;/g)).toHaveLength(3);
    expect(header).toMatch(/GRANT EXECUTE ON FUNCTION public\.search_public_items\(text, integer\)[\s\S]*TO PUBLIC, anon, authenticated;/);
  });

  test('DATA-SEARCH-001 末尾に自己検査の DO 文と PostgREST の再読み込みを持つ', () => {
    expect(body).toMatch(/SEC_WAVE2_MIGRATION_ASSERTION_FAILED/);
    expect(body).toMatch(/NOTIFY pgrst, 'reload schema';\s+COMMIT;\s*$/);
  });
});
