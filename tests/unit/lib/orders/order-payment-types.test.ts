import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_REASONS,
  CANCEL_REASON_LABELS,
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
    const columns = migrationEndingWith('_order_cancel_reasons.sql');
    expect(refundResults).toContain('payment_exceptions_reason_check');
    for (const reason of PAYMENT_EXCEPTION_REASONS) {
      expect(exceptions).toContain(`'${reason}'`);
    }
    for (const reason of CANCEL_REASONS) {
      expect(columns).toContain(`'${reason}'`);
    }
  });

  it('取消の理由と表示は決定した6つの順番で、2つの値CHECKと現行3関数が同じ値を検証する', () => {
    const reasons = ['customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other'];
    expect(CANCEL_REASONS).toEqual(reasons);
    expect(Object.values(CANCEL_REASON_LABELS)).toEqual(['お客様の都合', '支払いの拒否', '不正', '在庫切れ', 'お店の誤り', 'その他']);
    const sql = migrationEndingWith('_order_cancel_reasons.sql');
    for (const constraint of ['orders_cancel_reason_check', 'order_refunds_cancel_reason_value_check']) {
      const check = sql.match(new RegExp(`ADD CONSTRAINT ${constraint} CHECK \\([\\s\\S]*?cancel_reason IN \\(([^)]*)\\)`));
      expect(check).not.toBeNull();
      expect(check![1].match(/'[^']+'/g)?.map((value) => value.slice(1, -1))).toEqual(reasons);
    }
    for (const name of ['public.admin_cancel_failed_order', 'public.release_stock_for_unpaid_order', 'private.begin_order_refund_core']) {
      const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`)).split('$$;')[0];
      const validation = body.match(/_cancel_reason NOT IN \(([^)]*)\)/);
      expect(validation).not.toBeNull();
      expect(validation![1].match(/'[^']+'/g)?.map((value) => value.slice(1, -1))).toEqual(reasons);
      expect(body).toContain("SET search_path = ''");
    }
    expect(sql).not.toMatch(/(?:DROP|ADD) CONSTRAINT order_refunds_cancel_reason_check\b/);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.begin_order_refund(');
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
