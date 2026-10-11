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
const mockServiceClient = { name: 'service-client' };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));
const mockLoadMaterials = jest.fn();
jest.mock('@/lib/orders/refund/refund-materials', () => ({
  loadRefundMaterials: (...args: unknown[]) => mockLoadMaterials(...args),
}));
const mockSubmitAdminRefund = jest.fn();
const mockConfirmAwaitingRefund = jest.fn();
const mockRefundDeps = { name: 'refund-deps' };
jest.mock('@/lib/orders/refund/refund-service', () => ({
  submitAdminRefund: (...args: unknown[]) => mockSubmitAdminRefund(...args),
  confirmAwaitingRefund: (...args: unknown[]) => mockConfirmAwaitingRefund(...args),
  createDefaultRefundServiceDeps: async () => mockRefundDeps,
}));

import { GET as getMaterials, POST as postRefund } from '@/app/api/admin/orders/[id]/refund/route';
import { POST as postConfirm } from '@/app/api/admin/orders/[id]/refund/confirm/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { RefundMaterials } from '@/lib/orders/refund/refund-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };
const UNKNOWN_MESSAGE = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

const LINE = { orderItemId: ITEM_1, quantity: 1, beforeShipment: true };
const REFUND_BODY = {
  requestKey: REQUEST_KEY,
  lines: [LINE, { orderItemId: ITEM_2, quantity: 2, beforeShipment: false }],
  restock: true,
  shippingAmount: 500,
  amount: 12000,
  note: '電話で依頼',
  stripeReason: 'requested_by_customer',
  notifyCustomer: true,
};
const ACCEPTED = { kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false };
const ACCEPTED_BODY = { refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false };

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number・card などを含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

function refundRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

