import fs from 'node:fs';
import path from 'node:path';

/**
 * 波 6 の移行 M3 `sec_password_change_challenges`（DATA-AUTH-009・010、ADR-0421）の文面を、DB なしで確かめる。
 */

const SUFFIX = 'sec_password_change_challenges';

function findMigration(): string {
  const pattern = new RegExp(`^\\d{14}_${SUFFIX}\\.sql$`);
  const hits: string[] = [];
  for (const dir of ['supabase/migrations']) {
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
  { name: 'public.issue_password_change_challenge', args: 'uuid\\s*,\\s*uuid\\s*,\\s*text\\s*,\\s*integer' },
  { name: 'public.consume_password_change_challenge', args: 'uuid\\s*,\\s*uuid\\s*,\\s*text' },
] as const;

function functionHeader(name: string): string {
  const match = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i').exec(sql);
  if (!match) throw new Error(`function ${name} not created with CREATE OR REPLACE`);
  const rest = sql.slice(match.index);
  const bodyStart = rest.search(/\bas\s+\$/i);
  return bodyStart === -1 ? rest : rest.slice(0, bodyStart);
}

function functionBody(name: string): string {
  const match = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${name.replace('.', '\\.')}[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'i').exec(sql);
  return match?.[1] ?? '';
}

describe('DATA-AUTH-009 移行 sec_password_change_challenges の表の文面', () => {
  test('DATA-AUTH-009 BEGIN と COMMIT が 1 組で、NOTIFY pgrst が 1 回', () => {
    expect(sql.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(sql.match(/NOTIFY\s+pgrst\s*,\s*'reload schema'/gi)).toHaveLength(1);
  });

  test('DATA-AUTH-009 表は IF NOT EXISTS なしの CREATE TABLE（想定外の既存を黙らせない）', () => {
    expect(sql).toMatch(/CREATE\s+TABLE\s+public\.password_change_challenges\s*\(/i);
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
  });

  test('DATA-AUTH-009 user_id は auth.users を指す外部キーで ON DELETE CASCADE', () => {
    expect(sql).toMatch(/user_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+auth\.users\s*\(id\)\s+ON\s+DELETE\s+CASCADE/i);
  });

  test('DATA-AUTH-009 列の型と NOT NULL・既定値', () => {
    expect(sql).toMatch(/\bid\s+uuid\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
    expect(sql).toMatch(/\bauth_session_id\s+uuid\s+NOT\s+NULL/i);
    expect(sql).toMatch(/\bcode_hash\s+text\s+NOT\s+NULL/i);
    expect(sql).toMatch(/\battempts\s+smallint\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(sql).toMatch(/\bexpires_at\s+timestamptz\s+NOT\s+NULL/i);
    expect(sql).toMatch(/\bused_at\s+timestamptz\s*(,|\n)/i);
    expect(sql).toMatch(/\bcreated_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
  });

  test('DATA-AUTH-009 平文のコードを置く列が無い（code_hash だけ）', () => {
    const table = /CREATE\s+TABLE\s+public\.password_change_challenges\s*\(([\s\S]*?)\n\)\s*;/i.exec(sql)?.[1] ?? '';
    expect(table).not.toMatch(/\bcode\s+(text|varchar|char|integer|int)/i);
    expect(table).toMatch(/code_hash/);
  });

  test('DATA-AUTH-009 未使用の行の部分索引', () => {
    const index = /CREATE\s+INDEX\s+password_change_challenges_open_idx\s+ON\s+public\.password_change_challenges\s*\(user_id\)\s*WHERE\s+([^;]+);/i.exec(sql);
    expect(index).not.toBeNull();
    expect(index?.[1]).toMatch(/used_at\s+IS\s+NULL/i);
  });

  test('DATA-AUTH-009 RLS を有効にし、anon・authenticated の全拒否と service_role の許可の方針を持つ', () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.password_change_challenges\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*;/i);
    const policies = sql.match(/CREATE\s+POLICY\s+"?[\w ]+"?\s+ON\s+public\.password_change_challenges[\s\S]*?;/gi) ?? [];
    expect(policies).toHaveLength(3);
    const anon = policies.find((policy) => /TO\s+anon/i.test(policy)) ?? '';
    const authenticated = policies.find((policy) => /TO\s+authenticated/i.test(policy)) ?? '';
    const serviceRole = policies.find((policy) => /TO\s+service_role/i.test(policy)) ?? '';
    for (const policy of [anon, authenticated]) {
      expect(policy).toMatch(/FOR\s+ALL/i);
      expect(policy).toMatch(/USING\s*\(\s*false\s*\)/i);
      expect(policy).toMatch(/WITH\s+CHECK\s*\(\s*false\s*\)/i);
    }
    expect(serviceRole).toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  test('DATA-AUTH-009 表の権限は PUBLIC・anon・authenticated から REVOKE し、service_role に 4 操作だけ GRANT する', () => {
    const revoke = /REVOKE\s+ALL\s+ON\s+(?:TABLE\s+)?public\.password_change_challenges\s+FROM\s+([^;]+);/i.exec(sql);
    expect(revoke).not.toBeNull();
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(revoke?.[1]).toMatch(new RegExp(`\\b${role}\\b`, 'i'));
    }
    const grant = /GRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+)?public\.password_change_challenges\s+TO\s+([^;]+);/i.exec(sql);
    expect(grant?.[2].trim()).toBe('service_role');
    expect(grant?.[1].split(',').map((privilege) => privilege.trim().toUpperCase()).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});

describe('DATA-AUTH-010 移行 sec_password_change_challenges の関数の文面', () => {
  test.each(FUNCTIONS)("DATA-AUTH-010 $name は CREATE OR REPLACE FUNCTION で SECURITY DEFINER・SET search_path = ''", ({ name }) => {
    const header = functionHeader(name);
    expect(header).toMatch(/\bSECURITY\s+DEFINER\b/i);
    expect(header).toMatch(/\bSET\s+search_path\s*=\s*''/i);
  });

  test('DATA-AUTH-010 OR REPLACE の無い CREATE FUNCTION を使わない', () => {
    expect(sql).not.toMatch(/\bCREATE\s+FUNCTION\b/i);
  });

  test.each(FUNCTIONS)('DATA-AUTH-010 $name は PUBLIC・anon・authenticated から REVOKE し、service_role だけに GRANT する', ({ name, args }) => {
    const escaped = name.replace('.', '\\.');
    const revoke = new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${escaped}\\s*\\(\\s*${args}\\s*\\)\\s+FROM\\s+([^;]+);`, 'i').exec(sql);
    expect(revoke).not.toBeNull();
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(revoke?.[1]).toMatch(new RegExp(`\\b${role}\\b`, 'i'));
    }
    const grant = new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${escaped}\\s*\\(\\s*${args}\\s*\\)\\s+TO\\s+([^;]+);`, 'i').exec(sql);
    expect(grant?.[1].trim()).toBe('service_role');
  });

  test('DATA-AUTH-010 anon・authenticated に GRANT せず、ALTER DEFAULT PRIVILEGES を使わない', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated)\b/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  test('DATA-AUTH-010 issue は未使用の行を無効にし、1 日より古い行を消し、新しい行を入れ、TTL を 60..900 に制限する', () => {
    const body = functionBody('public.issue_password_change_challenge');
    expect(body).toMatch(/UPDATE\s+public\.password_change_challenges\s+SET\s+used_at\s*=\s*pg_catalog\.now\(\)/i);
    expect(body).toMatch(/used_at\s+IS\s+NULL/i);
    expect(body).toMatch(/DELETE\s+FROM\s+public\.password_change_challenges/i);
    expect(body).toMatch(/interval\s+'1 day'/i);
    expect(body).toMatch(/INSERT\s+INTO\s+public\.password_change_challenges/i);
    expect(body).toMatch(/p_ttl_seconds\s*<\s*60\s+OR\s+p_ttl_seconds\s*>\s*900/i);
    expect(body).toMatch(/RETURNING\s+id/i);
  });

  test('DATA-AUTH-010 issue は同じ利用者の発行を直列にする（取引内の助言ロック）', () => {
    expect(functionBody('public.issue_password_change_challenge')).toMatch(/pg_advisory_xact_lock/i);
  });

  test('DATA-AUTH-010 issue は code_hash が hex 64 桁でなければ断る（平文を置かせない）', () => {
    expect(functionBody('public.issue_password_change_challenge')).toMatch(/p_code_hash\s*!~\s*'\^\[0-9a-f\]\{64\}\$'/i);
  });

  test('DATA-AUTH-010 consume は行を FOR UPDATE で取り、ok / invalid / locked / none を返す', () => {
    const body = functionBody('public.consume_password_change_challenge');
    expect(body).toMatch(/FOR\s+UPDATE/i);
    for (const value of ['ok', 'invalid', 'locked', 'none']) {
      expect(body).toContain(`'${value}'`);
    }
    expect(body).toMatch(/attempts\s*>=\s*5/i);
    expect(body).toMatch(/attempts\s*=\s*attempts\s*\+\s*1/i);
    expect(body).toMatch(/used_at\s*=\s*pg_catalog\.now\(\)/i);
  });

  test('DATA-AUTH-010 consume は利用者・auth_session_id・未使用・期限内で行を絞る（別の session は none）', () => {
    const body = functionBody('public.consume_password_change_challenge');
    expect(body).toMatch(/user_id\s*=\s*p_user_id/i);
    expect(body).toMatch(/auth_session_id\s*=\s*p_auth_session_id/i);
    expect(body).toMatch(/used_at\s+IS\s+NULL/i);
    expect(body).toMatch(/expires_at\s*>\s*pg_catalog\.now\(\)/i);
  });
});

describe('DATA-AUTH-009 移行 sec_password_change_challenges の自己検査とヘッダー', () => {
  test('DATA-AUTH-009 末尾の自己検査は SEC_WAVE6_MIGRATION_ASSERTION_FAILED（55000）で落とす', () => {
    expect(sql).toMatch(/RAISE\s+EXCEPTION\s+'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'\s+USING\s+ERRCODE\s*=\s*'55000'/i);
  });

  test('DATA-AUTH-009 BEGIN の前のヘッダーに ROLLBACK の節と本番の事前の読み取りを持つ', () => {
    const header = raw.slice(0, raw.search(/^BEGIN;/m));
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/DROP TABLE IF EXISTS public\.password_change_challenges/);
    expect(header).toMatch(/BEFORE applying to production/i);
    expect(header).toMatch(/to_regclass\('public\.password_change_challenges'\)/);
    for (const { name } of FUNCTIONS) {
      expect(header).toContain(name);
    }
  });

  test('DATA-AUTH-009 既存の表・関数・方針には触れない', () => {
    expect(sql).not.toMatch(/has_permission/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+public\.(?!password_change_challenges)/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|FUNCTION|POLICY)/i);
  });
});
