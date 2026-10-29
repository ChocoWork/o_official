import fs from 'node:fs';
import path from 'node:path';

/**
 * 波 5 の移行 M2 `sec_has_permission_aal2_member_rls`（DATA-AUTH-008、ADR-0418）の文面を、DB なしで確かめる。
 * 移行は `supabase/pending-wave5/` にあり、controller が `supabase/migrations/` へ動かす。
 * どちらにあっても読めるようにして、動かした後も同じ試験が通る。
 */

const SUFFIX = 'sec_has_permission_aal2_member_rls';
const G0_FILE = 'supabase/migrations/20261023175712_group_g0_permissions.sql';
const MEMBER_TABLES = ['profiles', 'orders', 'order_items'] as const;

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

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 関数の本体（`$function$` の間）。G-0 の移行と新しい移行の両方から取る */
function hasPermissionBody(source: string): string {
  const match = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.has_permission\s*\([\s\S]*?\$function\$([\s\S]*?)\$function\$/i.exec(source);
  if (!match) throw new Error('has_permission body not found');
  return match[1];
}

/** `CREATE OR REPLACE FUNCTION public.has_permission (` から閉じの `$function$;` まで */
function hasPermissionStatement(source: string): string {
  const match = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.has_permission\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$\s*;/i.exec(source);
  if (!match) throw new Error('has_permission statement not found');
  return match[0];
}

function aclExists(body: string): string {
  const match = /SELECT\s+EXISTS\s*\([\s\S]*?\)\s+INTO\s+acl_allowed\s*;/i.exec(body);
  if (!match) throw new Error('ACL EXISTS not found');
  return match[0];
}

/** ヘッダーの ROLLBACK の節（`-- ` を外した文面） */
function rollbackText(): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^--\s*ROLLBACK:/.test(line));
  const end = lines.findIndex((line, index) => index > start && /^BEGIN;/.test(line));
  if (start === -1 || end === -1) throw new Error('ROLLBACK section not found');
  return lines
    .slice(start + 1, end)
    .map((line) => line.replace(/^--\s?/, ''))
    .join('\n');
}

