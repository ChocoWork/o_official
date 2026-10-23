jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockClientRpc = jest.fn();
const mockClient = { rpc: (...args: unknown[]) => mockClientRpc(...args), from: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockClient) }));
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-sender'),
  checkOrderEmailSendConfig: () => null,
}));
// 本物の worker が状況のリンクの準備（server 専用の部品）を読み込むため、試験の場では server-only の印を空にする
jest.mock('server-only', () => ({}), { virtual: true });

import {
  orderEmailWorkerDisabledReason,
  processOrderEmails,
  recipientFor,
  runOrderEmailWorker,
  skipReasonFor,
  type OrderEmailWorkerDeps,
} from '@/lib/orders/email/order-email-worker';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  OrderEmailMaterialError,
  type OrderEmailFulfillmentMaterial,
  type OrderEmailMaterial,
  type OrderEmailRefundMaterial,
  type OrderEmailReturnMaterial,
  type OrderEmailReturnReceipt,
} from '@/lib/orders/email/order-email-compose';
import { OrderEmailStoreError, type OrderEmailStore } from '@/lib/orders/email/order-email-store';
import type { OrderEmailSendOutcome } from '@/lib/orders/email/order-email-sender';

// 状況のURLの中のトークンは試験用の作り物
const STATUS_URL = `https://shop.example.test/order-status/${'FAKE'.padEnd(43, '0')}`;
const STATUS_LINE = `ご注文の状況はこちら: ${STATUS_URL}`;
const CONTACT = 'お問い合わせの際は、注文番号（ORD-ORDER-1）をお問い合わせフォームにご入力ください。';

type QueueRow = {
  email_id: string; order_id: string; kind: string; variant: string | null; origin: string; attempts: number;
  lease_token: string; subject: string | null; body_text: string | null; payment_expired_sent: boolean;
  fulfillment_id: string | null; refund_id: string | null; return_id: string | null; return_receipt_id: string | null;
};

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
    lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null,
    refund_id: null, return_id: null, return_receipt_id: null, ...overrides,
  };
}

function material(
  overrides: Partial<OrderEmailMaterial['order']> = {},
  fulfillment: OrderEmailMaterial['fulfillment'] = null,
  refund: OrderEmailMaterial['refund'] = null,
  orderReturn: OrderEmailMaterial['orderReturn'] = null,
): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
      subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
      shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
      shipping_building: null, shipping_phone: '0311112222', review_reason: null, cancel_reason: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
    fulfillment,
    refund,
    orderReturn,
    request: null,
  };
}

/** 発送のメールの材料。既定は、全部を送った発送（残りの案内なし） */
function fulfillmentMaterial(overrides: Partial<OrderEmailFulfillmentMaterial> = {}): OrderEmailFulfillmentMaterial {
  return {
    number: 1, carrier: 'yamato', trackingNumber: '1234-5678', completesOrder: true, cancelled: false,
    lines: [{ item_name: 'コート', color: null, size: null, quantity: 1 }],
    ...overrides,
  };
}

/** 返金のお知らせ・支払い済みのキャンセルのお知らせの材料。既定は、カードで払った注文の額だけの成功した返金 */
function refundMaterial(overrides: Partial<OrderEmailRefundMaterial> = {}): OrderEmailRefundMaterial {
  return {
    status: 'succeeded', amount: 3000, shippingAmount: 0, paymentMethodType: 'card', customerActionExpiresAt: null, cancelReason: null,
    lines: [], stillShipping: false,
    ...overrides,
  };
}

/** 返品のメールの材料。既定は、お客様が送る・お店の負担・手数料なしの、コート1点の返品（受け取りはまだ無い） */
function returnMaterial(overrides: Partial<OrderEmailReturnMaterial> = {}): OrderEmailReturnMaterial {
  return {
    number: 1, returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0, restockingFeePercent: 0,
    exchangeFee: 0, exchangeShippingFee: 0, feeWaitingAmount: 0,
    returnAddress: { name: 'Le Fil des Heures 返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
    items: [{ item_name: 'コート', color: null, size: null, quantity: 1 }], exchangePlan: [], hasRefundLines: true, receipt: null,
    ...overrides,
  };
}

/** 1回の受け取りの材料。既定は、コート1点を受け取っただけ（交換もお返しも返金待ちも無い） */
function receiptMaterial(overrides: Partial<OrderEmailReturnReceipt> = {}): OrderEmailReturnReceipt {
  return {
    refundChoice: 'none', received: [{ item_name: 'コート', color: null, size: null, quantity: 1 }], sentBack: [],
    sentBackMessage: null, sentBackCarrier: null, sentBackTrackingNumber: null, exchanges: [], pendingRefund: null,
    refundWaived: false, refundNotAccepted: false,
    ...overrides,
  };
}

/** DB の関数をまねる。取り出しは queue から1行ずつ返す */
function harness(queue: QueueRow[], options: {
  material?: OrderEmailMaterial | null | Error;
  send?: OrderEmailSendOutcome[];
  saveResult?: boolean;
  completeResult?: boolean;
  failOn?: string;
  config?: OrderEmailWorkerDeps['checkConfig'];
  clock?: number[];
  /** 店への知らせ（返金待ち）の送り先。既定は店のアドレス、null は設定が無い */
  shopRecipient?: string | null;
  /** 状況のURLの用意。既定は固定のURL。順に返す（足りなければ最後の値）。Error は DB の失敗 */
  statusUrls?: Array<string | null | Error>;
} = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const pending = [...queue];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (options.failOn === name) return { data: null, error: { message: 'db down', code: '08006' } };
    switch (name) {
      case 'claim_order_email':
        return { data: pending.length > 0 ? [pending.shift()] : [], error: null };
      case 'save_order_email_content':
        return { data: options.saveResult ?? true, error: null };
      case 'complete_order_email':
        return { data: options.completeResult ?? true, error: null };
      case 'skip_order_email':
        return { data: true, error: null };
      case 'fail_order_email':
        return { data: params?._category === 'permanent' ? 'dead' : 'retry_wait', error: null };
      case 'pause_order_email_sending':
        return { data: true, error: null };
      default:
        return { data: null, error: null };
    }
  });
  const outcomes = [...(options.send ?? [{ ok: true, providerMessageId: 're_1' } as const])];
  const send = jest.fn(async () => outcomes.shift() ?? ({ ok: true, providerMessageId: 're_next' } as const));
  const loadMaterial = jest.fn(async () => {
    const value = options.material === undefined ? material() : options.material;
    if (value instanceof Error) throw value;
    return value;
  });
  const times = [...(options.clock ?? [])];
  const statusUrls = [...(options.statusUrls ?? [STATUS_URL])];
  const loadStatusUrl = jest.fn(async (): Promise<string | null> => {
    const value = statusUrls.length > 1 ? (statusUrls.shift() as string | null | Error) : statusUrls[0];
    if (value instanceof Error) throw value;
    return value;
  });
  const deps: OrderEmailWorkerDeps = {
    store: { rpc } as unknown as OrderEmailStore,
    loadMaterial,
    loadRequestMaterial: loadMaterial,
    loadStatusUrl,
    shopRecipient: () => (options.shopRecipient === undefined ? 'shop-alert@example.com' : options.shopRecipient),
    send,
    checkConfig: options.config ?? (() => null),
    now: () => (times.length > 0 ? (times.shift() as number) : 0),
    budgetMs: 10_000,
  };
  return { deps, calls, send, loadMaterial, loadStatusUrl, rpc };
}

