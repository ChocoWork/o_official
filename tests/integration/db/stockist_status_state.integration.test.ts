/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * 取扱店の公開の状態 private・published の値と行き来（STATE-STOCKIST-001）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: 取扱店の公開の状態', (db) => {
  let marker: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-stockist-state-${randomUUID()}`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertStockist(status: string): Promise<string> {
    const result = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, '東京都港区南青山0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', $2)
       returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function stockist(id: string): Promise<{ status: string; type: string; name: string; address: string } | undefined> {
    const result = await db().query('select status, type, name, address from public.stockists where id = $1', [id]);
    return result.rows[0];
  }

  async function setStatus(id: string, status: string): Promise<number> {
    return (await db().query('update public.stockists set status = $2 where id = $1', [id, status])).rowCount;
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
      const result = await db().query('select 1 from public.stockists where id = $1', [id]);
      return (result.rowCount ?? 0) >= 1;
    } finally {
      await db().query('rollback to savepoint as_anon');
    }
  }

  test('STATE-STOCKIST-001 状態の CHECK は private と published の2つだけを許す', async () => {
    const result = await db().query(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid = 'public.stockists'::regclass and conname = 'stockists_status_check'`,
    );

    expect(result.rows).toHaveLength(1);
    const allowed = [...(result.rows[0].definition as string).matchAll(/'([^']*)'::text/g)].map((match) => match[1]);
    expect(allowed.sort()).toEqual(['private', 'published']);
  });

  test.each(['private', 'published'])('STATE-STOCKIST-001 作成で %s を入れられる', async (status) => {
    const id = await insertStockist(status);

    expect((await stockist(id))?.status).toBe(status);
  });

  test.each(['draft', 'PUBLISHED', 'archived', ''])('STATE-STOCKIST-001 状態 "%s" の作成は CHECK の違反で落ちる', async (status) => {
    const result = await failure(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, 'a', 'p', 't', 'h', $2)`,
      [`${marker} invalid`, status],
    );

    expect(result).toEqual({ code: '23514', constraint: 'stockists_status_check' });
  });

  test('STATE-STOCKIST-001 DB の初めの値は private で、状態を省いた作成は非公開の店になる', async () => {
    const defaults = await db().query(
      `select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists' and column_name = 'status'`,
    );
    expect(defaults.rows).toEqual([{ column_default: "'private'::text" }]);

    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday)
       values ('STORE', $1, 'a', 'p', 't', 'h')
       returning id::text as id, status`,
      [`${marker} default`],
    );

    expect(inserted.rows[0].status).toBe('private');
    expect(await visibleToAnon(inserted.rows[0].id)).toBe(false);
  });

  test('STATE-STOCKIST-001 private から published へ変えると公開の道に出る', async () => {
    const id = await insertStockist('private');
    expect(await visibleToAnon(id)).toBe(false);

    expect(await setStatus(id, 'published')).toBe(1);

    expect((await stockist(id))?.status).toBe('published');
    expect(await visibleToAnon(id)).toBe(true);
  });

  test('STATE-STOCKIST-001 published から private へ変えると公開の道から消える', async () => {
    const id = await insertStockist('published');
    expect(await visibleToAnon(id)).toBe(true);

    expect(await setStatus(id, 'private')).toBe(1);

    expect((await stockist(id))?.status).toBe('private');
    expect(await visibleToAnon(id)).toBe(false);
  });

  test('STATE-STOCKIST-001 公開と非公開を何度行き来しても、状態は最後に入れた値になる', async () => {
    const id = await insertStockist('private');

    for (const status of ['published', 'private', 'published', 'private']) {
      expect(await setStatus(id, status)).toBe(1);
      expect((await stockist(id))?.status).toBe(status);
    }
  });

  test.each(['private', 'published'])('STATE-STOCKIST-001 同じ状態 %s への変更も1行の更新として通る', async (status) => {
    const id = await insertStockist(status);

    expect(await setStatus(id, status)).toBe(1);
    expect((await stockist(id))?.status).toBe(status);
  });

  test.each(['private', 'published'])('STATE-STOCKIST-001 %s から CHECK に無い値へは変えられない', async (status) => {
    const id = await insertStockist(status);

    const result = await failure("update public.stockists set status = 'draft' where id = $1", [id]);

    expect(result).toEqual({ code: '23514', constraint: 'stockists_status_check' });
    expect((await stockist(id))?.status).toBe(status);
  });

  test('STATE-STOCKIST-001 状態を変えると updated_at が今になる', async () => {
    const inserted = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status, created_at, updated_at)
       values ('STORE', $1, 'a', 'p', 't', 'h', 'private', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
       returning id::text as id`,
      [`${marker} touch`],
    );

    // 取引の中の now() は取引の始まりの時刻で動かないので、送った値ではなく now() と比べる
    const updated = await db().query(
      `update public.stockists set status = 'published' where id = $1 returning updated_at, now() as now`,
      [inserted.rows[0].id],
    );

    expect((updated.rows[0].updated_at as Date).toISOString()).toBe((updated.rows[0].now as Date).toISOString());
  });

  test('STATE-STOCKIST-001 公開の日時の列は無く、状態を変えても他の列は変わらない', async () => {
    const columns = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'stockists' and column_name ~ '(publish|_date$)'`,
    );
    expect(columns.rows).toEqual([]);

    const id = await insertStockist('private');
    const before = await stockist(id);
    await setStatus(id, 'published');
    const after = await stockist(id);

    expect({ ...after, status: before?.status }).toEqual(before);
  });

  test.each(['private', 'published'])('STATE-STOCKIST-001 %s の店も削除で行が消え、消した店は更新の対象にもならない', async (status) => {
    const id = await insertStockist(status);

    const deleted = await db().query('delete from public.stockists where id = $1', [id]);

    expect(deleted.rowCount).toBe(1);
    expect(await stockist(id)).toBeUndefined();
    expect(await setStatus(id, 'published')).toBe(0);
  });

  test('STATE-STOCKIST-001 無い id の削除は0行で、エラーにならない', async () => {
    const deleted = await db().query('delete from public.stockists where id = -1');

    expect(deleted.rowCount).toBe(0);
  });
});
