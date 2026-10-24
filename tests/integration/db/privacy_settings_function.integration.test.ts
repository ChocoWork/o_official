/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';

/**
 * DATA-PRIVACY-001 設定の関数 get_delivery_tracking_settings の返り値と、頁が使う欄。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した利用者と切り替えた設定は残らない。
 */
jest.setTimeout(30000);

const COLUMNS = ['enabled', 'updated_at', 'updated_by_email', 'backfill_count'];

describeLocalDb('integration: privacy settings function', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function createActor(client: PgClient): Promise<{ id: string; email: string }> {
    const email = `privacy-settings-${randomUUID()}@example.com`;
    const res = await client.query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
      [email],
    );
    return { id: res.rows[0].id as string, email };
  }

  async function toggle(enabled: boolean, actorId: string) {
    return (await db().query('select * from public.admin_set_delivery_tracking($1, $2)', [enabled, actorId])).rows[0];
  }

  async function settings() {
    return (await db().query('select * from public.get_delivery_tracking_settings()')).rows;
  }

  test('DATA-PRIVACY-001 関数は設定の1行だけを、enabled・updated_at・updated_by_email・backfill_count の順で返す', async () => {
    const rows = await settings();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(COLUMNS);
    expect(typeof rows[0].enabled).toBe('boolean');
    expect(typeof rows[0].backfill_count).toBe('number');
    expect(Number.isInteger(rows[0].backfill_count)).toBe(true);
  });

  test('DATA-PRIVACY-001 関数は SQL・STABLE・SECURITY DEFINER で、search_path を空にして固定している', async () => {
    const res = await db().query(
      `select p.prosecdef, p.provolatile, p.proconfig, l.lanname
       from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
       where p.oid = 'public.get_delivery_tracking_settings()'::regprocedure`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ prosecdef: true, provolatile: 's', lanname: 'sql' });
    expect(res.rows[0].proconfig).toEqual([expect.stringMatching(/^search_path=("")?$/)]);
  });

  test('DATA-PRIVACY-001 enabled は shop_settings.delivery_tracking_enabled（boolean・NOT NULL・初めは false）を返す', async () => {
    const column = await db().query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'shop_settings' and column_name = 'delivery_tracking_enabled'`,
    );
    expect(column.rows).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);

    const actor = await createActor(db());
    await toggle(false, actor.id);
    expect((await settings())[0].enabled).toBe(false);
    await toggle(true, actor.id);
    expect((await settings())[0].enabled).toBe(true);
    const stored = await db().query('select delivery_tracking_enabled from public.shop_settings where id = 1');
    expect(stored.rows).toEqual([{ delivery_tracking_enabled: true }]);
    await toggle(false, actor.id);
    expect((await settings())[0].enabled).toBe(false);
  });

  test('DATA-PRIVACY-001 値を変えた時だけ、updated_at が切り替えの時刻に、updated_by_email が変えた人のメールになる', async () => {
    const first = await createActor(db());
    const second = await createActor(db());
    await toggle(true, first.id);
    await toggle(false, first.id);
    const now = (await db().query('select now() as now')).rows[0].now as Date;
    const changed = (await settings())[0];
    expect(changed.updated_by_email).toBe(first.email);
    expect(new Date(changed.updated_at).toISOString()).toBe(now.toISOString());

    // 同じ値の再保存は更新者も時刻も書き換えない
    await toggle(false, second.id);
    const unchanged = (await settings())[0];
    expect(unchanged.enabled).toBe(false);
    expect(unchanged.updated_by_email).toBe(first.email);
    expect(new Date(unchanged.updated_at).toISOString()).toBe(new Date(changed.updated_at).toISOString());

    await toggle(true, second.id);
    expect((await settings())[0]).toMatchObject({ enabled: true, updated_by_email: second.email });
  });

  test('DATA-PRIVACY-001 変えた人が auth.users に居なければ、updated_by_email は null になり、行は失われない', async () => {
    const ghost = randomUUID();
    await toggle(true, ghost);
    await toggle(false, ghost);
    const rows = await settings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: false, updated_by_email: null });
    expect(rows[0].updated_at).not.toBeNull();
  });

  test('DATA-PRIVACY-001 backfill_count は取り込み対象の関数 private.delivery_tracking_backfill_targets の件数と一致する', async () => {
    const actor = await createActor(db());
    const count = async () => (await db().query('select count(*)::int as n from private.delivery_tracking_backfill_targets()')).rows[0].n as number;
    await toggle(false, actor.id);
    expect((await settings())[0].backfill_count).toBe(await count());
    await toggle(true, actor.id);
    expect((await settings())[0].backfill_count).toBe(await count());
  });

  test('DATA-PRIVACY-001 設定の表は id=1 の1行だけで、2行目は CHECK が断る', async () => {
    const count = await db().query('select count(*)::int as n from public.shop_settings');
    expect(count.rows[0].n).toBe(1);
    await db().query('savepoint second_row');
    let code: string | undefined;
    try {
      await db().query('insert into public.shop_settings (id) values (2)');
    } catch (caught) {
      code = (caught as { code?: string }).code;
    } finally {
      await db().query('rollback to savepoint second_row');
    }
    expect(code).toBe('23514');
    expect((await db().query('select count(*)::int as n from public.shop_settings')).rows[0].n).toBe(1);
  });
});