function confirmRequest(body: unknown = { refundId: REFUND_ID }, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund/confirm`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

/** 返金の流れが返す答えと、窓口の HTTP・監査の対応（Review Focus 1・3） */
const RESULT_CASES = [
  {
    label: '受け付けた（保留）',
    result: ACCEPTED,
    status: 200,
    body: ACCEPTED_BODY,
    outcome: 'success',
    detail: 'Refund accepted',
    metadata: { refund_id: REFUND_ID, status: 'pending', amount: 12000, replayed: false },
  },
  {
    label: '受け付けた（成功）',
    result: { ...ACCEPTED, status: 'succeeded' },
    status: 200,
    body: { ...ACCEPTED_BODY, status: 'succeeded' },
    outcome: 'success',
    detail: 'Refund accepted',
    metadata: { refund_id: REFUND_ID, status: 'succeeded', amount: 12000, replayed: false },
  },
  {
    label: '同じ番号の送り直しで前の記録を返した（replayed）',
    result: { ...ACCEPTED, replayed: true },
    status: 200,
    body: { ...ACCEPTED_BODY, replayed: true },
    outcome: 'success',
    detail: 'Refund accepted',
    metadata: { refund_id: REFUND_ID, status: 'pending', amount: 12000, replayed: true },
  },
  {
    label: '返金と発送を同時に押して数を超えた（Review Focus 3）',
    result: { kind: 'refused', code: 'quantity_exceeds_unshipped' },
    status: 409,
    body: { error: '返金できる数を超えています。画面を開き直してください。', code: 'quantity_exceeds_unshipped' },
    outcome: 'conflict',
    detail: 'Refund refused',
    metadata: { code: 'quantity_exceeds_unshipped' },
  },
  {
    label: '注文が無い・記録がこの注文の物でない',
    result: { kind: 'refused', code: 'order_not_found' },
    status: 404,
    body: { error: '注文が見つかりません。', code: 'order_not_found' },
    outcome: 'failure',
    detail: 'Refund refused',
    metadata: { code: 'order_not_found' },
  },
  {
    label: '全部を返す時の送料と返金額の断り',
    result: { kind: 'refused', code: 'must_be_full' },
    status: 409,
    body: { error: 'まだ発送していない注文の商品を全部返す時は、送料と返金額も全部返してください。', code: 'must_be_full' },
    outcome: 'conflict',
    detail: 'Refund refused',
    metadata: { code: 'must_be_full' },
  },
  {
    label: 'DB が入力の誤りで断った',
    result: { kind: 'refused', code: 'invalid_argument' },
    status: 400,
    body: { error: '入力を確かめてください。', code: 'invalid_argument' },
    outcome: 'failure',
    detail: 'Refund refused',
    metadata: { code: 'invalid_argument' },
  },
  {
    label: 'Stripe の断り（理由あり）',
    result: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' },
    status: 422,
    body: { error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。', code: 'stripe_rejected', refundId: REFUND_ID },
    outcome: 'failure',
    detail: 'Stripe rejected the refund',
    metadata: { refund_id: REFUND_ID },
  },
  {
    label: 'Stripe の断り（理由なし）',
    result: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    status: 422,
    body: { error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected', refundId: REFUND_ID },
    outcome: 'failure',
    detail: 'Stripe rejected the refund',
    metadata: { refund_id: REFUND_ID },
  },
  {
    label: '答えが分からない（Stripe は返金を作ったかもしれない。Review Focus 1）',
    result: { kind: 'unknown', refundId: REFUND_ID },
    status: 502,
    body: { error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID },
    outcome: 'error',
    detail: 'Refund outcome is unknown',
    metadata: { refund_id: REFUND_ID },
  },
];

type Endpoint = {
  name: string;
  action: string;
  service: jest.Mock;
  call: () => Promise<Response>;
  /** 窓口ごとに監査へ足す鍵 */
  auditExtra: Record<string, unknown>;
  failureLog: string;
  failureAudit: string;
  failureMetadata: Record<string, unknown> | null;
};

// 返金する窓口と確かめ直す窓口は、同じ答え・同じ守りを持つ
const ENDPOINTS: Endpoint[] = [
  {
    name: '返金する',
    action: 'admin.orders.refund.create',
    service: mockSubmitAdminRefund,
    call: () => postRefund(refundRequest(REFUND_BODY), ORDER_CONTEXT),
    auditExtra: { source: 'admin', line_count: 2 },
    failureLog: '[admin.orders.refund.create] Failed to create refund',
    failureAudit: 'Failed to create refund',
    failureMetadata: null,
  },
  {
    name: '返事待ちの確かめ直し',
    action: 'admin.orders.refund.confirm',
    service: mockConfirmAwaitingRefund,
    call: () => postConfirm(confirmRequest(), ORDER_CONTEXT),
    auditExtra: { refund_id: REFUND_ID },
    failureLog: '[admin.orders.refund.confirm] Failed to confirm refund',
    failureAudit: 'Failed to confirm refund',
    failureMetadata: { refund_id: REFUND_ID },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockLoadMaterials.mockReset();
  mockSubmitAdminRefund.mockReset();
  mockConfirmAwaitingRefund.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる。確かめ直しの窓口は返金の窓口と同じ鍵で数える（P24）
describe.each(ENDPOINTS)('$name の窓口の守り', ({ service, call }) => {
  beforeEach(() => {
    service.mockResolvedValue(ACCEPTED);
  });

  it('権限 admin.orders.refund が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.refund', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、返金の窓口の名前と回数で数える', async () => {
    expect((await call()).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:orders:refund-create', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:orders:refund-create', limit: 30, windowSeconds: 600, subject: 'admin-1',
    });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe.each(ENDPOINTS)('$name の答え', (endpoint) => {
  it.each(RESULT_CASES)('$label', async (testCase) => {
    endpoint.service.mockResolvedValue(testCase.result);

    const response = await endpoint.call();

    expect(response.status).toBe(testCase.status);
    await expect(response.json()).resolves.toEqual(testCase.body);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: endpoint.action,
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: testCase.outcome,
      detail: testCase.detail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { ...endpoint.auditExtra, ...testCase.metadata },
    });
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    endpoint.service.mockRejectedValue(new RefundStoreError('begin_order_refund', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await endpoint.call();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返金の記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[endpoint.failureLog, 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: endpoint.action, outcome: 'error', detail: endpoint.failureAudit, metadata: endpoint.failureMetadata,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB の記号を持たない失敗は、例外名だけをログに出す', async () => {
    endpoint.service.mockRejectedValue(new TypeError('STRIPE_SECRET_KEY is not set'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await endpoint.call();
      expect(response.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([[endpoint.failureLog, 'TypeError']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('GET /api/admin/orders/[id]/refund（返金の材料）', () => {
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`);
  const MATERIALS: RefundMaterials = {
    order: {
      id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
      totalAmount: 13500, shippingAmount: 500, discountAmount: 0, paidAmount: 13500,
      succeededAmount: 0, openAmount: 0, refundableAmount: 13500, refundedShipping: 0,
      refundableShipping: 500, shippedTotal: 0, unshippedTotal: 3,
    },
    lines: [{
      orderItemId: ITEM_1, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
      itemPrice: 4000, quantity: 3, lineTotal: 12000, shipped: 0, unshipped: 3,
      refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 3,
      lineDiscount: 0, refundedUnits: 0,
    }],
    awaitingRefund: null,
  };

  it('返金の権限で材料を返す。読むだけなので CSRF と回数の制限は通さない', async () => {
    mockLoadMaterials.mockResolvedValueOnce(MATERIALS);

    const response = await getMaterials(request(), ORDER_CONTEXT);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.refund', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(MATERIALS);
    expect(mockLoadMaterials).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await getMaterials(request(), ORDER_CONTEXT)).status).toBe(403);
    expect(mockLoadMaterials).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400、注文が無ければ 404', async () => {
    const invalid = await getMaterials(request(), { params: Promise.resolve({ id: 'x' }) });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockLoadMaterials).not.toHaveBeenCalled();

    mockLoadMaterials.mockResolvedValueOnce(null);
    const missing = await getMaterials(request(), ORDER_CONTEXT);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ', async () => {
    mockLoadMaterials.mockRejectedValueOnce(new RefundStoreError('load_order_refund_materials', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getMaterials(request(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返金の材料を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.refund.materials] Failed to load materials', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/refund（返金する）', () => {
  const NOTE_CASES: Array<[string, string | null | undefined, string | null]> = [
    ['メモを付けない', undefined, null],
    ['メモが null', null, null],
    ['メモが空白だけ', '   ', null],
    ['メモの前後の空白は除く', '  電話で依頼  ', '電話で依頼'],
  ];

  const INVALID_BODIES: Array<[string, unknown]> = [
    ['requestKey が無い', { ...REFUND_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...REFUND_BODY, requestKey: 'abc' }],
    ['商品の行が配列でない', { ...REFUND_BODY, lines: 'x' }],
    [
      '商品の行が101行',
      {
        ...REFUND_BODY,
        lines: Array.from({ length: 101 }, (_, index) => ({
          ...LINE, orderItemId: `d1b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`,
        })),
      },
    ],
    ['商品の番号が UUID でない', { ...REFUND_BODY, lines: [{ ...LINE, orderItemId: 'item-1' }] }],
    ['数が0', { ...REFUND_BODY, lines: [{ ...LINE, quantity: 0 }] }],
    ['数が1000', { ...REFUND_BODY, lines: [{ ...LINE, quantity: 1000 }] }],
    ['数が小数', { ...REFUND_BODY, lines: [{ ...LINE, quantity: 1.5 }] }],
    ['発送前かどうかが真偽でない', { ...REFUND_BODY, lines: [{ ...LINE, beforeShipment: 'yes' }] }],
    ['発送前かどうかが無い', { ...REFUND_BODY, lines: [{ ...LINE, beforeShipment: undefined }] }],
    ['同じ商品の同じ側が2行', { ...REFUND_BODY, lines: [LINE, { ...LINE, quantity: 2 }] }],
    ['在庫に戻すが真偽でない', { ...REFUND_BODY, restock: 'yes' }],
    ['在庫に戻すが無い', { ...REFUND_BODY, restock: undefined }],
    ['送料が負', { ...REFUND_BODY, shippingAmount: -1 }],
    ['送料が小数', { ...REFUND_BODY, shippingAmount: 1.5 }],
    ['送料が integer の上限を超える', { ...REFUND_BODY, shippingAmount: 2147483648 }],
    ['返金額が0', { ...REFUND_BODY, amount: 0 }],
    ['返金額が小数', { ...REFUND_BODY, amount: 100.5 }],
    ['返金額が integer の上限を超える', { ...REFUND_BODY, amount: 2147483648 }],
    ['メモが501文字', { ...REFUND_BODY, note: 'あ'.repeat(501) }],
    ['メモが文字でない', { ...REFUND_BODY, note: 5 }],
    ['Stripe に伝える理由が知らない値', { ...REFUND_BODY, stripeReason: 'other' }],
    ['Stripe に伝える理由が無い', { ...REFUND_BODY, stripeReason: undefined }],
    ['お客様に送るが真偽でない', { ...REFUND_BODY, notifyCustomer: 'yes' }],
    ['お客様に送るが無い', { ...REFUND_BODY, notifyCustomer: undefined }],
  ];

  beforeEach(() => {
    mockSubmitAdminRefund.mockResolvedValue(ACCEPTED);
  });

  it('実行した人と中身を返金の流れに渡す。監査にメモ・連絡先を入れず、鍵も伏せられない', async () => {
    const response = await postRefund(refundRequest(REFUND_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitAdminRefund).toHaveBeenCalledTimes(1);
    expect(mockSubmitAdminRefund).toHaveBeenCalledWith(mockRefundDeps, {
      orderId: ORDER_ID,
      actorId: 'admin-1',
      request: REFUND_BODY,
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('電話で依頼');
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it.each(NOTE_CASES)('%s: 店だけのメモは、空なら null にして渡す', async (_name, note, expected) => {
    await postRefund(refundRequest({ ...REFUND_BODY, note }), ORDER_CONTEXT);

    expect(mockSubmitAdminRefund).toHaveBeenCalledWith(mockRefundDeps, expect.objectContaining({
      request: expect.objectContaining({ note: expected }),
    }));
  });

  it('同じ商品の発送前と発送後は、別の行として受ける', async () => {
    const lines = [
      { orderItemId: ITEM_1, quantity: 1, beforeShipment: true },
      { orderItemId: ITEM_1, quantity: 2, beforeShipment: false },
    ];

    const response = await postRefund(refundRequest({ ...REFUND_BODY, lines }), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitAdminRefund).toHaveBeenCalledWith(mockRefundDeps, expect.objectContaining({
      request: expect.objectContaining({ lines }),
    }));
  });

  it('商品の行が無くても受ける（送料だけ・額だけの返金）。監査の行の数は0', async () => {
    const response = await postRefund(refundRequest({ ...REFUND_BODY, lines: [] }), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ line_count: 0 }),
    }));
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。返金の流れを呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postRefund(refundRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockSubmitAdminRefund).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.refund.create', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postRefund(refundRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockSubmitAdminRefund).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400。返金の流れを呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postRefund(refundRequest(REFUND_BODY), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockSubmitAdminRefund).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });
});

describe('POST /api/admin/orders/[id]/refund/confirm（返事待ちの確かめ直し）', () => {
  const INVALID_BODIES: Array<[string, unknown]> = [
    ['refundId が無い', {}],
    ['refundId が UUID でない', { refundId: 'abc' }],
    ['refundId が文字でない', { refundId: 5 }],
  ];

  beforeEach(() => {
    mockConfirmAwaitingRefund.mockResolvedValue({ ...ACCEPTED, replayed: true });
  });

  it('注文の番号と記録の番号を返金の流れに渡し、前の記録の答えを返す。返金を新しく始めない', async () => {
    const response = await postConfirm(confirmRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...ACCEPTED_BODY, replayed: true });
    expect(mockConfirmAwaitingRefund).toHaveBeenCalledWith(mockRefundDeps, { orderId: ORDER_ID, refundId: REFUND_ID });
    expect(mockSubmitAdminRefund).not.toHaveBeenCalled();
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。返金の流れを呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postConfirm(confirmRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockConfirmAwaitingRefund).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.refund.confirm', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postConfirm(confirmRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockConfirmAwaitingRefund).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400。返金の流れを呼ばない', async () => {
    const response = await postConfirm(confirmRequest(), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    expect(mockConfirmAwaitingRefund).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });
});