const names = (calls: Array<{ name: string }>) => calls.map((call) => call.name);

describe('orderEmailWorkerDisabledReason', () => {
  it.each([
    ['Vercel preview', { NODE_ENV: 'production', VERCEL_ENV: 'preview' }, 'non_production_deployment'],
    ['Vercel development', { NODE_ENV: 'development', VERCEL_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, 'non_production_deployment'],
    ['Vercel production', { NODE_ENV: 'production', VERCEL_ENV: 'production' }, null],
    ['Vercel でない本番ビルド', { NODE_ENV: 'production' }, null],
    ['next dev と本番の DB', { NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co' }, 'development_shared_database'],
    ['next dev と手元の IPv4', { NODE_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, null],
    ['next dev と localhost', { NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, null],
    ['next dev と手元の IPv6', { NODE_ENV: 'development', SUPABASE_URL: 'http://[::1]:54321' }, null],
    ['next dev と住所なし', { NODE_ENV: 'development' }, 'development_shared_database'],
    ['next dev と壊れた住所', { NODE_ENV: 'development', SUPABASE_URL: 'broken-url' }, 'development_shared_database'],
    ['非公開の住所を優先', { NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, 'development_shared_database'],
    ['空の非公開の住所は公開の住所へ', { NODE_ENV: 'development', SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, null],
    ['localhost に似た外部の host', { NODE_ENV: 'development', SUPABASE_URL: 'https://localhost.example.com' }, 'development_shared_database'],
  ] as const)('%s の環境判定', (_name, env, expected) => {
    expect(orderEmailWorkerDisabledReason(env)).toBe(expected);
  });
});

describe('runOrderEmailWorker の環境の守り', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [{ NODE_ENV: 'production', VERCEL_ENV: 'preview' }, 'non_production_deployment'],
    [{ NODE_ENV: 'development', VERCEL_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, 'non_production_deployment'],
    [{ NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co' }, 'development_shared_database'],
    [{ NODE_ENV: 'development' }, 'development_shared_database'],
    [{ NODE_ENV: 'development', SUPABASE_URL: 'broken-url' }, 'development_shared_database'],
  ] as const)('%o では DB に触れず disabled を返す', async (env, reason) => {
    jest.replaceProperty(process, 'env', env);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runOrderEmailWorker()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' });

    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-worker] skipped', reason);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('runOrderEmailWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
    mockClient.from.mockReset();
    // 実際の環境変数（VERCEL_ENV など）に左右されず、環境の門を通る環境で試す
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('送るものが無くても、最後の成功を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: [], error: null });

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'empty' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', true, null);
  });

  it('取り出しに失敗したら、失敗と原因の記号を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: null, error: { message: 'down', code: '08006' } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'claim_error' });
      expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', false, 'db_unavailable');
      expect(error).toHaveBeenCalledWith('[order-email-worker] claim failed', 'OrderEmailStoreError', '08006');
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ['通常の例外', new Error('宛先・件名・本文を含む例外'), ['Error']],
    ['DB の記号付き', new OrderEmailStoreError('claim_order_email', { message: '宛先・件名・本文を含む例外', code: '08006' }), ['OrderEmailStoreError', '08006']],
  ])('心拍の記録が失敗（%s）しても worker の結果は変わらず、ログは例外名と DB の記号だけ', async (_label, failure, details) => {
    mockClientRpc.mockResolvedValue({ data: [], error: null });
    mockRecordHeartbeat.mockRejectedValueOnce(failure);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runOrderEmailWorker()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'empty' });
      expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', true, null);
      expect(error.mock.calls).toEqual([['[order-email-worker] failed to record heartbeat', ...details]]);
    } finally {
      error.mockRestore();
    }
  });

  it('止める環境では DB に触れず、最後の成功も記録しない（本番の記録を、開発や preview が上書きしない）', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'production', VERCEL_ENV: 'preview' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(runOrderEmailWorker()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(mockRecordHeartbeat).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[order-email-worker] skipped', 'non_production_deployment');
    } finally {
      warn.mockRestore();
    }
  });

  it('発送のメールの行は、行の発送の番号で発送を読む（注文の番号でも絞る）', async () => {
    type FilterChain = {
      eq: (column: string, value: unknown) => FilterChain;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const filters: Array<[string, unknown]> = [];
    const fulfillmentQuery: FilterChain = {
      eq: (column, value) => {
        filters.push([column, value]);
        return fulfillmentQuery;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: material().order, error: null }) }) }) };
      }
      if (table === 'order_items') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: material().items, error: null }) }) }) };
      }
      if (table === 'order_fulfillments') {
        return { select: () => fulfillmentQuery };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const claims = [[row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], []];
    mockClientRpc.mockImplementation(async (name: string) => ({
      data: name === 'claim_order_email' ? (claims.shift() ?? []) : 'dead',
      error: null,
    }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ failed: 1, stoppedBy: 'empty' });

    expect(filters).toEqual([['id', 'fulfillment-1'], ['order_id', 'order-1']]);
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });
  it('返金のお知らせの行は、行の返金の番号で返金の記録を読む（注文の番号でも絞る）', async () => {
    type FilterChain = {
      eq: (column: string, value: unknown) => FilterChain;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const filters: Array<[string, unknown]> = [];
    const refundQuery: FilterChain = {
      eq: (column, value) => {
        filters.push([column, value]);
        return refundQuery;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: material().order, error: null }) }) }) };
      }
      if (table === 'order_items') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: material().items, error: null }) }) }) };
      }
      if (table === 'order_refunds') {
        return { select: () => refundQuery };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const claims = [[row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1' })], []];
    mockClientRpc.mockImplementation(async (name: string) => ({
      data: name === 'claim_order_email' ? (claims.shift() ?? []) : 'dead',
      error: null,
    }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ failed: 1, stoppedBy: 'empty' });

    expect(filters).toEqual([['id', 'refund-1'], ['order_id', 'order-1']]);
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });

  it('返品の受付のお知らせの行は、行の返品の番号で返品の記録を読む（注文の番号でも絞る）。返品の記録が無ければ送れなかったにする', async () => {
    type FilterChain = {
      eq: (column: string, value: unknown) => FilterChain;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const filters: Array<[string, unknown]> = [];
    const returnQuery: FilterChain = {
      eq: (column, value) => {
        filters.push([column, value]);
        return returnQuery;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: material().order, error: null }) }) }) };
      }
      if (table === 'order_items') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: material().items, error: null }) }) }) };
      }
      if (table === 'order_returns') {
        return { select: () => returnQuery };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const claims = [[row({ kind: 'return_accepted', variant: null, return_id: 'return-1' })], []];
    mockClientRpc.mockImplementation(async (name: string) => ({
      data: name === 'claim_order_email' ? (claims.shift() ?? []) : 'dead',
      error: null,
    }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ failed: 1, stoppedBy: 'empty' });

    expect(filters).toEqual([['id', 'return-1'], ['order_id', 'order-1']]);
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });

  it('受け取りの番号を持つ行は、その受け取りの記録を読む。受け取りの記録が無ければ送れなかったにする', async () => {
    const receiptFilters: Array<[string, unknown]> = [];
    const receiptQuery = {
      eq: (column: string, value: unknown) => {
        receiptFilters.push([column, value]);
        return receiptQuery;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: material().order, error: null }) }) }) };
      }
      if (table === 'order_items') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: material().items, error: null }) }) }) };
      }
      if (table === 'order_return_receipts') {
        return { select: () => receiptQuery };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const claims = [[row({ kind: 'return_received', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })], []];
    mockClientRpc.mockImplementation(async (name: string) => ({
      data: name === 'claim_order_email' ? (claims.shift() ?? []) : 'dead',
      error: null,
    }));

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ failed: 1, stoppedBy: 'empty' });

    expect(receiptFilters).toEqual([['id', 'receipt-1']]);
    expect(mockClientRpc).toHaveBeenCalledWith('fail_order_email', expect.objectContaining({ _error_code: 'source_missing' }));
  });

});

