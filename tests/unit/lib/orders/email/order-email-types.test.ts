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
  type CanceledEmailVariant,
  type OrderEmailVariant,
  type OrderEmailPauseReason,
  type OrderEmailSkipReason,
  type OrderEmailFailureCategory,
  type RefundEmailVariant,
} from '@/lib/orders/email/order-email-types';
import type { PaidEmailVariant } from '@/lib/orders/order-payment-types';

/**
 * アプリの値と DB の CHECK・関数の入力制限がずれないことを、移行の本文で確かめる。
 * - 状態・配達の状態・一時停止の理由・失敗の分類・原因の記号・配達の問題の索引: グループ D の移行（20261009095633）
 * - メールの種類・書き分けの CHECK（返品のメール4種類と、返金のお知らせの返品の書き分けを足した）:
 *   グループ E-3 の移行 A（20261012235910）
 * - 再送できる状態の表（request_order_email_resend）、取りやめの理由（skip_order_email。発送ごとのメールで理由を足した E-1 の移行 B を、
 *   失敗・エラーになった返金の行の取りやめを足して作り直した関数を、E-3 が返品のメールの扱いを足して作り直した）:
 *   グループ E-3 の移行 C（20261013001143）
 * - 取消した返品の受付のお知らせの原因 return_cancelled は、返品の取消で DB が直に書く記号（グループ E-3 の移行 B）。
 *   worker が skip_order_email に渡す取りやめの理由ではないので、移行は読まず、アプリが名前を持つことだけを確かめる
 * 本番へ当てて版を改名したら、ここの名前も直す。
 */
const outboxMigration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261009095633_order_email_outbox.sql'), 'utf8',
);
// 行の説明にも関数名や許可の表の例が出るので、説明は外してから読む
const returnRecordsMigration = fs
  .readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012235910_order_return_records.sql'), 'utf8')
  .replace(/--.*$/gm, '');
const returnReceiptsMigration = fs
  .readFileSync(path.join(process.cwd(), 'supabase/migrations/20261013001143_order_return_receipts.sql'), 'utf8')
  .replace(/--.*$/gm, '');

