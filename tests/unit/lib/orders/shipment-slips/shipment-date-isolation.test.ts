/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const roots = ['src/lib/kpi', 'src/lib/finance', 'src/app/api/admin/kpi', 'src/app/api/admin/accounting'];
function sources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}
test.each(['repo', 'outside'])('FREQ-535-AC-04: cwd=%sでもKPI・会計・売上は出荷日に依存しない（認証や他sessionのファイルを読まない）', (cwd) => {
  const previous = process.cwd();
  process.chdir(cwd === 'repo' ? path.resolve(__dirname, '../../../../..') : tmpdir());
  try {
    for (const root of roots) {
      const files = sources(path.resolve(__dirname, '../../../../..', root));
      expect(files.length).toBeGreaterThan(0);
      const violations = files.filter((file) => /shipment_date|shipmentDate/.test(fs.readFileSync(file, 'utf8')));
      expect(violations).toEqual([]);
    }
  } finally { process.chdir(previous); }
});

const actions = fs.readFileSync(path.resolve(__dirname, '../../../../../supabase/migrations/20261025134538_group_g3_shipping_actions.sql'), 'utf8');
const correction = actions.slice(actions.indexOf('CREATE FUNCTION private.admin_correct_shipment_date('), actions.indexOf('ALTER FUNCTION private.admin_correct_shipment_date('));
test('FREQ-535-AC-03: DBのtrim集合はJSのtrimと一致し、tabs/newlines/Unicode空白だけの理由を受け付けない', () => {
  const encoded = /v_reason text := pg_catalog\.btrim\(_reason, U&'([^']+)'\);/.exec(correction)?.[1];
  expect(encoded).toBeDefined();
  const whitespace = encoded!.replace(/\\([0-9a-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
  const native = Array.from({ length: 0x10000 }, (_, index) => String.fromCharCode(index)).filter((char) => char.trim() === '').join('');
  expect(whitespace).toBe(native);
});
test('FREQ-535-AC-03: 発送の日付更新の直後に操作印を戻し、履歴INSERTへ持ち越さない', () => {
  const update = correction.indexOf('UPDATE public.order_fulfillments');
  const end = correction.indexOf(';', update) + 1;
  expect(correction.slice(end).trimStart()).toMatch(/^PERFORM pg_catalog\.set_config\('app.fulfillment_change', COALESCE\(v_previous_fulfillment, ''\), true\);\s+INSERT INTO public.shipment_date_history/);
});
