/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';

/**
 * 波1 Task 3（K-3）。実行は controller の使い捨てローカル DB に限る。
 * roles が無いリセット直後にも対応し、各試験の変更は取引を戻して残さない。
 */
describeLocalDb('integration: 監査ログを読む権限の付与', (db) => {
  let migrationSql: string;

  beforeAll(() => {
    // 本番適用時の改名に備え、時刻ではなく後ろの名前で移行を探す。
    const directory = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('_audit_read_permission.sql'));
    expect(files).toHaveLength(1);
    const migration = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    const transaction = migration.match(/^BEGIN;([\s\S]*?)^COMMIT;/m);
    expect(transaction).not.toBeNull();
    // 外側の BEGIN/COMMIT は流さず、中身をすべて実行して意図しない削除も検出する。
    migrationSql = transaction![1];
  });

  beforeEach(async () => {
    await db().query('begin');
    await db().query(
      `insert into public.roles (code, name)
       values ('admin', '店長'), ('supporter', 'サポート'), ('user', '利用者')
       on conflict (code) do nothing`,
    );
    // 既に移行済みの DB でも、権限の無い初期状態をこの取引内だけ再現する。
    await db().query(
      `delete from public.role_permissions
       where permission_id in (select id from public.permissions where code = 'admin.audit.read')`,
    );
    await db().query("delete from public.permissions where code = 'admin.audit.read'");
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function auditGrants() {
    const result = await db().query(
      `select r.code as role_code, p.code as permission_code, p.name as permission_name
       from public.role_permissions as rp
       join public.roles as r on r.id = rp.role_id
       join public.permissions as p on p.id = rp.permission_id
       where p.code = 'admin.audit.read'
       order by r.code`,
    );
    return result.rows;
  }

  const adminGrant = {
    role_code: 'admin', permission_code: 'admin.audit.read', permission_name: '監査ログの閲覧',
  };

  test('権限を登録し、admin だけに付けて supporter・user には付けない', async () => {
    await db().query(migrationSql);

    expect(await auditGrants()).toEqual([adminGrant]);
    const permission = await db().query(
      "select code, name from public.permissions where code = 'admin.audit.read'",
    );
    expect(permission.rows).toEqual([{ code: 'admin.audit.read', name: '監査ログの閲覧' }]);
  });

  test('二度実行しても権限と役割への付与は各1件のまま変わらない', async () => {
    await db().query(migrationSql);
    expect(await auditGrants()).toEqual([adminGrant]);

    await db().query(migrationSql);

    expect(await auditGrants()).toEqual([adminGrant]);
    const counts = await db().query(
      `select
         (select count(*)::int from public.permissions where code = 'admin.audit.read') as permissions,
         (select count(*)::int from public.role_permissions as rp
          join public.permissions as p on p.id = rp.permission_id
          where p.code = 'admin.audit.read') as role_permissions`,
    );
    expect(counts.rows).toEqual([{ permissions: 1, role_permissions: 1 }]);
  });

  test('既存の権限名を更新し、他役割の既存付与と別権限の付与を消さない', async () => {
    await db().query(
      `insert into public.permissions (code, name)
       values ('admin.audit.read', '以前の名前'), ('test.audit_read.preserved', '保存する試験権限')
       on conflict (code) do update set name = excluded.name`,
    );
    await db().query(
      `insert into public.role_permissions (role_id, permission_id)
       select r.id, p.id from public.roles as r
       cross join public.permissions as p
       where (p.code = 'admin.audit.read' and r.code in ('supporter', 'user'))
          or (p.code = 'test.audit_read.preserved' and r.code in ('admin', 'supporter', 'user'))
       on conflict do nothing`,
    );

    await db().query(migrationSql);
    await db().query(migrationSql);

    expect(await auditGrants()).toEqual([
      adminGrant,
      { role_code: 'supporter', permission_code: 'admin.audit.read', permission_name: '監査ログの閲覧' },
      { role_code: 'user', permission_code: 'admin.audit.read', permission_name: '監査ログの閲覧' },
    ]);
    const preserved = await db().query(
      `select r.code as role_code from public.role_permissions as rp
       join public.roles as r on r.id = rp.role_id
       join public.permissions as p on p.id = rp.permission_id
       where p.code = 'test.audit_read.preserved' order by r.code`,
    );
    expect(preserved.rows).toEqual([{ role_code: 'admin' }, { role_code: 'supporter' }, { role_code: 'user' }]);
  });
});
