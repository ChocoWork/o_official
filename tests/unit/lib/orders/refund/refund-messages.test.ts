import fs from 'node:fs';
import path from 'node:path';
import {
  INVALID_REQUEST_BODY,
  INVALID_REQUEST_MESSAGE,
  REFUND_ERROR_MESSAGES,
  REFUND_FAILURE_MESSAGES,
  REFUND_FAILURE_REASON_LABELS,
  REFUND_SOURCE_LABELS,
  REFUND_STATUS_LABELS,
  STRIPE_REFUND_REASON_LABELS,
  UNKNOWN_REFUND_OUTCOME_MESSAGE,
  formatYen,
  konbiniDeadlineLastDay,
  refundErrorBody,
  refundFailureBody,
  refundFailureReasonLabel,
  refundTimingNote,
  stripeRejectedBody,
  unknownOutcomeBody,
} from '@/lib/orders/refund/refund-messages';
import {
  ORDER_REFUND_SOURCES,
  ORDER_REFUND_STATUSES,
  REFUND_ERROR_CODES,
  STRIPE_REFUND_REASONS,
  type RefundPaymentMethod,
} from '@/lib/orders/refund/refund-types';
import { formatCurrency } from '@/lib/orders/order-confirmation-email';

const REFUND_ID = 'd1b2c3d4-1111-4222-8333-444455556666';

