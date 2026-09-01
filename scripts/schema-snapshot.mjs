/**
 * scripts/schema-snapshot.sql を任意の Postgres へ流し、正規化テキストとして書き出す。
 *
 * 本番（Supabase MCP 経由で取得したもの）とローカルの出力を突き合わせ、
 * 「ベースラインが本番を再現できているか」を機械的に判定するために使う。
 *
 * 使い方:
 *   node scripts/schema-snapshot.mjs <接続URL> <出力先>
 *   node scripts/schema-snapshot.mjs postgresql://postgres:postgres@127.0.0.1:54322/postgres tmp/local.txt
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";

const [connectionString, outPath] = process.argv.slice(2);

if (!connectionString || !outPath) {
  console.error("使い方: node scripts/schema-snapshot.mjs <接続URL> <出力先>");
  process.exit(1);
}

const sql = readFileSync("scripts/schema-snapshot.sql", "utf8");

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const { rows } = await client.query(sql);
  // タブ区切りの 1 行 1 オブジェクト。改行を含む定義（関数本体）は
  // 1 行に畳んでおかないと差分が読めなくなるのでエスケープする。
  const text = rows
    .map((r) => `${r.kind}\t${r.name}\t${String(r.def).replace(/\r?\n/g, "\\n")}`)
    .join("\n");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text + "\n");
  console.log(`${rows.length} 件を ${outPath} に書き出しました`);
} finally {
  await client.end();
}
