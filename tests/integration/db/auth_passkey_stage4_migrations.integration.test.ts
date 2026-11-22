/** @jest-environment node */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCAL_DATABASE_URL, describeLocalDb, type PgClient } from './helpers/local-db';

const { Client } = require('pg');

// Passkey stage 4 Task 32 (migrations J and K).
//   J: private.passkey_staff_config.reject_customer_password = true  (the hook rejects customer password logins)
//   K: drops public.password_reset_tokens, public.password_change_challenges and their three functions
// DB suite: needs the local Supabase after `db reset` (J and K applied). Every case that writes runs in a transaction that is rolled back.
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const CUSTOMER_MARKER = '[customer-password-disabled]';
const STAFF_MARKER = '[staff-passkey-required]';

const DROPPED_TABLES = ['password_reset_tokens', 'password_change_challenges'] as const;
const DROPPED_FUNCTIONS = [
  'public.issue_password_change_challenge(uuid, uuid, text, integer)',
  'public.consume_password_change_challenge(uuid, uuid, text)',
  'public.cleanup_password_reset_tokens(integer)',
] as const;

// The shape captured from the local DB BEFORE K was written (relacl, proacl, proconfig, policy counts).
const TABLE_ACL = '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}';
const FUNCTION_ACL = '{postgres=X/postgres,service_role=X/postgres}';
const FUNCTION_CONFIG = '{"search_path=\\"\\""}';
const POLICIES_BEFORE_K: Record<(typeof DROPPED_TABLES)[number], string[]> = {
  password_change_challenges: [
    'password_change_challenges_deny_anon_all|{anon}',
    'password_change_challenges_deny_authenticated_all|{authenticated}',
    'password_change_challenges_service_role_all|{service_role}',
  ],
  password_reset_tokens: [
    'password_reset_tokens_deny_anon_all|{anon}',
    'password_reset_tokens_deny_authenticated_all|{authenticated}',
    'password_reset_tokens_service_role_all|{service_role}',
  ],
};

