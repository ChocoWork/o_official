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
const mockLoadRequestMaterial = jest.fn();
jest.mock('@/lib/orders/email/order-email-compose', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-compose'),
  loadOrderEmailMaterial: (...args: unknown[]) => mockLoadMaterial(...args),
  loadRequestEmailMaterial: (...args: unknown[]) => mockLoadRequestMaterial(...args),
}));
// 状況のリンクの準備（グループ E-5 計画 P21）。本物の実装は status-email の試験が確かめる
const mockLoadStatusUrl = jest.fn();
jest.mock('@/lib/orders/status/status-email', () => ({
  loadOrderStatusEmailUrl: (...args: unknown[]) => mockLoadStatusUrl(...args),
}));

import { recipientFor, runOrderEmailWorker, skipReasonFor } from '@/lib/orders/email/order-email-worker';
import type { OrderEmailMaterial, OrderEmailRequestMaterial } from '@/lib/orders/email/order-email-compose';
import {
  isReturnRequestEmailKind,
  isShopEmailKind,
  ORDER_EMAIL_KINDS,
  REQUEST_EMAIL_KINDS,
  type RequestEmailKind,
} from '@/lib/orders/email/order-email-types';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';

// 状況のURLの中のトークンは試験用の作り物
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const STATUS_LINE = `ご注文の状況はこちら: ${STATUS_URL}`;
const CONTACT = 'お問い合わせの際は、注文番号（ORD-ORDER-1）をお問い合わせフォームにご入力ください。';

const RETURN_REQUEST: OrderEmailRequestMaterial = {
  kind: 'return',
  number: 1,
  declineMessage: '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。',
  lines: [
    {
      item_name: 'コート', color: null, size: null, quantity: 1,
      reason: 'defective', requestedResolution: 'refund', requestedExchange: null, photoCount: 1,
    },
  ],
};

const CANCEL_REQUEST: OrderEmailRequestMaterial = {
  kind: 'cancel',
  declineMessage: 'すでに発送の準備が終わっているため、キャンセルはお受けできませんでした。',
  lines: [{ item_name: 'コート', color: null, size: null, quantity: 1 }],
};

const requestFor = (kind: RequestEmailKind): OrderEmailRequestMaterial =>
  isReturnRequestEmailKind(kind) ? RETURN_REQUEST : CANCEL_REQUEST;

/** 申し込みのメールの材料。注文の行と申し込みだけを持つ（loadRequestEmailMaterial が返す形） */
function material(
  request: OrderEmailRequestMaterial | null,
  orderOverrides: Partial<OrderEmailMaterial['order']> = {},
): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
      subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
      shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
      shipping_building: null, shipping_phone: '0311112222', review_reason: null, cancel_reason: null,
      ...orderOverrides,
    },
    items: [],
    fulfillment: null,
    refund: null,
    orderReturn: null,
    request,
  };
}

function claimRow(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    email_id: 'email-1', order_id: 'order-1', kind, variant: null, origin: 'auto', attempts: 1, lease_token: 'lease-1',
    subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null, refund_id: null,
    return_id: null, return_receipt_id: null, cancel_request_id: null,
    ...overrides,
  };
}

/** 取り出しは1行だけ返し、あとは空。ほかの DB の関数は成功を返す（失敗の記録 fail_order_email だけは dead を返す） */
function queue(row: ReturnType<typeof claimRow>) {
  const rows = [[row], []];
  mockClientRpc.mockImplementation(async (name: string) => ({
    data: name === 'claim_order_email' ? (rows.shift() ?? []) : name === 'fail_order_email' ? 'dead' : true,
    error: null,
  }));
}

