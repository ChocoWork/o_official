/**
 * ローカル DB のカタログ指紋を取り、本番の指紋（tmp/prod-digest.txt）と突き合わせる。
 *
 * 本番側は Supabase MCP 経由でしか触れないため、全文を持ってくるのではなく
 * カテゴリごとの md5 を比較する。一致すれば「ベースラインは本番を再現できている」と言える。
 * 食い違ったカテゴリだけを後から詳しく見ればよい。
 *
 * 使い方:
 *   node scripts/compare-schema.mjs postgresql://postgres:postgres@127.0.0.1:54322/postgres
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const connectionString = process.argv[2];
if (!connectionString) {
  console.error("使い方: node scripts/compare-schema.mjs <接続URL>");
  process.exit(1);
}

// 本番で流したものと同一の SQL。片方だけ変えると比較が成立しないので必ず揃えること。
const DIGEST_SQL = `
SELECT kind, count(*)::int AS n, md5(string_agg(name || E'\\t' || def, E'\\n' ORDER BY name, def)) AS digest FROM (
  SELECT 'extension' AS kind, e.extname AS name, e.extname AS def FROM pg_extension e
  UNION ALL
  SELECT 'column', c.table_name || '.' || c.column_name,
         c.data_type || coalesce('(' || c.character_maximum_length || ')', '') || ' null=' || c.is_nullable || ' default=' || coalesce(c.column_default, '-')
    FROM information_schema.columns c WHERE c.table_schema = 'public'
  UNION ALL
  SELECT 'constraint', rel.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index', i.tablename || '.' || i.indexname, i.indexdef FROM pg_indexes i WHERE i.schemaname = 'public'
  UNION ALL
  SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
  UNION ALL
  SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'rls', c.relname, CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
  UNION ALL
  SELECT 'policy', p.tablename || '.' || p.policyname, p.cmd || ' roles=' || array_to_string(p.roles, ',') || ' using=' || coalesce(p.qual,'-') || ' check=' || coalesce(p.with_check,'-')
    FROM pg_policies p WHERE p.schemaname='public'
  UNION ALL
  SELECT 'function_acl', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', coalesce(array_to_string(p.proacl::text[], ' | '), 'default')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
  UNION ALL
  SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname='public' GROUP BY t.typname
) s GROUP BY kind ORDER BY kind;
`;

const expected = new Map();
for (const line of readFileSync("tmp/prod-digest.txt", "utf8").trim().split(/\r?\n/)) {
  const [kind, n, digest] = line.split("\t");
  expected.set(kind, { n: Number(n), digest });
}

const client = new pg.Client({ connectionString });
await client.connect();
let rows;
try {
  ({ rows } = await client.query(DIGEST_SQL));
} finally {
  await client.end();
}

const actual = new Map(rows.map((r) => [r.kind, { n: r.n, digest: r.digest }]));
const kinds = [...new Set([...expected.keys(), ...actual.keys()])].sort();

let mismatched = 0;
console.log("kind            本番件数  ローカル件数  判定");
for (const kind of kinds) {
  const e = expected.get(kind);
  const a = actual.get(kind);
  const ok = e && a && e.n === a.n && e.digest === a.digest;
  if (!ok) mismatched += 1;
  console.log(
    `${kind.padEnd(14)} ${String(e?.n ?? "-").padStart(6)} ${String(a?.n ?? "-").padStart(12)}  ${ok ? "一致" : "不一致"}`,
  );
}

console.log(mismatched === 0 ? "\n全カテゴリ一致。" : `\n${mismatched} カテゴリが不一致。`);
process.exit(mismatched === 0 ? 0 : 1);
