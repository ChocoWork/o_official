import fs from 'node:fs';
import path from 'node:path';
import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  isOrderEmailKind,
  ORDER_EMAIL_ERROR_CODES,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  ORDER_EMAIL_KINDS,
  ORDER_EMAIL_STATUSES,
  ORDER_EMAIL_DELIVERY_STATUSES,
  DELIVERY_PROBLEM_STATUSES,
  RESENDABLE_ORDER_STATUSES,
  type OrderEmailVariant,
  type OrderEmailPauseReason,
  type OrderEmailSkipReason,
  type OrderEmailFailureCategory,
} from '@/lib/orders/email/order-email-types';

/** アプリの値と DB の CHECK・関数の入力制限がずれないことを、移行の本文で確かめる。 */
const outboxMigration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261009120000_order_email_outbox.sql'), 'utf8',
);

function sqlValues(pattern: RegExp, sql = outboxMigration): string[] {
  const values = sql.match(pattern)?.[1];
  expect(values).toBeDefined();
  return [...(values ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

describe('注文のメールの種類と名前', () => {
  it('メールの種類・状態・配達の状態は DB の CHECK と同じ値', () => {
    expect([...ORDER_EMAIL_KINDS].sort()).toEqual(sqlValues(/CHECK\s*\(kind IN \(([^)]+)\)/));
    expect([...ORDER_EMAIL_STATUSES].sort()).toEqual(sqlValues(/CHECK\s*\(status IN \(([^)]+)\)/));
    expect([...ORDER_EMAIL_DELIVERY_STATUSES].sort()).toEqual(sqlValues(/delivery_status IN \(([^)]+)\)/));
  });

  it('書き分けと一時停止の理由は DB の CHECK と同じ値', () => {
    // 型だけの値も Record で全件を並べ、型の増減と DB の増減を両方検知する。
    const variants: Record<OrderEmailVariant, true> = {
      order_confirmed: true, payment_received: true, payment_received_after_expiry: true, payment_in_progress: true, pending: true,
    };
    const pauseReasons: Record<OrderEmailPauseReason, true> = {
      config_api_key: true, config_sender_domain: true, config_provider: true, quota_daily: true, quota_monthly: true,
    };
    const paidVariants = sqlValues(/kind = 'paid'[\s\S]*?variant IN \(([^)]+)\)/);
    const canceledVariants = sqlValues(/kind = 'canceled'[\s\S]*?variant IN \(([^)]+)\)/);
    expect(Object.keys(variants).sort()).toEqual([...paidVariants, ...canceledVariants].sort());
    expect(Object.keys(pauseReasons).sort()).toEqual(sqlValues(/reason IN \(([^)]+)\)/));
  });

  it('取りやめの理由・失敗の分類は DB の関数の入力制限と同じ値', () => {
    const skipReasons: Record<OrderEmailSkipReason, true> = { superseded: true, no_recipient: true };
    const categories: Record<OrderEmailFailureCategory, true> = { transient: true, config: true, permanent: true };
    const skipFunction = outboxMigration.split('CREATE OR REPLACE FUNCTION public.skip_order_email')[1]?.split('$$;')[0];
    const failFunction = outboxMigration.split('CREATE OR REPLACE FUNCTION public.fail_order_email')[1]?.split('$$;')[0];
    expect(skipFunction).toBeDefined();
    expect(failFunction).toBeDefined();
    expect(Object.keys(skipReasons).sort()).toEqual(sqlValues(/_reason NOT IN \(([^)]+)\)/, skipFunction));
    expect(Object.keys(categories).sort()).toEqual(sqlValues(/_category NOT IN \(([^)]+)\)/, failFunction));
  });

  it('原因の記号は DB の CHECK の形を満たし、配達の問題の一覧は DB の索引と同じ値', () => {
    const errorPattern = outboxMigration.match(/last_error_code ~ '([^']+)'/)?.[1];
    expect(errorPattern).toBeDefined();
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(code).toMatch(new RegExp(errorPattern as string));
    expect([...DELIVERY_PROBLEM_STATUSES].sort()).toEqual(sqlValues(/WHERE delivery_status IN \(([^)]+)\)/));
  });

  it('種類の名前は設計書のとおり', () => {
    expect(ORDER_EMAIL_KIND_LABELS).toEqual({
      paid: '注文確認', awaiting_payment: '入金待ち', payment_expired: '支払い期限切れ', canceled: '取消', shipped: '発送',
    });
  });

  it('原因の記号にはすべて日本語の名前がある。宛先の形の不正は「宛先の形が不正」', () => {
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(ORDER_EMAIL_ERROR_LABELS[code]).toEqual(expect.any(String));
    expect(ORDER_EMAIL_ERROR_LABELS.invalid_message).toBe('宛先の形が不正');
    expect(ORDER_EMAIL_ERROR_LABELS.provider_unavailable).toBe('送信サービスの一時的な失敗');
  });

  it('再送できる注文の状態は DB の request_order_email_resend と同じ表', () => {
    expect(RESENDABLE_ORDER_STATUSES).toEqual({
      paid: ['paid', 'shipped'], awaiting_payment: ['pending'], payment_expired: ['failed'], canceled: ['cancelled'], shipped: ['shipped'],
    });
  });

  it.each([
    ['pending', null, '送信待ち', false],
    ['sending', null, '送信待ち', false],
    ['retry_wait', null, 'やり直し待ち', false],
    ['sent', null, '送信済み', false],
    ['sent', 'delivered', '配達済み', false],
    ['sent', 'delayed', '配達の遅れ', false],
    ['sent', 'bounced', '届かなかった', true],
    ['sent', 'complained', '迷惑メールにされた', true],
    ['sent', 'suppressed', '送信先が止められている', true],
    ['sent', 'failed', '送信サービスで送れなかった', true],
    ['skipped', null, '取りやめ', false],
    ['dead', null, '送れなかった', true],
  ] as const)('%s・%s は「%s」（注意の印 %s）', (status, delivery, label, warning) => {
    expect(describeOrderEmailState(status, delivery)).toEqual({ label, warning });
  });

  it('種類と原因の記号を見分ける', () => {
    expect(isOrderEmailKind('shipped')).toBe(true);
    expect(isOrderEmailKind('refund')).toBe(false);
    expect(isOrderEmailErrorCode('lease_expired')).toBe(true);
    expect(isOrderEmailErrorCode('Error: boom')).toBe(false);
  });
});
