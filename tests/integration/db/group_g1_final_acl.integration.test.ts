/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';

/**
 * G-1 移行の末尾の確かめ（表の ACL）は意味で比べる（T14-M2）。本番の既定の権限で別の grantee が付いても通り、
 * 要る権限が欠ける・要らない権限が付くと GROUP_G_MIGRATION_ASSERTION_FAILED / table_acl で止まる。
 * 移行の文から確かめの DO を取り出し、権限を変えた取引の中で流して必ず戻す。
 */
jest.setTimeout(30000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g1_allocation.sql'));
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATION_DIRECTORY, MIGRATION_FILE[0]), 'utf8');

function finalBlock(tag: string): string {
  const assertions = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- G1_FINAL_ASSERT_BEGIN'), MIGRATION_SQL.indexOf('-- G1_FINAL_ASSERT_END'));
  const start = assertions.indexOf(`DO ${tag}`);
  const end = assertions.indexOf(`${tag};`, start + tag.length + 3);
  if (start < 0 || end < 0) throw new Error(`missing ${tag}`);
  return assertions.slice(start, end + tag.length + 1);
}

const TABLE_ACL = finalBlock('$g1_final_table_acl$');

describe('表の ACL の確かめの形（DB なし）', () => {
  test('最後の確かめの節にあり、文字列の ACL の完全一致を使わない', () => {
    expect(MIGRATION_FILE).toHaveLength(1);
    expect(TABLE_ACL).toContain('has_table_privilege');
    expect(TABLE_ACL).toContain('aclexplode');
    expect(MIGRATION_SQL).not.toMatch(/relacl::text/);
    expect(MIGRATION_SQL).not.toContain('arwdDxtm');
  });
});

describeLocalDb('G-1 Task 16: 表の ACL の確かめは意味で比べる', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function runAssertion(): Promise<{ code?: string; message?: string; detail?: string } | null> {
    await db().query('savepoint acl_assert');
    try {
      await db().query(TABLE_ACL);
      await db().query('release savepoint acl_assert');
      return null;
    } catch (error) {
      await db().query('rollback to savepoint acl_assert');
      const e = error as { code?: string; message?: string; detail?: string };
      return { code: e.code, message: e.message, detail: e.detail };
    }
  }

  const FAILED = { code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail: 'table_acl' };

  test('今の DB で通り、関係の無い grantee（本番の既定の権限に当たるもの）を足しても通る', async () => {
    expect(await runAssertion()).toBeNull();
    await db().query('create role g1_acl_probe nologin');
    for (const table of ['private.group_g_operations', 'public.order_item_allocations',
      'public.order_item_allocation_events', 'public.order_item_state_events']) {
      await db().query(`grant all on table ${table} to g1_acl_probe`);
    }
    const acl = (await db().query(`select relacl::text as acl from pg_class where oid = 'public.order_item_allocations'::regclass`)).rows[0].acl;
    expect(acl).toContain('g1_acl_probe=');
    expect(await runAssertion()).toBeNull();
  });

  test('要る権限が欠けると止まる（service_role の SELECT・所有者の権限）', async () => {
    await db().query('revoke select on table public.order_item_allocations from service_role');
    expect(await runAssertion()).toEqual(FAILED);
    await db().query('grant select on table public.order_item_allocations to service_role');
    expect(await runAssertion()).toBeNull();
    await db().query('revoke truncate on table public.order_item_state_events from postgres');
    expect(await runAssertion()).toEqual(FAILED);
  });

  test.each([
    ['service_role の書込み', 'grant insert on table public.order_item_state_events to service_role'],
    ['service_role の操作の記録の読取', 'grant select on table private.group_g_operations to service_role'],
    ['service_role の列の更新', 'grant update (reason) on table public.order_item_allocation_events to service_role'],
    ['anon の列の読取', 'grant select (id) on table public.order_item_allocations to anon'],
    ['authenticated の読取', 'grant select on table public.order_item_state_events to authenticated'],
    ['PUBLIC の読取', 'grant select on table public.order_item_allocation_events to public'],
  ])('要らない権限が付くと止まる: %s', async (_name, grant) => {
    await db().query(grant);
    expect(await runAssertion()).toEqual(FAILED);
  });

  test.each(['anon', 'authenticated', 'service_role'])('PG17 の MAINTAIN が %s に付くと止まる（PG17 より前の版では権限名が無いので見ない）', async (role) => {
    const version = Number((await db().query("select current_setting('server_version_num') as v")).rows[0].v);
    if (version < 170000) return; // MAINTAIN does not exist before PG17; the assertion skips it there too.
    expect(await runAssertion()).toBeNull();
    await db().query(`grant maintain on table public.order_item_allocations to ${role}`);
    expect(await runAssertion()).toEqual(FAILED);
  });
});