function migrationFile(suffix: string): string {
  const name = readdirSync(MIGRATIONS).find((file) => file.endsWith(suffix));
  if (!name) throw new Error(`migration not found: ${suffix}`);
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

/** The SQL between "--   BEGIN;" and "--   COMMIT;" in the header of K (the ROLLBACK), with the comment marker removed. */
function rollbackSqlOfK(): string {
  const lines = migrationFile('_drop_password_auth_objects.sql').split('\n');
  const start = lines.findIndex((line) => line === '--   BEGIN;');
  const end = lines.findIndex((line, index) => index > start && line === '--   COMMIT;');
  if (start < 0 || end < 0) throw new Error('the ROLLBACK block is missing from K');
  return lines
    .slice(start + 1, end)
    .map((line) => line.replace(/^--   /, ''))
    .join('\n');
}

describeLocalDb('passkey stage 4 migrations J and K', () => {
  let admin: PgClient;
  const db = () => admin;
  beforeAll(async () => {
    // the hook runs as supabase_auth_admin; the shared test user cannot become it, so this suite opens a supabase_admin connection (local only)
    const url = new URL(LOCAL_DATABASE_URL as string);
    url.username = 'supabase_admin';
    admin = new Client({ connectionString: url.toString() }) as PgClient;
    await (admin as unknown as { connect: () => Promise<void> }).connect();
  });
  afterAll(async () => { await admin.end(); });
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function user(roleCode?: string): Promise<string> {
    const created = await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id::text as id`,
      [`passkey-stage4-${randomUUID()}@example.com`],
    );
    const id: string = created.rows[0].id;
    if (roleCode) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1, r.id, true, null from public.roles r where r.code = $2`,
        [id, roleCode],
      );
    }
    return id;
  }
  async function hook(event: unknown): Promise<any> {
    await db().query('savepoint h');
    try {
      await db().query('set local role supabase_auth_admin');
      const result = await db().query('select public.passkey_access_token_hook($1::jsonb) as r', [JSON.stringify(event)]);
      return result.rows[0].r;
    } finally {
      await db().query('rollback to savepoint h');
    }
  }
  const ev = (userId: string, method: string) => ({
    user_id: userId,
    authentication_method: method,
    claims: { aal: 'aal1', amr: [{ method, timestamp: 1 }], session_id: randomUUID() },
  });

  describe('J: the flag', () => {
    test('DATA-AUTH-013 after J the flag row is true and the column default stays false', async () => {
      const row = await db().query('select reject_customer_password as flag from private.passkey_staff_config');
      expect(row.rows).toEqual([{ flag: true }]);
      const column = await db().query(
        `select column_default from information_schema.columns
          where table_schema = 'private' and table_name = 'passkey_staff_config' and column_name = 'reject_customer_password'`,
      );
      expect(column.rows[0].column_default).toBe('false');
    });

    test('DATA-AUTH-013 a customer password login is rejected with the customer marker, not the staff marker', async () => {
      const customer = await user();
      const rejected = await hook(ev(customer, 'password'));
      expect(rejected?.error?.http_code).toBe(403);
      expect(String(rejected.error.message).startsWith(CUSTOMER_MARKER)).toBe(true);
      expect(String(rejected.error.message)).not.toContain(STAFF_MARKER);
    });

    test.each(['otp', 'magiclink', 'oauth', 'passkey', 'token_refresh'])(
      'DATA-AUTH-013 a customer %s login gets the event back unchanged while the flag is true',
      async (method) => {
        const customer = await user();
        const input = ev(customer, method);
        expect(await hook(input)).toEqual(input);
      },
    );

    test('DATA-AUTH-013 turning the flag off lets the customer password pass again, and the flag goes back to the value it started with', async () => {
      const started = (await db().query('select reject_customer_password as flag from private.passkey_staff_config')).rows[0].flag as boolean;
      const customer = await user();
      const input = ev(customer, 'password');
      try {
        await db().query('update private.passkey_staff_config set reject_customer_password = false');
        expect(await hook(input)).toEqual(input);
      } finally {
        await db().query('update private.passkey_staff_config set reject_customer_password = $1', [started]);
      }
      expect(started).toBe(true);
      expect((await hook(input))?.error?.http_code).toBe(403);
    });

    test.each([true, false])('DATA-AUTH-013 a staff password login is rejected with the staff marker whatever the flag is (flag %s)', async (flag) => {
      await db().query('update private.passkey_staff_config set reject_customer_password = $1', [flag]);
      const staff = await user('admin');
      const rejected = await hook(ev(staff, 'password'));
      expect(rejected?.error?.http_code).toBe(403);
      expect(String(rejected.error.message).startsWith(STAFF_MARKER)).toBe(true);
      expect(String(rejected.error.message)).not.toContain(CUSTOMER_MARKER);
    });
  });

  describe('K: the dropped objects', () => {
    test('DATA-AUTH-013 after K the two tables and three functions are gone, and the audit and rate-limit tables remain', async () => {
      for (const table of DROPPED_TABLES) {
        const found = await db().query('select to_regclass($1)::text as t', [`public.${table}`]);
        expect(found.rows[0].t).toBeNull();
      }
      for (const fn of DROPPED_FUNCTIONS) {
        const found = await db().query('select to_regprocedure($1)::text as f', [fn]);
        expect(found.rows[0].f).toBeNull();
      }
      for (const table of ['public.audit_logs', 'private.auth_return_intents', 'public.rate_limit_counters']) {
        const found = await db().query('select to_regclass($1)::text as t', [table]);
        expect(found.rows[0].t).toBe(table.replace(/^public\./, ''));
      }
    });

    test('DATA-AUTH-013 the ROLLBACK block of K brings back the tables and functions with the same ACL, config and policies as before K', async () => {
      // the objects belong to postgres in production; this connection is supabase_admin, so run the block as postgres
      await db().query('set local role postgres');
      await db().query(rollbackSqlOfK());
      await db().query('reset role');

      for (const table of DROPPED_TABLES) {
        const rel = await db().query(
          `select relacl::text as acl, relrowsecurity as rls, relowner::regrole::text as owner
             from pg_class where oid = to_regclass($1)`,
          [`public.${table}`],
        );
        expect(rel.rows).toEqual([{ acl: TABLE_ACL, rls: true, owner: 'postgres' }]);
        const policies = await db().query(
          `select policyname || '|' || roles::text as p from pg_policies where schemaname = 'public' and tablename = $1 order by policyname`,
          [table],
        );
        expect(policies.rows.map((row) => row.p)).toEqual(POLICIES_BEFORE_K[table]);
      }
      for (const fn of DROPPED_FUNCTIONS) {
        const proc = await db().query(
          `select proacl::text as acl, proconfig::text as config, prosecdef as secdef, proowner::regrole::text as owner
             from pg_proc where oid = to_regprocedure($1)`,
          [fn],
        );
        expect(proc.rows).toEqual([{ acl: FUNCTION_ACL, config: FUNCTION_CONFIG, secdef: true, owner: 'postgres' }]);
      }
      // anon and authenticated hold nothing on the restored tables or functions
      const grants = await db().query(
        `select count(*)::int as n from information_schema.role_table_grants
          where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
        [[...DROPPED_TABLES]],
      );
      expect(grants.rows[0].n).toBe(0);
      const fnGrants = await db().query(
        `select count(*)::int as n from information_schema.routine_privileges
          where routine_schema = 'public' and routine_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
        [['issue_password_change_challenge', 'consume_password_change_challenge', 'cleanup_password_reset_tokens']],
      );
      expect(fnGrants.rows[0].n).toBe(0);
    });
  });
});
