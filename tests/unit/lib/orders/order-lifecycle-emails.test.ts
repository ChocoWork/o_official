const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import {
  sendShopPaymentAlert,
  sendUnplacedPaymentNotice,
  shopAlertNextStep,
} from '@/lib/orders/order-lifecycle-emails';
import { PAYMENT_EXCEPTION_REASONS } from '@/lib/orders/order-payment-types';

/** 注文にならなかった支払いの案内と店への要対応メールを確かめ、個人情報を店へ送らない */
const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const env = process.env as Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue(undefined);
  env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  env.SHOP_ALERT_EMAIL = 'shop@example.com';
});

describe('受付を通らない支払いの案内', () => {
  it('入金済みなら再度の支払いは不要と書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: '山田 花子', state: 'paid' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【Le Fil des Heures】ご注文の確認についてのお知らせ');
    expect(mail.text).toContain('お支払いは受け付けました。');
    expect(mail.text).toContain('再度のお支払いは不要です。');
  });

  it('入金待ちなら支払いを控えるよう書く', async () => {
    await sendUnplacedPaymentNotice({ to: 'hanako@example.com', fullName: null, state: 'awaiting_payment' });

    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.text).toContain('お客様');
    expect(mail.text).toContain('お支払いはお控えください。');
  });
});

describe('店への要対応メール', () => {
  const ALERT = {
    reason: 'paid_amount_mismatch' as const,
    detail: null,
    orderId: ORDER_ID,
    paymentRef: 'cs_test_123',
    detectedAt: new Date('2026-09-27T01:00:00.000Z'),
  };

  /** 返金の失敗の要対応。支払いの参照には Stripe の返金の番号が入る（設計書 8-4） */
  const REFUND_FAILED = {
    reason: 'refund_failed' as const,
    detail: 'expired',
    orderId: ORDER_ID,
    paymentRef: 're_123',
    detectedAt: new Date('2026-10-11T01:00:00.000Z'),
  };

  it('理由・注文番号・Stripe の支払い ID・次にやることを書き、個人情報は入れない', async () => {
    const sent = await sendShopPaymentAlert(ALERT);

    expect(sent).toBe(true);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toBe('shop@example.com');
    expect(mail.subject).toBe('【要対応】支払額の違い');
    expect(mail.text).toContain('注文番号: ORD-A1B2C3D4');
    expect(mail.text).toContain('Stripe の支払い: cs_test_123');
    expect(mail.text).toContain('次にやること:');
    expect(mail.text).not.toContain('hanako@example.com');
    expect(mail.text).not.toContain('山田');
  });

  it('SHOP_ALERT_EMAIL が未設定なら送らない（見回りが後で送り直す）', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete env.SHOP_ALERT_EMAIL;

    try {
      expect(await sendShopPaymentAlert(ALERT)).toBe(false);
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[shop-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    } finally {
      warn.mockRestore();
    }
  });

  it('返金の失敗は、失敗の理由・確保し直せなかった商品・キャンセルのお知らせを送った注文であることを、次にやることの前に書く', async () => {
    // コンビニ払いの返金が45日の期限で失敗し、その間に在庫が売れていた（Review Focus 2）
    const sent = await sendShopPaymentAlert({
      ...REFUND_FAILED,
      refundFailure: {
        failureReasonLabel: '口座の入力の期限が過ぎました',
        shortages: [
          { name: 'シルクブラウス（WHITE / M）', quantity: 2 },
          { name: 'ウールパンツ（L）', quantity: 1 },
        ],
        cancelEmailSent: true,
      },
    });

    expect(sent).toBe(true);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.subject).toBe('【要対応】返金の失敗');
    const lines: string[] = mail.text.split('\n');
    expect(lines).toContain('理由: 返金の失敗（expired）');
    expect(lines).toContain('Stripe の支払い: re_123');
    expect(lines.slice(-6)).toEqual([
      '',
      '失敗の理由: 口座の入力の期限が過ぎました',
      '確保し直せなかった商品: シルクブラウス（WHITE / M） × 2、ウールパンツ（L） × 1',
      'キャンセルのお知らせを送った注文です。お客様への連絡が要ります。',
      '',
      '次にやること: お客様に連絡し、別の方法で返金するか、管理画面からもう一度返金してください。',
    ]);
  });

  it('確保し直せなかった商品が無く、キャンセルのお知らせも送っていなければ、失敗の理由の行だけを書く', async () => {
    await sendShopPaymentAlert({
      ...REFUND_FAILED,
      refundFailure: { failureReasonLabel: 'カード会社に断られました', shortages: [], cancelEmailSent: false },
    });

    const text: string = mockSendMail.mock.calls[0][0].text;
    expect(text.split('\n').slice(-4)).toEqual([
      '',
      '失敗の理由: カード会社に断られました',
      '',
      '次にやること: お客様に連絡し、別の方法で返金するか、管理画面からもう一度返金してください。',
    ]);
    expect(text).not.toContain('確保し直せなかった商品');
    expect(text).not.toContain('キャンセルのお知らせ');
  });

  it('店への知らせを送り直す時（失敗の材料が無い）は、失敗の行を書かず、次にやることだけを書く', async () => {
    await sendShopPaymentAlert(REFUND_FAILED);

    const text: string = mockSendMail.mock.calls[0][0].text;
    expect(text).toContain('理由: 返金の失敗（expired）');
    expect(text).not.toContain('失敗の理由:');
    expect(text.split('\n').slice(-2)).toEqual([
      '',
      '次にやること: お客様に連絡し、別の方法で返金するか、管理画面からもう一度返金してください。',
    ]);
  });

  it.each([
    ['cancelled_order_paid', 'auto_refunded', '自動で全額を返金しました。対応は要りません。'],
    ['cancelled_order_paid', 'auto_refund_failed', '自動の返金ができませんでした。管理画面の注文から返金してください。'],
    ['cancelled_order_paid', undefined, '管理画面の注文から返金してください。'],
    ['paid_amount_mismatch', 'auto_cancelled', '自動で全額を返金し、注文を取り消しました。'],
    [
      'paid_amount_mismatch',
      'auto_cancel_failed',
      '管理画面で差額を返金するか、注文をキャンセルしてください。解決済みにするまで発送できません。',
    ],
  ] as const)('%s に自動の返金の結果 %s が付けば、次にやることに書く', async (reason, automation, expected) => {
    await sendShopPaymentAlert({ ...ALERT, reason, automation });

    expect(mockSendMail.mock.calls[0][0].text).toContain(`次にやること: ${expected}`);
  });
});

