import fs from 'node:fs';
import path from 'node:path';

/**
 * 戻り先の控えの移行の文面（DATA-AUTH-005、SEC-AUTH-032、ADR-0412）。単体テストは詳細設計の ID を先頭に書く決まりなので、表と関数を使う保存の部品の DD-AUTH-033 を付ける。
 * DB なしで流せる。実際の権限・振る舞いは tests/integration/db/auth_return_intents.integration.test.ts が見る。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const SUFFIX = '_auth_return_intents.sql';
const G3_SLIPS_TIMESTAMP = '20261025100130';

const CREATE_SIG = 'public.create_auth_return_intent(text, text, text)';
const CONSUME_SIG = 'public.consume_auth_return_intent(text, text, uuid)';
const TABLE = 'private.auth_return_intents';

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(SUFFIX));
}

function readMigration(): string {
  const files = migrationFiles();
  expect(files).toHaveLength(1);
  // 作業ツリーが CRLF（core.autocrlf）でも同じ結果になるよう、改行は LF に揃えて読む。
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8').replace(/\r\n/g, '\n');
}

/** コメント行に登場する語を数えないよう、-- 以降を落とした本文。 */
function statements(): string {
  return readMigration().replace(/--.*$/gm, '');
}

/** 関数 1 本の定義（CREATE から次の `;` まで）。本体の `$$` を跨ぐので `$$;` で区切る。 */
function definitionOf(name: string): string {
  const body = statements();
  const start = body.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = body.indexOf('$$;', body.indexOf('$$', start) + 2);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end + 3);
}

