/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';

/**
 * 取扱店の権限 admin.stockists.read・admin.stockists.manage と初めの割り当て（DATA-STOCKIST-004）。
 * 1つのテストを1つの取引にして最後に巻き戻すので、足した利用者・店・割り当ての変更は残らない。
 */

type Claims = Record<string, unknown>;
type Outcome = { rows: any[]; rowCount: number } | { code: string };
type Role = 'anon' | 'authenticated';
type WriteShape = { insert: unknown; update: unknown; delete: unknown };

const STOCKIST_PERMISSIONS = ['admin.stockists.manage', 'admin.stockists.read'];

describeLocalDb('integration: stockist permissions', (db) => {
  let seed: string;

  beforeAll(() => {
    const directory = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g0_permissions.sql'));
    expect(files).toHaveLength(1);
    const sql = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    const match = sql.match(/^-- BEGIN G0_PERMISSION_SEED_RECONCILE\r?\n([\s\S]*?)^-- END G0_PERMISSION_SEED_RECONCILE\r?$/m);
    expect(match).not.toBeNull();
    seed = match![1];
  });
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function member(role: string | null, options: { active?: boolean; expired?: boolean; metadataRole?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', $2::text), '{}', now(), now())`,
      [id, options.metadataRole ?? role ?? 'user'],
    );
    if (role) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         select $1, id, $3, case when $4 then now() - interval '1 day' else null end
         from public.roles where code = $2
         on conflict (user_id, role_id) do update set active = excluded.active, expires_at = excluded.expires_at`,
        [id, role, options.active ?? true, options.expired ?? false],
      );
    }
    return id;
  }

  function claimsOf(id: string, appRole?: string): Claims {
    return { sub: id, role: 'authenticated', ...(appRole ? { app_metadata: { role: appRole } } : {}) };
  }

  async function grant(role: string, code: string) {
    await db().query(
      `insert into public.role_permissions (role_id, permission_id)
       select r.id, p.id from public.roles r cross join public.permissions p
       where r.code = $1 and p.code = $2
       on conflict do nothing`,
      [role, code],
    );
  }

  async function revoke(role: string, code: string) {
    await db().query(
      `delete from public.role_permissions rp
       using public.roles r, public.permissions p
       where rp.role_id = r.id and rp.permission_id = p.id and r.code = $1 and p.code = $2`,
      [role, code],
    );
  }

  async function stockistGrants(): Promise<Record<string, string[]>> {
    const res = await db().query(
      `select r.code as role, coalesce(array_agg(p.code order by p.code) filter (where p.code is not null), '{}') as codes
       from public.roles r
       left join public.role_permissions rp on rp.role_id = r.id
       left join public.permissions p on p.id = rp.permission_id and p.code = any($1::text[])
       where r.code in ('admin', 'supporter', 'user')
       group by r.code
       order by r.code`,
      [STOCKIST_PERMISSIONS],
    );
    return Object.fromEntries(res.rows.map((row) => [row.role as string, row.codes as string[]]));
  }

  async function insertStockist(status: 'published' | 'private'): Promise<number> {
    const res = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, 'address', '000-0000-0000', '11:00-18:00', 'holiday', $2)
       returning id`,
      [`permission test ${randomUUID()}`, status],
    );
    return Number(res.rows[0].id);
  }

  // PostgREST が取引ごとに入れる役と JWT のクレームを再現する。権限の誤りで取引を壊さないよう savepoint で包む
  async function attempt(role: Role, claims: Claims | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await db().query('savepoint permission_attempt');
    try {
      await db().query(`set local role ${role}`);
      if (claims) await db().query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
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

  async function permissionsOf(claims: Claims): Promise<Record<string, boolean>> {
    const outcome = await attempt('authenticated', claims,
      `select public.has_permission('admin.stockists.read') as read, public.has_permission('admin.stockists.manage') as manage`);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows[0];
  }

  async function visibleIds(claims: Claims | null, role: Role, ids: number[]): Promise<number[]> {
    const outcome = await attempt(role, claims,
      'select id from public.stockists where id = any($1::bigint[]) order by id', [ids]);
    if ('code' in outcome) throw new Error(`unexpected database error ${outcome.code}`);
    return outcome.rows.map((row) => Number(row.id));
  }

  async function writes(claims: Claims, target: number): Promise<WriteShape> {
    return {
      insert: shape(await attempt('authenticated', claims,
        `insert into public.stockists (type, name, address, phone, time, holiday, status)
         values ('STORE', 'permission insert', 'address', 'phone', 'time', 'holiday', 'private')
         returning id`)),
      update: shape(await attempt('authenticated', claims,
        "update public.stockists set name = 'permission update' where id = $1", [target])),
      delete: shape(await attempt('authenticated', claims,
        'delete from public.stockists where id = $1', [target])),
    };
  }

  test('DATA-STOCKIST-004 権限の表に admin.stockists.read（取扱店の閲覧）と admin.stockists.manage（取扱店の管理）がある', async () => {
    const res = await db().query(
      'select code, name from public.permissions where code = any($1::text[]) order by code',
      [STOCKIST_PERMISSIONS],
    );
    expect(res.rows).toEqual([
      { code: 'admin.stockists.manage', name: '取扱店の管理' },
      { code: 'admin.stockists.read', name: '取扱店の閲覧' },
    ]);
  });

  test('DATA-STOCKIST-004 手元の DB の割り当ては、店長だけが2つの権限を持ち、サポーターと一般利用者は持たない', async () => {
    expect(await stockistGrants()).toEqual({ admin: STOCKIST_PERMISSIONS, supporter: [], user: [] });
  });

  test('DATA-STOCKIST-004 初めの割り当ての手順は、崩れた割り当てを店長に2つとも付け、サポーターと一般利用者から外す形に戻す', async () => {
    for (const code of STOCKIST_PERMISSIONS) {
      await revoke('admin', code);
      await grant('supporter', code);
      await grant('user', code);
    }
    expect(await stockistGrants()).toEqual({ admin: [], supporter: STOCKIST_PERMISSIONS, user: STOCKIST_PERMISSIONS });

    await db().query(seed);

    expect(await stockistGrants()).toEqual({ admin: STOCKIST_PERMISSIONS, supporter: [], user: [] });
  });

  test('DATA-STOCKIST-004 has_permission は店長に2つとも真を返し、サポーター・一般利用者には偽を返す', async () => {
    expect(await permissionsOf(claimsOf(await member('admin')))).toEqual({ read: true, manage: true });
    expect(await permissionsOf(claimsOf(await member('supporter')))).toEqual({ read: false, manage: false });
    expect(await permissionsOf(claimsOf(await member('user')))).toEqual({ read: false, manage: false });
  });

  test('DATA-STOCKIST-004 has_permission は JWT の役ではなく ACL の割り当てだけで決め、止めた・期限切れの割り当ては数えない', async () => {
    const metadataOnly = await member(null, { metadataRole: 'admin' });
    expect(await permissionsOf(claimsOf(metadataOnly, 'admin'))).toEqual({ read: false, manage: false });
    expect(await permissionsOf(claimsOf(await member('admin', { active: false })))).toEqual({ read: false, manage: false });
    expect(await permissionsOf(claimsOf(await member('admin', { expired: true })))).toEqual({ read: false, manage: false });
    expect(await permissionsOf({ role: 'authenticated' })).toEqual({ read: false, manage: false });
  });

  test('DATA-STOCKIST-004 anon は has_permission を呼べない（42501）', async () => {
    const outcome = await attempt('anon', null, "select public.has_permission('admin.stockists.read') as read");
    expect(outcome).toEqual({ code: '42501' });
  });

  test('DATA-STOCKIST-004 admin.stockists.read を持つ人は非公開の店を読め、持たない人と anon は公開の店だけを読む', async () => {
    const published = await insertStockist('published');
    const hidden = await insertStockist('private');
    const ids = [published, hidden].sort((a, b) => a - b);

    expect(await visibleIds(claimsOf(await member('admin')), 'authenticated', ids)).toEqual(ids);
    expect(await visibleIds(claimsOf(await member('supporter')), 'authenticated', ids)).toEqual([published]);
    expect(await visibleIds(null, 'anon', ids)).toEqual([published]);
  });

  test('DATA-STOCKIST-004 店長がサポーターに admin.stockists.read だけを付けると、非公開の店を読めるが書き換えはできない', async () => {
    const published = await insertStockist('published');
    const hidden = await insertStockist('private');
    const ids = [published, hidden].sort((a, b) => a - b);
    await grant('supporter', 'admin.stockists.read');
    const reader = claimsOf(await member('supporter'));

    expect(await permissionsOf(reader)).toEqual({ read: true, manage: false });
    expect(await visibleIds(reader, 'authenticated', ids)).toEqual(ids);
    expect(await writes(reader, hidden)).toEqual({ insert: '42501', update: '42501', delete: '42501' });
  });

  test('DATA-STOCKIST-004 admin.stockists.manage を持つ店長でも、DB へ直に店を足し・直し・消すのは権限の誤り（42501）で断られる（書き込みは service role だけ）', async () => {
    const hidden = await insertStockist('private');
    const denied = { insert: '42501', update: '42501', delete: '42501' };

    expect(await writes(claimsOf(await member('admin')), hidden)).toEqual(denied);
    expect(await writes(claimsOf(await member('supporter')), hidden)).toEqual(denied);

    const res = await db().query('select name from public.stockists where id = $1', [hidden]);
    expect(res.rows).toHaveLength(1);
  });
});
