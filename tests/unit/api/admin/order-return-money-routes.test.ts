/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockDeps = { name: 'refund-deps' };
const mockCreateDeps = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: (...args: unknown[]) => mockCreateDeps(...args),
}));
const mockReceive = jest.fn();
const mockRefund = jest.fn();
jest.mock('@/lib/orders/returns/return-service', () => ({
  receiveReturnAndRefund: (...args: unknown[]) => mockReceive(...args),
  refundReturnAndRequestStripe: (...args: unknown[]) => mockRefund(...args),
}));

import { POST as postReceive } from '@/app/api/admin/returns/[returnId]/receive/route';
import { POST as postRefund } from '@/app/api/admin/returns/[returnId]/refund/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import {
  C4_CASES,
  HEADERS,
  LINE_ID,
  RECEIPT_ID,
  REFUND_ID,
  REQUEST_KEY,
  RETURN_ID,
  UNKNOWN_MESSAGE,
} from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const RETURN_CONTEXT = { params: Promise.resolve({ returnId: RETURN_ID }) };
const BAD_RETURN_CONTEXT = { params: Promise.resolve({ returnId: 'x' }) };

/** 持っている権限だけを通す認可の差し替え。それ以外は 403 */
function grant(...permissions: string[]) {
  mockAuthorize.mockImplementation(async (permission: string) =>
    permissions.includes(permission) ? ADMIN : { ok: false, response: DENIED },
  );
}

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number・card などを含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