describe('DATA-AUTH-005 戻り先の控えの移行の文面', () => {
  test('DD-AUTH-033 移行は 1 本で、時刻は G-3 の発送票の移行より後', () => {
    const files = migrationFiles();
    expect(files).toHaveLength(1);
    const timestamp = files[0].slice(0, files[0].indexOf('_'));
    expect(timestamp).toMatch(/^\d{14}$/);
    expect(timestamp > G3_SLIPS_TIMESTAMP).toBe(true);
  });

  test('DD-AUTH-033 全角の空白・BOM が無く、BEGIN と COMMIT が 1 組で、COMMIT が最後', () => {
    const sql = readMigration();
    expect(sql.charCodeAt(0)).not.toBe(0xfeff);
    expect(sql).not.toMatch(/[　 ﻿​-‍]/);
    const lines = sql.split('\n');
    expect(lines.filter((line) => /^\s*BEGIN\s*;/i.test(line))).toEqual(['BEGIN;']);
    expect(lines.filter((line) => /^\s*COMMIT\s*;/i.test(line))).toEqual(['COMMIT;']);
    expect(lines.filter((line) => line.trim() !== '').at(-1)).toBe('COMMIT;');
    expect(sql.match(/NOTIFY pgrst/g)).toHaveLength(1);
  });

  test('DD-AUTH-033 2 本の関数はそれぞれ PUBLIC・anon・authenticated・service_role から外してから service_role にだけ EXECUTE を付ける', () => {
    const body = statements();
    for (const signature of [CREATE_SIG, CONSUME_SIG]) {
      expect(body).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;`,
      );
      expect(body).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
      expect(body).toContain(`ALTER FUNCTION ${signature} OWNER TO postgres;`);
    }
    // 外してから付ける順
    for (const signature of [CREATE_SIG, CONSUME_SIG]) {
      expect(body.indexOf(`REVOKE ALL ON FUNCTION ${signature}`)).toBeLessThan(
        body.indexOf(`GRANT EXECUTE ON FUNCTION ${signature}`),
      );
    }
  });

  test('DD-AUTH-033 GRANT は service_role への EXECUTE の 2 本だけで、anon・authenticated・PUBLIC・表への付与が無い', () => {
    const body = statements();
    const grants = body.match(/\bGRANT\b[^;]*;/gi) ?? [];
    expect(grants).toEqual([
      `GRANT EXECUTE ON FUNCTION ${CREATE_SIG} TO service_role;`,
      `GRANT EXECUTE ON FUNCTION ${CONSUME_SIG} TO service_role;`,
    ]);
    // 付与先は service_role だけ（スキーマ名の public と取り違えないよう、付与先の語で見る）
    for (const grant of grants) expect(grant).toMatch(/\bTO service_role;$/);
    expect(body).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\b(?:anon|authenticated)\b/i);
    expect(body).not.toMatch(/\bGRANT\b[^;]*\bTO\b[^;]*\bPUBLIC\b/);
    expect(body).not.toMatch(/\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?private\./i);
  });

  test('DD-AUTH-033 表は RLS を有効にし、4 つの役の権限を全部外す', () => {
    const body = statements();
    expect(body).toContain(`CREATE TABLE ${TABLE} (`);
    expect(body).toContain(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(body).toContain(`ALTER TABLE ${TABLE} OWNER TO postgres;`);
    expect(body).toContain(`REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC, anon, authenticated, service_role;`);
  });

  test('DD-AUTH-033 表の列は番号のハッシュだけを持ち、平文の番号の列が無い', () => {
    const body = statements();
    const create = body.slice(body.indexOf(`CREATE TABLE ${TABLE} (`), body.indexOf(`ALTER TABLE ${TABLE} OWNER`));
    const columns = [...create.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|timestamptz)\b/gm)].map((m) => m[1]);
    expect(columns).toEqual(['id', 'token_hash', 'return_path', 'purpose', 'created_at', 'expires_at', 'consumed_at', 'user_id']);
    expect(create).toContain("token_hash ~ '^[0-9a-f]{64}$'");
    expect(create).toContain("purpose IN ('login', 'signup')");
    expect(create).toContain('char_length(return_path) BETWEEN 1 AND 512');
    expect(create).toContain('(consumed_at IS NULL) = (user_id IS NULL)');
    expect(create).toContain('expires_at > created_at');
    expect(create).not.toMatch(/REFERENCES/i);
  });

  test('DD-AUTH-033 SECURITY DEFINER の数と SET search_path = \'\' の数が同じ（2 本）で、本文は pg_catalog. と private. で修飾する', () => {
    const body = statements();
    expect(body.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(body.match(/SET search_path = ''/g)).toHaveLength(2);
    for (const name of ['create_auth_return_intent', 'consume_auth_return_intent']) {
      const definition = definitionOf(name);
      expect(definition).toContain("SET search_path = ''");
      expect(definition).toContain('private.auth_return_intents');
      expect(definition).not.toMatch(/\bFROM\s+auth_return_intents\b/);
      expect(definition).not.toMatch(/(?<!pg_catalog\.)\bnow\(\)/i);
    }
    expect(definitionOf('create_auth_return_intent')).toContain('pg_catalog.now()');
    expect(definitionOf('consume_auth_return_intent')).toContain('pg_catalog.now()');
  });

  test('DD-AUTH-033 consume は STRICT で、1 回の更新で使い切る条件（未使用・期限内・用途が同じ）を持つ', () => {
    const consume = definitionOf('consume_auth_return_intent');
    expect(consume).toMatch(/\bSTRICT\b/);
    expect(definitionOf('create_auth_return_intent')).not.toMatch(/\bSTRICT\b/);
    expect(consume).toContain('consumed_at IS NULL AND expires_at > pg_catalog.now()');
    expect(consume).toContain('token_hash = _token_hash AND purpose = _purpose');
    expect(consume).toContain('SET consumed_at = pg_catalog.now(), user_id = _user_id');
    expect(consume).toContain('RETURNING return_path');
  });

  test('DD-AUTH-033 create の期限は login が 900 秒、signup が 3600 秒で、秒数を返す', () => {
    const create = definitionOf('create_auth_return_intent');
    expect(create).toContain("CASE _purpose WHEN 'login' THEN 900 ELSE 3600 END");
    expect(create).toContain('RETURN v_seconds;');
    expect(create).toContain('RETURNS integer');
  });

  test('DD-AUTH-033 掃除の cron は毎日 03:20 で、cron スキーマへの自己付与を写さない', () => {
    const body = statements();
    expect(body).toMatch(/cron\.schedule\(\s*'auth-return-intents-cleanup',\s*'20 3 \* \* \*'/);
    expect(body).toContain('DELETE FROM private.auth_return_intents WHERE expires_at < pg_catalog.now() - interval \'1 day\'');
    expect(body).toContain('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;');
    expect(body).not.toMatch(/grant\s+usage\s+on\s+schema\s+cron/i);
    expect(body).not.toMatch(/grant\s+all\s+privileges\s+on\s+all\s+tables\s+in\s+schema\s+cron/i);
    expect(body).not.toMatch(/\bON\s+SCHEMA\s+private\b/i);
  });

  test('DD-AUTH-033 末尾の確かめは印で囲まれた DO ブロック 1 つで、失敗は 55000 と項目名だけ', () => {
    const sql = readMigration();
    const begin = '-- AUTH_RETURN_INTENT_ASSERT_BEGIN';
    const end = '-- AUTH_RETURN_INTENT_ASSERT_END';
    expect(sql.split(`\n${begin}\n`)).toHaveLength(2);
    expect(sql.split(`\n${end}\n`)).toHaveLength(2);
    const section = sql.slice(sql.indexOf(begin), sql.indexOf(end));
    expect(section).toContain('DO $auth_return_intents_final$');
    const raises = section.match(/RAISE EXCEPTION [^;]*;/g) ?? [];
    expect(raises).toEqual([
      "RAISE EXCEPTION 'AUTH_RETURN_INTENT_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;",
    ]);
    const names = [...section.matchAll(/v_failed := '([^']*)'/g)].map((m) => m[1]);
    expect(names).toEqual(['auth_return_intents_table', 'auth_return_intents_functions', 'auth_return_intents_cleanup_job']);
    // 確かめは表・関数・掃除の後、NOTIFY と COMMIT の前
    expect(sql.indexOf(begin)).toBeGreaterThan(sql.indexOf("'auth-return-intents-cleanup'"));
    expect(sql.indexOf(end)).toBeLessThan(sql.indexOf('NOTIFY pgrst'));
  });
});