describe('runOrderEmailWorker（申し込みのメール）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
    mockSend.mockReset().mockResolvedValue({ ok: true, providerMessageId: 're_1' });
    mockLoadMaterial.mockReset().mockResolvedValue(null);
    mockLoadRequestMaterial.mockReset();
    mockLoadStatusUrl.mockReset().mockResolvedValue(STATUS_URL);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['return_requested', '【Le Fil des Heures】返品のお申し込みを受け付けました（ORD-ORDER-1）'],
    ['return_declined', '【Le Fil des Heures】返品のお申し込みについて（ORD-ORDER-1）'],
  ] as const)('%s は、お客様の宛先へ送る。返品の番号で申し込みの材料を読み、今の読み込みは使わない', async (kind, subject) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(material(RETURN_REQUEST));
    queue(claimRow(kind, { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });

    expect(mockLoadRequestMaterial).toHaveBeenCalledWith(expect.anything(), 'order-1', {
      kind, returnId: 'return-1', cancelRequestId: null,
    });
    expect(mockLoadMaterial).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'hanako@example.com', subject, idempotencyKey: 'order-email/email-1' }),
    );
    // 新しいお客様向けの本文は、状況のリンクを同じ注文の番号で用意して、問い合わせ文の直前に書く
    expect(mockLoadStatusUrl).toHaveBeenCalledTimes(1);
    expect(mockLoadStatusUrl).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), 'order-1');
    expect(mockSend.mock.calls[0][0].text).toContain(`${STATUS_LINE}\n${CONTACT}`);
  });

  it.each([
    ['cancel_request_received', '【Le Fil des Heures】キャンセルのお申し込みを受け付けました（ORD-ORDER-1）'],
    ['cancel_request_declined', '【Le Fil des Heures】キャンセルのお申し込みについて（ORD-ORDER-1）'],
  ] as const)('%s は、お客様の宛先へ送る。キャンセルの申し込みの番号で申し込みの材料を読む', async (kind, subject) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(material(CANCEL_REQUEST));
    queue(claimRow(kind, { cancel_request_id: 'cancel-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });

    expect(mockLoadRequestMaterial).toHaveBeenCalledWith(expect.anything(), 'order-1', {
      kind, returnId: null, cancelRequestId: 'cancel-1',
    });
    expect(mockLoadMaterial).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'hanako@example.com', subject }));
    expect(mockLoadStatusUrl).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), 'order-1');
    expect(mockSend.mock.calls[0][0].text).toContain(`${STATUS_LINE}\n${CONTACT}`);
  });

  it.each([
    ['return_request_shop', { return_id: 'return-1' }, RETURN_REQUEST, '【要対応】返品の申し込みが届きました（ORD-ORDER-1）'],
    ['cancel_request_shop', { cancel_request_id: 'cancel-1' }, CANCEL_REQUEST, '【要対応】キャンセルの申し込みが届きました（ORD-ORDER-1）'],
  ] as const)('%s は、環境変数 SHOP_ALERT_EMAIL の店のアドレス（前後の空白を除く）へ送り、お客様の宛先へは送らない', async (kind, ids, request, subject) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: ' shop-alert@example.com ' });
    mockLoadRequestMaterial.mockResolvedValue(material(request));
    queue(claimRow(kind, ids));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'shop-alert@example.com', subject }));
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'hanako@example.com' }));
    expect(mockLoadStatusUrl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'return_request_shop',
      { return_id: 'return-1' },
      RETURN_REQUEST,
      [
        'お客様から返品の申し込みが届きました（返品番号 ORD-ORDER-1-R1）。',
        '',
        '申し込みの商品:',
        '・コート × 1（理由: 破損・不良／ご希望: 返金／写真 1枚）',
        '',
        '管理画面の注文の一覧で「申し込みを確かめる」を押して、承認するかお断りしてください。',
      ].join('\n'),
    ],
    [
      'cancel_request_shop',
      { cancel_request_id: 'cancel-1' },
      CANCEL_REQUEST,
      [
        'お客様からキャンセルの申し込みが届きました。',
        '',
        '申し込みの商品:',
        '・コート × 1',
        '',
        '管理画面の注文の一覧で「キャンセルの申し込み」を押して、品を外すかお断りしてください。',
      ].join('\n'),
    ],
  ] as const)('%s はリンクを用意せず、本文も今までのまま', async (kind, ids, request, previousShopText) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(material(request));
    queue(claimRow(kind, ids));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, failed: 0 });

    expect(mockLoadStatusUrl).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0][0].text).toBe(previousShopText);
  });

  it('お客様あては、状況のURLが作れなければ（設定の誤り）送らず、永続の source_missing にする。次のメールを止めない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    mockLoadRequestMaterial.mockResolvedValue(material(RETURN_REQUEST));
    mockLoadStatusUrl.mockReset().mockResolvedValue(null);
    queue(claimRow('return_requested', { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, failed: 1, stoppedBy: 'empty' });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).not.toHaveBeenCalledWith('save_order_email_content', expect.anything());
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'source_missing', _category: 'permanent', _retry_after_seconds: null,
    });
  });

  it('お客様あては、状況のリンクの準備でDBが失敗したら、一時的な失敗としてやり直す。送らず、ログも出さない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadRequestMaterial.mockResolvedValue(material(CANCEL_REQUEST));
    mockLoadStatusUrl.mockReset().mockRejectedValue(new Error('customer@example.com 秘密の本文'));
    queue(claimRow('cancel_request_received', { cancel_request_id: 'cancel-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, failed: 1 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).not.toHaveBeenCalledWith('save_order_email_content', expect.anything());
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'db_unavailable', _category: 'transient', _retry_after_seconds: null,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('店あては、お客様の宛先が空でも、店のアドレスへ送る（お客様に送るメールではない）', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(material(RETURN_REQUEST, { shipping_email: null }));
    queue(claimRow('return_request_shop', { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0 });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'shop-alert@example.com' }));
  });

  it.each([
    ['return_request_shop', { return_id: 'return-1' }, RETURN_REQUEST],
    ['cancel_request_shop', { cancel_request_id: 'cancel-1' }, CANCEL_REQUEST],
  ] as const)(
    '店のアドレスが設定に無い時、%s は送らずに取りやめにし、設定が無いことだけをログに出す。お客様の宛先へ送り替えない',
    async (kind, ids, request) => {
      jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: '   ' });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockLoadRequestMaterial.mockResolvedValue(material(request));
      queue(claimRow(kind, ids));

      await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockClientRpc).toHaveBeenCalledWith('skip_order_email', {
        _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'no_recipient',
      });
      // 今の店への知らせと同じく、設定が無いことだけを出す（アドレスの値は出さない）
      expect(warn).toHaveBeenCalledWith('[order-email-worker] SHOP_ALERT_EMAIL is not configured', 'email-1');
    },
  );

  it('お客様あては、お客様の宛先が空なら取りやめにする。店のアドレスがあっても店へ送り替えず、ログも出さない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadRequestMaterial.mockResolvedValue(material(RETURN_REQUEST, { shipping_email: '  ' }));
    queue(claimRow('return_requested', { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 1, failed: 0 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).toHaveBeenCalledWith('skip_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'no_recipient',
    });
    expect(warn).not.toHaveBeenCalled();
    // 送らない行のために状況のリンクを用意しない
    expect(mockLoadStatusUrl).not.toHaveBeenCalled();
  });

  it('申し込みの材料が無ければ、送れなかった（永続の source_missing）にする。送らない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(null);
    queue(claimRow('return_requested', { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 0, failed: 1 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'source_missing', _category: 'permanent', _retry_after_seconds: null,
    });
    expect(mockLoadStatusUrl).not.toHaveBeenCalled();
  });

  it('本文が作れなければ（お断りのメッセージが空）、送れなかった（永続の source_missing）にする', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockResolvedValue(material({ ...RETURN_REQUEST, declineMessage: null } as OrderEmailRequestMaterial));
    queue(claimRow('return_declined', { return_id: 'return-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 0, failed: 1 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing', _category: 'permanent' }));
  });

  it('申し込みの材料を読めなければ（DB の失敗）、一時的な失敗としてやり直す', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', SHOP_ALERT_EMAIL: 'shop-alert@example.com' });
    mockLoadRequestMaterial.mockRejectedValue(new Error('down'));
    queue(claimRow('cancel_request_received', { cancel_request_id: 'cancel-1' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 0, skipped: 0, failed: 1 });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'db_unavailable', _category: 'transient', _retry_after_seconds: null,
    });
  });

  it('ほかの種類（注文確認）は、今までどおり発送・返金・返品・受け取りの番号で読み、申し込みの読み込みは使わない', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
    mockLoadMaterial.mockResolvedValue({
      ...material(null),
      items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
    });
    queue(claimRow('paid', { variant: 'order_confirmed' }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });

    expect(mockLoadMaterial).toHaveBeenCalledWith(expect.anything(), 'order-1', null, null, null, null);
    expect(mockLoadRequestMaterial).not.toHaveBeenCalled();
    expect(mockLoadStatusUrl).toHaveBeenCalledTimes(1);
    expect(mockLoadStatusUrl).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), 'order-1');
    expect(mockSend.mock.calls[0][0].text).toContain(`${STATUS_LINE}\n${CONTACT}`);
  });
});

