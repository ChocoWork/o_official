/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';

/**
 * ADMIN の監査ログの表 audit_logs（DATA-ADMIN-003）。
 * 手元の使い捨て DB でだけ流す。各試験は取引の中で動かし、最後に巻き戻して足した行を残さない。
 */
describeLocalDb('integration: ADMIN の監査ログの表', (db) => {
  beforeEach(async () => {
    await db().query('begin');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertLog(
    action: string,
    extra: { actorId?: string | null; metadata?: string } = {},
  ): Promise<string> {
    const result = await db().query(
      `insert into public.audit_logs (action, outcome, resource, resource_id, actor_id, actor_email, detail, ip, user_agent, metadata)
       values ($1, 'success', 'users', 'target-1', $2, 'admin@example.com', 'detail text', '203.0.113.5', 'jest', $3::jsonb)
       returning id::text as id`,
      [action, extra.actorId ?? null, extra.metadata ?? '{"key":"value"}'],
    );
    return result.rows[0].id;
  }

  /** 失敗が取引全体を壊さないよう、savepoint の中で役を替えて流し、SQLSTATE を返す。 */
  async function failureAs(role: string, sql: string, params: unknown[] = []): Promise<string | undefined> {
    await db().query('savepoint expected_failure');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      await db().query(sql, params);
      return undefined;
    } catch (caught) {
      return (caught as { code?: string }).code;
    } finally {
      await db().query('rollback to savepoint expected_failure');
    }
  }

  /** 指定した役のまま流した文の行の数を返す。RLS が行を隠す・断るかを確かめる。 */
  async function rowCountAs(role: string, sql: string, params: unknown[] = []): Promise<number> {
    await db().query('savepoint as_role');
    try {
      await db().query("select set_config('request.jwt.claims', '', true)");
      await db().query(`set local role ${role}`);
      const result = await db().query(sql, params);
      return result.rowCount;
    } finally {
      await db().query('rollback to savepoint as_role');
    }
  }

  test('DATA-ADMIN-003 列は12本で、型と NOT NULL が設計どおり', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'audit_logs' order by column_name`,
    );

    const actual = Object.fromEntries(
      result.rows.map((row: { column_name: string; data_type: string; is_nullable: string }) => [
        row.column_name,
        `${row.data_type} ${row.is_nullable === 'NO' ? 'not null' : 'null'}`,
      ]),
    );
    expect(actual).toEqual({
      id: 'uuid not null',
      created_at: 'timestamp with time zone not null',
      action: 'text not null',
      outcome: 'text not null',
      actor_id: 'uuid null',
      actor_email: 'text null',
      resource: 'text null',
      resource_id: 'text null',
      detail: 'text null',
      ip: 'text null',
      user_agent: 'text null',
      metadata: 'jsonb null',
    });
  });

  test('DATA-ADMIN-003 操作と結果だけで作ると、id と作った時刻に初めの値が入り、ほかの列は空', async () => {
    const result = await db().query(
      `insert into public.audit_logs (action, outcome) values ('integration_admin_audit_minimal', 'success')
       returning id::text as id, created_at = now() as created_now, actor_id, actor_email, resource, resource_id,
                 detail, ip, user_agent, metadata`,
    );

    const row = result.rows[0];
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({
      created_now: true,
      actor_id: null,
      actor_email: null,
      resource: null,
      resource_id: null,
      detail: null,
      ip: null,
      user_agent: null,
      metadata: null,
    });
  });

  test('DATA-ADMIN-003 操作の無い作成は NOT NULL の違反で落ちる', async () => {
    const code = await failureAs('service_role', `insert into public.audit_logs (outcome) values ('success')`);

    expect(code).toBe('23502');
  });

  test('DATA-ADMIN-003 結果の無い作成は NOT NULL の違反で落ちる', async () => {
    const code = await failureAs(
      'service_role',
      `insert into public.audit_logs (action) values ('integration_admin_audit')`,
    );

    expect(code).toBe('23502');
  });

  test('DATA-ADMIN-003 操作した人の id が空でも、強制失効の認可の失敗のように1行残せる', async () => {
    const id = await insertLog('integration_admin_audit_no_actor', { actorId: null });

    const result = await db().query('select actor_id from public.audit_logs where id = $1', [id]);
    expect(result.rows).toEqual([{ actor_id: null }]);
  });

  test('DATA-ADMIN-003 付帯の情報は jsonb の入れ子のまま保存して読み戻せる', async () => {
    const id = await insertLog('integration_admin_audit_metadata', {
      metadata: '{"changes":{"role":["user","admin"]},"count":2}',
    });

    const result = await db().query('select metadata from public.audit_logs where id = $1', [id]);
    expect(result.rows[0].metadata).toEqual({ changes: { role: ['user', 'admin'] }, count: 2 });
  });

  test('DATA-ADMIN-003 主キーは id で、同じ id の2行目は一意の違反で落ちる', async () => {
    const id = await insertLog('integration_admin_audit_pk');

    const code = await failureAs(
      'service_role',
      `insert into public.audit_logs (id, action, outcome) values ($1, 'integration_admin_audit_dup', 'success')`,
      [id],
    );

    expect(code).toBe('23505');
  });

  test('DATA-ADMIN-003 索引は操作と作った時刻にある', async () => {
    const result = await db().query(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'audit_logs'`,
    );

    const byName = Object.fromEntries(
      result.rows.map((row: { indexname: string; indexdef: string }) => [row.indexname, row.indexdef]),
    );
    expect(byName.audit_logs_pkey).toContain('(id)');
    expect(byName.audit_logs_action_idx).toContain('(action)');
    expect(byName.audit_logs_created_at_idx).toContain('(created_at)');
  });

  test('DATA-ADMIN-003 行の hash の列も、書き換えと消去を検知するトリガーも無い', async () => {
    const columns = await db().query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'audit_logs' and column_name ilike '%hash%'`,
    );
    const triggers = await db().query(
      `select tgname from pg_trigger where tgrelid = 'public.audit_logs'::regclass and not tgisinternal`,
    );

    expect(columns.rows).toEqual([]);
    expect(triggers.rows).toEqual([]);
  });

  test('DATA-ADMIN-003 行の保護（RLS）が有効になっている', async () => {
    const result = await db().query(`select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass`);

    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  test.each(['anon', 'authenticated'])('DATA-ADMIN-003 %s は行を1件も読めない', async (role) => {
    await insertLog('integration_admin_audit_hidden');

    const count = await rowCountAs(role, 'select id from public.audit_logs');

    expect(count).toBe(0);
  });

  test.each(['anon', 'authenticated'])('DATA-ADMIN-003 %s は行を足せず、方針の違反で落ちる', async (role) => {
    const code = await failureAs(
      role,
      `insert into public.audit_logs (action, outcome) values ('integration_admin_audit_denied', 'success')`,
    );

    expect(code).toBe('42501');
  });

  test.each(['anon', 'authenticated'])('DATA-ADMIN-003 %s は行を書き換えられず消せず、どちらも0件のまま', async (role) => {
    const id = await insertLog('integration_admin_audit_immutable');

    const updated = await rowCountAs(role, `update public.audit_logs set outcome = 'failure' where id = $1`, [id]);
    const deleted = await rowCountAs(role, 'delete from public.audit_logs where id = $1', [id]);

    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    const row = await db().query('select outcome from public.audit_logs where id = $1', [id]);
    expect(row.rows).toEqual([{ outcome: 'success' }]);
  });

  test('DATA-ADMIN-003 service_role は行を読め、足せる', async () => {
    const id = await insertLog('integration_admin_audit_service_read');

    const readable = await rowCountAs('service_role', 'select id from public.audit_logs where id = $1', [id]);
    const inserted = await rowCountAs(
      'service_role',
      `insert into public.audit_logs (action, outcome) values ('integration_admin_audit_service', 'success')`,
    );

    expect(readable).toBe(1);
    expect(inserted).toBe(1);
  });

  test('DATA-ADMIN-003 service_role は行を書き換えられ、消せる（掃除の部品が使う）', async () => {
    const id = await insertLog('integration_admin_audit_service_write');

    const updated = await rowCountAs('service_role', `update public.audit_logs set outcome = 'failure' where id = $1`, [id]);
    const deleted = await rowCountAs('service_role', 'delete from public.audit_logs where id = $1', [id]);

    expect(updated).toBe(1);
    expect(deleted).toBe(1);
  });

  test('DATA-ADMIN-003 古い行だけを作った時刻で選んで消すと、新しい行は残る', async () => {
    const action = `integration_admin_audit_${randomUUID()}`;
    const oldId = await insertLog(action);
    const newId = await insertLog(action);
    await db().query(`update public.audit_logs set created_at = now() - interval '400 days' where id = $1`, [oldId]);

    await db().query("select set_config('request.jwt.claims', '', true)");
    await db().query('set local role service_role');
    let deletedCount: number;
    try {
      const deleted = await db().query(
        `delete from public.audit_logs where action = $1 and created_at < now() - interval '365 days'`,
        [action],
      );
      deletedCount = deleted.rowCount;
    } finally {
      await db().query('reset role');
    }

    expect(deletedCount).toBe(1);
    const remaining = await db().query('select id::text as id from public.audit_logs where action = $1', [action]);
    expect(remaining.rows).toEqual([{ id: newId }]);
  });
});