describe('processOrderEmails', () => {
  afterEach(() => jest.restoreAllMocks());

  it('中身を作って送る前に控え、行の番号の重複防止キーで送り、送信済みにする', async () => {
    const h = harness([row()]);

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    // 発送のメールでも返金のお知らせでも返品のメールでもない行は、発送・返金・返品・受け取りの番号を渡さずに材料を読む
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, null, null, null);
    expect(names(h.calls)).toEqual(['claim_order_email', 'save_order_email_content', 'complete_order_email', 'claim_order_email']);
    const saved = h.calls[1].params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご注文ありがとうございます（ORD-ORDER-1）');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
    expect(h.calls[2].params).toEqual({ _email_id: 'email-1', _lease_token: 'lease-1', _provider_message_id: 're_1' });
  });

  it('新しいお客様向けの本文は、材料を読み取りやめを判定した後、控える前に状況のリンクを注文の番号で用意し、問い合わせ文の直前に書く', async () => {
    const h = harness([row()]);

    await processOrderEmails(h.deps);

    expect(h.loadStatusUrl).toHaveBeenCalledTimes(1);
    expect(h.loadStatusUrl).toHaveBeenCalledWith('order-1');
    const saveIndex = h.calls.findIndex((call) => call.name === 'save_order_email_content');
    const saved = h.calls[saveIndex].params as { _body_text: string };
    expect(saved._body_text).toContain(`${STATUS_LINE}\n${CONTACT}`);
    expect(saved._body_text).not.toContain('0311112222');
    // 材料の読み込み → リンクの用意 → 控え の順
    expect(h.loadMaterial.mock.invocationCallOrder[0]).toBeLessThan(h.loadStatusUrl.mock.invocationCallOrder[0]);
    const saveCallOrder = h.rpc.mock.invocationCallOrder[saveIndex];
    expect(h.loadStatusUrl.mock.invocationCallOrder[0]).toBeLessThan(saveCallOrder);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ text: saved._body_text }));
  });

  it('控えがあれば作り直さず、控えた中身を同じ鍵で送る（送れた直後に落ちた後のやり直し）', async () => {
    const h = harness([row({ attempts: 2, subject: '控えた件名', body_text: '控えた本文' })]);

    await processOrderEmails(h.deps);

    expect(names(h.calls)).not.toContain('save_order_email_content');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: '控えた件名', text: '控えた本文', idempotencyKey: 'order-email/email-1',
    });
  });

  it('保存済み本文ではリンクを用意せずそのまま送る（古い電話・旧リンクのある本文も書き換えない）', async () => {
    const savedOldText = [
      '山田 花子 様', '', 'お届け先:', '山田 花子 様', '〒1500001', '東京都渋谷区神宮前1-1-1', '0311112222', '',
      'ご注文の確認はこちら: https://shop.example.test/account/orders/order-1', '',
      CONTACT, '', 'Le Fil des Heures',
    ].join('\n');
    const h = harness([row({ attempts: 2, subject: '保存した件名', body_text: savedOldText })]);

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, failed: 0 });

    expect(h.loadStatusUrl).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('save_order_email_content');
    const sentText = (h.send.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(sentText).toBe(savedOldText);
  });

  it('入金待ちは、注文がもう入金待ちでなければ取りやめにし、送らない', async () => {
    const h = harness([row({ kind: 'awaiting_payment', variant: null })], { material: material({ status: 'paid' }) });

    const result = await processOrderEmails(h.deps);

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'superseded',
    });
    // 送らない行のために状況のリンクを用意しない
    expect(h.loadStatusUrl).not.toHaveBeenCalled();
  });

  it('宛先が無ければ取りやめにする', async () => {
    const h = harness([row()], { material: material({ shipping_email: '  ' }) });

    await processOrderEmails(h.deps);

    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'no_recipient' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.loadStatusUrl).not.toHaveBeenCalled();
  });

  it('住所を作れない時は材料不足で次のメールを続ける', async () => {
    // 1通目はサイトの住所の設定の誤りで状況のURLが作れず、2通目は作れる
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      statusUrls: [null, STATUS_URL],
    });

    const result = await processOrderEmails(h.deps);

    const failures = h.calls
      .filter((call) => call.name === 'fail_order_email')
      .map((call) => ({ code: call.params?._error_code, category: call.params?._category, emailId: call.params?._email_id }));
    expect(failures).toEqual([{ code: 'source_missing', category: 'permanent', emailId: 'email-1' }]);
    expect(failures[0].code).toBe('source_missing');
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, stoppedBy: 'empty' });
    expect(h.loadStatusUrl).toHaveBeenCalledTimes(2);
    expect(h.loadStatusUrl).toHaveBeenNthCalledWith(1, 'order-1');
    expect(h.loadStatusUrl).toHaveBeenNthCalledWith(2, 'order-2');
    // 1通目は控えも送りもしない。2通目だけ控えて送る
    expect(h.calls.filter((call) => call.name === 'save_order_email_content')).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('リンク準備のDB失敗はdb_unavailableとして再試行する', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      statusUrls: [new Error('hanako@example.com 秘密の本文'), STATUS_URL],
    });

    const result = await processOrderEmails(h.deps);

    const failure = h.calls.find((call) => call.name === 'fail_order_email')?.params;
    expect(failure).toMatchObject({ _email_id: 'email-1', _error_code: 'db_unavailable', _category: 'transient' });
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, stoppedBy: 'empty' });
    expect(h.calls.filter((call) => call.name === 'save_order_email_content')).toHaveLength(1);
    // 例外の文（宛先・本文を含みうる）はログに出さない
    expect(error).not.toHaveBeenCalled();
  });

  it('店向け3種類の1つ（返金待ち）はリンクを用意せず本文も変えない', async () => {
    const receipt = receiptMaterial({ pendingRefund: { items: [{ item_name: 'コート', color: null, size: null, quantity: 1 }], amount: 5000 } });
    const h = harness(
      [row({ kind: 'return_refund_pending_shop', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })],
      { material: material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt })) },
    );

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, failed: 0 });

    expect(h.loadStatusUrl).not.toHaveBeenCalled();
    const previousShopText = [
      '返品 ORD-ORDER-1-R1 の品を受け取りました（受け取った人: サポート）。',
      '',
      '受け取った返金の品:',
      '・コート × 1',
      '計算どおりの額: ￥5,000',
      '',
      '管理画面の注文の一覧で「額を決めて返金する」を押して、返金してください。',
    ].join('\n');
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _body_text: string };
    const actualShopText = saved._body_text;
    expect(actualShopText).toBe(previousShopText);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'shop-alert@example.com', text: previousShopText }));
  });

  it('発送のメールは、行の発送の番号で材料を読み、その発送の商品と残りの案内を書いて送る', async () => {
    const h = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-2' })], {
      material: material({ status: 'paid' }, fulfillmentMaterial({ number: 2, completesOrder: false })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', 'fulfillment-2', null, null, null);
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】商品を発送いたしました（ORD-ORDER-1）');
    expect(saved._body_text).toContain('・コート x1');
    expect(saved._body_text).toContain('残りの商品は、準備ができ次第お送りします。');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
  });

  it('発送が取り消されていたら、送らずに取りやめにする（送っている途中だった行は、ここで取消を見る）', async () => {
    const h = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], {
      material: material({ status: 'paid' }, fulfillmentMaterial({ cancelled: true })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
    expect(h.send).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('save_order_email_content');
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'fulfillment_cancelled',
    });
  });

  it('控えた中身がある行（やり直しの行）でも、発送が取り消されていたら送らない', async () => {
    const h = harness(
      [row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1', attempts: 2, subject: '控えた件名', body_text: '控えた本文' })],
      { material: material({ status: 'paid' }, fulfillmentMaterial({ cancelled: true })) },
    );

    await processOrderEmails(h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'fulfillment_cancelled' });
  });

  it('注文や明細が無い・発送の伝票番号が無いときは、すぐ送れなかったにする', async () => {
    const missing = harness([row()], { material: null });
    await processOrderEmails(missing.deps);
    expect(missing.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });

    const shipped = harness([row({ kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' })], {
      material: material({ status: 'shipped' }, fulfillmentMaterial({ trackingNumber: null })),
    });
    await processOrderEmails(shipped.deps);
    expect(shipped.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(shipped.send).not.toHaveBeenCalled();
  });

  it('返金のお知らせは、行の返金の番号で材料を読み、返金額と戻る時期を書いて、行の番号の重複防止キーで送る', async () => {
    const h = harness([row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1' })], {
      material: material({ status: 'paid' }, null, refundMaterial({ amount: 2000 })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, 'refund-1', null, null);
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご返金のお知らせ（ORD-ORDER-1）');
    expect(saved._body_text).toContain('返金額: ￥2,000');
    expect(saved._body_text).toContain('ご返金は、カード会社によって5〜10営業日ほどで反映されます。');
    // 重複防止キーは今のまま行の番号。返金の番号は入れない（やり直しでも同じ行は同じ鍵で送り、Resend が2通目を送らない）
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
  });

  it('支払い済みのキャンセルのお知らせも、行の返金の番号で材料を読み、全額の返金を書く。お支払いは発生していないとは書かない', async () => {
    const h = harness([row({ kind: 'canceled', variant: 'paid', refund_id: 'refund-2' })], {
      material: material({ status: 'cancelled' }, null, refundMaterial({ amount: 5000, cancelReason: 'customer_request' })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, 'refund-2', null, null);
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご注文取消のお知らせ（ORD-ORDER-1）');
    expect(saved._body_text).toContain('ご依頼により、ご注文を取り消しました。');
    expect(saved._body_text).toContain('お支払いいただいた ￥5,000（全額）を返金いたします。');
    expect(saved._body_text).not.toContain('お支払いは発生していません。');
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'order-email/email-1' }));
  });

  it.each([
    ['payment_declined', 'お支払いを確認できなかったため、ご注文を取り消しました。'],
    ['shop_error', '当店の不手際により、ご注文を取り消しました。ご迷惑をおかけし、誠に申し訳ございません。'],
    ['stock_unavailable', '商品をご用意できなくなったため、ご注文を取り消しました。ご迷惑をおかけし、申し訳ございません。'],
  ] as const)('未入金の取消理由 %s の本文を保存する', async (cancel_reason, lead) => {
    const order = { status: 'cancelled', cancel_reason } as const;
    const h = harness([row({ kind: 'canceled', variant: 'pending' })], { material: material(order) });
    await processOrderEmails(h.deps);
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _body_text: string };
    expect(saved._body_text).toContain(`${lead}\nお支払いは発生していません。`);
  });

  it('未入金の取消のお知らせは今のまま。返金の番号を渡さずに材料を読み、お支払いは発生していないと書く', async () => {
    const h = harness([row({ kind: 'canceled', variant: 'pending' })], { material: material({ status: 'cancelled' }) });

    await processOrderEmails(h.deps);

    expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, null, null, null);
    const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _body_text: string };
    expect(saved._body_text).toContain('お支払い待ちのご注文を取り消しました。\nお支払いは発生していません。');
  });

  it.each(['failed', 'error'] as const)(
    '返金が %s になっていたら、返金のお知らせも支払い済みのキャンセルのお知らせも、中身を作らず送らずに取りやめにする（受け付けた後に失敗しても、お金が戻らないのに「返金します」と送らない）',
    async (status) => {
      for (const queued of [
        row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1' }),
        row({ kind: 'canceled', variant: 'paid', refund_id: 'refund-2' }),
      ]) {
        const h = harness([queued], { material: material({ status: 'paid' }, null, refundMaterial({ status })) });

        const result = await processOrderEmails(h.deps);

        expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
        expect(h.send).not.toHaveBeenCalled();
        expect(names(h.calls)).not.toContain('save_order_email_content');
        expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
          _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'superseded',
        });
      }
    },
  );

  it('控えた中身がある行（やり直しの行）でも、返金が失敗していたら送らずに取りやめにする', async () => {
    const h = harness(
      [row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1', attempts: 2, subject: '控えた件名', body_text: '控えた本文' })],
      { material: material({ status: 'paid' }, null, refundMaterial({ status: 'failed' })) },
    );

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'superseded' });
  });

  it('返金が保留（pending）の間は、返金のお知らせを今までどおり送る（残高不足の保留は、予定が成功まで書かれない）', async () => {
    const h = harness([row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1' })], {
      material: material({ status: 'paid' }, null, refundMaterial({ status: 'pending', amount: 2000 })),
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(names(h.calls)).not.toContain('skip_order_email');
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('返金の記録が読めない（材料が無い）時と、返金の材料が付いていない時は、すぐ送れなかったにする。送らない', async () => {
    const missing = harness([row({ kind: 'refund', variant: 'standard', refund_id: 'refund-1' })], { material: null });
    await processOrderEmails(missing.deps);
    expect(missing.loadMaterial).toHaveBeenCalledWith('order-1', null, 'refund-1', null, null);
    expect(missing.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(missing.send).not.toHaveBeenCalled();

    // 支払い済みのキャンセルのお知らせの行なのに返金の材料が無い。未入金の取消の本文で送ってしまわない
    const noRefund = harness([row({ kind: 'canceled', variant: 'paid', refund_id: 'refund-2' })], {
      material: material({ status: 'cancelled' }),
    });
    await processOrderEmails(noRefund.deps);
    expect(noRefund.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(noRefund.send).not.toHaveBeenCalled();
  });

  it('材料を読めないときと、中身を控えられないときは、送らずにやり直す', async () => {
    const unreadable = harness([row()], { material: new OrderEmailMaterialError('orders') });
    await processOrderEmails(unreadable.deps);
    expect(unreadable.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });

    const unsaved = harness([row()], { failOn: 'save_order_email_content' });
    await processOrderEmails(unsaved.deps);
    expect(unsaved.send).not.toHaveBeenCalled();
    expect(unsaved.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });
  });

  it('担当を失っていて控えられなければ、送らず何も書かない', async () => {
    const h = harness([row()], { saveResult: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await processOrderEmails(h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('fail_order_email');
    expect(result.failed).toBe(1);
    expect(warn).toHaveBeenCalledWith('[order-email-worker] lease lost', 'email-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('一時的な失敗は待つ時間の指示を渡してやり直し、次の行へ進む', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [
        { ok: false, failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 2 } },
        { ok: true, providerMessageId: 're_2' },
      ],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, stoppedBy: 'empty' });
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'rate_limited', _category: 'transient', _retry_after_seconds: 2,
    });
  });

  it('設定の問題では止めて、残りを取り出さない', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [{ ok: false, failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null } }],
    });

    const result = await processOrderEmails(h.deps);

    expect(result.stoppedBy).toBe('paused');
    expect(names(h.calls).filter((name) => name === 'claim_order_email')).toHaveLength(1);
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({ _category: 'config', _error_code: 'config_api_key' });
  });

  it('送る前に設定が足りなければ、止めて取り出さない', async () => {
    const h = harness([row()], { config: () => 'config_provider' });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'paused' });
    expect(names(h.calls)).toEqual(['pause_order_email_sending']);
    expect(h.calls[0].params).toEqual({ _reason: 'config_provider' });
  });

  it('取り出しに失敗したら止める', async () => {
    const h = harness([row()], { failOn: 'claim_order_email' });
    // 想定した失敗のログを検証し、試験の出力には流さない。
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ stoppedBy: 'claim_error' });
    expect(error).toHaveBeenCalledWith('[order-email-worker] claim failed', 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('時間の予算を使い切ったら止める', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      clock: [0, 0, 10_001],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'budget' });
  });

  it('送信済みの記録に失敗しても止めない（担当の期限の後に、同じ鍵で送り直す）', async () => {
    const h = harness([row()], { failOn: 'complete_order_email' });
    // 送信後の DB 失敗でも、宛先や本文をログに残していないことを確かめる。
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });
    expect(error).toHaveBeenCalledWith('[order-email-worker] failed to record sent', 'email-1', 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('送信済みの記録で担当を失ったときは、行の ID だけを警告する', async () => {
    const h = harness([row()], { completeResult: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });

    expect(warn).toHaveBeenCalledWith('[order-email-worker] lease lost', 'email-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fail_order_email', { send: [{ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } }] }, ['email-1', 'network_error']],
    ['skip_order_email', { material: material({ shipping_email: null }) }, ['email-1', 'no_recipient']],
    ['pause_order_email_sending', { config: () => 'config_provider' }, ['config_provider']],
  ] satisfies Array<[string, Parameters<typeof harness>[1], string[]]>)('%s の DB 失敗は原因と SQLSTATE だけを記録する', async (failOn, options, context) => {
    const h = harness([row()], { ...options, failOn });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await processOrderEmails(h.deps);

    const messages: Record<string, string> = {
      fail_order_email: '[order-email-worker] failed to record failure',
      skip_order_email: '[order-email-worker] failed to record skip',
      pause_order_email_sending: '[order-email-worker] failed to pause sending',
    };
    expect(error).toHaveBeenCalledWith(messages[failOn], ...context, 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });

  // 返品のメール（グループ E-3 設計書 9 章）。行の返品の番号・受け取りの番号で材料を読み、送り先は種類で決まる
  describe('返品のメール', () => {
    const CUSTOMER_RETURN_KINDS = ['return_accepted', 'return_received', 'return_sent_back'] as const;
    const COAT_ITEM = { item_name: 'コート', color: null, size: null, quantity: 1 };

    it('返品の受付のお知らせは、行の返品の番号で材料を読み、お客様の宛先へ、行の番号の重複防止キーで送る', async () => {
      const h = harness([row({ kind: 'return_accepted', variant: null, return_id: 'return-1' })], {
        material: material({ status: 'shipped' }, null, null, returnMaterial()),
      });

      const result = await processOrderEmails(h.deps);

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
      expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, null, 'return-1', null);
      const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
      expect(saved._subject).toBe('【Le Fil des Heures】返品の受付のお知らせ（ORD-ORDER-1）');
      expect(saved._body_text).toContain('ご注文（ORD-ORDER-1）の返品を承りました（返品番号 ORD-ORDER-1-R1）。');
      expect(h.send).toHaveBeenCalledWith({
        to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
      });
    });

    it.each([
      [
        'return_received',
        receiptMaterial({ refundChoice: 'consult' }),
        '【Le Fil des Heures】返品をお受け取りしました（ORD-ORDER-1）',
        'ご返金の額は、確かめてから改めてご連絡いたします。',
      ],
      [
        'return_sent_back',
        receiptMaterial({ received: [], sentBack: [COAT_ITEM], sentBackMessage: '使用の跡があり、お返しいたします。' }),
        '【Le Fil des Heures】品物をお返しします（ORD-ORDER-1）',
        '当店より:\n使用の跡があり、お返しいたします。',
      ],
    ] as const)('%s は、行の返品の番号と受け取りの番号で材料を読み、お客様の宛先へ送る', async (kind, receipt, subject, bodyPart) => {
      const h = harness([row({ kind, variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })], {
        material: material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt })),
      });

      const result = await processOrderEmails(h.deps);

      expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
      expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, null, 'return-1', 'receipt-1');
      const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
      expect(saved._subject).toBe(subject);
      expect(saved._body_text).toContain(bodyPart);
      expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'hanako@example.com', idempotencyKey: 'order-email/email-1' }));
    });

    it('返品の返金のお知らせは、行の返金・返品・受け取りの番号で材料を読む。受け取りの番号があれば「お受け取りしました」、無ければ「ご返金です」と書く', async () => {
      const withReceipt = harness(
        [row({ kind: 'refund', variant: 'return', refund_id: 'refund-1', return_id: 'return-1', return_receipt_id: 'receipt-1' })],
        { material: material({ status: 'shipped' }, null, refundMaterial({ amount: 5000 }), returnMaterial({ items: [], receipt: receiptMaterial() })) },
      );
      const later = harness(
        [row({ kind: 'refund', variant: 'return', refund_id: 'refund-2', return_id: 'return-1', return_receipt_id: null })],
        { material: material({ status: 'shipped' }, null, refundMaterial({ amount: 5000 }), returnMaterial({ items: [] })) },
      );

      await processOrderEmails(withReceipt.deps);
      await processOrderEmails(later.deps);

      expect(withReceipt.loadMaterial).toHaveBeenCalledWith('order-1', null, 'refund-1', 'return-1', 'receipt-1');
      expect(later.loadMaterial).toHaveBeenCalledWith('order-1', null, 'refund-2', 'return-1', null);
      const savedWith = withReceipt.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
      const savedLater = later.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
      expect(savedWith._subject).toBe('【Le Fil des Heures】ご返金のお知らせ（ORD-ORDER-1）');
      expect(savedWith._body_text).toContain('ご返品いただいた商品をお受け取りしました（返品番号 ORD-ORDER-1-R1）。');
      expect(savedLater._body_text).toContain('ご返品いただいた商品のご返金です（返品番号 ORD-ORDER-1-R1）。');
      expect(withReceipt.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'hanako@example.com' }));
      expect(later.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'hanako@example.com' }));
    });

    it.each([null, 'hanako@example.com'])(
      '店への知らせ（返金待ち）は、お客様の宛先（%s）でなく店のアドレスへ送る。中身にお客様の氏名・メールは入らない',
      async (customerEmail) => {
        const receipt = receiptMaterial({ pendingRefund: { items: [COAT_ITEM], amount: 5000 } });
        const h = harness(
          [row({ kind: 'return_refund_pending_shop', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })],
          { material: material({ status: 'shipped', shipping_email: customerEmail }, null, null, returnMaterial({ items: [], receipt })) },
        );

        const result = await processOrderEmails(h.deps);

        expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
        expect(h.loadMaterial).toHaveBeenCalledWith('order-1', null, null, 'return-1', 'receipt-1');
        const saved = h.calls.find((call) => call.name === 'save_order_email_content')?.params as { _subject: string; _body_text: string };
        expect(saved._subject).toBe('【要対応】返金待ちの返品があります（ORD-ORDER-1）');
        expect(saved._body_text).toContain('計算どおりの額: ￥5,000');
        expect(saved._body_text).not.toContain('山田');
        expect(saved._body_text).not.toContain('hanako@example.com');
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.send).toHaveBeenCalledWith({
          to: 'shop-alert@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
        });
      },
    );

    it.each([null, '', '   '])(
      '店への知らせ（返金待ち）は、店のアドレスの設定が %j なら、中身を作らず送らずに取りやめにし、設定が無いことだけをログに出す（お客様の宛先があっても使わない）',
      async (shopRecipient) => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const receipt = receiptMaterial({ pendingRefund: { items: [COAT_ITEM], amount: 5000 } });
        const h = harness(
          [row({ kind: 'return_refund_pending_shop', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })],
          { material: material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt })), shopRecipient },
        );

        const result = await processOrderEmails(h.deps);

        expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
        expect(h.send).not.toHaveBeenCalled();
        expect(names(h.calls)).not.toContain('save_order_email_content');
        expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
          _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'no_recipient',
        });
        // 今の店への知らせと同じく、設定が無いことだけを出す（アドレスの値は出さない）
        expect(warn).toHaveBeenCalledWith('[order-email-worker] SHOP_ALERT_EMAIL is not configured', 'email-1');
        expect(warn).toHaveBeenCalledTimes(1);
      },
    );

    it('店への知らせ（返金待ち）は、送る前に店長が返金を済ませて返金待ちの品が無くなっていたら、中身を作らず送らずに取りやめにする（superseded）', async () => {
      const receipt = receiptMaterial({ pendingRefund: { items: [], amount: 0 } });
      const h = harness(
        [row({ kind: 'return_refund_pending_shop', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })],
        { material: material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt })) },
      );

      const result = await processOrderEmails(h.deps);

      expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
      expect(h.send).not.toHaveBeenCalled();
      expect(names(h.calls)).not.toContain('save_order_email_content');
      expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
        _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'superseded',
      });
    });

    it.each(CUSTOMER_RETURN_KINDS)('%s は、お客様の宛先が空なら取りやめにする（店のアドレスがあっても、お客様へのメールは店へ送らない）', async (kind) => {
      const receipt = receiptMaterial({ sentBack: [COAT_ITEM], sentBackMessage: 'お返しします。' });
      const h = harness([row({ kind, variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })], {
        material: material({ status: 'shipped', shipping_email: '  ' }, null, null, returnMaterial({ receipt })),
      });

      const result = await processOrderEmails(h.deps);

      expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'no_recipient' });
    });

    it.each([...CUSTOMER_RETURN_KINDS, 'return_refund_pending_shop'] as const)(
      '%s は、返品の材料が付いていない時と、返品の記録が読めない（材料が無い）時は、送らずにすぐ送れなかったにする',
      async (kind) => {
        const noReturn = harness([row({ kind, variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })], {
          material: material({ status: 'shipped' }),
        });
        const missing = harness([row({ kind, variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1' })], { material: null });

        await processOrderEmails(noReturn.deps);
        await processOrderEmails(missing.deps);

        for (const h of [noReturn, missing]) {
          expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
            _error_code: 'source_missing', _category: 'permanent',
          });
          expect(h.send).not.toHaveBeenCalled();
          expect(names(h.calls)).not.toContain('save_order_email_content');
        }
      },
    );

    it('返品の返金が失敗していたら、返品の返金のお知らせも、送らずに取りやめにする（お金が戻らないのに「返金します」と送らない）', async () => {
      const h = harness(
        [row({ kind: 'refund', variant: 'return', refund_id: 'refund-1', return_id: 'return-1', return_receipt_id: 'receipt-1' })],
        {
          material: material({ status: 'shipped' }, null, refundMaterial({ status: 'failed' }), returnMaterial({ items: [], receipt: receiptMaterial() })),
        },
      );

      const result = await processOrderEmails(h.deps);

      expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, stoppedBy: 'empty' });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'superseded' });
    });

    it('控えた中身がある返品のメールの行（やり直しの行）は、作り直さず、控えた中身を同じ鍵で、種類ごとの送り先へ送る', async () => {
      const customer = harness([row({ kind: 'return_received', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1', attempts: 2, subject: '控えた件名', body_text: '控えた本文' })], {
        material: material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt: receiptMaterial() })),
      });
      const shop = harness([row({ kind: 'return_refund_pending_shop', variant: null, return_id: 'return-1', return_receipt_id: 'receipt-1', attempts: 2, subject: '控えた件名', body_text: '控えた本文' })], {
        material: material({ status: 'shipped' }, null, null, returnMaterial({
          items: [], receipt: receiptMaterial({ pendingRefund: { items: [COAT_ITEM], amount: 5000 } }),
        })),
      });

      await processOrderEmails(customer.deps);
      await processOrderEmails(shop.deps);

      expect(names(customer.calls)).not.toContain('save_order_email_content');
      expect(names(shop.calls)).not.toContain('save_order_email_content');
      expect(customer.send).toHaveBeenCalledWith({ to: 'hanako@example.com', subject: '控えた件名', text: '控えた本文', idempotencyKey: 'order-email/email-1' });
      expect(shop.send).toHaveBeenCalledWith({ to: 'shop-alert@example.com', subject: '控えた件名', text: '控えた本文', idempotencyKey: 'order-email/email-1' });
    });
  });
});

