/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 範囲の窓口の権限の印と初めの割り当て（DATA-ADMIN-006）。
 * 初めの割り当ては権限の作業の移行の「初めの割り当てを合わせる」部分を取引の中で流し直して確かめるので、
 * 手元の DB が後から編集されていても結果が変わらない。各試験は取引を巻き戻し、足した利用者・権限を残さない。
 */
type Grant = { role_code: string; permission_code: string };

const SCOPE_PERMISSIONS = [
  { code: 'admin.users.manage', supporter: false },
  { code: 'admin.audit.read', supporter: false },
  { code: 'admin.contact.read', supporter: true },
  { code: 'admin.contact.manage', supporter: true },
  { code: 'admin.items.read', supporter: false },
  { code: 'admin.items.manage', supporter: false },
];
const SCOPE_CODES = SCOPE_PERMISSIONS.map((permission) => permission.code);

describeLocalDb('integration: 範囲の窓口の権限の印と初めの割り当て', (db) => {
  let reconcileSql: string;

  beforeAll(() => {
    // 本番適用時の改名に備え、時刻ではなく後ろの名前で移行を探す。
    const directory = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g0_permissions.sql'));
    expect(files).toHaveLength(1);
    const migration = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    const block = migration.match(
      /-- BEGIN G0_PERMISSION_SEED_RECONCILE\r?\n([\s\S]*?)-- END G0_PERMISSION_SEED_RECONCILE/,
    );
    expect(block).not.toBeNull();
    reconcileSql = block![1];
  });

  beforeEach(async () => {
    await db().query('begin');
    await db().query(reconcileSql);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function scopeGrants(): Promise<Grant[]> {
    const result = await db().query(
      `select r.code as role_code, p.code as permission_code
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where p.code = any($1::text[])
       order by r.code, p.code`,
      [SCOPE_CODES],
    );
    return result.rows as Grant[];
  }

  async function grantsOf(roleCode: string): Promise<string[]> {
    return (await scopeGrants()).filter((grant) => grant.role_code === roleCode).map((grant) => grant.permission_code).sort();
  }

  async function roleId(code: string): Promise<string> {
    const result = await db().query('select id::text as id from public.roles where code = $1', [code]);
    return result.rows[0].id;
  }

  async function permissionId(code: string): Promise<string> {
    const result = await db().query('select id::text as id from public.permissions where code = $1', [code]);
    return result.rows[0].id;
  }

  async function createUser(roleCode: string | null, assignment = { active: true, expired: false }): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '{}', '{}', now(), now())`,
      [id],
    );
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         values ($1, $2::bigint, $3, case when $4::boolean then now() - interval '1 minute' else null end)`,
        [id, await roleId(roleCode), assignment.active, assignment.expired],
      );
    }
    return id;
  }

  /** authenticated の JWT で has_permission を呼び、6つの印の結果を返す。 */
  async function hasPermissionsAs(sub: string): Promise<Record<string, boolean>> {
    await db().query('savepoint as_actor');
    try {
      await db().query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role: 'authenticated', aal: 'aal2' }),
      ]);
      await db().query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
      await db().query('set local role authenticated');
      const result = await db().query(
        'select code, public.has_permission(code) as allowed from unnest($1::text[]) as code',
        [SCOPE_CODES],
      );
      return Object.fromEntries(result.rows.map((row) => [row.code as string, row.allowed as boolean]));
    } finally {
      await db().query('reset role');
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query("select set_config('request.jwt.claim.sub', '', true)");
      await db().query('release savepoint as_actor');
    }
  }

  async function failureOf(sql: string, params: unknown[]): Promise<{ code?: string; message?: string } | undefined> {
    await db().query('savepoint guarded');
    try {
      await db().query(sql, params);
      await db().query('release savepoint guarded');
      return undefined;
    } catch (caught) {
      await db().query('rollback to savepoint guarded');
      return caught as { code?: string; message?: string };
    }
  }

  test('DATA-ADMIN-006 6つの権限の印が1つずつ登録されている', async () => {
    const result = await db().query(
      `select code, count(*)::int as count from public.permissions
       where code = any($1::text[]) group by code order by code`,
      [SCOPE_CODES],
    );

    expect(result.rows).toEqual([...SCOPE_CODES].sort().map((code) => ({ code, count: 1 })));
  });

  test('DATA-ADMIN-006 監査ログの閲覧の印は DB の名前が「監査ログの閲覧」で登録されている', async () => {
    const result = await db().query("select name from public.permissions where code = 'admin.audit.read'");

    expect(result.rows).toEqual([{ name: '監査ログの閲覧' }]);
  });

  test('DATA-ADMIN-006 店長は6つとも持つ', async () => {
    expect(await grantsOf('admin')).toEqual([...SCOPE_CODES].sort());
  });

  test('DATA-ADMIN-006 サポーターは問い合わせの閲覧・管理だけを持つ', async () => {
    expect(await grantsOf('supporter')).toEqual(['admin.contact.manage', 'admin.contact.read']);
  });

  test.each(SCOPE_PERMISSIONS)(
    'DATA-ADMIN-006 $code の持ち主は初めから店長（と、サポーターは $supporter の時だけ）で、一般利用者には付かない',
    async ({ code, supporter }) => {
      const grants = await scopeGrants();
      const holders = grants.filter((grant) => grant.permission_code === code).map((grant) => grant.role_code);

      expect(holders).toEqual(supporter ? ['admin', 'supporter'] : ['admin']);
      expect(holders).not.toContain('user');
    },
  );

  test('DATA-ADMIN-006 合わせ直しは何度流しても付与の数が変わらない', async () => {
    const before = await scopeGrants();

    await db().query(reconcileSql);
    await db().query(reconcileSql);

    expect(await scopeGrants()).toEqual(before);
  });

  test('DATA-ADMIN-006 外れた付与は合わせ直しで戻り、余計な付与は外れる', async () => {
    const supporter = await roleId('supporter');
    await db().query(
      'delete from public.role_permissions where role_id = $1::bigint and permission_id = $2::bigint',
      [supporter, await permissionId('admin.contact.read')],
    );
    await db().query(
      'insert into public.role_permissions (role_id, permission_id) values ($1::bigint, $2::bigint)',
      [supporter, await permissionId('admin.audit.read')],
    );
    await db().query(
      'delete from public.role_permissions where role_id = $1::bigint and permission_id = $2::bigint',
      [await roleId('admin'), await permissionId('admin.items.read')],
    );

    await db().query(reconcileSql);

    expect(await grantsOf('supporter')).toEqual(['admin.contact.manage', 'admin.contact.read']);
    expect(await grantsOf('admin')).toEqual([...SCOPE_CODES].sort());
  });

  test('DATA-ADMIN-006 合わせ直しは一覧の外の権限の付与を消さない', async () => {
    await db().query("insert into public.permissions (code, name) values ('test.admin_seed.preserved', '保存する試験権限')");
    await db().query(
      `insert into public.role_permissions (role_id, permission_id)
       select r.id, p.id from public.roles r cross join public.permissions p
       where p.code = 'test.admin_seed.preserved' and r.code in ('admin', 'supporter', 'user')`,
    );

    await db().query(reconcileSql);

    const result = await db().query(
      `select r.code as role_code from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where p.code = 'test.admin_seed.preserved' order by r.code`,
    );
    expect(result.rows).toEqual([{ role_code: 'admin' }, { role_code: 'supporter' }, { role_code: 'user' }]);
  });

  test('DATA-ADMIN-006 利用者の管理はサポーターにも一般利用者にも付けられない（トリガーが断る）', async () => {
    for (const roleCode of ['supporter', 'user']) {
      const failure = await failureOf(
        'insert into public.role_permissions (role_id, permission_id) values ($1::bigint, $2::bigint)',
        [await roleId(roleCode), await permissionId('admin.users.manage')],
      );

      expect(failure?.code).toBe('42501');
      expect(failure?.message).toContain('ROLE_PERMISSION_FIXED');
    }
    expect(await grantsOf('supporter')).not.toContain('admin.users.manage');
  });

  test('DATA-ADMIN-006 利用者の管理を店長から外すのもトリガーが断り、店長に残る', async () => {
    const failure = await failureOf(
      'delete from public.role_permissions where role_id = $1::bigint and permission_id = $2::bigint',
      [await roleId('admin'), await permissionId('admin.users.manage')],
    );

    expect(failure?.code).toBe('42501');
    expect(failure?.message).toContain('ROLE_PERMISSION_FIXED');
    expect(await grantsOf('admin')).toContain('admin.users.manage');
  });

  test('DATA-ADMIN-006 固定でない印（商品の閲覧）はサポーターに付け外しできる', async () => {
    const supporter = await roleId('supporter');
    const items = await permissionId('admin.items.read');

    await db().query(
      'insert into public.role_permissions (role_id, permission_id) values ($1::bigint, $2::bigint)',
      [supporter, items],
    );
    expect(await grantsOf('supporter')).toContain('admin.items.read');

    await db().query(
      'delete from public.role_permissions where role_id = $1::bigint and permission_id = $2::bigint',
      [supporter, items],
    );
    expect(await grantsOf('supporter')).toEqual(['admin.contact.manage', 'admin.contact.read']);
  });

  test('DATA-ADMIN-006 has_permission は店長の利用者に6つとも true を返す', async () => {
    const admin = await createUser('admin');

    expect(await hasPermissionsAs(admin)).toEqual(Object.fromEntries(SCOPE_CODES.map((code) => [code, true])));
  });

  test('DATA-ADMIN-006 has_permission はサポーターの利用者に問い合わせの2つだけ true を返す', async () => {
    const supporter = await createUser('supporter');

    expect(await hasPermissionsAs(supporter)).toEqual(
      Object.fromEntries(SCOPE_PERMISSIONS.map(({ code, supporter: allowed }) => [code, allowed])),
    );
  });

  test.each([
    ['役が無い', null, { active: true, expired: false }],
    ['一般利用者', 'user', { active: true, expired: false }],
    ['店長でも無効にした', 'admin', { active: false, expired: false }],
    ['店長でも期限が切れた', 'admin', { active: true, expired: true }],
  ] as const)('DATA-ADMIN-006 has_permission は%sの利用者に6つとも false を返す', async (_label, roleCode, assignment) => {
    const user = await createUser(roleCode, { ...assignment });

    expect(await hasPermissionsAs(user)).toEqual(Object.fromEntries(SCOPE_CODES.map((code) => [code, false])));
  });
});
