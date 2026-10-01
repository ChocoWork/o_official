import fs from 'node:fs';
import path from 'node:path';

/**
 * SECURITY DEFINER 関数の search_path を固める（FREQ-390、優先度低の指摘⑪の残り）。
 *
 * 1. 一時スキーマの取り違え
 *    PostgreSQL は search_path に pg_temp が書かれていないと、テーブル・ビュー・型の解決で
 *    一時スキーマを「先頭より前」に見る。SECURITY DEFINER の関数は所有者（postgres）の権限で
 *    動くため、中で参照する public.xxx が一時テーブルに置き換わると所有者権限で読み書きしてしまう。
 *    PostgreSQL 公式は「pg_temp を最後に書いて一時スキーマを最後に探させる」ことを勧めている。
 *
 *    本番の public スキーマは anon / authenticated / service_role のいずれにも CREATE を与えて
 *    いないため（実測）、いま踏める経路は無い。将来の権限変更に備えた多層防御として入れる。
 *    ALTER FUNCTION ... SET なので関数本体は書き換えない。
 *
 * 2. anon から has_permission を外す
 *    Supabase のリンターが「anon が SECURITY DEFINER 関数を /rest/v1/rpc/has_permission から
 *    実行できる」と警告していた。この関数を参照する RLS ポリシーは本番の実測で全部
 *    authenticated 向けなので、anon の EXECUTE を外してもポリシーは壊れない。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
// 版番号は本番へ適用したときに確定するため、ファイル名の後半で探す。
const MIGRATION_SUFFIX = '_harden_security_definer_search_path.sql';

function readMigration(): string {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), 'utf8');
}

/** コメントを外した本文。 */
function statements(): string {
  return readMigration().replace(/--.*$/gm, '');
}

/** ALTER FUNCTION ... SET search_path = ... の右辺だけを並べる。 */
function searchPaths(): string[] {
  return [...statements().matchAll(/set\s+search_path\s*=\s*([^;]+);/gi)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  );
}

describe('SECURITY DEFINER の search_path を固めるマイグレーション', () => {
  it('本番にある対象の関数をすべて直す（20本）', () => {
    expect(searchPaths()).toHaveLength(20);
  });

  it('どれも pg_temp を最後に置く', () => {
    for (const value of searchPaths()) {
      expect(value.endsWith('pg_temp')).toBe(true);
    }
  });

  it('元の検索順は落とさない（public を消さない）', () => {
    for (const value of searchPaths()) {
      expect(value).toMatch(/\bpublic\b/);
    }
  });

  it('関数本体は書き換えない', () => {
    expect(statements()).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });

  it('anon から has_permission の実行権限を外す', () => {
    expect(statements()).toMatch(
      /revoke\s+execute\s+on\s+function\s+"?public"?\."?has_permission"?\s*\(\s*text\s*\)\s+from\s+"?anon"?\s*;/i,
    );
  });

  it('authenticated の実行権限は残す（RLS ポリシーが参照している）', () => {
    expect(statements()).not.toMatch(
      /revoke[\s\S]*?has_permission[\s\S]*?from[^;]*\bauthenticated\b/i,
    );
  });

  it('全体をトランザクションで包む（規約: docs/06_Operations/db-migrations.md）', () => {
    const sql = readMigration();
    expect(sql).toMatch(/^BEGIN;$/im);
    expect(sql).toMatch(/^COMMIT;$/im);
  });
});
