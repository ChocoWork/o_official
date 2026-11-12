import fs from 'node:fs';
import path from 'node:path';

/**
 * 1着ごとの値段（FREQ-642）の移行の末尾の確かめを、今の DB に向けて再生する時に使う。
 * 後の移行（X4 の 20261112064013_unit_binding_refund_retry.sql など）が同じ署名で中身を置き換えた関数は、
 * 前の移行の確かめが書いた中身の md5 を、その関数を最後に定義した移行の確かめの md5 に替える（FREQ-642-AC-37）。
 * 行の形は `('schema', 'signature', ..., 'md5')`（移行 B・D・X4 の確かめと同じ）。
 */
const LATER_FILES = ['_unit_binding_refund_retry.sql'];

function laterBodies(): Map<string, string> {
  const directory = path.join(process.cwd(), 'supabase', 'migrations');
  const bodies = new Map<string, string>();
  for (const suffix of LATER_FILES) {
    const file = fs.readdirSync(directory).find((name) => name.endsWith(suffix));
    if (!file) continue;
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const row of sql.matchAll(/\('(\w+)', '([^']+\))'[^\n]*'([0-9a-f]{32})'\)/g)) bodies.set(`${row[1]}.${row[2]}`, row[3]);
  }
  return bodies;
}

/** 前の移行の確かめの本文で、後の移行が置き換えた関数の md5 を今の物に替えた本文を返す */
export function withLatestBodies(assertSql: string): string {
  let out = assertSql;
  for (const [key, md5] of laterBodies()) {
    const [schema, signature] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(\\('${schema}', '${escaped}'[^\\n]*')[0-9a-f]{32}('\\))`), `$1${md5}$2`);
  }
  return out;
}
