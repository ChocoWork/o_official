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

jest.setTimeout(30000);

describeLocalDb('integration: 最初の店長を作るコマンド', (db) => {
  let client: SupabaseClient;
  const createdIds: string[] = [];
  const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ALERT_AUDIT_URL'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    const status = readLocalSupabaseStatus();
    // logAudit は process.env から service role の client を作るので、手元の Supabase に向ける（遠い先には書かない）。
    if (!['127.0.0.1', 'localhost'].includes(new URL(status.apiUrl).hostname)) {
      throw new Error('手元の Supabase 以外には向けない');
    }
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.SUPABASE_URL = status.apiUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
    delete process.env.ALERT_AUDIT_URL;
    client = createClient(status.apiUrl, status.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
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
    // 手元の DB は共有なので、全体の数の差は他の作業で揺れうる。付けた3行は SQL で直接確かめる。
    const rows = (
      await db().query(
        `select user_id::text as id from public.user_roles
          where user_id = any($1::uuid[]) and role_id = $2 and active and (expires_at is null or expires_at > now())`,
        [[active, inactive, expired], role],
      )
    ).rows;
    expect(rows).toEqual([{ id: active }]);
    expect(await deps.countActiveAdmins()).toBe(before + 1);
  });

  test('creates confirmed admin with role and audit', async () => {
    const email = `e2e-bootstrap-${randomBytes(6).toString('hex')}@example.com`;
    const deps = { ...createBootstrapDeps(client), countActiveAdmins: async () => 0, checkPwned: async () => ({ status: 'ok' as const }) };
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
    const email = `e2e-bootstrap-${randomBytes(6).toString('hex')}@example.com`;
    const result = await bootstrapFirstAdmin(
      { email, password: PASSWORD, passwordConfirmation: PASSWORD },
      createBootstrapDeps(client),
    );
    expect(result).toMatchObject({ ok: false, reason: 'admin_exists' });
    const rows = (await db().query('select 1 from auth.users where email = $1', [email])).rows;
    expect(rows).toHaveLength(0);
  });
});