describe('shopAlertNextStep（店への知らせの「次にやること」。グループ E-2 設計書 8-4）', () => {
  it('返金の失敗は、お客様への連絡と、別の方法またはもう一度の返金を促す', () => {
    expect(shopAlertNextStep({ reason: 'refund_failed' }, false)).toBe(
      'お客様に連絡し、別の方法で返金するか、管理画面からもう一度返金してください。',
    );
  });

  it.each([
    ['①で返金できた', 'auto_refunded', true, '自動で全額を返金しました。対応は要りません。'],
    ['①で返金できなかった', 'auto_refund_failed', true, '自動の返金ができませんでした。管理画面の注文から返金してください。'],
    ['①がオフ', undefined, false, '管理画面の注文から返金してください。'],
    [
      '①がオンで結果が付いていない（要対応が開いたまま）',
      undefined,
      true,
      '自動の返金ができませんでした。管理画面の注文から返金してください。',
    ],
  ] as const)('取り消した注文への入金: %s', (_name, automation, autoEnabled, expected) => {
    expect(shopAlertNextStep({ reason: 'cancelled_order_paid', automation }, autoEnabled)).toBe(expected);
  });

  it.each([
    ['②で取り消せた', 'auto_cancelled', true, '自動で全額を返金し、注文を取り消しました。'],
    [
      '②で取り消せなかった',
      'auto_cancel_failed',
      true,
      '管理画面で差額を返金するか、注文をキャンセルしてください。解決済みにするまで発送できません。',
    ],
    [
      '②がオフ',
      undefined,
      false,
      '管理画面で差額を返金するか、注文をキャンセルしてください。解決済みにするまで発送できません。',
    ],
  ] as const)('支払額の違い: %s', (_name, automation, autoEnabled, expected) => {
    expect(shopAlertNextStep({ reason: 'paid_amount_mismatch', automation }, autoEnabled)).toBe(expected);
  });

  it('注文を作れない支払いは、管理画面からの返金か、注文の登録を促す', () => {
    expect(shopAlertNextStep({ reason: 'order_not_creatable' }, false)).toBe(
      '支払いを確かめ、管理画面から返金するか、お客様に連絡して注文を登録してください。お客様には確認中の案内を送っています。',
    );
  });

  it.each([
    [
      'state_conflict',
      '管理画面と Stripe の記録で支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
    ],
    [
      'unexpected_state',
      '管理画面と Stripe の記録で支払いの状態を確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
    ],
    [
      'stripe_object_missing',
      '管理画面と Stripe の記録で支払いがあるか確かめてください。未入金の注文は管理画面の「注文を取り消して解決」で閉じられます。',
    ],
  ] as const)('%s は「Stripe ダッシュボードで」を「管理画面と Stripe の記録で」に改めた文', (reason, expected) => {
    expect(shopAlertNextStep({ reason }, false)).toBe(expected);
  });

  it('どの理由・どの結果の文にも、古い「Stripe ダッシュボードで返金」の案内が残っていない（FREQ-457）', () => {
    const automations = [undefined, 'auto_refunded', 'auto_refund_failed', 'auto_cancelled', 'auto_cancel_failed'] as const;

    for (const reason of PAYMENT_EXCEPTION_REASONS) {
      for (const automation of automations) {
        for (const autoEnabled of [true, false]) {
          expect(shopAlertNextStep({ reason, automation }, autoEnabled)).not.toContain('Stripe ダッシュボード');
        }
      }
    }
  });
});