describe('recipientFor（送り先）', () => {
  const claim = (kind: string) => ({ kind } as never);

  it.each([
    // お客様へのメールは、注文の配送先のメール（前後の空白を除く）
    ['paid', ' hanako@example.com ', 'shop-alert@example.com', 'hanako@example.com'],
    ['refund', 'hanako@example.com', null, 'hanako@example.com'],
    ['return_accepted', 'hanako@example.com', 'shop-alert@example.com', 'hanako@example.com'],
    ['return_received', 'hanako@example.com', null, 'hanako@example.com'],
    ['return_sent_back', 'hanako@example.com', null, 'hanako@example.com'],
    // お客様へのメールは、宛先が空なら、店のアドレスがあっても店へは送らない
    ['return_received', null, 'shop-alert@example.com', null],
    ['return_sent_back', '  ', 'shop-alert@example.com', null],
    // 店への知らせは、店のアドレス（前後の空白を除く）。お客様の宛先は使わない
    ['return_refund_pending_shop', 'hanako@example.com', ' shop-alert@example.com ', 'shop-alert@example.com'],
    ['return_refund_pending_shop', null, 'shop-alert@example.com', 'shop-alert@example.com'],
    ['return_refund_pending_shop', 'hanako@example.com', null, null],
    ['return_refund_pending_shop', 'hanako@example.com', '  ', null],
  ])('%s: お客様の宛先 %j・店の宛先 %j の送り先は %j', (kind, customer, shop, expected) => {
    expect(recipientFor(claim(kind), material({ shipping_email: customer }), shop)).toBe(expected);
  });
});

