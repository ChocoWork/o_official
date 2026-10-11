import fs from 'node:fs';
import path from 'node:path';
import {
  derivePaymentStatus,
  PAYMENT_STATUS_KEYS,
  PAYMENT_STATUS_LABELS,
  REFUND_FAILED_BADGE,
  REFUND_PENDING_BADGE,
} from '@/lib/orders/payment-status';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';

describe('支払いの言葉と小さな印', () => {
  it('6つの言葉と2つの印は設計書のとおり', () => {
    expect([...PAYMENT_STATUS_KEYS]).toEqual(['unpaid', 'failed', 'none', 'paid', 'partially_refunded', 'refunded']);
    expect(PAYMENT_STATUS_LABELS).toEqual({
      unpaid: '未入金',
      failed: '支払いの失敗',
      none: '支払いなし',
      paid: '支払い済み',
      partially_refunded: '一部返金',
      refunded: '返金済み',
    });
    expect(Object.keys(PAYMENT_STATUS_LABELS)).toEqual([...PAYMENT_STATUS_KEYS]);
    expect(REFUND_PENDING_BADGE).toBe('返金の手続き中');
    expect(REFUND_FAILED_BADGE).toBe('返金の失敗');
  });
});

describe('derivePaymentStatus（上の決まりから順に当てはめて、最初に当たった1つ）', () => {
  it.each([
    ['決まり1-a: 支払い手続き中は未入金（受け取った額が空でも）', 'payment_in_progress', null, 0, 'unpaid'],
    ['決まり1-b: 未決済は未入金（受け取った額が入っていても、決まり1が先）', 'pending', 5000, 0, 'unpaid'],
    ['決まり2: 失敗は支払いの失敗（受け取った額が入っていても、決まり2が先）', 'failed', 5000, 0, 'failed'],
    ['決まり3: 放棄は支払いなし（受け取った額が入っていても、決まり3が先）', 'abandoned', 5000, 0, 'none'],
    ['決まり4-a: 受け取った額が空（未入金のまま取消）は支払いなし', 'cancelled', null, 0, 'none'],
    ['決まり4-b: 受け取った額が0は支払いなし', 'paid', 0, 0, 'none'],
    ['決まり5-a: 支払い済みで返金が0は支払い済み', 'paid', 5000, 0, 'paid'],
    ['決まり5-b: 発送済みで返金が0も支払い済み', 'shipped', 5000, 0, 'paid'],
    ['決まり6-a: 返金が0より多く全額より少なければ一部返金', 'paid', 5000, 1, 'partially_refunded'],
    ['決まり6-b: 全額の1円手前まで返金しても一部返金', 'shipped', 5000, 4999, 'partially_refunded'],
    ['決まり7-a: 返金が全額に届けば返金済み', 'cancelled', 5000, 5000, 'refunded'],
    ['決まり7-b: 返金が受け取った額を超えていても返金済み', 'cancelled', 5000, 5001, 'refunded'],
  ] as const)('%s', (_name, status, paidAmount, refundedAmount, expected) => {
    expect(derivePaymentStatus({ status, paidAmount, refundedAmount })).toBe(expected);
  });

  it('どの注文の状態でも、6つの言葉のどれかになる（例外を投げない）', () => {
    for (const status of ORDER_STATUSES) {
      for (const paidAmount of [null, 0, 5000]) {
        for (const refundedAmount of [0, 2500, 5000]) {
          expect(PAYMENT_STATUS_KEYS).toContain(derivePaymentStatus({ status, paidAmount, refundedAmount }));
        }
      }
    }
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/payment-status.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/order-payment-types']);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
