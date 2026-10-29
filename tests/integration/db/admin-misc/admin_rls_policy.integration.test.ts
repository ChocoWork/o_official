/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createLiveAppSession, jwtClaims } from '../helpers/app-session';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 管理の表（contact_inquiries・contact_messages・contact_reply_templates・audit_logs・sessions）の
 * RLS の方針と表の付与（DATA-ADMIN-002）。PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。
 * 手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻すので、足した行を残さない。
 */
type DbRole = 'anon' | 'authenticated' | 'service_role';
type Actor = { label: string; role: DbRole; sub?: string };
type Policy = { policyname: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null };
type Context = { marker: string; inquiryId: string; userId: string };
type Fixture = {
  table: string;
  /** 行を足す文。`returning id::text as id` で番号を返す。 */
  insertSql: string;
  insertParams: (context: Context) => unknown[];
  /** 文字の列 1 つを 'tampered' に書き換える文と、その列の名前。 */
  column: string;
  updateSql: string;
};

const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];

const FIXTURES: Fixture[] = [
  {
    table: 'contact_inquiries',
    insertSql: `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
                values ($1, 'a@example.invalid', 'other', 'original', 'm') returning id::text as id`,
    insertParams: ({ marker }) => [marker],
    column: 'subject',
    updateSql: "update public.contact_inquiries set subject = 'tampered' where id = $1",
  },
  {
    table: 'contact_messages',
    insertSql: `insert into public.contact_messages (inquiry_id, sender_role, body)
                values ($1, 'user', 'original') returning id::text as id`,
    insertParams: ({ inquiryId }) => [inquiryId],
    column: 'body',
    updateSql: "update public.contact_messages set body = 'tampered' where id = $1",
  },
  {
    table: 'contact_reply_templates',
    insertSql: `insert into public.contact_reply_templates (title, body)
                values ($1, 'b') returning id::text as id`,
    insertParams: ({ marker }) => [marker],
    column: 'body',
    updateSql: "update public.contact_reply_templates set body = 'tampered' where id = $1",
  },
  {
    table: 'audit_logs',
    insertSql: `insert into public.audit_logs (action, outcome, detail)
                values ('integration.test', 'success', $1) returning id::text as id`,
    insertParams: ({ marker }) => [marker],
    column: 'detail',
    updateSql: "update public.audit_logs set detail = 'tampered' where id = $1",
  },
  {
    table: 'sessions',
    insertSql: `insert into public.sessions (user_id, refresh_token_hash, device_name)
                values ($1, $2, 'original') returning id::text as id`,
    insertParams: ({ userId, marker }) => [userId, marker],
    column: 'device_name',
    updateSql: "update public.sessions set device_name = 'tampered' where id = $1",
  },
];

const CONTACT_TABLES = ['contact_inquiries', 'contact_messages', 'contact_reply_templates'];
/** anon・authenticated に表の権限が無い表（ADR-0414。RLS の全拒否の方針は二重の守りとして残す）。 */
const NO_CLIENT_GRANT_TABLES = ['audit_logs', 'sessions'];
const ALL_TABLES = FIXTURES.map((fixture) => fixture.table);
const hasClientGrant = (table: string): boolean => !NO_CLIENT_GRANT_TABLES.includes(table);

const DENIED_ACTORS: Actor[] = [
  { label: 'anon', role: 'anon' },
  { label: 'sub の無い authenticated', role: 'authenticated' },
  { label: '会員（authenticated）', role: 'authenticated', sub: randomUUID() },
];

const byCodeUnit = (a: Policy, b: Policy): number => (a.policyname < b.policyname ? -1 : 1);