function jsonRequest(path: string, body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/returns/${RETURN_ID}/${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

const UNIT = { returnLineId: LINE_ID, disposition: 'restocked', quantity: 2 };
const RECEIVE_BODY = {
  requestKey: REQUEST_KEY,
  units: [UNIT],
  exchangeOverrides: [],
  refundChoice: 'now',
  refundAmount: null,
  refundShippingAmount: 0,
  note: '袖の汚れなし',
  notifyCustomer: true,
  sentBackMessage: null,
  sentBackCarrier: null,
  sentBackTrackingNumber: null,
};
// Task 5 の入口の答え（受け取りを記録し、Stripe が返金を受け付けた）
const RECEIVED = {
  kind: 'received',
  receiptId: RECEIPT_ID,
  returnStatus: 'closed',
  refund: { refundId: REFUND_ID, amount: 8000, status: 'pending' },
  feeDueAmount: 0,
  exchangeOrderItemIds: [],
  replayed: false,
};
const RECEIVED_DATA = {
  receiptId: RECEIPT_ID, returnStatus: 'closed', refundId: REFUND_ID, refundAmount: 8000,
  refundStatus: 'pending', feeDueAmount: 0, replayed: false,
};
const RECEIVE_AUDIT = { refund_choice: 'now', unit_count: 2 };

const REFUND_BODY = { requestKey: REQUEST_KEY, amount: 7500, shippingAmount: 500, note: '電話で相談済み', notifyCustomer: true };
const ACCEPTED = { kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 8000, replayed: false };
const ACCEPTED_DATA = { refundId: REFUND_ID, status: 'pending', amount: 8000, replayed: false };

type Endpoint = {
  name: string;
  path: string;
  post: (request: Request, context: { params: Promise<{ returnId: string }> }) => Promise<Response>;
  action: string;
  rateLimit: { endpoint: string; limit: number };
  /** 受け取りの窓口は admin.orders.return だけで通り、返金の権限は本文を読んだ後に確かめる。額を決めて返金は最初から両方を求める */
  requiresRefund: boolean;
  service: jest.Mock;
  validBody: unknown;
  okResult: unknown;
  /** 窓口が監査に足す鍵（どの結果にも付く） */
  auditExtra: Record<string, unknown>;
  refusedDetail: string;
  failureLog: string;
  failureAudit: string;
  failureMessage: string;
};

// 受け取りと額を決めて返金は、同じ守り・同じ断りと失敗の答えを持つ
const ENDPOINTS: Endpoint[] = [
  {
    name: '受け取り',
    path: 'receive',
    post: postReceive,
    action: 'admin.orders.return.receive',
    rateLimit: { endpoint: 'admin:returns:receive', limit: 30 },
    requiresRefund: false,
    service: mockReceive,
    validBody: RECEIVE_BODY,
    okResult: RECEIVED,
    auditExtra: RECEIVE_AUDIT,
    refusedDetail: 'Return receive refused',
    failureLog: '[admin.orders.return.receive] Failed to receive return',
    failureAudit: 'Failed to receive return',
    failureMessage: '受け取りの記録に失敗しました。',
  },
  {
    name: '額を決めて返金',
    path: 'refund',
    post: postRefund,
    action: 'admin.orders.return.refund',
    rateLimit: { endpoint: 'admin:returns:refund', limit: 30 },
    requiresRefund: true,
    service: mockRefund,
    validBody: REFUND_BODY,
    okResult: ACCEPTED,
    auditExtra: { source: 'return' },
    refusedDetail: 'Return refund refused',
    failureLog: '[admin.orders.return.refund] Failed to refund return',
    failureAudit: 'Failed to refund return',
    failureMessage: '返金の記録に失敗しました。',
  },
];

function call(endpoint: Endpoint, options: { body?: unknown; rawBody?: string; context?: typeof RETURN_CONTEXT } = {}) {
  const body = 'body' in options ? options.body : endpoint.validBody;
  return endpoint.post(jsonRequest(endpoint.path, body, options.rawBody), options.context ?? RETURN_CONTEXT);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockCreateDeps.mockReset();
  mockReceive.mockReset();
  mockRefund.mockReset();
  grant('admin.orders.return', 'admin.orders.refund');
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockCreateDeps.mockResolvedValue(mockDeps);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる
describe.each(ENDPOINTS)('$name の窓口の守り', (endpoint) => {
  beforeEach(() => {
    endpoint.service.mockResolvedValue(endpoint.okResult);
  });

  it('権限 admin.orders.return が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    grant();

    expect((await call(endpoint)).status).toBe(403);
    expect(mockAuthorize.mock.calls[0]).toEqual(['admin.orders.return', expect.any(Request)]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call(endpoint)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、この窓口の名前と回数（10分に30回）で数える', async () => {
    expect((await call(endpoint)).status).toBe(200);

    const { endpoint: name, limit } = endpoint.rateLimit;
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint: name, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: name, limit, windowSeconds: 600, subject: 'admin-1',
    });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call(endpoint)).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call(endpoint)).status).toBe(429);
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe.each(ENDPOINTS.filter((endpoint) => endpoint.requiresRefund))('$name の窓口は返金の権限も求める', (endpoint) => {
  it('権限 admin.orders.refund が無ければ（サポートの人）CSRF も回数の制限も確かめず、認可の応答を返す', async () => {
    grant('admin.orders.return');

    expect((await call(endpoint)).status).toBe(403);
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// 断りと失敗の答え。入口が断りを答えで返す形（Task 5 の本来の形）と、断りが投げられる形のどちらも、同じ HTTP・言葉・監査にする
describe.each(ENDPOINTS)('$name の窓口の断りと失敗', (endpoint) => {
  it.each(C4_CASES)('入口が %s で断った（答えで返した）ら HTTP %i と C-4 の言葉。409 は衝突、ほかは失敗として監査に残す', async (code, status, message) => {
    endpoint.service.mockResolvedValue({ kind: 'refused', code });

    const response = await call(endpoint);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message, code });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: endpoint.action,
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: status === 409 ? 'conflict' : 'failure',
      detail: endpoint.refusedDetail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { ...endpoint.auditExtra, code },
    });
  });

  it.each(C4_CASES)('入口が %s で断った（投げた）ら HTTP %i と C-4 の言葉。監査は断りとして残す', async (code, status, message) => {
    endpoint.service.mockRejectedValue(new ReturnStoreError(code));

    const response = await call(endpoint);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message, code });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: endpoint.action,
      outcome: status === 409 ? 'conflict' : 'failure',
      detail: endpoint.refusedDetail,
      metadata: { code },
    }));
  });

  it('E-2 の断り（確かめ中の返金がある）は、E-2 の言葉と HTTP のまま', async () => {
    endpoint.service.mockResolvedValue({ kind: 'refused', code: 'awaiting_refund_exists' });

    const response = await call(endpoint);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '確かめ中の返金があります。先に確かめてください。',
      code: 'awaiting_refund_exists',
    });
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    endpoint.service.mockRejectedValue(new RefundStoreError('begin_order_refund', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: endpoint.failureMessage, code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[endpoint.failureLog, 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: endpoint.action, outcome: 'error', detail: endpoint.failureAudit, metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('入口に渡す道具を作れなかった（環境の値が無い）時も、決まった 500。ログは例外名だけ', async () => {
    mockCreateDeps.mockRejectedValue(new TypeError('STRIPE_SECRET_KEY is not set'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: endpoint.failureMessage, code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[endpoint.failureLog, 'TypeError']]);
      expect(endpoint.service).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の番号の形が違えば 400。入口を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await call(endpoint, { context: BAD_RETURN_CONTEXT });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: endpoint.action, actor_id: 'admin-1', resource: 'order_returns', resource_id: 'x',
      outcome: 'failure', detail: 'Invalid return id', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await call(endpoint, { body: null, rawBody });

    expect(response.status).toBe(400);
    expect(endpoint.service).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/returns/[returnId]/receive（受け取る）', () => {
  const SENT_BACK_BODY = {
    ...RECEIVE_BODY,
    units: [{ returnLineId: LINE_ID, disposition: 'sent_back', quantity: 1 }],
    refundChoice: 'none',
    sentBackMessage: '着用の跡がありましたので、お返しいたします。',
    sentBackCarrier: 'yamato',
    sentBackTrackingNumber: 'AB-9',
  };

  const INVALID_BODIES: Array<[string, unknown]> = [
    ['requestKey が無い', { ...RECEIVE_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...RECEIVE_BODY, requestKey: 'abc' }],
    ['品の行が無い', { ...RECEIVE_BODY, units: undefined }],
    ['品の行が空', { ...RECEIVE_BODY, units: [] }],
    ['品の行が配列でない', { ...RECEIVE_BODY, units: 'x' }],
    [
      '品の行が101行',
      {
        ...RECEIVE_BODY,
        units: Array.from({ length: 101 }, (_, index) => ({
          ...UNIT, returnLineId: `a3b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`,
        })),
      },
    ],
    ['返品の行の番号が UUID でない', { ...RECEIVE_BODY, units: [{ ...UNIT, returnLineId: 'line-1' }] }],
    ['状態が知らない値', { ...RECEIVE_BODY, units: [{ ...UNIT, disposition: 'lost' }] }],
    ['状態が無い', { ...RECEIVE_BODY, units: [{ ...UNIT, disposition: undefined }] }],
    ['数が0', { ...RECEIVE_BODY, units: [{ ...UNIT, quantity: 0 }] }],
    ['数が1000', { ...RECEIVE_BODY, units: [{ ...UNIT, quantity: 1000 }] }],
    ['数が小数', { ...RECEIVE_BODY, units: [{ ...UNIT, quantity: 1.5 }] }],
    ['同じ品の同じ状態が2行', { ...RECEIVE_BODY, units: [UNIT, { ...UNIT, quantity: 1 }] }],
    ['交換の選び直しの動きが知らない値', { ...RECEIVE_BODY, exchangeOverrides: [{ returnLineId: LINE_ID, action: 'skip' }] }],
    ['交換の選び直しの番号が UUID でない', { ...RECEIVE_BODY, exchangeOverrides: [{ returnLineId: 'line-1', action: 'make' }] }],
    [
      '同じ品の交換の選び直しが2行',
      { ...RECEIVE_BODY, exchangeOverrides: [{ returnLineId: LINE_ID, action: 'make' }, { returnLineId: LINE_ID, action: 'refund' }] },
    ],
    ['返金の選び方が知らない値', { ...RECEIVE_BODY, refundChoice: 'later' }],
    ['返金の選び方が無い', { ...RECEIVE_BODY, refundChoice: undefined }],
    ['返金額が負', { ...RECEIVE_BODY, refundAmount: -1 }],
    ['返金額が小数', { ...RECEIVE_BODY, refundAmount: 100.5 }],
    ['返金額が integer の上限を超える', { ...RECEIVE_BODY, refundAmount: 2147483648 }],
    ['返金額が文字', { ...RECEIVE_BODY, refundAmount: '100' }],
    ['送料が負', { ...RECEIVE_BODY, refundShippingAmount: -1 }],
    ['送料が小数', { ...RECEIVE_BODY, refundShippingAmount: 1.5 }],
    ['送料が integer の上限を超える', { ...RECEIVE_BODY, refundShippingAmount: 2147483648 }],
    ['メモが501文字', { ...RECEIVE_BODY, note: 'あ'.repeat(501) }],
    ['お客様に知らせるが無い', { ...RECEIVE_BODY, notifyCustomer: undefined }],
    ['お客様に知らせるが真偽でない', { ...RECEIVE_BODY, notifyCustomer: 'yes' }],
    ['お返しのメッセージが1001文字', { ...SENT_BACK_BODY, sentBackMessage: 'あ'.repeat(1001) }],
    ['送り返しの配送業者が知らない値', { ...SENT_BACK_BODY, sentBackCarrier: 'fedex' }],
    ['送り返しの伝票番号に空白', { ...SENT_BACK_BODY, sentBackTrackingNumber: 'AB 123' }],
    ['送り返しの伝票番号が65文字', { ...SENT_BACK_BODY, sentBackTrackingNumber: 'a'.repeat(65) }],
  ];

  beforeEach(() => {
    mockReceive.mockResolvedValue(RECEIVED);
  });

  it('店長の今返金は、実行した人・返金の権限ありと本文をそのまま入口に渡し、受け取りと返金の結果を data で返す', async () => {
    const response = await call(ENDPOINTS[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: RECEIVED_DATA });
    expect(mockCreateDeps).toHaveBeenCalledTimes(1);
    expect(mockReceive).toHaveBeenCalledTimes(1);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', actorCanRefund: true, ...RECEIVE_BODY,
    });
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
  });

  it('監査に、番号・状態・額・数だけを残す（メモ・お返しのメッセージ・伝票番号は入れない）。鍵も伏せられない', async () => {
    await call(ENDPOINTS[0], { body: { ...SENT_BACK_BODY, refundChoice: 'now' } });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.return.receive',
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: 'success',
      detail: 'Return received',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: {
        receipt_id: RECEIPT_ID, return_status: 'closed', refund_id: REFUND_ID, refund_amount: 8000,
        refund_status: 'pending', fee_due_amount: 0, replayed: false, refund_choice: 'now', unit_count: 1,
      },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('着用の跡');
    expect(audited).not.toContain('AB-9');
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('監査の数は、行の数でなく点数の合計', async () => {
    const units = [
      { returnLineId: LINE_ID, disposition: 'restocked', quantity: 2 },
      { returnLineId: LINE_ID, disposition: 'not_restocked', quantity: 1 },
    ];

    await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, units } });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ unit_count: 3 }),
    }));
  });

  it('省ける欄は既定の値で入口に渡す（交換の選び直しは空・送料は0・額は計算どおりの null）。空のメモ・メッセージは null', async () => {
    const body = {
      requestKey: REQUEST_KEY,
      units: [UNIT],
      refundChoice: 'consult',
      note: '   ',
      notifyCustomer: false,
      sentBackMessage: '',
      sentBackTrackingNumber: '',
    };

    const response = await call(ENDPOINTS[0], { body });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, {
      returnId: RETURN_ID,
      actorId: 'admin-1',
      actorCanRefund: true,
      requestKey: REQUEST_KEY,
      units: [UNIT],
      exchangeOverrides: [],
      refundChoice: 'consult',
      refundAmount: null,
      refundShippingAmount: 0,
      note: null,
      notifyCustomer: false,
      sentBackMessage: null,
      sentBackCarrier: null,
      sentBackTrackingNumber: null,
    });
  });

  // Task 9 の受け取りの画面が送る本文: 使わない欄は null、交換の選び直しは空、今返金でなければ送料は 0
  const SCREEN_BODY = {
    requestKey: REQUEST_KEY,
    units: [UNIT],
    exchangeOverrides: [],
    refundChoice: 'consult',
    refundAmount: null,
    refundShippingAmount: 0,
    note: null,
    notifyCustomer: true,
    sentBackMessage: null,
    sentBackCarrier: null,
    sentBackTrackingNumber: null,
  };

  it('画面が送る本文（メモ・お返しの3つの欄・返金額がすべて null、交換の選び直しは空、送料は 0）を受け、null のまま入口に渡す', async () => {
    const response = await call(ENDPOINTS[0], { body: SCREEN_BODY });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', actorCanRefund: true, ...SCREEN_BODY,
    });
  });

  it('サポートの画面が送る本文（相談・メモなし）も、そのまま通る', async () => {
    grant('admin.orders.return');

    const response = await call(ENDPOINTS[0], { body: SCREEN_BODY });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', actorCanRefund: false, ...SCREEN_BODY,
    });
  });

  // 任意の文字の欄は、null・省く・空・空白だけのどれでも null で入口に渡す（T7-16）
  describe.each(['note', 'sentBackMessage', 'sentBackTrackingNumber'])('任意の文字の欄 %s', (field) => {
    it.each<[string, unknown]>([
      ['null', null],
      ['省く', undefined],
      ['空の文', ''],
      ['空白だけ', '   '],
    ])('%s なら null で入口に渡す', async (_name, value) => {
      const response = await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, [field]: value } });

      expect(response.status).toBe(200);
      expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ [field]: null }));
    });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['省く', undefined],
  ])('お返しの配送業者が %s なら null で入口に渡す（メッセージだけのお返し）', async (_name, value) => {
    const response = await call(ENDPOINTS[0], { body: { ...SENT_BACK_BODY, sentBackCarrier: value } });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ sentBackCarrier: null }));
  });

  it('お返しは、メッセージ・配送業者・伝票番号をそのまま渡す（メッセージは前後の空白だけ除く）', async () => {
    const response = await call(ENDPOINTS[0], {
      body: { ...SENT_BACK_BODY, sentBackMessage: '  着用の跡がありましたので、お返しいたします。  ' },
    });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({
      units: [{ returnLineId: LINE_ID, disposition: 'sent_back', quantity: 1 }],
      sentBackMessage: '着用の跡がありましたので、お返しいたします。',
      sentBackCarrier: 'yamato',
      sentBackTrackingNumber: 'AB-9',
    }));
  });

  // Review Focus 5: サポート＝返金の権限が無い人。受け取りは通り、返金は店長が行う
  it('サポート（返金の権限が無い人）の相談の受け取りは通り、返金の権限なし（actorCanRefund: false）で入口に渡す', async () => {
    grant('admin.orders.return');

    const response = await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, refundChoice: 'consult' } });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ actorCanRefund: false, refundChoice: 'consult' }));
  });

  it('サポートの「返金なし」（お返し・戻さないだけ）の受け取りも通る', async () => {
    grant('admin.orders.return');

    const response = await call(ENDPOINTS[0], { body: { ...SENT_BACK_BODY, refundChoice: 'none' } });

    expect(response.status).toBe(200);
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ actorCanRefund: false, refundChoice: 'none' }));
  });

  it.each<[string, Record<string, unknown>]>([
    ['今返金', { refundChoice: 'now' }],
    ['返金額の指定', { refundChoice: 'consult', refundAmount: 5000 }],
    ['返金額を0に指定', { refundChoice: 'consult', refundAmount: 0 }],
    ['送料の指定', { refundChoice: 'consult', refundShippingAmount: 300 }],
    ['交換の選び直し', { refundChoice: 'none', exchangeOverrides: [{ returnLineId: LINE_ID, action: 'make' }] }],
  ])('サポートの「%s」は 403 RETURN_FORBIDDEN。入口を呼ばず、断りとして監査に残す（Review Focus 5）', async (_name, change) => {
    grant('admin.orders.return');

    const response = await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, ...change } });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'この操作は店長だけができます。', code: 'RETURN_FORBIDDEN' });
    expect(mockReceive).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.return.receive', actor_id: 'admin-1', resource: 'order_returns', resource_id: RETURN_ID,
      outcome: 'failure', detail: 'Refund permission is missing', ip: '203.0.113.5', user_agent: 'jest',
      metadata: { code: 'RETURN_FORBIDDEN' },
    }]]);
  });

  // 返金の権限を確かめられなかった（セッションの確認が一時的に使えない）だけの店長を、黙ってサポートの扱いにしない
  it.each([401, 503])('返金の権限を確かめられなかった（%i）時は、その応答をそのまま返し、入口を呼ばない', async (status) => {
    mockAuthorize.mockReset();
    mockAuthorize
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status }) });

    expect((await call(ENDPOINTS[0])).status).toBe(status);
    expect(mockReceive).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  // Review Focus 1: 通信が切れて Stripe が返金を作ったか分からない。画面は同じ二重防止の番号で送り直し、前の受け取りと返金の記録を受け取る
  it('同じ二重防止の番号の送り直しの答え（replayed）は、200 のまま写す', async () => {
    mockReceive.mockResolvedValue({ ...RECEIVED, replayed: true });

    const response = await call(ENDPOINTS[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ...RECEIVED_DATA, replayed: true } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ replayed: true }),
    }));
  });

  it('返金の無い受け取り（相談・なし）は、返金の3つの欄が null で、お支払い待ちの額を返す', async () => {
    mockReceive.mockResolvedValue({ ...RECEIVED, returnStatus: 'open', refund: null, feeDueAmount: 300 });

    const response = await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, refundChoice: 'consult' } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        receiptId: RECEIPT_ID, returnStatus: 'open', refundId: null, refundAmount: null, refundStatus: null,
        feeDueAmount: 300, replayed: false,
      },
    });
  });

  // 計画の冒頭 P20: 手数料が商品の額以上、または店長が額を0に直して、返金が0円になった。返金の記録も Stripe への頼みも無い。
  // 画面（Task 9）は、見込みが元から0円なら額を送らず（null）、手で直した0円なら 0 を送る。どちらも同じ答えになり、
  // 額は変えずに入口へ渡す（0 を null の計算どおりに直さない）
  it.each<[string, number | null]>([
    ['見込みが元から0円で額を送らない（refundAmount: null）', null],
    ['店長が額を0に直した（refundAmount: 0）', 0],
  ])('返金が0円で省かれた受け取り（waived。%s）は、返金の番号が null・額が 0・状態が waived', async (_name, refundAmount) => {
    mockReceive.mockResolvedValue({ ...RECEIVED, refund: { refundId: null, amount: 0, status: 'waived' }, feeDueAmount: 200 });

    const response = await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, refundAmount } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        receiptId: RECEIPT_ID, returnStatus: 'closed', refundId: null, refundAmount: 0, refundStatus: 'waived',
        feeDueAmount: 200, replayed: false,
      },
    });
    expect(mockReceive).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ refundAmount, actorCanRefund: true }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      metadata: expect.objectContaining({ refund_id: null, refund_amount: 0, refund_status: 'waived' }),
    }));
  });

  it('受け取りは記録できたが Stripe が断った時は 422。返金の番号と、記録済みの受け取りの番号を返す', async () => {
    mockReceive.mockResolvedValue({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' },
    });

    const response = await call(ENDPOINTS[0]);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。',
      code: 'stripe_rejected',
      refundId: REFUND_ID,
      receiptId: RECEIPT_ID,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      detail: 'Stripe rejected the refund',
      metadata: { refund_id: REFUND_ID, receipt_id: RECEIPT_ID, ...RECEIVE_AUDIT },
    }));
  });

  // Review Focus 1
  it('答えが分からない時は 502。決まった文と、返金の番号・受け取りの番号を返す（画面が開き直した後も確かめ直せる）', async () => {
    mockReceive.mockResolvedValue({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    });

    const response = await call(ENDPOINTS[0]);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID, receiptId: RECEIPT_ID,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      detail: 'Refund outcome is unknown',
      metadata: { refund_id: REFUND_ID, receipt_id: RECEIPT_ID, ...RECEIVE_AUDIT },
    }));
  });

  it('受け取りは記録できたが E-2 が返金を断った時（支払いの番号が Stripe の物でない注文など）は、E-2 の言葉と HTTP に受け取りの番号を付ける', async () => {
    mockReceive.mockResolvedValue({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'refused', code: 'order_not_refundable' },
    });

    const response = await call(ENDPOINTS[0]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'この注文は返金できません。', code: 'order_not_refundable', receiptId: RECEIPT_ID,
    });
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。入口を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await call(ENDPOINTS[0], { body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockReceive).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.return.receive', actor_id: 'admin-1', resource: 'order_returns', resource_id: RETURN_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it('本文が壊れている時は、返金の権限を確かめる前に 400（認可の呼び出しは返品の権限の1回だけ）', async () => {
    await call(ENDPOINTS[0], { body: { ...RECEIVE_BODY, units: [] } });

    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
  });
});

