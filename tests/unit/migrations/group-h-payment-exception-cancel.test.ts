/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

const directory = path.join(process.cwd(), 'supabase/migrations');
const original = fs.readFileSync(path.join(directory, '20261023211425_group_g1_allocation.sql'), 'utf8').replace(/\r/g, '');
const file = path.join(directory, '20261029130600_group_h_payment_exception_cancel.sql');
const migration = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const definition = (sql: string) => /CREATE (?:OR REPLACE )?FUNCTION private\.resolve_payment_exception\([\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? '';

test('FREQ-549-AC-03: H7はG-1の定義にHの鍵と取消の2行だけを足す', () => {
  const before = definition(original);
  expect(before).not.toBe('');
  const expected = before.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    .replace('  v_orders := private.lock_group_g_inventory(', '  PERFORM private.group_h_lock_acceptance(NULL, v_order_id);\n  v_orders := private.lock_group_g_inventory(')
    .replace('      AND o.status = current_status;\n', '      AND o.status = current_status;\n    PERFORM private.group_h_settle_redemptions(target.order_id, false);\n');
  expect(definition(migration)).toBe(expected);
});

test('FREQ-549-AC-03: H7はG-1の所有者と権限を保持し、public入口と既存の書き手の一覧を作り直さない', () => {
  const grants = original.slice(original.indexOf('ALTER FUNCTION private.resolve_payment_exception('), original.indexOf('CREATE OR REPLACE FUNCTION public.resolve_payment_exception(')).trim();
  expect(grants).not.toBe('');
  expect(migration).toContain(grants);
  expect(migration.match(/^CREATE OR REPLACE FUNCTION /gm)).toHaveLength(1);
  expect(migration).not.toMatch(/(?:DROP FUNCTION|COMMENT ON FUNCTION|CREATE(?: OR REPLACE)? FUNCTION public\.)/);
});

test('FREQ-549-AC-03: H7はASCII・BOMなしLFの単一取引で本文のMD5を固定する', () => {
  expect(migration).not.toBe('');
  expect(migration).not.toMatch(/[^\x00-\x7f]|\r/);
  expect(migration.startsWith('BEGIN;\n')).toBe(true);
  expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
  expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  expect(migration.trimEnd()).toMatch(/-- H7_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
  const assertion = migration.split('-- H7_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H7_FINAL_ASSERT_END')[0] ?? '';
  expect(assertion).toContain("pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r',''))");
  expect(assertion).not.toMatch(/CONTROLLER|0{32}/);
  expect(assertion).toMatch(/'resolve_payment_exception\(uuid,uuid,text,boolean,text,boolean\)'[^\n]*'656d6fc09913ed4865fe2b26029b0fd0'/);
});
