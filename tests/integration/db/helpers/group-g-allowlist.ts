import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';

/**
 * G-3 Task 4: 書き手の閉じた一覧（private.group_g_writer_allowlist()）を、取引の中で決めた一覧へ入れ替える共有の道具。
 *
 * 移行の末尾の確かめ（G2B_FINAL_ASSERT など）は「その移行を当てた時点の一覧」を固定で持つ。G-3 で一覧が65本を超えたので、
 * G-2 の確かめを今の DB で流す試験は、流す前にこの道具で一覧を G-2 の65本へ入れ替える。入れ替えは呼び出し元の取引の中だけで、
 * 戻すのは呼び出し元の rollback（savepoint への rollback を含む）。
 */

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');

/** 'private.name(args)' の形の行を並びのまま集める */
function signaturesIn(text: string): string[] {
  return [...text.matchAll(/^\s*'((?:private|public)\.[a-z_0-9]+\([^']*\))',?\s*$/gm)].map((match) => match[1]);
}

/** G2B の移行ファイルの末尾の確かめが持つ v_writers の配列リテラルから、G-2 の65本を並びのまま読み取って固定する */
function readG2Allowlist(): readonly string[] {
  const file = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_writers.sql'));
  if (file.length !== 1) throw new Error('GROUP_G_G2B_MIGRATION_MISSING');
  const sql = fs.readFileSync(path.join(MIGRATION_DIRECTORY, file[0]), 'utf8');
  const start = sql.indexOf('v_writers text[] := ARRAY[');
  const end = start < 0 ? -1 : sql.indexOf('];', start);
  if (start < 0 || end < 0) throw new Error('GROUP_G_G2B_WRITERS_MISSING');
  const entries = signaturesIn(sql.slice(start, end));
  if (entries.length !== 65 || new Set(entries).size !== 65) throw new Error('GROUP_G_G2B_WRITERS_NOT_65');
  return Object.freeze(entries);
}

/** G-2 の書き手の閉じた一覧（G-1 の56本 + 発注書の9本 = 65本） */
export const G2_ALLOWLIST: readonly string[] = readG2Allowlist();

/**
 * G-3 の移行 group_g3_shipping_slips（G3C）が、その時点までに存在する書き手だけで持つ一覧。
 * Task 4: 下書きの保存・破棄の2本で67本。Task 5 で確定の書き手を足して70本、Task 6 で72本、…（まだ存在しない関数の署名を
 * ::regprocedure に通さない）。この定数で G3C の末尾の確かめを流すのは Task 10。
 */
export const G3C_ALLOWLIST: readonly string[] = Object.freeze([
  ...G2_ALLOWLIST,
  'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
  'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
]);

/** 書き手の閉じた一覧を、渡した一覧へ置き換える文（関数の所有者・SECURITY DEFINER・search_path 空は移行と同じ） */
export function replaceAllowlistSql(entries: readonly string[]): string {
  return `create or replace function private.group_g_writer_allowlist()
    returns pg_catalog.regprocedure[] language sql stable security definer set search_path = ''
    as $f$ select array[${entries.map((entry) => `'${entry}'`).join(', ')}]::pg_catalog.regprocedure[] $f$`;
}

/** 呼び出し元の取引の中で一覧を入れ替えてから、末尾の確かめの節を流す。戻すのは呼び出し元の rollback */
export async function runWithAllowlist(client: PgClient, entries: readonly string[], assertSql: string): Promise<void> {
  await client.query(replaceAllowlistSql(entries));
  await client.query(assertSql);
}
