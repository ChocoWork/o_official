import { randomUUID } from 'node:crypto';
import { createLiveAppSession, jwtClaims } from './app-session';
import type { PgClient } from './local-db';

/**
 * 管理だけが書く表（looks・look_items・news_articles・stockists・item_color_presets）の権限の試験の補助。
 * PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。呼ぶ側が begin / rollback で包む前提。
 */
export type GrantRole = 'anon' | 'authenticated' | 'service_role';
export type Claims = Record<string, unknown>;
export type Failure = { code: string; message: string };

export const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
export const ALL_PRIVILEGES = ['SELECT', ...WRITE_PRIVILEGES];

export function adminTableTools(db: () => PgClient) {
  /** 指定の役と JWT で 1 本流す。権限の誤りで取引を壊さないよう savepoint で包み、必ず元に戻す。成功は null を返す */
  async function failureAs(role: GrantRole, claims: Claims | null, sql: string, params: unknown[] = []): Promise<Failure | null> {
    await db().query('savepoint grants_attempt');
    try {
      await db().query(`set local role ${role}`);
      await db().query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : '']);
      await db().query(sql, params);
      return null;
    } catch (caught) {
      const error = caught as { code?: string; message?: string };
      return { code: error.code ?? 'unknown', message: error.message ?? '' };
    } finally {
      await db().query('rollback to savepoint grants_attempt');
      await db().query('release savepoint grants_attempt');
    }
  }

  /** 指定の役と JWT で読んだ行を返す。失敗は投げる。読んだ後は元に戻す */
  async function rowsAs(role: GrantRole, claims: Claims | null, sql: string, params: unknown[] = []) {
    await db().query('savepoint grants_read');
    try {
      await db().query(`set local role ${role}`);
      await db().query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : '']);
      const result = await db().query(sql, params);
      return result.rows;
    } finally {
      await db().query('rollback to savepoint grants_read');
      await db().query('release savepoint grants_read');
    }
  }

  /** 表単位で持っている権限を、並び順を決めて返す */
  async function privileges(role: string, relation: string, list: string[] = ALL_PRIVILEGES): Promise<string[]> {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege) order by privilege`,
      [role, `public.${relation}`, list],
    );
    return result.rows.map((row) => row.privilege as string);
  }

  /** 列単位の書き込み系の権限を 1 列でも持っているか */
  async function columnWritePrivileges(role: string, relation: string): Promise<Record<string, boolean>> {
    const result = await db().query(
      `select has_any_column_privilege($1::name, $2::regclass, 'INSERT') as column_insert,
              has_any_column_privilege($1::name, $2::regclass, 'UPDATE') as column_update,
              has_any_column_privilege($1::name, $2::regclass, 'REFERENCES') as column_references`,
      [role, `public.${relation}`],
    );
    return result.rows[0];
  }

  /**
   * manage の権限を持つ管理者（店長の役）を作る。has_permission は aal2 とアプリに結び付いた生きた session を求める
   * （SEC-AUTH-010-AC-03）ので、session を作って aal2 と session_id を入れ、管理者の窓口と同じ入り口を再現する
   */
  async function insertAdmin(): Promise<Claims> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', 'admin'), '{}', now(), now())`,
      [id],
    );
    await db().query(
      `insert into public.user_roles (user_id, role_id, active)
       select $1, id, true from public.roles where code = 'admin'
       on conflict (user_id, role_id) do update set active = true, expires_at = null`,
      [id],
    );
    return jwtClaims(id, await createLiveAppSession(db(), id));
  }

  /** 権限を何も持たない一般会員（ログイン済み、aal1）を作り、その JWT のクレームを返す。DB の `auth.uid()` が NULL にならない形で公開の読みを確かめる */
  async function insertMember(): Promise<Claims> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '{}'::jsonb, '{}', now(), now())`,
      [id],
    );
    return { sub: id, role: 'authenticated', aal: 'aal1' };
  }

  /** 権限の誤り（RLS の違反ではなく、表の権限が無い）であることを示す文言か */
  const isPermissionDenied = (failure: Failure | null, relation: string) =>
    failure !== null && failure.code === '42501' && failure.message === `permission denied for table ${relation}`;

  return { failureAs, rowsAs, privileges, columnWritePrivileges, insertAdmin, insertMember, isPermissionDenied };
}
