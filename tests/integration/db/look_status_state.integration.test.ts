/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * LOOK の公開の状態 private・published の値と行き来（STATE-LOOK-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: LOOK の公開の状態', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-look-state-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertLook(status: string): Promise<string> {
    const result = await db().query(
      `insert into public.looks (season_year, season_type, theme, status)
       values (2026, 'SS', $1, $2) returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function look(id: string): Promise<{ status: string; season_year: number; theme: string } | undefined> {
    const result = await db().query('select status, season_year, theme from public.looks where id = $1', [id]);
    return result.rows[0];
  }

  async function setStatus(id: string, status: string): Promise<number> {
    return (await db().query('update public.looks set status = $2 where id = $1', [id, status])).rowCount;
  }

  async function insertItem(): Promise<string> {
    const result = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'integration item', 1000, 'TOPS', 'integration/look-state.png', 'published')
       returning id::text as id`,
      [`${marker} item`],
    );
    return result.rows[0].id;
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
  async function visibleToAnon(table: 'looks' | 'look_items', id: string): Promise<boolean> {
    const column = table === 'looks' ? 'id' : 'look_id';
    await db().query('savepoint as_anon');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query('set local role anon');
      const result = await db().query(`select 1 from public.${table} where ${column} = $1`, [id]);
      return (result.rowCount ?? 0) >= 1;
    } finally {
      await db().query('rollback to savepoint as_anon');
    }
  }

  test('STATE-LOOK-001 状態の CHECK は private と published の2つだけを許す', async () => {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.looks'::regclass and conname = 'looks_status_check'`,
    );

    expect(result.rows).toHaveLength(1);
    const allowed = [...(result.rows[0].definition as string).matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(allowed.sort()).toEqual(['private', 'published']);
  });

  test.each(['private', 'published'])('STATE-LOOK-001 作成で %s を入れられる', async (status) => {
    const id = await insertLook(status);

    expect((await look(id))?.status).toBe(status);
  });

  test.each(['draft', 'PUBLISHED', 'archived', ''])('STATE-LOOK-001 状態 "%s" の作成は CHECK の違反で落ちる', async (status) => {
    const result = await failure(
      `insert into public.looks (season_year, season_type, theme, status) values (2026, 'SS', $1, $2)`,
      [`${marker} invalid`, status],
    );

    expect(result).toEqual({ code: '23514', constraint: 'looks_status_check' });
  });

  test('STATE-LOOK-001 DB の初めの値は private で、状態を省いた作成は非公開の LOOK になる', async () => {
    const defaults = await db().query(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'looks' and column_name = 'status'`,
    );
    expect(defaults.rows).toEqual([{ column_default: "'private'::text" }]);

    const inserted = await db().query(
      `insert into public.looks (season_year, season_type, theme) values (2026, 'SS', $1)
       returning id::text as id, status`,
      [`${marker} default`],
    );

    expect(inserted.rows[0].status).toBe('private');
    expect(await visibleToAnon('looks', inserted.rows[0].id)).toBe(false);
  });

  test('STATE-LOOK-001 private から published へ変えると公開の道に出る', async () => {
    const id = await insertLook('private');
    expect(await visibleToAnon('looks', id)).toBe(false);

    expect(await setStatus(id, 'published')).toBe(1);

    expect((await look(id))?.status).toBe('published');
    expect(await visibleToAnon('looks', id)).toBe(true);
  });

  test('STATE-LOOK-001 published から private へ変えると公開の道から消える', async () => {
    const id = await insertLook('published');
    expect(await visibleToAnon('looks', id)).toBe(true);

    expect(await setStatus(id, 'private')).toBe(1);

    expect((await look(id))?.status).toBe('private');
    expect(await visibleToAnon('looks', id)).toBe(false);
  });

  test('STATE-LOOK-001 公開と非公開を何度行き来しても、状態は最後に入れた値になる', async () => {
    const id = await insertLook('private');

    for (const status of ['published', 'private', 'published', 'private']) {
      expect(await setStatus(id, status)).toBe(1);
      expect((await look(id))?.status).toBe(status);
    }
  });

  test.each(['private', 'published'])('STATE-LOOK-001 同じ状態 %s への変更も1行の更新として通る', async (status) => {
    const id = await insertLook(status);

    expect(await setStatus(id, status)).toBe(1);
    expect((await look(id))?.status).toBe(status);
  });

  test.each(['private', 'published'])('STATE-LOOK-001 %s から CHECK に無い値へは変えられない', async (status) => {
    const id = await insertLook(status);

    const result = await failure("update public.looks set status = 'draft' where id = $1", [id]);

    expect(result).toEqual({ code: '23514', constraint: 'looks_status_check' });
    expect((await look(id))?.status).toBe(status);
  });

  test('STATE-LOOK-001 状態を変えると updated_at が今になる', async () => {
    const inserted = await db().query(
      `insert into public.looks (season_year, season_type, theme, status, created_at, updated_at)
       values (2026, 'SS', $1, 'private', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
       returning id::text as id`,
      [`${marker} touch`],
    );

    // 取引の中の now() は取引の始まりの時刻で動かないので、送った値ではなく now() と比べる
    const updated = await db().query(
      `update public.looks set status = 'published' where id = $1 returning updated_at, now() as now`,
      [inserted.rows[0].id],
    );

    expect((updated.rows[0].updated_at as Date).toISOString()).toBe((updated.rows[0].now as Date).toISOString());
  });

  test('STATE-LOOK-001 公開の日時の列は無く、状態を変えても他の列は変わらない', async () => {
    const columns = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'looks' and column_name ~ '(publish|_date$)'`,
    );
    expect(columns.rows).toEqual([]);

    const id = await insertLook('private');
    const before = await look(id);
    await setStatus(id, 'published');
    const after = await look(id);

    expect({ ...after, status: before?.status }).toEqual(before);
  });

  test('STATE-LOOK-001 公開の状態に合わせて、関連の行も公開の道に出入りする', async () => {
    const id = await insertLook('private');
    const itemId = await insertItem();
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [id, itemId]);
    expect(await visibleToAnon('look_items', id)).toBe(false);

    await setStatus(id, 'published');
    expect(await visibleToAnon('look_items', id)).toBe(true);

    await setStatus(id, 'private');
    expect(await visibleToAnon('look_items', id)).toBe(false);
    const kept = await db().query('select count(*)::int as count from public.look_items where look_id = $1', [id]);
    expect(kept.rows).toEqual([{ count: 1 }]);
  });

  test.each(['private', 'published'])('STATE-LOOK-001 %s の LOOK も削除で行が消え、関連の行も一緒に消える', async (status) => {
    const id = await insertLook(status);
    const itemId = await insertItem();
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [id, itemId]);

    const deleted = await db().query('delete from public.looks where id = $1', [id]);

    expect(deleted.rowCount).toBe(1);
    expect(await look(id)).toBeUndefined();
    const links = await db().query('select count(*)::int as count from public.look_items where look_id = $1', [id]);
    expect(links.rows).toEqual([{ count: 0 }]);
  });
});
