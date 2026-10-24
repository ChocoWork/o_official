/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * DATA-PRIVACY-002 設定の表 shop_settings と設定の関数を、service role だけに許す。
 * PostgREST が取引ごとに入れる役を set local role で再現し、権限の誤りで取引を壊さないよう savepoint で包む。
 * 1つのテストを1つの取引にして最後に巻き戻すので、切り替えた設定は残らない。
 */
jest.setTimeout(30000);

type Role = 'anon' | 'authenticated' | 'service_role';
type Outcome = { rows: any[]; rowCount: number } | { code: string };

const CLIENT_ROLES: Role[] = ['anon', 'authenticated'];
const FUNCTIONS = ['public.get_delivery_tracking_settings()', 'public.admin_set_delivery_tracking(boolean, uuid)'];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

describeLocalDb('integration: privacy settings permissions', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function attempt(role: Role, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint permission_attempt');
    try {
      await db().query(`set local role ${role}`);
      const res = await db().query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (caught) {
      return { code: (caught as { code?: string }).code ?? 'unknown' };
    } finally {
      await db().query('rollback to savepoint permission_attempt');
      await db().query('release savepoint permission_attempt');
    }
  }

  const shape = (outcome: Outcome) => ('code' in outcome ? outcome.code : outcome.rowCount);

  function rowsOf(outcome: Outcome): any[] {
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows;
  }

  async function tableGrants() {
    const res = await db().query(
      `select coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
       from pg_catalog.pg_class c
       cross join lateral pg_catalog.aclexplode(c.relacl) a
       left join pg_catalog.pg_roles r on r.oid = a.grantee
       where c.oid = 'public.shop_settings'::regclass
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
       order by 1, 2`,
    );
    return res.rows;
  }

  async function functionGrants(signature: string) {
    const res = await db().query(
      `select coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
       from pg_catalog.pg_proc p
       cross join lateral pg_catalog.aclexplode(p.proacl) a
       left join pg_catalog.pg_roles r on r.oid = a.grantee
       where p.oid = $1::regprocedure
         and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
       order by 1, 2`,
      [signature],
    );
    return res.rows;
  }

  async function storedEnabled(): Promise<boolean> {
    return (await db().query('select delivery_tracking_enabled as enabled from public.shop_settings where id = 1')).rows[0].enabled;
  }

  test('DATA-PRIVACY-002 表 shop_settings の付与は、PUBLIC・anon・authenticated に無く、service_role に SELECT だけある', async () => {
    expect(await tableGrants()).toEqual([{ grantee: 'service_role', privilege_type: 'SELECT' }]);
  });

  test('DATA-PRIVACY-002 表の権限を役ごとに引くと、anon・authenticated は何も持たず、service_role は読むだけで書けない', async () => {
    for (const role of CLIENT_ROLES) {
      for (const privilege of TABLE_PRIVILEGES) {
        const res = await db().query('select has_table_privilege($1, $2, $3) as allowed', [role, 'public.shop_settings', privilege]);
        expect({ role, privilege, allowed: res.rows[0].allowed }).toEqual({ role, privilege, allowed: false });
      }
    }
    for (const privilege of TABLE_PRIVILEGES) {
      const res = await db().query('select has_table_privilege($1, $2, $3) as allowed', ['service_role', 'public.shop_settings', privilege]);
      expect({ privilege, allowed: res.rows[0].allowed }).toEqual({ privilege, allowed: privilege === 'SELECT' });
    }
  });

  test('DATA-PRIVACY-002 表は RLS が有効で、anon・authenticated へ RESTRICTIVE の方針 deny direct client access（USING・WITH CHECK とも false）が付く', async () => {
    const rls = await db().query("select relrowsecurity from pg_catalog.pg_class where oid = 'public.shop_settings'::regclass");
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);

    const policies = await db().query(
      `select policyname, permissive, roles::text[] as roles, cmd, qual, with_check
       from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'shop_settings'`,
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({
      policyname: 'deny direct client access', permissive: 'RESTRICTIVE', cmd: 'ALL', qual: 'false', with_check: 'false',
    });
    expect([...policies.rows[0].roles].sort()).toEqual(['anon', 'authenticated']);
  });

  test('DATA-PRIVACY-002 anon・authenticated は表を読むことも書くことも断られる（permission denied）', async () => {
    const before = await storedEnabled();
    for (const role of CLIENT_ROLES) {
      expect({ role, select: shape(await attempt(role, 'select * from public.shop_settings')) }).toEqual({ role, select: '42501' });
      expect({ role, insert: shape(await attempt(role, 'insert into public.shop_settings (id) values (1)')) }).toEqual({ role, insert: '42501' });
      expect({ role, update: shape(await attempt(role, 'update public.shop_settings set delivery_tracking_enabled = true')) }).toEqual({ role, update: '42501' });
      expect({ role, delete: shape(await attempt(role, 'delete from public.shop_settings')) }).toEqual({ role, delete: '42501' });
    }
    expect(await storedEnabled()).toBe(before);
  });

  test('DATA-PRIVACY-002 service_role は表を読めるが、直接の書き込み（追加・更新・削除）は断られる', async () => {
    const read = await attempt('service_role', 'select id, delivery_tracking_enabled from public.shop_settings');
    expect(rowsOf(read)).toHaveLength(1);
    expect(rowsOf(read)[0].id).toBe(1);

    const before = await storedEnabled();
    expect(shape(await attempt('service_role', 'update public.shop_settings set delivery_tracking_enabled = not delivery_tracking_enabled'))).toBe('42501');
    expect(shape(await attempt('service_role', 'insert into public.shop_settings (id) values (1)'))).toBe('42501');
    expect(shape(await attempt('service_role', 'delete from public.shop_settings'))).toBe('42501');
    expect(await storedEnabled()).toBe(before);
  });

  test('DATA-PRIVACY-002 設定の2つの関数は SECURITY DEFINER で、PUBLIC・anon・authenticated から EXECUTE を外し service_role にだけ付ける', async () => {
    for (const signature of FUNCTIONS) {
      const definer = await db().query('select prosecdef from pg_catalog.pg_proc where oid = $1::regprocedure', [signature]);
      expect({ signature, prosecdef: definer.rows[0].prosecdef }).toEqual({ signature, prosecdef: true });
      expect({ signature, grants: await functionGrants(signature) }).toEqual({
        signature, grants: [{ grantee: 'service_role', privilege_type: 'EXECUTE' }],
      });
      for (const role of CLIENT_ROLES) {
        const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [role, signature, 'EXECUTE']);
        expect({ signature, role, allowed: res.rows[0].allowed }).toEqual({ signature, role, allowed: false });
      }
      const service = await db().query('select has_function_privilege($1, $2, $3) as allowed', ['service_role', signature, 'EXECUTE']);
      expect(service.rows[0].allowed).toBe(true);
    }
  });

  test('DATA-PRIVACY-002 anon・authenticated は設定の読み出しの関数を呼べない（permission denied）', async () => {
    for (const role of CLIENT_ROLES) {
      expect({ role, outcome: shape(await attempt(role, 'select * from public.get_delivery_tracking_settings()')) }).toEqual({ role, outcome: '42501' });
    }
  });

  test('DATA-PRIVACY-002 service_role は設定の読み出しの関数を呼べ、表を直接読まなくても4つの欄が返る', async () => {
    const rows = rowsOf(await attempt('service_role', 'select * from public.get_delivery_tracking_settings()'));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(['enabled', 'updated_at', 'updated_by_email', 'backfill_count']);
    expect(rows[0].enabled).toBe(await storedEnabled());
  });

  test('DATA-PRIVACY-002 anon・authenticated は設定の切り替えの関数を呼べず、保存された値は変わらない', async () => {
    const before = await storedEnabled();
    for (const role of CLIENT_ROLES) {
      const outcome = shape(await attempt(role, 'select * from public.admin_set_delivery_tracking($1, $2)', [!before, randomUUID()]));
      expect({ role, outcome }).toEqual({ role, outcome: '42501' });
    }
    expect(await storedEnabled()).toBe(before);
  });

  test('DATA-PRIVACY-002 service_role は切り替えの関数を通してだけ設定を書き換えられる（表への直接の更新は断られる）', async () => {
    const before = await storedEnabled();
    const actor = randomUUID();
    const result = rowsOf(await attempt('service_role', 'select * from public.admin_set_delivery_tracking($1, $2)', [!before, actor]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ enabled: !before, updated_by: actor });
    expect(shape(await attempt('service_role', 'update public.shop_settings set delivery_tracking_enabled = $1', [!before]))).toBe('42501');
    // attempt は savepoint を巻き戻すので、関数の書き込みも残らない
    expect(await storedEnabled()).toBe(before);
  });
});
