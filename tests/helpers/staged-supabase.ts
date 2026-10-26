import fs from 'node:fs';
import path from 'node:path';

/**
 * 名前の末尾（例 'sec_grants_hardening'）で移行を探す。
 * supabase/migrations を先に、無ければ supabase/pending-wave2 を見る。
 * 同じ場所に 2 本以上あれば、どちらを読むか決められないので throw。どこにも無ければ throw。
 * root は試験用（既定は process.cwd()）。絶対パスを返す。
 */
export function findMigration(suffix: string, root: string = process.cwd()): string {
  // 時刻の接頭辞（14 桁）の直後から末尾までが suffix と全部一致する物だけ。別の名前の末尾が偶然同じ物は数えない
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\d{14}_${escaped}\\.sql$`);
  for (const dir of [path.join(root, 'supabase', 'migrations'), path.join(root, 'supabase', 'pending-wave2')]) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const hits = fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort();
    if (hits.length > 1) {
      throw new Error(`migration ambiguous: ${suffix} in ${dir} (${hits.join(', ')})`);
    }
    if (hits.length === 1) {
      return path.join(dir, hits[0]);
    }
  }
  throw new Error(`migration not found: ${suffix}`);
}

/** findMigration で見つけた移行の中身を文字列で返す。 */
export function readMigration(suffix: string, root?: string): string {
  return fs.readFileSync(findMigration(suffix, root), 'utf8');
}

/**
 * 見本・見本の置き場の script を探す。
 * supabase/pending-wave2/seed/<rel> を先に、無ければ <rel>（rel は repo root からの相対）。
 */
export function resolveSeedPath(rel: string, root: string = process.cwd()): string {
  const staged = path.join(root, 'supabase', 'pending-wave2', 'seed', rel);
  return fs.existsSync(staged) ? staged : path.join(root, rel);
}
