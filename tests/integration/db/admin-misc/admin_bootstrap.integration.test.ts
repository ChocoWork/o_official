/** @jest-environment node */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readLocalSupabaseStatus } from '../../../../scripts/e2e/environment';
import { bootstrapFirstAdmin } from '../../../../scripts/admin/bootstrap-core';
import { createBootstrapDeps } from '../../../../scripts/admin/bootstrap-deps';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 最初の店長を作るコマンドの本物の deps を、手元の Supabase に向けて確かめる。
 * 手元の DB には E2E の店長が残っているので、作る側の試験は countActiveAdmins だけ 0 を返す物に替える。
 * 作った利用者は afterAll で消す。
 */
const PASSWORD = 'Bootstrap-Test-Pass-9z8y7x6w';

describeLocalDb('integration: 最初の店長を作るコマンド', (db) => {
  let client: SupabaseClient;
  const createdIds: string[] = [];

  beforeAll(() => {
    const status = readLocalSupabaseStatus();
    client = createClient(status.apiUrl, status.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  afterAll(async () => {
    for (const id of createdIds) await client.auth.admin.deleteUser(id);
  });

  async function makeUser(label: string): Promise<string> {
    const { data, error } = await client.auth.admin.createUser({
      email: `e2e-bootstrap-${label}-${randomBytes(4).toString('hex')}@example.com`,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error('試し用の利用者を作れない');
    createdIds.push(data.user.id);
    return data.user.id;
  }

  async function userCount(): Promise<number> {
    const { rows } = await db().query('select count(*)::int as n from auth.users');
    return rows[0].n;
  }

  test('counts only active unexpired admins', async () => {
    const deps = createBootstrapDeps(client);
    const before = await deps.countActiveAdmins();
    const [active, inactive, expired] = [await makeUser('a'), await makeUser('i'), await makeUser('x')];
    const role = (await db().query(`select id from public.roles where code = 'admin'`)).rows[0].id;
    await db().query(
      `insert into public.user_roles (user_id, role_id, active, expires_at) values
        ($1::uuid, $4, true, null),
        ($2::uuid, $4, false, null),
        ($3::uuid, $4, true, now() - interval '1 day')`,
      [active, inactive, expired, role],
    );
    expect(await deps.countActiveAdmins()).toBe(before + 1);
  });

  test('creates confirmed admin with role and audit', async () => {
    const email = `e2e-bootstrap-${randomBytes(6).toString('hex')}@example.com`;
    const deps = { ...createBootstrapDeps(client), countActiveAdmins: async () => 0 };
    const result = await bootstrapFirstAdmin({ email, password: PASSWORD, passwordConfirmation: PASSWORD, displayName: 'テスト店長' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIds.push(result.userId);

    const user = (
      await db().query(
        `select email_confirmed_at is not null as confirmed, raw_app_meta_data->>'role' as role from auth.users where id = $1::uuid`,
        [result.userId],
      )
    ).rows[0];
    expect(user).toEqual({ confirmed: true, role: 'admin' });

    const roles = (
      await db().query(
        `select r.code from public.user_roles ur join public.roles r on r.id = ur.role_id
          where ur.user_id = $1::uuid and ur.active and (ur.expires_at is null or ur.expires_at > now())`,
        [result.userId],
      )
    ).rows;
    expect(roles).toEqual([{ code: 'admin' }]);

    const audits = (
      await db().query(
        `select 1 from public.audit_logs where action = 'admin_bootstrap' and outcome = 'success' and resource_id = $1`,
        [result.userId],
      )
    ).rows;
    expect(audits).toHaveLength(1);
  });

  test('refuses with real admin count', async () => {
    const before = await userCount();
    const email = `e2e-bootstrap-${randomBytes(6).toString('hex')}@example.com`;
    const result = await bootstrapFirstAdmin(
      { email, password: PASSWORD, passwordConfirmation: PASSWORD },
      createBootstrapDeps(client),
    );
    expect(result).toMatchObject({ ok: false, reason: 'admin_exists' });
    expect(await userCount()).toBe(before);
  });
});
