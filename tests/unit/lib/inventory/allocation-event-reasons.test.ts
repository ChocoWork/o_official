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
const MIGRATION_FILES = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('.sql')).sort();
const REASON_MIGRATIONS = MIGRATION_FILES.map((name) => ({
  name,
  sql: fs.readFileSync(path.join(MIGRATION_DIRECTORY, name), 'utf8'),
})).filter(({ sql }) => /CONSTRAINT order_item_allocation_events_reason_check CHECK/.test(sql));
const MIGRATION_SQL = REASON_MIGRATIONS.at(-1)!.sql;
const G1_MIGRATION_SQL = REASON_MIGRATIONS.find(({ name }) => name.endsWith('_group_g1_allocation.sql'))!.sql;

function checkCodes(): string[] {
  const match = MIGRATION_SQL.match(
    /CONSTRAINT order_item_allocation_events_reason_check CHECK \(\s*reason IS NULL OR reason IN \(([^)]*)\)\s*\)/,
  );
  if (!match) throw new Error('reason check missing');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('割当の履歴の理由の決まった値', () => {
  test('FREQ-533-AC-04: 発送の確定と取消の理由を日本語で表示する', () => {
    expect(ALLOCATION_EVENT_REASON_CODES).toContain('shipment_confirm');
    expect(ALLOCATION_EVENT_REASON_CODES).toContain('shipment_cancel');
    expect(allocationEventReasonLabel('shipment_confirm')).toBe('発送の確定');
    expect(allocationEventReasonLabel('shipment_cancel')).toBe('発送の取消');
  });

  test('FREQ-523-AC-03: 最後の理由CHECKはG-4のfoundationで、定義は1か所だけ', () => {
    expect(REASON_MIGRATIONS.at(-1)!.name).toMatch(/_group_g4_orders_foundation\.sql$/);
    expect(MIGRATION_SQL.split('order_item_allocation_events_reason_check CHECK')).toHaveLength(2);
  });

  test('FREQ-523-AC-03: TS の18値は DB の CHECK と同じ集合（重複なし）', () => {
    const codes = checkCodes();
    expect(ALLOCATION_EVENT_REASON_CODES).toHaveLength(18);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...ALLOCATION_EVENT_REASON_CODES].sort()).toEqual([...codes].sort());
  });

  test('FREQ-523-AC-03: allocation_swap は末尾の18値目で、日本語は「割当の入替」', () => {
    expect(ALLOCATION_EVENT_REASON_CODES.at(-1)).toBe('allocation_swap');
    expect(allocationEventReasonLabel('allocation_swap')).toBe('割当の入替');
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
    const withoutComments = G1_MIGRATION_SQL.replace(/--[^\n]*/g, '');
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