describe('DATA-AUTH-008 移行 sec_has_permission_aal2_member_rls の文面', () => {
  test('DATA-AUTH-008 BEGIN と COMMIT が 1 組で、NOTIFY pgrst が 1 回', () => {
    expect(sql.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(sql.match(/NOTIFY\s+pgrst\s*,\s*'reload schema'/gi)).toHaveLength(1);
  });

  test('DATA-AUTH-008 has_permission は CREATE OR REPLACE が 1 つで、SECURITY DEFINER・STABLE・SET search_path = \'\' を書き直す', () => {
    expect(sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.has_permission\b/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\bCREATE\s+FUNCTION\b/i);
    const statement = hasPermissionStatement(sql);
    const header = statement.slice(0, statement.search(/\$function\$/));
    expect(header).toMatch(/\bSECURITY\s+DEFINER\b/i);
    expect(header).toMatch(/\bSTABLE\b/i);
    expect(header).toMatch(/\bSET\s+search_path\s*=\s*''/i);
    expect(header).toMatch(/RETURNS\s+boolean/i);
    expect(header).toMatch(/LANGUAGE\s+plpgsql/i);
  });

  test('DATA-AUTH-008 本体は aal2・app_session_is_live と、ACL の 4 つの表を含む', () => {
    const body = hasPermissionBody(sql);
    for (const word of ["'aal2'", 'app_session_is_live', 'user_roles', 'roles', 'role_permissions', 'permissions']) {
      expect(body).toContain(word);
    }
    expect(body).toMatch(/private\.app_session_is_live/);
  });

  test('DATA-AUTH-008 aal の検査は ACL の SELECT EXISTS より前、app_session_is_live は ACL の後', () => {
    const body = hasPermissionBody(sql);
    const aal = body.indexOf("'aal2'");
    const acl = body.search(/SELECT\s+EXISTS/i);
    const live = body.indexOf('app_session_is_live');
    expect(aal).toBeGreaterThan(-1);
    expect(aal).toBeLessThan(acl);
    expect(live).toBeGreaterThan(acl);
    // auth.uid() が空の早期 return は aal の検査より前
    expect(body.indexOf('auth.uid()')).toBeLessThan(aal);
    // ACL が偽ならここで返り、session の検査へ進まない
    expect(squash(body)).toMatch(/IF NOT COALESCE\(acl_allowed, false\) THEN RETURN false; END IF;/);
  });

  test('DATA-AUTH-008 aal が無い claims は aal1 として断る', () => {
    expect(squash(hasPermissionBody(sql))).toContain("COALESCE(claims ->> 'aal', 'aal1') <> 'aal2'");
  });

  test('DATA-AUTH-008 session_id は uuid の形を正規表現で確かめてからキャストする（形が悪ければ例外でなく偽）', () => {
    const body = hasPermissionBody(sql);
    const regex = body.indexOf('~*');
    const cast = body.indexOf('::uuid');
    expect(regex).toBeGreaterThan(-1);
    expect(cast).toBeGreaterThan(regex);
    expect(body).toContain('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  });

  test('DATA-AUTH-008 ACL の SELECT EXISTS は G-0 の本体と一字も違わない（空白を除く）', () => {
    const g0 = fs.readFileSync(path.join(process.cwd(), G0_FILE), 'utf8');
    expect(squash(aclExists(hasPermissionBody(sql)))).toBe(squash(aclExists(hasPermissionBody(g0))));
  });

  test('DATA-AUTH-008 has_permission に GRANT・REVOKE・ALTER ... OWNER を書かない（CREATE OR REPLACE は権限を保つ）', () => {
    expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b[^;]*has_permission/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION\s+public\.has_permission/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  test.each(MEMBER_TABLES)('DATA-AUTH-008 %s の方針は DROP POLICY IF EXISTS の後に AS RESTRICTIVE・FOR ALL・TO authenticated で作る', (table) => {
    const drop = new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"require app bound live session"\\s+ON\\s+public\\.${table}\\s*;`, 'i').exec(sql);
    const create = new RegExp(
      `CREATE\\s+POLICY\\s+"require app bound live session"\\s+ON\\s+public\\.${table}\\s+AS\\s+RESTRICTIVE\\s+FOR\\s+ALL\\s+TO\\s+authenticated\\s+USING\\s*\\(\\(SELECT\\s+private\\.is_app_bound_live_session\\(\\)\\)\\)\\s+WITH\\s+CHECK\\s*\\(\\(SELECT\\s+private\\.is_app_bound_live_session\\(\\)\\)\\)\\s*;`,
      'i',
    ).exec(sql);
    expect(drop).not.toBeNull();
    expect(create).not.toBeNull();
    expect(drop!.index).toBeLessThan(create!.index);
  });

  test('DATA-AUTH-008 方針は 3 本だけで、anon・PUBLIC 向けは作らない', () => {
    const creates = sql.match(/CREATE\s+POLICY[^;]*;/gi) ?? [];
    expect(creates).toHaveLength(3);
    for (const statement of creates) {
      expect(statement).toMatch(/\bTO\s+authenticated\b/i);
      expect(statement).not.toMatch(/\banon\b/i);
      expect(statement).not.toMatch(/\bTO\s+PUBLIC\b/i);
      expect(statement).not.toMatch(/\bAS\s+PERMISSIVE\b/i);
    }
  });

  test('DATA-AUTH-008 公開の読みの方針や G の関数には触れない', () => {
    expect(sql).not.toMatch(/ALTER\s+POLICY/i);
    expect(sql).not.toMatch(/group_g_actor_has_permissions/i);
    expect(sql).not.toMatch(/is_auth_session_active/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
  });

  test('DATA-AUTH-008 ROLLBACK に G-0 の本体の全文と、DROP POLICY 3 本がある', () => {
    const g0 = fs.readFileSync(path.join(process.cwd(), G0_FILE), 'utf8');
    const rollback = rollbackText();
    expect(squash(hasPermissionStatement(rollback))).toBe(squash(hasPermissionStatement(g0)));
    for (const table of MEMBER_TABLES) {
      expect(rollback).toMatch(
        new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"require app bound live session"\\s+ON\\s+public\\.${table}\\s*;`, 'i'),
      );
    }
  });

  test('DATA-AUTH-008 M1 が先に当たっていることを、変更の前に確かめて止める', () => {
    const precheck = sql.indexOf('sec_has_permission_aal2_precheck');
    expect(precheck).toBeGreaterThan(-1);
    expect(precheck).toBeLessThan(sql.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.has_permission/i));
    const check = /DO\s+\$sec_has_permission_aal2_precheck\$([\s\S]*?)\$sec_has_permission_aal2_precheck\$/i.exec(sql)?.[1] ?? '';
    expect(check).toContain('private.app_session_is_live(uuid)');
    expect(check).toContain('private.is_app_bound_live_session()');
    expect(check).toContain('auth_session_id');
    expect(check).toContain('SEC_WAVE5_MIGRATION_ASSERTION_FAILED');
    expect(check).toMatch(/apply M1/);
  });

  test('DATA-AUTH-008 末尾の自己検査が本体・順序・設定・権限・方針 3 本を確かめ、失敗は固定の符号だけで出す', () => {
    const assertion = /DO\s+\$sec_has_permission_aal2_assert\$([\s\S]*?)\$sec_has_permission_aal2_assert\$/i.exec(sql)?.[1] ?? '';
    expect(assertion).toContain('SEC_WAVE5_MIGRATION_ASSERTION_FAILED');
    expect(assertion).toContain("'aal2'");
    expect(assertion).toContain('app_session_is_live');
    expect(assertion).toContain('user_roles');
    expect(assertion).toContain('search_path=""');
    expect(assertion).toMatch(/has_function_privilege\('authenticated'/);
    expect(assertion).toMatch(/has_function_privilege\('anon'/);
    expect(assertion).toMatch(/has_function_privilege\('service_role'/);
    expect(assertion).toMatch(/NOT\s+pol\.polpermissive/);
    expect(assertion).toMatch(/pol\.polcmd\s*=\s*'\*'/);
    expect(assertion).toMatch(/pol\.polroles\s*=\s*ARRAY\['authenticated'::regrole::oid\]/);
    for (const table of MEMBER_TABLES) expect(assertion).toContain(table);
    // DETAIL に動的な値（利用者の値）を入れない。入れるのは固定の項目名だけ
    for (const detail of assertion.match(/DETAIL\s*=\s*[^;]+;/g) ?? []) {
      expect(detail).toMatch(/'sec_has_permission_aal2: [^']+'/);
    }
  });
});
