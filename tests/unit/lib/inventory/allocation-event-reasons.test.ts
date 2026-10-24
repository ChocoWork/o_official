import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOCATION_EVENT_REASON_CODES,
  ALLOCATION_EVENT_REASON_LABELS,
  allocationEventReasonLabel,
} from '@/lib/inventory/allocation-types';

/**
 * 割当の履歴の理由は、DB の CHECK（order_item_allocation_events_reason_check）と TS の一覧が同じ集合。
 * 一覧を移行の文から読むので、片方だけを足すと赤になる。
 */
const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g1_allocation.sql'));
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATION_DIRECTORY, MIGRATION_FILE[0]), 'utf8');

function checkCodes(): string[] {
  const match = MIGRATION_SQL.match(
    /CONSTRAINT order_item_allocation_events_reason_check CHECK \(\s*reason IS NULL OR reason IN \(([^)]*)\)\s*\)/,
  );
  if (!match) throw new Error('reason check missing');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('割当の履歴の理由の決まった値', () => {
  test('移行は G-1 の1本で、CHECK は1か所だけ', () => {
    expect(MIGRATION_FILE).toHaveLength(1);
    expect(MIGRATION_SQL.split('order_item_allocation_events_reason_check CHECK')).toHaveLength(2);
  });

  test('TS の一覧は DB の CHECK と同じ集合（重複なし）', () => {
    const codes = checkCodes();
    expect(new Set(codes).size).toBe(codes.length);
    expect([...ALLOCATION_EVENT_REASON_CODES].sort()).toEqual([...codes].sort());
  });

  test('名前の表は一覧のすべての値に日本語の名前を持ち、ほかの値を持たない', () => {
    expect(Object.keys(ALLOCATION_EVENT_REASON_LABELS).sort()).toEqual([...ALLOCATION_EVENT_REASON_CODES].sort());
    for (const code of ALLOCATION_EVENT_REASON_CODES) {
      expect(ALLOCATION_EVENT_REASON_LABELS[code]).toMatch(/[぀-ヿ一-龯]/);
      expect(allocationEventReasonLabel(code)).toBe(ALLOCATION_EVENT_REASON_LABELS[code]);
    }
  });

  test('知らない値・管理者のメモのような文は「システム」', () => {
    for (const reason of ['unknown_internal_reason', '在庫を数え直した', 'toString', '__proto__']) {
      expect(allocationEventReasonLabel(reason)).toBe('システム');
    }
  });

  test('移行の割当の履歴への INSERT が書く文字の理由は、すべて決まった値', () => {
    // `--` comments are removed first: a `;` inside a comment would otherwise end the INSERT early (review M1).
    const withoutComments = MIGRATION_SQL.replace(/--[^\n]*/g, '');
    const inserts = [...withoutComments.matchAll(/INSERT INTO public\.order_item_allocation_events[\s\S]*?;/g)].map((m) => m[0]);
    expect(inserts.length).toBeGreaterThanOrEqual(6);
    // The CASE of release_group_g_payment_holds (the codes it passes through and its status_change fallback) is scanned.
    const holdRelease = inserts.filter((sql) => sql.includes("THEN _reason ELSE 'status_change' END"));
    expect(holdRelease).toHaveLength(1);
    for (const code of ['stripe_checkout_expired', 'stripe_voucher_expired', 'admin_cancel', 'admin_cancel_failed_order',
      'resolve_payment_exception', 'status_change']) expect(holdRelease[0]).toContain(`'${code}'`);
    const literals = inserts.flatMap((sql) => [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    // event_type の値と、理由を選ぶ CASE の比べの値（返金の行の restock_type = 'cancel'）は理由ではない
    const notReasons = ['hold', 'promote', 'allocate', 'release', 'consume', 'restore', 'transfer', 'paid', 'cancel'];
    const reasons = literals.filter((value) => !notReasons.includes(value));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(ALLOCATION_EVENT_REASON_CODES).toContain(reason);
  });
});
