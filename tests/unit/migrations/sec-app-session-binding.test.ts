import fs from 'node:fs';
import path from 'node:path';

/**
 * 波 5 の移行 M1 `sec_app_session_binding`（DATA-AUTH-007、ADR-0417）の文面を、DB なしで確かめる。
 * 移行は `supabase/pending-wave5/` にあり、controller が `supabase/migrations/` へ動かす。
 * どちらにあっても読めるようにして、動かした後も同じ試験が通る。
 */

const SUFFIX = 'sec_app_session_binding';

function findMigration(): string {
  const pattern = new RegExp(`^\\d{14}_${SUFFIX}\\.sql$`);
  const hits: string[] = [];
  for (const dir of ['supabase/migrations', 'supabase/pending-wave5']) {
    const absolute = path.join(process.cwd(), dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute)) {
      if (pattern.test(name)) hits.push(path.join(absolute, name));
    }
  }
  if (hits.length !== 1) {
    throw new Error(`migration ${SUFFIX}: expected exactly one file, found ${hits.length}`);
  }
  return hits[0];
}

const raw = fs.readFileSync(findMigration(), 'utf8');
/** コメントを外した本文（コメント内の語を拾わないため） */
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

const FUNCTIONS = [
  'private.app_session_is_live',
  'public.is_app_session_active',
  'private.is_app_bound_live_session',
] as const;

function functionHeader(name: string): string {
  const match = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!match) throw new Error(`function ${name} not created with CREATE OR REPLACE`);
  const rest = sql.slice(match.index);
  const bodyStart = rest.search(/\bas\s+\$/i);
  return bodyStart === -1 ? rest : rest.slice(0, bodyStart);
}

describe('DATA-AUTH-007 移行 sec_app_session_binding の文面', () => {
  test('DATA-AUTH-007 BEGIN と COMMIT が 1 組で、NOTIFY pgrst が 1 回', () => {
    expect(sql.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(sql.match(/NOTIFY\s+pgrst\s*,\s*'reload schema'/gi)).toHaveLength(1);
  });

  test('DATA-AUTH-007 列は auth_session_id uuid の追加で、IF NOT EXISTS を付けない（想定外の既存を黙らせない）', () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.sessions\s+ADD\s+COLUMN\s+auth_session_id\s+uuid\s*;/i);
    expect(sql).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
  });

  test('DATA-AUTH-007 索引は部分索引で、一意にしない（更新の間は同じ id の生きた行が 2 本並ぶ）', () => {
    const index = /CREATE\s+(UNIQUE\s+)?INDEX\s+sessions_auth_session_id_live_idx\s+ON\s+public\.sessions\s*\(auth_session_id\)\s*WHERE\s+([^;]+);/i.exec(
      sql,
    );
    expect(index).not.toBeNull();
    expect(index?.[1]).toBeUndefined();
    expect(index?.[2]).toMatch(/revoked_at\s+IS\s+NULL/i);
    expect(index?.[2]).toMatch(/auth_session_id\s+IS\s+NOT\s+NULL/i);
  });

  test.each(FUNCTIONS)('DATA-AUTH-007 %s は CREATE OR REPLACE FUNCTION で SECURITY DEFINER・SET search_path = \'\'', (name) => {
    const header = functionHeader(name);
    expect(header).toMatch(/\bSECURITY\s+DEFINER\b/i);
    expect(header).toMatch(/\bSET\s+search_path\s*=\s*''/i);
  });

  test('DATA-AUTH-007 OR REPLACE の無い CREATE FUNCTION を使わない', () => {
    expect(sql).not.toMatch(/\bCREATE\s+FUNCTION\b/i);
  });

  test.each(FUNCTIONS)('DATA-AUTH-007 %s は PUBLIC と anon から EXECUTE を REVOKE する', (name) => {
    const revoke = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\([^)]*\\)\\s+FROM\\s+([^;]+);`, 'i').exec(sql);
    expect(revoke).not.toBeNull();
    expect(revoke?.[1]).toMatch(/\bPUBLIC\b/i);
    expect(revoke?.[1]).toMatch(/\banon\b/i);
  });

  test('DATA-AUTH-007 private.app_session_is_live は service_role からも REVOKE し、誰にも GRANT しない', () => {
    const revoke = /REVOKE\s+ALL\s+ON\s+FUNCTION\s+private\.app_session_is_live\s*\(uuid\)\s+FROM\s+([^;]+);/i.exec(sql);
    expect(revoke?.[1]).toMatch(/\bauthenticated\b/i);
    expect(revoke?.[1]).toMatch(/\bservice_role\b/i);
    expect(sql).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+private\.app_session_is_live/i);
  });

  test('DATA-AUTH-007 public.is_app_session_active は service_role だけに GRANT する', () => {
    const grant = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.is_app_session_active\s*\(uuid\)\s+TO\s+([^;]+);/i.exec(sql);
    expect(grant?.[1].trim()).toBe('service_role');
  });

  test('DATA-AUTH-007 private.is_app_bound_live_session は authenticated と service_role だけに GRANT する', () => {
    const grant = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+private\.is_app_bound_live_session\s*\(\)\s+TO\s+([^;]+);/i.exec(sql);
    expect(grant?.[1].split(',').map((role) => role.trim()).sort()).toEqual(['authenticated', 'service_role']);
  });

  test('DATA-AUTH-007 生存の判定は expires_at を見ず、auth.sessions の not_after と revoked_at だけを見る', () => {
    const body = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.app_session_is_live[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(sql)?.[1] ?? '';
    expect(body).toMatch(/auth\.sessions/i);
    expect(body).toMatch(/not_after/i);
    expect(body).toMatch(/revoked_at\s+IS\s+NULL/i);
    expect(body).not.toMatch(/expires_at/i);
  });

  test('DATA-AUTH-007 JWT の session_id は形を正規表現で確かめてから uuid にキャストする', () => {
    const body = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.is_app_bound_live_session[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(sql)?.[1] ?? '';
    expect(body).toMatch(/!~\*/);
    expect(body.indexOf('!~*')).toBeLessThan(body.indexOf('::uuid'));
  });

  test('DATA-AUTH-007 has_permission と方針には触れず、ALTER DEFAULT PRIVILEGES を使わない', () => {
    expect(sql).not.toMatch(/has_permission/i);
    expect(sql).not.toMatch(/\bPOLICY\b/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  test('DATA-AUTH-007 public.is_auth_session_active（G-2 の ACL 一覧）は変えない', () => {
    expect(sql).not.toMatch(/is_auth_session_active/i);
  });

  test('DATA-AUTH-007 末尾の自己検査は SEC_WAVE5_MIGRATION_ASSERTION_FAILED（55000）で落とす', () => {
    expect(sql).toMatch(/RAISE\s+EXCEPTION\s+'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'\s+USING\s+ERRCODE\s*=\s*'55000'/i);
  });

  test('DATA-AUTH-007 BEGIN の前のヘッダーに ROLLBACK の節を持つ', () => {
    const header = raw.slice(0, raw.search(/^BEGIN;/m));
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/DROP COLUMN auth_session_id/);
    for (const name of FUNCTIONS) {
      expect(header).toContain(name);
    }
  });
});