describe('recipientFor（店あての3種類）', () => {
  it('店あての3種類は店のアドレス（前後の空白を除く）、ほかの種類は注文の配送先のメール', () => {
    const target = material(RETURN_REQUEST);

    expect(ORDER_EMAIL_KINDS.filter(isShopEmailKind)).toEqual(['return_refund_pending_shop', 'return_request_shop', 'cancel_request_shop']);
    for (const kind of ORDER_EMAIL_KINDS) {
      expect(recipientFor({ kind }, target, ' shop-alert@example.com ')).toBe(
        isShopEmailKind(kind) ? 'shop-alert@example.com' : 'hanako@example.com',
      );
    }
  });

  it('宛先が空・空白だけなら null。店あては店のアドレスだけを見る', () => {
    expect(recipientFor({ kind: 'cancel_request_shop' }, material(CANCEL_REQUEST), null)).toBeNull();
    expect(recipientFor({ kind: 'cancel_request_shop' }, material(CANCEL_REQUEST), '   ')).toBeNull();
    expect(recipientFor({ kind: 'cancel_request_received' }, material(CANCEL_REQUEST, { shipping_email: ' ' }), 'shop-alert@example.com')).toBeNull();
    expect(recipientFor({ kind: 'return_request_shop' }, material(RETURN_REQUEST, { shipping_email: null }), 'shop-alert@example.com')).toBe(
      'shop-alert@example.com',
    );
  });
});

describe('skipReasonFor（申し込みのメール）', () => {
  it('注文がどの状態でも、取りやめにしない（受けた事実・お断りした事実をその時のまま伝える。superseded にしない）', () => {
    for (const kind of REQUEST_EMAIL_KINDS) {
      for (const status of ORDER_STATUSES) {
        expect(skipReasonFor({ kind }, material(requestFor(kind), { status }), 'shop-alert@example.com')).toBeNull();
      }
    }
  });

  it('取りやめるのは宛先が無い時だけ（no_recipient）', () => {
    expect(skipReasonFor({ kind: 'return_requested' }, material(RETURN_REQUEST, { shipping_email: '' }), 'shop-alert@example.com')).toBe('no_recipient');
    expect(skipReasonFor({ kind: 'return_request_shop' }, material(RETURN_REQUEST), null)).toBe('no_recipient');
    expect(skipReasonFor({ kind: 'cancel_request_shop' }, material(CANCEL_REQUEST), 'shop-alert@example.com')).toBeNull();
  });
});
