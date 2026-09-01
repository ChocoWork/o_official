/**
 * migrations/*.sql（squash 前の既存マイグレーション）を、指定した Postgres へ順に適用する。
 *
 * 目的は「本番スキーマをローカルに再現すること」。再現できれば pg_dump で
 * 正規のベースラインを起こせる。
 *
 * ファイル群はそのままでは本番を再現できないことが実測で分かっているので、
 * scripts/replay-patches.mjs の補正を当てながら流す。ファイル自体は履歴として
 * 書き換えない。
 *
 * 使い方:
 *   node scripts/apply-legacy-migrations.mjs postgresql://postgres:postgres@127.0.0.1:54322/postgres
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PRE_SQL, TEXT_PATCHES, POST_SQL } from "./replay-patches.mjs";

const connectionString = process.argv[2];
if (!connectionString) {
  console.error("使い方: node scripts/apply-legacy-migrations.mjs <接続URL>");
  process.exit(1);
}

const DIR = "migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort(); // 001_ 〜 092_ のゼロ埋めなので辞書順＝番号順

const client = new pg.Client({ connectionString });
await client.connect();

let applied = 0;
let patched = 0;
const failures = [];

async function rollbackIfNeeded() {
  try {
    await client.query("ROLLBACK");
  } catch {
    // トランザクション外なら何もしない
  }
}

// 本番に存在するがマイグレーションが作っていないオブジェクト（手動作成分）を先に入れる。
// これが無いと 075 と 092 が参照先を見つけられない。
const MISSING = readFileSync("scripts/replay-missing-objects.sql", "utf8");

try {
  for (const file of files) {
    let sql = readFileSync(join(DIR, file), "utf8");

    const patches = TEXT_PATCHES[file];
    if (patches) {
      for (const { from, to } of patches) {
        const before = sql;
        sql = sql.replace(from, to);
        if (sql === before) {
          console.warn(`WARN ${file}: 補正パッチが当たらなかった -> ${String(from).slice(0, 50)}`);
        }
      }
      patched += 1;
    }

    try {
      if (PRE_SQL[file]) await client.query(PRE_SQL[file]);
      // ファイル単位でまとめて流す。$$ を含む関数定義があるため、
      // 文単位に分割するとかえって壊れる。
      await client.query(sql);
      if (POST_SQL[file]) await client.query(POST_SQL[file]);
      if (file.startsWith("021_")) {
        // carts / wishlist が揃った直後に流す（関数がこの 2 表に依存するため）
        await client.query(MISSING);
      }
      applied += 1;
    } catch (err) {
      failures.push({ file, message: err.message });
      // 失敗するとトランザクションが中断状態のまま残り、以降が
      // 「current transaction is aborted」で全滅する。明示的に戻す。
      await rollbackIfNeeded();
      console.error(`FAIL ${file}: ${err.message}`);
    }
  }
} finally {
  await client.end();
}

console.log(`\n適用成功: ${applied} / ${files.length}（補正を当てたファイル: ${patched}）`);
if (failures.length > 0) {
  console.log(`失敗: ${failures.length} 本`);
  process.exit(1);
}