describe('skipReasonFor（設計書 4-1）', () => {
  const claim = (kind: string) => ({ kind } as never);

  it.each([
    ['awaiting_payment', 'pending', null],
    ['awaiting_payment', 'paid', 'superseded'],
    ['awaiting_payment', 'failed', 'superseded'],
    ['payment_expired', 'failed', null],
    ['payment_expired', 'cancelled', null],
    ['payment_expired', 'paid', 'superseded'],
    ['payment_expired', 'shipped', 'superseded'],
    ['paid', 'shipped', null],
    ['canceled', 'cancelled', null],
    ['shipped', 'shipped', null],
    // 返金のお知らせは、注文がどの状態でも取りやめにしない（返金は決済完了でも発送済みでもキャンセルでも起きる）
    ['refund', 'paid', null],
    ['refund', 'shipped', null],
    ['refund', 'cancelled', null],
    // 返品のメール（お客様あて）も、その時の事実を伝えるので、注文がどの状態でも取りやめにしない（グループ E-3 計画 P7）
    ['return_accepted', 'paid', null],
    ['return_accepted', 'shipped', null],
    ['return_received', 'paid', null],
    ['return_received', 'shipped', null],
    ['return_sent_back', 'shipped', null],
    ['return_sent_back', 'cancelled', null],
  ])('%s のメールは、注文が %s なら %s', (kind, status, expected) => {
    expect(skipReasonFor(claim(kind), material({ status: status as never }))).toBe(expected);
  });

  it('店への知らせ（返金待ち）は、注文がどの状態でも取りやめにしない。取りやめになるのは店のアドレスが無い時と、返金待ちの品が無くなった時だけで、お客様の宛先は見ない', () => {
    const pending = { items: [{ item_name: 'コート', color: null, size: null, quantity: 1 }], amount: 5000 };
    const shopNotice = (status: 'paid' | 'shipped' | 'cancelled', customer: string | null, shopRecipient: string | null) =>
      skipReasonFor(
        claim('return_refund_pending_shop'),
        material({ status, shipping_email: customer }, null, null, returnMaterial({ items: [], receipt: receiptMaterial({ pendingRefund: pending }) })),
        shopRecipient,
      );

    for (const status of ['paid', 'shipped', 'cancelled'] as const) {
      expect(shopNotice(status, 'hanako@example.com', 'shop-alert@example.com')).toBeNull();
      expect(shopNotice(status, null, 'shop-alert@example.com')).toBeNull();
    }
    expect(shopNotice('shipped', 'hanako@example.com', null)).toBe('no_recipient');
    expect(shopNotice('shipped', 'hanako@example.com', '  ')).toBe('no_recipient');
    // 店のアドレスを渡さない呼び方（お客様へのメールの呼び方）では、店への知らせは送り先が無い
    expect(skipReasonFor(claim('return_refund_pending_shop'), material({ status: 'shipped' }))).toBe('no_recipient');
  });

  // 店長が先に「額を決めて返金する」を済ませると、返金待ちの品が無くなる。もう知らせる事が無いので取りやめる
  it('店への知らせ（返金待ち）は、返金待ちの品が無い（品が空・返金待ちの材料が無い）なら superseded。受け取りの材料そのものが無い時と、お客様あての返品のメールは取りやめにしない', () => {
    const withReceipt = (pendingRefund: OrderEmailReturnReceipt['pendingRefund']) =>
      material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt: receiptMaterial({ pendingRefund }) }));
    const shopNotice = (target: OrderEmailMaterial, shopRecipient: string | null = 'shop-alert@example.com') =>
      skipReasonFor(claim('return_refund_pending_shop'), target, shopRecipient);

    expect(shopNotice(withReceipt({ items: [{ item_name: 'コート', color: null, size: null, quantity: 1 }], amount: 5000 }))).toBeNull();
    expect(shopNotice(withReceipt({ items: [], amount: 0 }))).toBe('superseded');
    expect(shopNotice(withReceipt(null))).toBe('superseded');
    // 店のアドレスが無い時は、先に no_recipient
    expect(shopNotice(withReceipt({ items: [], amount: 0 }), null)).toBe('no_recipient');
    // 受け取りの材料そのものが無い時は取りやめでなく、本文を作る所で材料の不足（source_missing）になる
    expect(shopNotice(material({ status: 'shipped' }))).toBeNull();
    expect(shopNotice(material({ status: 'shipped' }, null, null, returnMaterial({ items: [], receipt: null })))).toBeNull();
    // お客様あての返品のメールは、受け取りに返金待ちの品が無くても取りやめにしない
    for (const kind of ['return_accepted', 'return_received', 'return_sent_back']) {
      expect(skipReasonFor(claim(kind), withReceipt(null), 'shop-alert@example.com')).toBeNull();
    }
  });

  // 返金のお知らせと支払い済みのキャンセルのお知らせの予定は、Stripe が返金を受け付けた時に書かれ、送るのは後になる。
  // その間に返金が失敗・エラーになっていたら、お金が戻らないのに「返金します」と送ることになるので取りやめる（設計書 8-1・8-2）
  it.each([
    ['refund', 'failed', 'superseded'],
    ['refund', 'error', 'superseded'],
    ['canceled', 'failed', 'superseded'],
    ['canceled', 'error', 'superseded'],
    ['refund', 'pending', null],
    ['refund', 'succeeded', null],
    ['refund', 'awaiting_response', null],
    ['canceled', 'pending', null],
    ['canceled', 'succeeded', null],
  ] as const)('%s のメールは、返金が %s なら %s', (kind, refundStatus, expected) => {
    const refund = refundMaterial({ status: refundStatus });
    expect(skipReasonFor(claim(kind), material({ status: 'paid' }, null, refund))).toBe(expected);
  });

  it('返金の材料が付いていない種類（未入金の取消など）は、返金の状態を見ずに今のまま', () => {
    expect(skipReasonFor(claim('canceled'), material({ status: 'cancelled' }))).toBeNull();
  });

  it('宛先が無い時は、返金が失敗していても宛先が無い理由を先に返す', () => {
    const refund = refundMaterial({ status: 'failed' });
    expect(skipReasonFor(claim('refund'), material({ shipping_email: null }, null, refund))).toBe('no_recipient');
  });

  it.each([
    ['shipped', false, null],
    ['shipped', true, 'fulfillment_cancelled'],
    // 発送の取消は発送のメールだけの理由。ほかの種類は、材料に取消済みの発送があっても見ない
    ['paid', true, null],
  ])('%s のメールは、発送が取消済み=%s なら %s（グループ E-1 設計書 7-3）', (kind, cancelled, expected) => {
    expect(skipReasonFor(claim(kind), material({ status: 'paid' }, fulfillmentMaterial({ cancelled })))).toBe(expected);
  });
});