describeLocalDb('integration: 管理の表の RLS と付与', (db) => {
  let context: Context;
  // 会員（権限の無い authenticated）にも aal2 と結び付いた生きた session を持たせ、断る理由が「権限が無いこと」だけになるようにする
  let liveSessions: Map<string, { sessionId: string }>;

  beforeEach(async () => {
    await db().query('begin');
    liveSessions = new Map();
    // 取引の中で、savepoint に巻き戻されない所に作る
    for (const denied of DENIED_ACTORS) {
      if (!denied.sub) continue;
      await db().query(
        `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ($1, '{}', '{}', now(), now())`,
        [denied.sub],
      );
      liveSessions.set(denied.sub, await createLiveAppSession(db(), denied.sub));
    }
    const marker = `integration-admin-rls-${randomUUID()}`;
    const userId = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '{}', '{}', now(), now())`,
      [userId],
    );
    const inquiry = await db().query(
      `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
       values ($1, 'parent@example.invalid', 'other', 'parent', 'm') returning id::text as id`,
      [marker],
    );
    context = { marker, inquiryId: inquiry.rows[0].id, userId };
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  /** テストの下ごしらえ。RLS を通らない接続の役で行を足す。 */
  async function seed(fixture: Fixture): Promise<string> {
    const result = await db().query(fixture.insertSql, fixture.insertParams(context));
    return result.rows[0].id;
  }

  async function enter(actor: Actor): Promise<void> {
    const session = actor.sub ? liveSessions.get(actor.sub) : undefined;
    const claims = actor.sub
      ? JSON.stringify(session ? { ...jwtClaims(actor.sub, session), role: actor.role } : { sub: actor.sub, role: actor.role, aal: 'aal2' })
      : '';
    await db().query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db().query("select set_config('request.jwt.claim.sub', $1, true)", [actor.sub ?? '']);
    await db().query(`set local role ${actor.role}`);
  }

  async function leave(): Promise<void> {
    await db().query('reset role');
    await db().query("select set_config('request.jwt.claims', '', true)");
    await db().query("select set_config('request.jwt.claim.sub', '', true)");
  }

  /** 利用者の役で1本流す。失敗しても取引が壊れないよう savepoint に戻す。 */
  async function runAs(actor: Actor, sql: string, params: unknown[] = []) {
    await db().query('savepoint as_actor');
    try {
      await enter(actor);
      const result = await db().query(sql, params);
      await leave();
      await db().query('release savepoint as_actor');
      return result;
    } catch (error) {
      await db().query('rollback to savepoint as_actor');
      throw error;
    }
  }

  async function errorCodeAs(actor: Actor, sql: string, params: unknown[] = []): Promise<string | undefined> {
    try {
      await runAs(actor, sql, params);
      return undefined;
    } catch (caught) {
      return (caught as { code?: string }).code;
    }
  }

  async function rowCount(table: string, id: string): Promise<number> {
    const result = await db().query(`select count(*)::int as count from public.${table} where id = $1`, [id]);
    return result.rows[0].count;
  }

  async function tableCount(table: string): Promise<number> {
    const result = await db().query(`select count(*)::int as count from public.${table}`);
    return result.rows[0].count;
  }

  async function columnValue(fixture: Fixture, id: string): Promise<string | undefined> {
    const result = await db().query(`select ${fixture.column} as value from public.${fixture.table} where id = $1`, [id]);
    return result.rows[0]?.value;
  }

  async function policies(table: string): Promise<Policy[]> {
    const result = await db().query(
      `select policyname, roles::text[] as roles, cmd, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = $1`,
      [table],
    );
    return (result.rows as Policy[]).sort(byCodeUnit);
  }

  test.each(ALL_TABLES)('DATA-ADMIN-002 %s の RLS が有効になっている', async (table) => {
    const result = await db().query(
      'select relrowsecurity from pg_class where oid = $1::regclass', [`public.${table}`],
    );

    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  test.each(CONTACT_TABLES)('DATA-ADMIN-002 %s の方針は select・insert・update・delete の4つで、どれも全員に対して false', async (table) => {
    const rows = await policies(table);

    expect(rows.map(({ policyname, roles, cmd, qual, with_check }) => ({ policyname, roles, cmd, qual, with_check }))).toEqual([
      { policyname: `Deny direct delete on ${table}`, roles: ['public'], cmd: 'DELETE', qual: 'false', with_check: null },
      { policyname: `Deny direct insert on ${table}`, roles: ['public'], cmd: 'INSERT', qual: null, with_check: 'false' },
      { policyname: `Deny direct select on ${table}`, roles: ['public'], cmd: 'SELECT', qual: 'false', with_check: null },
      { policyname: `Deny direct update on ${table}`, roles: ['public'], cmd: 'UPDATE', qual: 'false', with_check: 'false' },
    ]);
  });

  test.each(['audit_logs', 'sessions'])('DATA-ADMIN-002 %s の方針は anon・authenticated を全部断り、service_role を全部許す3つ', async (table) => {
    const rows = await policies(table);

    expect(rows.map(({ policyname, roles, cmd, qual, with_check }) => ({ policyname, roles, cmd, qual, with_check }))).toEqual([
      { policyname: `${table}_deny_anon_all`, roles: ['anon'], cmd: 'ALL', qual: 'false', with_check: 'false' },
      { policyname: `${table}_deny_authenticated_all`, roles: ['authenticated'], cmd: 'ALL', qual: 'false', with_check: 'false' },
      { policyname: `${table}_service_role_all`, roles: ['service_role'], cmd: 'ALL', qual: 'true', with_check: 'true' },
    ]);
  });

  test.each(ALL_TABLES)('DATA-ADMIN-002 %s の方針は権限の関数に頼らず、条件は固定の true か false だけ', async (table) => {
    const rows = await policies(table);

    for (const row of rows) {
      expect(['true', 'false', null]).toContain(row.qual);
      expect(['true', 'false', null]).toContain(row.with_check);
    }
  });

  test.each(
    CONTACT_TABLES.flatMap((table) => (['anon', 'authenticated', 'service_role'] as DbRole[]).map((role) => [role, table])),
  )('DATA-ADMIN-002 %s には %s の権限が全部付いていて、守りは方針の1段だけ', async (role, table) => {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege)
       order by privilege`,
      [role, `public.${table}`, TABLE_PRIVILEGES],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(TABLE_PRIVILEGES);
  });

  test.each(
    NO_CLIENT_GRANT_TABLES.flatMap((table) => (['anon', 'authenticated'] as DbRole[]).map((role) => [role, table])),
  )('DATA-ADMIN-002 %s には %s の表の権限が1つも付いていない（方針の手前で断る）', async (role, table) => {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege)
       order by privilege`,
      [role, `public.${table}`, TABLE_PRIVILEGES],
    );

    expect(result.rows).toEqual([]);
  });

  test.each(NO_CLIENT_GRANT_TABLES)('DATA-ADMIN-002 service_role には %s の権限が全部付いている', async (table) => {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege)
       order by privilege`,
      ['service_role', `public.${table}`, TABLE_PRIVILEGES],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(TABLE_PRIVILEGES);
  });

  describe.each(DENIED_ACTORS)('$label', (actor) => {
    test.each(FIXTURES)('DATA-ADMIN-002 $table の行は読めない（問い合わせの3表は0行、audit_logs・sessions は権限の誤り 42501）', async (fixture) => {
      const id = await seed(fixture);
      expect(await rowCount(fixture.table, id)).toBe(1);

      if (!hasClientGrant(fixture.table)) {
        expect(await errorCodeAs(actor, `select id::text as id from public.${fixture.table} where id = $1`, [id])).toBe('42501');
        expect(await errorCodeAs(actor, `select count(*)::int as count from public.${fixture.table}`)).toBe('42501');
        return;
      }
      const result = await runAs(actor, `select id::text as id from public.${fixture.table} where id = $1`, [id]);
      const all = await runAs(actor, `select count(*)::int as count from public.${fixture.table}`);

      expect(result.rows).toEqual([]);
      expect(all.rows).toEqual([{ count: 0 }]);
    });

    test.each(FIXTURES)('DATA-ADMIN-002 $table への追加は RLS の違反で落ち、行は増えない', async (fixture) => {
      const before = await tableCount(fixture.table);

      const code = await errorCodeAs(actor, fixture.insertSql, fixture.insertParams(context));

      expect(code).toBe('42501');
      expect(await tableCount(fixture.table)).toBe(before);
    });

    test.each(FIXTURES)('DATA-ADMIN-002 $table の更新は1行も変えない（audit_logs・sessions は権限の誤り 42501）', async (fixture) => {
      const id = await seed(fixture);
      const before = await columnValue(fixture, id);

      if (!hasClientGrant(fixture.table)) {
        expect(await errorCodeAs(actor, fixture.updateSql, [id])).toBe('42501');
      } else {
        const updated = await runAs(actor, fixture.updateSql, [id]);
        expect(updated.rowCount).toBe(0);
      }

      expect(await columnValue(fixture, id)).toBe(before);
      expect(before).not.toBe('tampered');
    });

    test.each(FIXTURES)('DATA-ADMIN-002 $table の削除は1行も消さない（audit_logs・sessions は権限の誤り 42501）', async (fixture) => {
      const id = await seed(fixture);

      if (!hasClientGrant(fixture.table)) {
        expect(await errorCodeAs(actor, `delete from public.${fixture.table} where id = $1`, [id])).toBe('42501');
      } else {
        const deleted = await runAs(actor, `delete from public.${fixture.table} where id = $1`, [id]);
        expect(deleted.rowCount).toBe(0);
      }

      expect(await rowCount(fixture.table, id)).toBe(1);
    });
  });

  describe('service_role', () => {
    const actor: Actor = { label: 'service_role', role: 'service_role' };

    test.each(FIXTURES)('DATA-ADMIN-002 $table を service_role は追加・読み・更新・削除のどれもできる', async (fixture) => {
      const inserted = await runAs(actor, fixture.insertSql, fixture.insertParams(context));
      const id = inserted.rows[0].id as string;

      const read = await runAs(actor, `select id::text as id from public.${fixture.table} where id = $1`, [id]);
      const updated = await runAs(actor, fixture.updateSql, [id]);
      const afterUpdate = await columnValue(fixture, id);
      const deleted = await runAs(actor, `delete from public.${fixture.table} where id = $1`, [id]);

      expect(read.rows).toEqual([{ id }]);
      expect(updated.rowCount).toBe(1);
      expect(afterUpdate).toBe('tampered');
      expect(deleted.rowCount).toBe(1);
      expect(await rowCount(fixture.table, id)).toBe(0);
    });

    test('DATA-ADMIN-002 service_role は問い合わせの全件を読め、anon が見た0行とは違う', async () => {
      const id = await seed(FIXTURES[0]);

      const asService = await runAs(actor, 'select id::text as id from public.contact_inquiries where id = $1', [id]);
      const asAnon = await runAs(DENIED_ACTORS[0], 'select id::text as id from public.contact_inquiries where id = $1', [id]);

      expect(asService.rows).toHaveLength(1);
      expect(asAnon.rows).toHaveLength(0);
    });
  });
});