// 共通の約束 C-2 の表。言葉を直す時は、画面と文書の言葉も一緒に直すため、ここは1字も変えずに写す
const EXPECTED = [
  ['order_not_found', 404, '注文が見つかりません。'],
  ['order_not_refundable', 409, 'この注文は返金できません。'],
  ['order_not_cancellable', 409, '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。'],
  ['awaiting_refund_exists', 409, '確かめ中の返金があります。先に確かめてください。'],
  ['refund_request_mismatch', 409, '画面を開き直してから、もう一度返金してください。'],
  ['refund_line_not_in_order', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['quantity_exceeds_unshipped', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['quantity_exceeds_shipped', 409, '返金できる数を超えています。画面を開き直してください。'],
  ['shipping_exceeds', 409, '返せる送料を超えています。'],
  ['exceeds_refundable', 409, '返せる額を超えています。'],
  ['must_include_unshipped', 409, '全額を返金する時は、まだ発送していない商品もすべて選んでください。'],
  ['must_be_full', 409, 'まだ発送していない注文の商品を全部返す時は、送料と返金額も全部返してください。'],
  ['invalid_argument', 400, '入力を確かめてください。'],
] as const;

describe('返金の記号', () => {
  it('返金の道・状態・Stripe に伝える理由は Global Constraints のとおり', () => {
    expect([...ORDER_REFUND_SOURCES]).toEqual([
      'admin', 'order_cancel', 'stripe_dashboard', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'legacy', 'return',
    ]);
    expect([...ORDER_REFUND_STATUSES]).toEqual(['awaiting_response', 'error', 'pending', 'succeeded', 'failed']);
    expect([...STRIPE_REFUND_REASONS]).toEqual(['requested_by_customer', 'duplicate', 'fraudulent']);
  });

  it('窓口が返す13の誤りの記号は共通の約束のとおり', () => {
    expect([...REFUND_ERROR_CODES]).toEqual([
      'order_not_found', 'order_not_refundable', 'order_not_cancellable', 'awaiting_refund_exists', 'refund_request_mismatch',
      'refund_line_not_in_order', 'quantity_exceeds_unshipped', 'quantity_exceeds_shipped', 'shipping_exceeds',
      'exceeds_refundable', 'must_include_unshipped', 'must_be_full', 'invalid_argument',
    ]);
  });
});

describe('誤りの記号ごとの HTTP と言葉', () => {
  it.each(EXPECTED)('%s は %i、言葉は「%s」', (code, status, message) => {
    expect(REFUND_ERROR_MESSAGES[code]).toEqual({ status, message });
    expect(refundErrorBody(code)).toEqual({ error: message, code });
  });

  it('表は誤りの記号を過不足なく持つ（記号を足したら言葉と HTTP も要る）', () => {
    const codes = [...REFUND_ERROR_CODES].sort();

    expect(EXPECTED.map(([code]) => code).sort()).toEqual(codes);
    expect(Object.keys(REFUND_ERROR_MESSAGES).sort()).toEqual(codes);
  });
});

describe('入力の誤り・失敗・Stripe の断り・答えが分からない時の言葉', () => {
  it('入力の誤りは 400 の窓口で、記号は invalid_request', () => {
    expect(INVALID_REQUEST_MESSAGE).toBe('入力を確かめてください。');
    expect(INVALID_REQUEST_BODY).toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
  });

  it('失敗（500）の言葉は窓口ごとに違い、記号は failed', () => {
    expect(REFUND_FAILURE_MESSAGES).toEqual({
      create: '返金の記録に失敗しました。',
      cancel: '注文のキャンセルに失敗しました。',
      materials: '返金の材料を読み込めませんでした。',
      settings: 'ショップの設定を読み込めませんでした。',
      settings_update: 'ショップの設定を保存できませんでした。',
    });
    expect(refundFailureBody('cancel')).toEqual({ error: '注文のキャンセルに失敗しました。', code: 'failed' });
    expect(refundFailureBody('settings_update')).toEqual({ error: 'ショップの設定を保存できませんでした。', code: 'failed' });
  });

  it('Stripe の断り（422）は、理由があれば括弧で添える。理由が無い・空なら添えない', () => {
    expect(stripeRejectedBody('カード会社に断られました')).toEqual({
      error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。',
      code: 'stripe_rejected',
    });
    expect(stripeRejectedBody(null)).toEqual({ error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected' });
    expect(stripeRejectedBody('')).toEqual({ error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected' });
  });

  it('答えが分からない時（502）の言葉は Global Constraints のとおり。返金の番号を添える', () => {
    expect(UNKNOWN_REFUND_OUTCOME_MESSAGE).toBe(
      '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
    );
    expect(unknownOutcomeBody(REFUND_ID)).toEqual({
      error: UNKNOWN_REFUND_OUTCOME_MESSAGE,
      code: 'unknown_outcome',
      refundId: REFUND_ID,
    });
  });
});

describe('ラベルの表', () => {
  it('返金の状態の言葉（履歴の状態の移り変わり）', () => {
    expect(REFUND_STATUS_LABELS).toEqual({
      awaiting_response: '返事待ち', error: 'エラー', pending: '保留', succeeded: '成功', failed: '失敗',
    });
    expect(Object.keys(REFUND_STATUS_LABELS)).toEqual([...ORDER_REFUND_STATUSES]);
  });

  it('返金の道の言葉（履歴の「どこから」）', () => {
    expect(REFUND_SOURCE_LABELS).toEqual({
      admin: '管理画面',
      order_cancel: '注文のキャンセル',
      stripe_dashboard: 'Stripe の画面',
      auto_cancelled_order_payment: '自動の返金（取り消した注文への入金）',
      auto_amount_mismatch: '自動の取消（支払額の違い）',
      legacy: '前からの写し',
      // 履歴の返金の行は、返品の番号が引ければ「返品（{番号}）」と出す。この言葉は、番号が引けない時の言葉
      return: '返品',
    });
    expect(Object.keys(REFUND_SOURCE_LABELS)).toEqual([...ORDER_REFUND_SOURCES]);
  });

  it('Stripe に伝える理由の言葉', () => {
    expect(STRIPE_REFUND_REASON_LABELS).toEqual({
      requested_by_customer: 'お客様の希望', duplicate: '重複した支払い', fraudulent: '不正の疑い',
    });
    expect(Object.keys(STRIPE_REFUND_REASON_LABELS)).toEqual([...STRIPE_REFUND_REASONS]);
  });

  it('返金の失敗の理由の言葉。unknown は「不明な理由」', () => {
    expect(REFUND_FAILURE_REASON_LABELS).toEqual({
      expired_or_canceled_card: 'カードが使えません',
      lost_or_stolen_card: 'カードが使えません',
      declined: 'カード会社に断られました',
      insufficient_funds: 'Stripe の残高が足りません',
      merchant_request: '店が取り消しました',
      expired: '口座の入力の期限が過ぎました',
      charge_for_pending_refund_disputed: '異議申し立てがありました',
      not_found_in_stripe: 'Stripe に届きませんでした',
      stripe_rejected: 'Stripe が受け付けませんでした',
      unknown: '不明な理由',
    });
  });
});

describe('refundFailureReasonLabel（失敗の理由を安全に言葉にする）', () => {
  it.each([
    ['expired_or_canceled_card', 'カードが使えません'],
    ['lost_or_stolen_card', 'カードが使えません'],
    ['declined', 'カード会社に断られました'],
    ['insufficient_funds', 'Stripe の残高が足りません'],
    ['merchant_request', '店が取り消しました'],
    ['expired', '口座の入力の期限が過ぎました'],
    ['charge_for_pending_refund_disputed', '異議申し立てがありました'],
    ['not_found_in_stripe', 'Stripe に届きませんでした'],
    ['stripe_rejected', 'Stripe が受け付けませんでした'],
    ['unknown', '不明な理由'],
  ])('%s は %s', (reason, expected) => {
    expect(refundFailureReasonLabel(reason)).toBe(expected);
  });

  it.each(['new_reason', null, undefined, '', 'constructor'])('%s は不明な理由（表の外や空、継承した欄を返さない）', (reason) => {
    expect(refundFailureReasonLabel(reason)).toBe('不明な理由');
  });
});

describe('refundTimingNote（お金が戻る時期の案内）', () => {
  it.each([
    ['card', 'お金はカード会社によって、5〜10営業日ほどで戻ります。'],
    ['link', 'お金はカード会社によって、5〜10営業日ほどで戻ります。'],
    ['paypay', 'お金は PayPay 残高にすぐ戻ります。'],
    ['konbini', 'コンビニ払いの返金は、お客様に返金先の口座を入れてもらう必要があります（Stripe からお客様にメールが届きます。45日以内）。'],
    ['unknown', 'お金が戻るまでの日数は、お支払いの方法によって異なります。'],
  ] as const satisfies ReadonlyArray<readonly [RefundPaymentMethod, string]>)('%s', (method, note) => {
    expect(refundTimingNote(method)).toBe(note);
  });
});

describe('formatYen（金額の書き方。ブラウザの画面で使う）', () => {
  it.each([
    [1000, '￥1,000'],
    [0, '￥0'],
    [8500, '￥8,500'],
    [1234567, '￥1,234,567'],
  ])('%i は %s', (amount, expected) => {
    expect(formatYen(amount)).toBe(expected);
  });

  it('全角の ￥（U+FFE5）で書き、半角の ¥（U+00A5）は使わない', () => {
    expect(formatYen(1000).charCodeAt(0)).toBe(0xffe5);
    expect(formatYen(1000)).not.toContain('¥');
  });

  it('メールとサーバーの formatCurrency(amount, "jpy") と同じ出力（画面とメールで金額の書き方が食い違わない）', () => {
    for (const amount of [0, 1, 999, 1000, 4055, 8500, 1234567]) {
      expect(formatYen(amount)).toBe(formatCurrency(amount, 'jpy'));
    }
  });
});

describe('konbiniDeadlineLastDay（コンビニ払いの口座の入力の期限の日付）', () => {
  it.each([
    ['2026-11-24T15:30:00.000Z', { year: 2026, month: 11, day: 24 }],
    ['2026-11-25T14:59:59.000Z', { year: 2026, month: 11, day: 25 }],
    ['2026-11-25T15:00:00.000Z', { year: 2026, month: 11, day: 25 }],
    ['2026-12-31T15:00:00.000Z', { year: 2026, month: 12, day: 31 }],
  ])('期限 %s は、その日のうちに入力すれば間に合う最後の日を日本時間で返す', (expiresAt, expected) => {
    expect(konbiniDeadlineLastDay(expiresAt)).toEqual(expected);
  });

  it.each([null, undefined, '', 'invalid-date'])('読めない期限 %s は null', (expiresAt) => {
    expect(konbiniDeadlineLastDay(expiresAt)).toBeNull();
  });
});

describe('画面からも読めること', () => {
  const SCREEN_FILES: Array<[file: string, imports: string[]]> = [
    ['src/lib/orders/refund/refund-types.ts', ['@/lib/orders/order-payment-types']],
    ['src/lib/orders/refund/refund-messages.ts', ['@/lib/orders/refund/refund-types']],
  ];

  it.each(SCREEN_FILES)('%s はサーバーだけの物を import しない（型だけの import に限る）', (file, expected) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(expected);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