describe('POST /api/admin/returns/[returnId]/refund（額を決めて返金する）', () => {
  const INVALID_BODIES: Array<[string, unknown]> = [
    ['requestKey が無い', { ...REFUND_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...REFUND_BODY, requestKey: 'abc' }],
    ['返金額が負', { ...REFUND_BODY, amount: -1 }],
    ['返金額が小数', { ...REFUND_BODY, amount: 100.5 }],
    ['返金額が integer の上限を超える', { ...REFUND_BODY, amount: 2147483648 }],
    ['返金額が文字', { ...REFUND_BODY, amount: '100' }],
    ['送料が負', { ...REFUND_BODY, shippingAmount: -1 }],
    ['送料が小数', { ...REFUND_BODY, shippingAmount: 1.5 }],
    ['送料が integer の上限を超える', { ...REFUND_BODY, shippingAmount: 2147483648 }],
    ['メモが501文字', { ...REFUND_BODY, note: 'あ'.repeat(501) }],
    ['メモが文字でない', { ...REFUND_BODY, note: 5 }],
    ['お客様に知らせるが無い', { ...REFUND_BODY, notifyCustomer: undefined }],
    ['お客様に知らせるが真偽でない', { ...REFUND_BODY, notifyCustomer: 'yes' }],
  ];

  beforeEach(() => {
    mockRefund.mockResolvedValue(ACCEPTED);
  });

  it('実行した人と本文を入口に渡し、返金の番号・状態・額を data で返す。監査にメモ・連絡先を入れず、鍵も伏せられない', async () => {
    const response = await call(ENDPOINTS[1]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: ACCEPTED_DATA });
    expect(mockCreateDeps).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', ...REFUND_BODY });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.return.refund',
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: 'success',
      detail: 'Refund accepted',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { refund_id: REFUND_ID, status: 'pending', amount: 8000, replayed: false, source: 'return' },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('電話で相談済み');
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('額を省く（計算どおり）と null で、送料を省くと 0 で渡す。空のメモは null、前後の空白は除く', async () => {
    await call(ENDPOINTS[1], { body: { requestKey: REQUEST_KEY, note: '   ', notifyCustomer: false } });
    expect(mockRefund).toHaveBeenLastCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', requestKey: REQUEST_KEY, amount: null, shippingAmount: 0, note: null, notifyCustomer: false,
    });

    await call(ENDPOINTS[1], { body: { ...REFUND_BODY, note: '  電話で相談済み  ' } });
    expect(mockRefund).toHaveBeenLastCalledWith(mockDeps, expect.objectContaining({ note: '電話で相談済み' }));
  });

  // Task 9 の額を決めて返金の画面が送る本文: 見込みどおりなので額は null、メモも null、送料は 0
  it('画面が送る本文（額・メモが null、送料は 0）を受け、null のまま入口に渡す', async () => {
    const body = { requestKey: REQUEST_KEY, amount: null, shippingAmount: 0, note: null, notifyCustomer: true };

    const response = await call(ENDPOINTS[1], { body });

    expect(response.status).toBe(200);
    expect(mockRefund).toHaveBeenCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', ...body });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['省く', undefined],
    ['空の文', ''],
    ['空白だけ', '   '],
  ])('メモが %s なら null で入口に渡す', async (_name, note) => {
    const response = await call(ENDPOINTS[1], { body: { ...REFUND_BODY, note } });

    expect(response.status).toBe(200);
    expect(mockRefund).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ note: null }));
  });

  // 計画の冒頭 P20: 額を0にすると、返金しないで終える。0は null（計算どおり）に直さず、0のまま渡す。
  // 画面（Task 9）は、手で0円に直したなら amount: 0、見込みが元から0円なら amount: null を送る（どちらもメモ null・お客様に知らせない）
  it.each<[string, number | null]>([
    ['手で0円に直した（amount: 0）', 0],
    ['見込みが元から0円で額を送らない（amount: null）', null],
  ])('返金しないで終える本文（%s）を受け付け、額をそのまま入口に渡す。返金の記録も Stripe への頼みも無い答え（waived）は 200', async (_name, amount) => {
    mockRefund.mockResolvedValue({ kind: 'waived', replayed: false });

    const response = await call(ENDPOINTS[1], {
      body: { requestKey: REQUEST_KEY, amount, shippingAmount: 0, note: null, notifyCustomer: false },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { refundId: null, amount: 0, status: 'waived', replayed: false } });
    expect(mockRefund).toHaveBeenCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', requestKey: REQUEST_KEY, amount, shippingAmount: 0, note: null, notifyCustomer: false,
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.return.refund',
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: 'success',
      detail: 'Refund waived',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { refund_id: null, status: 'waived', amount: 0, replayed: false, source: 'return' },
    });
  });

  it('0円の送り直し（replayed）も、そのまま写す', async () => {
    mockRefund.mockResolvedValue({ kind: 'waived', replayed: true });

    const response = await call(ENDPOINTS[1], { body: { ...REFUND_BODY, amount: 0 } });

    await expect(response.json()).resolves.toEqual({ data: { refundId: null, amount: 0, status: 'waived', replayed: true } });
  });

  // Review Focus 1
  it('同じ二重防止の番号の送り直しの答え（replayed）は、200 のまま写す', async () => {
    mockRefund.mockResolvedValue({ ...ACCEPTED, replayed: true });

    const response = await call(ENDPOINTS[1]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ...ACCEPTED_DATA, replayed: true } });
  });

  it('Stripe が成功を返した（status: succeeded）答えもそのまま写す', async () => {
    mockRefund.mockResolvedValue({ ...ACCEPTED, status: 'succeeded' });

    const response = await call(ENDPOINTS[1]);

    await expect(response.json()).resolves.toEqual({ data: { ...ACCEPTED_DATA, status: 'succeeded' } });
  });

  it('Stripe の断りは 422。E-2 の言葉に返金の番号を付ける', async () => {
    mockRefund.mockResolvedValue({ kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null });

    const response = await call(ENDPOINTS[1]);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected', refundId: REFUND_ID,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', detail: 'Stripe rejected the refund', metadata: { refund_id: REFUND_ID, source: 'return' },
    }));
  });

  // Review Focus 1
  it('答えが分からない時は 502。決まった文と返金の番号を返す（画面が開き直した後も確かめ直せる）', async () => {
    mockRefund.mockResolvedValue({ kind: 'unknown', refundId: REFUND_ID });

    const response = await call(ENDPOINTS[1]);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', detail: 'Refund outcome is unknown', metadata: { refund_id: REFUND_ID, source: 'return' },
    }));
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。入口を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await call(ENDPOINTS[1], { body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.return.refund', actor_id: 'admin-1', resource: 'order_returns', resource_id: RETURN_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });
});
