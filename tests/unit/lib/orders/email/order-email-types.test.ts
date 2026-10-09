import {
  describeOrderEmailState,
  isOrderEmailErrorCode,
  isOrderEmailKind,
  ORDER_EMAIL_ERROR_CODES,
  ORDER_EMAIL_ERROR_LABELS,
  ORDER_EMAIL_KIND_LABELS,
  RESENDABLE_ORDER_STATUSES,
} from '@/lib/orders/email/order-email-types';

describe('注文のメールの種類と名前', () => {
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
