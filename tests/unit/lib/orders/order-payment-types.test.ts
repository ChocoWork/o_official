import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_REASONS,
  HIDDEN_ORDER_STATUS_FILTER,
  ORDER_STATUSES,
  PAYMENT_EXCEPTION_REASONS,
} from '@/lib/orders/order-payment-types';

/** アプリの値と DB の enum・CHECK 制約がずれないことを、マイグレーションの本文で確かめる。 */
function migration(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
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
    const exceptions = migration('20260927100500_payment_exceptions.sql');
    const columns = migration('20260927100100_order_payment_columns.sql');
    for (const reason of PAYMENT_EXCEPTION_REASONS) {
      expect(exceptions).toContain(`'${reason}'`);
    }
    for (const reason of CANCEL_REASONS) {
      expect(columns).toContain(`'${reason}'`);
    }
  });

  it('お客様の画面と KPI から除く状態を PostgREST の not.in の形で持つ', () => {
    expect(HIDDEN_ORDER_STATUS_FILTER).toBe('(payment_in_progress,abandoned)');
  });
});
