/**
 * 送り先の組み立て（グループ E-3 計画 P7）を、実際の worker の入口（runOrderEmailWorker）から確かめる。
 * 店への知らせ（返金待ち）は環境変数 SHOP_ALERT_EMAIL の店のアドレスへ、返品のお客様あてのメールはお客様の宛先へ送る。
 * 材料の読み込みと送信は偽物に替える（読み込みの中身は order-email-return-material.test.ts、本文は order-email-compose-returns.test.ts が確かめる）。
 * アドレスの値は、この試験の作り物（example.com）だけ
 */
// 本物の worker がサイトの住所の見張り（server 専用の部品）を読み込むため、試験の場では server-only の印を空にする
jest.mock('server-only', () => ({}), { virtual: true });
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockClientRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockClientRpc(...args), from: jest.fn() })),
}));
const mockSend = jest.fn();
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-sender'),
  checkOrderEmailSendConfig: () => null,
  sendOrderEmailMessage: (...args: unknown[]) => mockSend(...args),
}));
const mockLoadMaterial = jest.fn();
jest.mock('@/lib/orders/email/order-email-compose', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-compose'),
  loadOrderEmailMaterial: (...args: unknown[]) => mockLoadMaterial(...args),
}));
// 状況のリンクの準備（グループ E-5 計画 P21）。本物の実装は status-email の試験が確かめる
const mockLoadStatusUrl = jest.fn();
jest.mock('@/lib/orders/status/status-email', () => ({
  loadOrderStatusEmailUrl: (...args: unknown[]) => mockLoadStatusUrl(...args),
}));

import { runOrderEmailWorker } from '@/lib/orders/email/order-email-worker';
import type { OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';

// 状況のURLの中のトークンは試験用の作り物
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const COAT = { item_name: 'コート', color: null, size: null, quantity: 1 };

/** サポートの受け取りで返金待ちになった返品の材料（店への知らせも、お客様へのお受け取りのメールも作れる） */
const MATERIAL: OrderEmailMaterial = {
  order: {
    id: 'order-1', status: 'shipped', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
    subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
    shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
    shipping_building: null, shipping_phone: '0311112222', review_reason: null, cancel_reason: null,
  },
  items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
  fulfillment: null,
  refund: null,
  request: null,
  orderReturn: {
    number: 1, returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0, restockingFeePercent: 0,
    exchangeFee: 0, exchangeShippingFee: 0, feeWaitingAmount: 0, returnAddress: null, items: [], exchangePlan: [], hasRefundLines: true,
    receipt: {
      refundChoice: 'consult', received: [COAT], sentBack: [], sentBackMessage: null, sentBackCarrier: null,
      sentBackTrackingNumber: null, exchanges: [], pendingRefund: { items: [COAT], amount: 5000 },
      refundWaived: false, refundNotAccepted: false,
    },
  },
};

function claimRow(kind: string) {
  return {
    email_id: 'email-1', order_id: 'order-1', kind, variant: null, origin: 'auto', attempts: 1, lease_token: 'lease-1',
    subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null, refund_id: null,
    return_id: 'return-1', return_receipt_id: 'receipt-1',
  };
}

/** 取り出しは1行だけ返し、あとは空。ほかの DB の関数は成功を返す */
function queue(kind: string) {
  const rows = [[claimRow(kind)], []];
  mockClientRpc.mockImplementation(async (name: string) => ({
    data: name === 'claim_order_email' ? (rows.shift() ?? []) : name === 'fail_order_email' ? 'dead' : true,
    error: null,
  }));
}

describe('runOrderEmailWorker の送り先（返品のメール）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
    mockSend.mockReset().mockResolvedValue({ ok: true, providerMessageId: 're_1' });
    mockLoadMaterial.mockReset().mockResolvedValue(MATERIAL);
    mockLoadStatusUrl.mockReset().mockResolvedValue(STATUS_URL);
  });
  afterEach(() => jest.restoreAllMocks());

  it('店への知らせ（返金待ち）は、環境変数 SHOP_ALERT_EMAIL の店のアドレス（前後の空白を除く）へ送り、お客様の宛先へは送らない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: ' shop-alert@example.com ' });
    queue('return_refund_pending_shop');

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });

    expect(mockLoadMaterial).toHaveBeenCalledWith(expect.anything(), 'order-1', null, null, 'return-1', 'receipt-1');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'shop-alert@example.com',
        subject: '【要対応】返金待ちの返品があります（ORD-ORDER-1）',
        idempotencyKey: 'order-email/email-1',
      }),
    );
  });

  it('店への知らせ（返金待ち）は、状況のリンクを用意せず、本文も変えない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    queue('return_refund_pending_shop');

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });

    expect(mockLoadStatusUrl).not.toHaveBeenCalled();
    const previousShopText = [
      '返品 ORD-ORDER-1-R1 の品を受け取りました（受け取った人: サポート）。',
      '',
      '受け取った返金の品:',
      '・コート × 1',
      '計算どおりの額: ￥5,000',
      '',
      '管理画面の注文の一覧で「額を決めて返金する」を押して、返金してください。',
    ].join('\n');
    expect(mockSend.mock.calls[0][0].text).toBe(previousShopText);
  });

  it('返品のお客様あてのメールは、環境変数 SHOP_ALERT_EMAIL があっても、お客様の宛先へ送る。状況のリンクは同じ注文の番号で用意する', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    queue('return_received');

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'hanako@example.com', subject: '【Le Fil des Heures】返品をお受け取りしました（ORD-ORDER-1）' }),
    );
    expect(mockLoadStatusUrl).toHaveBeenCalledTimes(1);
    expect(mockLoadStatusUrl).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), 'order-1');
    expect(mockSend.mock.calls[0][0].text).toContain(
      `ご注文の状況はこちら: ${STATUS_URL}\nお問い合わせの際は、注文番号（ORD-ORDER-1）をお問い合わせフォームにご入力ください。`,
    );
  });

  it.each([{ NODE_ENV: 'test' }, { NODE_ENV: 'test', SHOP_ALERT_EMAIL: '' }, { NODE_ENV: 'test', SHOP_ALERT_EMAIL: '   ' }] as const)(
    '店のアドレスが設定に無い（%j）時、店への知らせは送らずに取りやめにし、設定が無いことだけをログに出す。お客様の宛先へ送り替えない',
    async (env) => {
      jest.replaceProperty(process, 'env', env);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      queue('return_refund_pending_shop');

      await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockClientRpc).toHaveBeenCalledWith('skip_order_email', {
        _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'no_recipient',
      });
      // 今の店への知らせと同じく、設定が無いことだけを出す（アドレスの値は出さない）
      expect(warn).toHaveBeenCalledWith('[order-email-worker] SHOP_ALERT_EMAIL is not configured', 'email-1');
    },
  );
});