function sqlValues(pattern: RegExp, sql = outboxMigration): string[] {
  const values = sql.match(pattern)?.[1];
  expect(values).toBeDefined();
  return [...(values ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

/** 関数の本文。`CREATE [OR REPLACE] FUNCTION <名前>(` の次から、最初の `$$;` まで */
function functionBody(sql: string, qualifiedName: string): string {
  const header = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${qualifiedName.replace('.', '[.]')} *[(]`);
  const body = sql.split(header)[1]?.split('$$;')[0];
  expect(body).toBeDefined();
  return body as string;
}

/**
 * 書き分けの CHECK（order_email_outbox_variant_check）から、種類ごとの書き分けを集める。
 * 1つの枝は `(kind = '種類' AND variant IS NOT NULL AND variant IN ('値', …))` の形。1つの種類に枝が複数あれば和を取る。
 * 書き分けの無い種類（`variant IS NULL` の枝）は集めない
 */
function variantsByKind(sql: string): Record<string, string[]> {
  const check = sql.split(/CONSTRAINT order_email_outbox_variant_check\s+CHECK/)[1]?.split(';')[0];
  expect(check).toBeDefined();
  const byKind: Record<string, Set<string>> = {};
  for (const branch of (check as string).matchAll(/kind = '([a-z_]+)'[^)]*?variant IN \(([^)]+)\)/g)) {
    const values = byKind[branch[1]] ?? new Set<string>();
    for (const value of branch[2].matchAll(/'([^']+)'/g)) values.add(value[1]);
    byKind[branch[1]] = values;
  }
  return Object.fromEntries(Object.entries(byKind).map(([kind, values]) => [kind, [...values].sort()]));
}

describe('注文のメールの種類と名前', () => {
  it('メールの種類・状態・配達の状態は DB の CHECK と同じ値', () => {
    // 種類は、返品のメール4種類を足した移行 A の CHECK（order_email_outbox_kind_check）から読む
    expect([...ORDER_EMAIL_KINDS].sort()).toEqual(
      sqlValues(/CONSTRAINT order_email_outbox_kind_check\s+CHECK\s*\(\s*kind IN \(([^)]+)\)/, returnRecordsMigration),
    );
    expect([...ORDER_EMAIL_STATUSES].sort()).toEqual(sqlValues(/CHECK\s*\(status IN \(([^)]+)\)/));
    expect([...ORDER_EMAIL_DELIVERY_STATUSES].sort()).toEqual(sqlValues(/delivery_status IN \(([^)]+)\)/));
  });

  it('書き分けと一時停止の理由は DB の CHECK と同じ値', () => {
    // 型だけの値も Record で全件を並べ、型の増減と DB の増減を両方検知する。
    // 書き分けは種類ごとの和（支払い済み・取消・返金）に分けて並べ、3つを合わせた Record が OrderEmailVariant の全件になることも型で確かめる
    const paidVariants: Record<PaidEmailVariant, true> = {
      order_confirmed: true, payment_received: true, payment_received_after_expiry: true,
    };
    const canceledVariants: Record<CanceledEmailVariant, true> = { payment_in_progress: true, pending: true, paid: true };
    const refundVariants: Record<RefundEmailVariant, true> = { standard: true, after_cancel: true, return: true };
    const variants: Record<OrderEmailVariant, true> = { ...paidVariants, ...canceledVariants, ...refundVariants };
    const pauseReasons: Record<OrderEmailPauseReason, true> = {
      config_api_key: true, config_sender_domain: true, config_provider: true, quota_daily: true, quota_monthly: true,
    };
    // 書き分けは、返金のお知らせの返品の書き分けを足した移行 A の CHECK（order_email_outbox_variant_check）から、種類ごとに読む。
    // 返品のメール4種類は書き分けを持たない（variant IS NULL の枝なので集めない）
    const sqlVariants = variantsByKind(returnRecordsMigration);
    expect(sqlVariants).toEqual({
      paid: Object.keys(paidVariants).sort(),
      canceled: Object.keys(canceledVariants).sort(),
      refund: Object.keys(refundVariants).sort(),
    });
    expect(Object.keys(variants).sort()).toEqual(Object.values(sqlVariants).flat().sort());
    expect(Object.keys(pauseReasons).sort()).toEqual(sqlValues(/reason IN \(([^)]+)\)/));
  });

  it('取りやめの理由・失敗の分類は DB の関数の入力制限と同じ値', () => {
    const skipReasons: Record<OrderEmailSkipReason, true> = { superseded: true, no_recipient: true, fulfillment_cancelled: true };
    const categories: Record<OrderEmailFailureCategory, true> = { transient: true, config: true, permanent: true };
    // 取りやめの理由は、一番新しい関数（E-3 の移行 C）から読む。失敗の分類は変わっていないグループ D の移行から読む。
    // return_cancelled（返品の取消で DB が直に書く記号）は、worker が渡す理由ではないので、ここには入れない
    const sqlSkipReasons = sqlValues(/_reason NOT IN \(([^)]+)\)/, functionBody(returnReceiptsMigration, 'public.skip_order_email'));
    expect(Object.keys(skipReasons).sort()).toEqual(sqlSkipReasons);
    // 取りやめの理由は、履歴に出す原因の記号でもある。DB が受ける理由は、アプリが名前を持つ記号だけ
    for (const reason of sqlSkipReasons) expect(isOrderEmailErrorCode(reason)).toBe(true);
    expect(Object.keys(categories).sort()).toEqual(
      sqlValues(/_category NOT IN \(([^)]+)\)/, functionBody(outboxMigration, 'public.fail_order_email')),
    );
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
      refund: '返金のお知らせ',
      // 返品のメール（グループ E-3 計画 C-5 の「メールの種類の名前」）
      return_accepted: '返品の受付のお知らせ', return_received: '返品の受け取りのお知らせ',
      return_sent_back: '品物のお返しのお知らせ', return_refund_pending_shop: '店への知らせ（返金待ち）',
    });
  });

  it('原因の記号にはすべて日本語の名前がある。宛先の形の不正は「宛先の形が不正」、発送の取消は「発送の取消」、返品の取消は「返品の取消」', () => {
    for (const code of ORDER_EMAIL_ERROR_CODES) expect(ORDER_EMAIL_ERROR_LABELS[code]).toEqual(expect.any(String));
    expect(ORDER_EMAIL_ERROR_LABELS.invalid_message).toBe('宛先の形が不正');
    expect(ORDER_EMAIL_ERROR_LABELS.provider_unavailable).toBe('送信サービスの一時的な失敗');
    expect(ORDER_EMAIL_ERROR_LABELS.fulfillment_cancelled).toBe('発送の取消');
    // 取消した返品の、まだ送っていない受付のお知らせは、DB が last_error_code = 'return_cancelled' で取りやめにする（グループ E-3 設計書 7-3）
    expect(ORDER_EMAIL_ERROR_LABELS.return_cancelled).toBe('返品の取消');
  });

  it('再送できる注文の状態は DB の request_order_email_resend と同じ表（発送のメールは、一部だけ送った間の決済完了でも再送できる。返金のお知らせと返品のメール4種類は再送しない）', () => {
    expect(RESENDABLE_ORDER_STATUSES).toEqual({
      paid: ['paid', 'shipped'], awaiting_payment: ['pending'], payment_expired: ['failed'], canceled: ['cancelled'],
      shipped: ['paid', 'shipped'], refund: [],
      return_accepted: [], return_received: [], return_sent_back: [], return_refund_pending_shop: [],
    });

    // 移行 C の関数の許可の表を読んで突き合わせる。1つの種類は
    // `(_kind = '種類' AND v_status IN ('状態', ...))` か `(_kind = '種類' AND v_status = '状態')` の形で書いてある。
    // 再送できない種類（返金のお知らせ・返品のメール4種類）は、表に組が1つも無い
    const sqlMatrix: Record<string, string[]> = {};
    for (const match of functionBody(returnReceiptsMigration, 'public.request_order_email_resend').matchAll(
      /\(_kind = '([a-z_]+)' AND v_status (?:IN \(([^)]+)\)|= '([a-z_]+)')\)/g,
    )) {
      sqlMatrix[match[1]] = (match[2] ? [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1]) : [match[3]]).sort();
    }
    const appMatrix = Object.fromEntries(
      ORDER_EMAIL_KINDS
        .filter((kind) => RESENDABLE_ORDER_STATUSES[kind].length > 0)
        .map((kind) => [kind, [...RESENDABLE_ORDER_STATUSES[kind]].sort()]),
    );
    expect(sqlMatrix).toEqual(appMatrix);
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
    expect(isOrderEmailKind('refund')).toBe(true);
    for (const kind of ['return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop']) {
      expect(isOrderEmailKind(kind)).toBe(true);
    }
    expect(isOrderEmailKind('refunded')).toBe(false);
    expect(isOrderEmailKind('return')).toBe(false);
    expect(isOrderEmailErrorCode('lease_expired')).toBe(true);
    expect(isOrderEmailErrorCode('return_cancelled')).toBe(true);
    expect(isOrderEmailErrorCode('Error: boom')).toBe(false);
  });
});
