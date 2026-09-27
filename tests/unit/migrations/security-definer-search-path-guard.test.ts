import fs from 'node:fs';
import path from 'node:path';

/**
 * これから足すマイグレーションが SECURITY DEFINER 関数の search_path を弱めないようにする（FREQ-395）。
 *
 * `CREATE OR REPLACE FUNCTION` は関数の設定（pg_proc.proconfig）を丸ごと置き換える。
 * 本番で実測（巻き戻し済み）:
 *
 * | 書き方 | 適用後の proconfig |
 * |---|---|
 * | `SET search_path = public, pg_temp` | `search_path=public, pg_temp` |
 * | `SET search_path TO 'public'`       | `search_path=public`（pg_temp が消える） |
 * | SET 句なし                          | NULL（設定ごと消える） |
 *
 * つまり、pg_temp を足した ALTER（20260921011535）より後に古い版を雛形として貼り直すと、
 * 対策が静かに巻き戻る。ALTER は関数定義の中に残らないので、ファイルを読んでも気づけない。
 * レビューの目視ではなく、ここで落とす。
 *
 * 対象はしきい値（上の ALTER）より後のファイルだけ。それ以前の関数は ALTER 側で直してあり、
 * 定義そのものは古い書き方のまま残っている（適用済みのファイルは書き換えない。
 * docs/ops/db-migrations.md の台帳一致の規約）。
 *
 * 実際に本番の関数が pg_temp を持っているかは
 * tests/integration/db/security_definer_search_path.integration.test.ts が見る。
 * こちらはファイル側、あちらは DB 側。
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const HARDENING_SUFFIX = '_harden_security_definer_search_path.sql';

/** コメントを外した本文（コメント内の CREATE を拾わないため）。 */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

/**
 * 関数定義の「見出し」（CREATE FUNCTION から本体の開始区切りまで）を取り出す。
 * SECURITY DEFINER も SET search_path もここに書く。
 */
function functionHeaders(sql: string): string[] {
  const headers: string[] = [];
  const createPattern = /\bcreate\s+(?:or\s+replace\s+)?function\b/gi;
  // 位置はコメントを外した本文の上で数える（元の文字列を切ると索引がずれる）。
  const cleaned = withoutComments(sql);

  for (const match of cleaned.matchAll(createPattern)) {
    const rest = cleaned.slice(match.index ?? 0);
    // 本体は AS $...$ で始まる。見つからなければ定義の末尾までを見出しとみなす。
    const bodyStart = rest.search(/\bas\s+\$/i);
    headers.push(bodyStart === -1 ? rest : rest.slice(0, bodyStart));
  }

  return headers;
}

function sortedMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/** pg_temp を要求し始めた地点。これより後のファイルだけを見る。 */
function hardeningMigrationName(): string {
  const files = sortedMigrationFiles().filter((name) => name.endsWith(HARDENING_SUFFIX));
  expect(files).toHaveLength(1);
  return files[0];
}

type Offender = { file: string; header: string };

function definitionsMissingPgTemp(): Offender[] {
  const files = sortedMigrationFiles();
  const cutoff = hardeningMigrationName();
  const offenders: Offender[] = [];

  for (const file of files.filter((name) => name > cutoff)) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    for (const header of functionHeaders(sql)) {
      if (!/\bsecurity\s+definer\b/i.test(header)) continue;

      const searchPath = header.match(/\bset\s+search_path\s*(?:=|to)\s*([^\n]+)/i)?.[1] ?? null;
      // search_path='' は「どのスキーマも探さない」で、一時スキーマも見ないため対象外。
      if (searchPath !== null && /^''\s*$/.test(searchPath.trim())) continue;
      if (searchPath !== null && /\bpg_temp\b/.test(searchPath)) continue;

      offenders.push({ file, header: header.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }

  return offenders;
}

describe('SECURITY DEFINER 関数の search_path（これから足すマイグレーション）', () => {
  it('しきい値になる pg_temp 対応のマイグレーションがある', () => {
    expect(hardeningMigrationName()).toMatch(/^\d{14}_harden_security_definer_search_path\.sql$/);
  });

  it('しきい値より後の定義は、search_path の最後に pg_temp を置く', () => {
    expect(definitionsMissingPgTemp()).toEqual([]);
  });

  it('見出しの抜き出しが SECURITY DEFINER と search_path を拾える', () => {
    const headers = functionHeaders(`
      CREATE OR REPLACE FUNCTION public.sample()
        RETURNS int
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path TO 'public'
        AS $function$ SELECT 1 $function$;
    `);

    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(/security\s+definer/i);
    expect(headers[0]).toMatch(/set\s+search_path/i);
    expect(headers[0]).not.toMatch(/SELECT 1/);
  });
});
