import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_REASONS,
  HIDDEN_ORDER_STATUS_FILTER,
  ORDER_STATUSES,
  PAYMENT_EXCEPTION_REASONS,
  PAYMENT_EXCEPTION_REASON_LABELS,
} from '@/lib/orders/order-payment-types';

/** アプリの値と DB の enum・CHECK 制約がずれないことを、マイグレーションの本文で確かめる。 */
function migration(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

/** 本番に当てる時に版の頭の数字が付け替わる移行は、名前の後ろで探す */
function migrationEndingWith(suffix: string): string {
  const directory = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(directory, files[0]), 'utf8');
}

describe('注文と支払いの値', () => {
  it('注文の状態は DB の enum と同じ7つ', () => {
    const initial = migration('20260901102912_remote_schema.sql');
    const added = migration('20260927100000_add_order_payment_statuses.sql');
    for (const status of ORDER_STATUSES) {
      expect(`${initial}\n${added}`).toContain(`'${status}'`);
    }
    expect(ORDER_STATUSES).toHaveLength(7);
  });

  it('要対応の理由と取消の理由は DB の CHECK と同じ', () => {
    // 理由の CHECK は、返金の移行 C（20261011223453_order_refund_results.sql）が名前を付けて作り直し、refund_failed を足した
    const refundResults = migrationEndingWith('_order_refund_results.sql');
    const exceptions = `${migration('20260927100500_payment_exceptions.sql')}\n${refundResults}`;
    const columns = migration('20260927100100_order_payment_columns.sql');
    expect(refundResults).toContain('payment_exceptions_reason_check');
    for (const reason of PAYMENT_EXCEPTION_REASONS) {
      expect(exceptions).toContain(`'${reason}'`);
    }
    for (const reason of CANCEL_REASONS) {
      expect(columns).toContain(`'${reason}'`);
    }
  });

  it('要対応の理由は7つで、最後が返金の失敗。どの理由にも名前がある（グループ E-2 設計書 9-4）', () => {
    expect(PAYMENT_EXCEPTION_REASONS).toHaveLength(7);
    expect(PAYMENT_EXCEPTION_REASONS[PAYMENT_EXCEPTION_REASONS.length - 1]).toBe('refund_failed');
    expect(PAYMENT_EXCEPTION_REASON_LABELS.refund_failed).toBe('返金の失敗');
    expect(Object.keys(PAYMENT_EXCEPTION_REASON_LABELS)).toEqual([...PAYMENT_EXCEPTION_REASONS]);
  });

  it('お客様の画面と KPI から除く状態を PostgREST の not.in の形で持つ', () => {
    expect(HIDDEN_ORDER_STATUS_FILTER).toBe('(payment_in_progress,abandoned)');
  });
});
