/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// These tests commit. The controller must use a disposable local database.
const supportCodes = [
  'admin.users.read', 'admin.orders.read', 'admin.orders.manage', 'admin.contact.read',
  'admin.contact.manage', 'admin.orders.return', 'admin.shipping.read', 'admin.shipping.manage',
].sort();
const fixedCodes = ['admin.permissions.manage', 'admin.users.manage'];
type Outcome = { status: 'saved'; value: any } | { status: string };

describeLocalDb('integration: G0 permissions concurrency', () => {
  // Own the restoration connection: describeLocalDb's automatic afterAll can run
  // before this suite's afterAll. Keep setup and cleanup on this separate postgres connection.
  let control: PgClient;
  const db = () => control;
  const actors = [randomUUID(), randomUUID()];
  let originalGrants: { role_id: string; permission_id: string; created_at: string }[];
  let originalRoles: { id: string; permissions_version: string }[];
  let originalUserRoles: any[];
  let catalogCodes: string[];
  let prepared = false;

  beforeAll(async () => {
    control = await connectLocalDb();
    await db().query('begin');
    try {
      await db().query('select pg_catalog.pg_advisory_xact_lock(190519,0)');
      originalRoles = (await db().query("select id,permissions_version from public.roles where code in ('admin','supporter') order by id")).rows;
      originalGrants = (await db().query(`select rp.role_id,rp.permission_id,rp.created_at::text as created_at from public.role_permissions rp
        join public.roles r on r.id=rp.role_id where r.code in ('admin','supporter') order by role_id,permission_id`)).rows;
      originalUserRoles = (await db().query(`select ur.* from public.user_roles ur
        join public.roles r on r.id=ur.role_id where r.code='admin' order by user_id,role_id`)).rows;
      // Isolate the last-admin count from all pre-existing active/expired assignments.
      await db().query("update public.user_roles set active=false where role_id=(select id from public.roles where code='admin')");
      for (const id of actors) {
        await db().query(`insert into auth.users(id,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          values($1,'{"role":"admin","g0_keep":"unchanged"}','{}',now(),now())`, [id]);
        await db().query("insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code='admin'", [id]);
      }
      catalogCodes = (await db().query('select public.admin_get_permissions($1) as result', [actors[0]])).rows[0].result.permissionCodes;
      await db().query('commit');
      prepared = true;
    } catch (error) { await db().query('rollback'); throw error; }
  });

  beforeEach(async () => {
    await db().query('begin');
    try {
      await db().query('select pg_catalog.pg_advisory_xact_lock(190519,0)');
      await db().query(`delete from public.role_permissions rp using public.roles r,public.permissions p
        where rp.role_id=r.id and rp.permission_id=p.id and r.code='supporter'
          and p.code=any($2::text[]) and not(p.code=any($1::text[]))`, [supportCodes, catalogCodes]);
      await db().query(`insert into public.role_permissions(role_id,permission_id)
        select r.id,p.id from public.roles r cross join public.permissions p
        where r.code='supporter' and p.code=any($1::text[]) on conflict do nothing`, [supportCodes]);
      for (const id of actors) {
        await db().query('update public.user_roles set active=false where user_id=$1', [id]);
        await db().query(`insert into public.user_roles(user_id,role_id,active,expires_at)
          select $1,id,true,null from public.roles where code='admin'
          on conflict(user_id,role_id) do update set active=true,expires_at=null`, [id]);
        await db().query(`update auth.users set raw_app_meta_data='{"role":"admin","g0_keep":"unchanged"}' where id=$1`, [id]);
      }
      await db().query('commit');
    } catch (error) { await db().query('rollback'); throw error; }
  });

  afterAll(async () => {
    if (!control) return;
    try {
      if (!prepared) return; // setup was rolled back in its entirety.
      await db().query('begin');
      await db().query('select pg_catalog.pg_advisory_xact_lock(190519,0)');
      // Restore by differences. Never remove the two protected admin grants.
      await db().query(`delete from public.role_permissions rp using public.roles r,public.permissions p
        where rp.role_id=r.id and rp.permission_id=p.id and r.code in ('admin','supporter')
          and not(r.code='admin' and p.code=any($2::text[]))
          and not exists(select 1 from jsonb_to_recordset($1::jsonb) as old(role_id bigint,permission_id bigint)
            where old.role_id=rp.role_id and old.permission_id=rp.permission_id)`, [JSON.stringify(originalGrants), fixedCodes]);
      for (const row of originalGrants) await db().query(`insert into public.role_permissions(role_id,permission_id,created_at)
        values($1,$2,$3) on conflict(role_id,permission_id) do update set created_at=excluded.created_at
        where public.role_permissions.created_at is distinct from excluded.created_at`, [row.role_id, row.permission_id, row.created_at]);
      for (const role of originalRoles) await db().query('update public.roles set permissions_version=$2 where id=$1', [role.id, role.permissions_version]);
      // Original assignments/metadata of other users were never replaced; restore only active flags.
      for (const row of originalUserRoles) await db().query('update public.user_roles set active=$3 where user_id=$1 and role_id=$2', [row.user_id, row.role_id, row.active]);
      for (const id of actors) await db().query('delete from auth.users where id=$1', [id]);
      // Events/requests deliberately remain append-only, isolated by random request keys.
      await db().query('commit');
    } catch (error) { await db().query('rollback'); throw error; }
    finally { await control.end(); }
  });

  async function version(): Promise<string> {
    return (await db().query("select permissions_version::text as version from public.roles where code='supporter'")).rows[0].version;
  }
  async function waitForLock(waitingPid: number, blockingPid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const observed = (await db().query(`select exists(select 1 from pg_catalog.pg_locks l
        where l.pid=$1 and l.locktype='advisory' and not l.granted)
        and $2::integer=any(pg_catalog.pg_blocking_pids($1)) as blocked`, [waitingPid, blockingPid])).rows[0].blocked;
      if (observed) return;
    }
    throw new Error('G0 advisory lock wait was not observed');
  }
  async function finish(client: PgClient, sql: string, params: unknown[]): Promise<Outcome> {
    try {
      const value = (await client.query(sql, params)).rows[0].result;
      await client.query('commit');
      return { status: 'saved', value };
    } catch (error) {
      await client.query('rollback');
      // Keep only the fixed contract symbol; never print a raw DB error.
      const symbol = (error as { message: string }).message;
      const allowed = ['ROLE_PERMISSION_VERSION_CONFLICT', 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT',
        'ROLE_PERMISSION_FORBIDDEN', 'LAST_ADMIN_REQUIRED', 'SELF_ROLE_CHANGE_FORBIDDEN'];
      return { status: allowed.includes(symbol) ? symbol : 'G0_UNEXPECTED_DB_ERROR' };
    }
  }
  async function race(firstParams: unknown[], secondParams: unknown[], userRoles = false) {
    const a = await connectLocalDb();
    let b: PgClient | undefined;
    let pending: Promise<Outcome> | undefined;
    try {
      b = await connectLocalDb();
      for (const client of [a, b]) {
        await client.query('begin');
        await client.query("set local statement_timeout='10s'");
      }
      const aPid = (await a.query('select pg_backend_pid() as pid')).rows[0].pid;
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('select pg_catalog.pg_advisory_xact_lock(190519,0)');
      await a.query('set local role service_role');
      await b.query('set local role service_role');
      const sql = userRoles ? 'select public.admin_set_user_role($1,$2,$3) as result'
        : 'select public.admin_set_role_permissions($1,$2,$3,$4,$5) as result';
      pending = finish(b, sql, secondParams);
      await waitForLock(bPid, aPid);
      const first = await finish(a, sql, firstParams);
      return [first, await pending];
    } finally {
      try { await a.query('rollback'); }
      finally {
        try { if (pending) await pending; }
        finally {
          try { if (b) await b.query('rollback'); }
          finally { await Promise.all([a.end(), b?.end()]); }
        }
      }
    }
  }

  test('serializes stale edits and duplicate requests', async () => {
    const removed = supportCodes.filter((code) => code !== 'admin.shipping.read');
    const other = supportCodes.filter((code) => code !== 'admin.shipping.manage');
    // Both arrival orders, duplicate request, and same-key/different-input.
    for (const mode of ['forward', 'reverse', 'duplicate', 'key-conflict']) {
      // Restore just these two toggles before the next scenario, without erasing history.
      await db().query(`insert into public.role_permissions(role_id,permission_id)
        select r.id,p.id from public.roles r cross join public.permissions p
        where r.code='supporter' and p.code=any($1::text[]) on conflict do nothing`, [supportCodes]);
      const startVersion = await version();
      const firstKey = randomUUID();
      const secondKey = mode === 'duplicate' || mode === 'key-conflict' ? firstKey : randomUUID();
      const firstCodes = mode === 'reverse' ? other : removed;
      const secondCodes = mode === 'duplicate' ? firstCodes : mode === 'reverse' ? removed : other;
      const results = await race([actors[0], 'supporter', firstCodes, startVersion, firstKey],
        [actors[0], 'supporter', secondCodes, startVersion, secondKey]);
      expect(results.map((r) => r.status)).toEqual(mode === 'duplicate' ? ['saved', 'saved'] :
        ['saved', mode === 'key-conflict' ? 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT' : 'ROLE_PERMISSION_VERSION_CONFLICT']);
      if (mode === 'duplicate') expect(results[1]).toEqual(results[0]);
      expect(BigInt(await version())).toBe(BigInt(startVersion) + BigInt(1));
      const snapshot = (await db().query(`select
        (select array_agg(p.code order by p.code) from public.role_permissions rp join public.roles r on r.id=rp.role_id
          join public.permissions p on p.id=rp.permission_id where r.code='supporter' and p.code=any($2::text[])) as codes,
        (select count(*)::int from public.role_permission_events where request_key=any($1::uuid[])) as events,
        (select count(*)::int from private.role_permission_requests where request_key=any($1::uuid[])) as requests`, [[firstKey, secondKey], catalogCodes])).rows[0];
      expect(snapshot).toEqual({ codes: firstCodes, events: 1, requests: 1 });
    }
  }, 60000);

  test('keeps at least one active admin and rejects self changes', async () => {
    const state = async (id: string) => (await db().query(`select raw_app_meta_data,
      (select jsonb_agg(ur order by role_id) from public.user_roles ur where user_id=$1) as acl
      from auth.users where id=$1`, [id])).rows[0];
    const before = await state(actors[0]);
    const results = await race([actors[0], actors[1], 'supporter'], [actors[1], actors[0], 'supporter'], true);
    expect(results.map((r) => r.status)).toEqual(['saved', 'ROLE_PERMISSION_FORBIDDEN']);
    expect(await state(actors[0])).toEqual(before);
    const count = (await db().query(`select count(*)::int as n from public.user_roles ur
      join public.roles r on r.id=ur.role_id where r.code='admin' and ur.active
      and (ur.expires_at is null or ur.expires_at>now())`)).rows[0].n;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBe(1);
    expect((await state(actors[1])).raw_app_meta_data).toEqual({ role: 'supporter', g0_keep: 'unchanged' });
    const a = await connectLocalDb();
    try {
      await a.query('begin');
      await a.query('set local role service_role');
      const result = await finish(a, 'select public.admin_set_user_role($1,$2,$3) as result', [actors[0], actors[0], 'user']);
      expect(result.status).toBe('LAST_ADMIN_REQUIRED');
      expect(await state(actors[0])).toEqual(before);
    } finally { await a.end(); }
  }, 30000);
});
