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
const mockLoadRefundMaterials = jest.fn();
jest.mock('@/lib/orders/refund/refund-materials', () => ({
  loadRefundMaterials: (...args: unknown[]) => mockLoadRefundMaterials(...args),
}));
const mockLoadReturnableUnits = jest.fn();
jest.mock('@/lib/orders/returns/return-counts', () => ({
  loadReturnableUnits: (...args: unknown[]) => mockLoadReturnableUnits(...args),
}));
const mockDeps = { name: 'refund-deps' };
const mockCreateDeps = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: (...args: unknown[]) => mockCreateDeps(...args),
}));
const mockSubmitCreate = jest.fn();
jest.mock('@/lib/orders/returns/return-service', () => ({
  submitCreateReturn: (...args: unknown[]) => mockSubmitCreate(...args),
}));
// 誤りの型（ReturnStoreError）は本物を残し、一覧・材料・設定（要検品）の読み出しだけを差し替える
const mockListOrderReturns = jest.fn();
const mockLoadReturnCreateMaterials = jest.fn();
const mockGetShopReturnSettings = jest.fn();
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  listOrderReturns: (...args: unknown[]) => mockListOrderReturns(...args),
  loadReturnCreateMaterials: (...args: unknown[]) => mockLoadReturnCreateMaterials(...args),
  getShopReturnSettings: (...args: unknown[]) => mockGetShopReturnSettings(...args),
}));

import { GET as getReturns, POST as postReturn } from '@/app/api/admin/orders/[id]/returns/route';
import { GET as getMaterials } from '@/app/api/admin/orders/[id]/returns/materials/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import {
  RETURN_REASONS,
  type OrderReturnDetail,
  type OutOfStockExchange,
  type ReturnCreateMaterials,
  type ReturnReason,
  type ShippingPayer,
  type ShopReturnSettings,
} from '@/lib/orders/returns/return-types';
import {
  C4_CASES,
  FULFILLMENT_ID,
  HEADERS,
  ITEM_ID,
  ITEM_ID_2,
  LINE_ID,
  ORDER_ID,
  REQUEST_KEY,
  RETURN_ID,
} from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const BAD_ORDER_CONTEXT = { params: Promise.resolve({ id: 'x' }) };

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

function listRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/returns`);
}

function materialsRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/returns/materials`);
}

function createRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/returns`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

const RETURN_DETAIL: OrderReturnDetail = {
  id: RETURN_ID, number: 1, label: 'ORD-A1B2C3D4-R1', status: 'open', source: 'shop',
  displayStatus: 'in_progress', marks: ['awaiting_items'],
  returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
  fees: {
    returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
    feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
  },
  firstReceiptDone: false, firstExchangeReceiptDone: false,
  shopNote: null, notifyCustomer: true, createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com',
  closedAt: null, cancelledAt: null,
  lines: [{
    id: LINE_ID, fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, orderItemId: ITEM_ID,
    itemName: 'シルクブラウス', color: '白', size: 'M',
    quantity: 2, reason: 'defective', reasonNote: null, resolution: 'refund', exchange: null,
    progress: {
      restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
      processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    },
    refundAmountsByCount: [4000, 8000], refundWaitingAmount: 0,
  }],
  refunds: [], receipts: [], exchangeItems: [],
};

const PAYERS = Object.fromEntries(RETURN_REASONS.map((reason) => [reason, 'customer'])) as Record<ReturnReason, ShippingPayer>;
const OUT_OF_STOCK = Object.fromEntries(RETURN_REASONS.map((reason) => [reason, 'decline'])) as Record<ReturnReason, OutOfStockExchange>;

const MATERIALS: ReturnCreateMaterials = {
  order: { id: ORDER_ID, status: 'shipped', hasAwaitingRefund: false },
  shipments: [{
    fulfillmentId: FULFILLMENT_ID, number: 1, shippedAt: '2026-10-05T03:00:00.000Z', deadlineDate: '2026-10-15', pastDeadline: false,
    lines: [{
      orderItemId: ITEM_ID, itemId: 10, variantId: 100, itemName: 'シルクブラウス', color: '白', size: 'M',
      lineKind: 'order', quantity: 2, returnable: 2,
    }],
  }],
  exchangeOptions: [{
    itemId: 10,
    variants: [{ variantId: 101, color: '白', size: 'L', isActive: true, stockQuantity: 3, madeToOrderLeadDays: null }],
  }],
  settings: {
    returnAddressSet: true, noReturnNeededEnabled: false, customerPaidMethod: 'customer_ships', shopLabelFee: 0,
    restockingFeeEnabled: false, restockingFeePercent: 0, exchangeFeesEnabled: false, exchangeFee: 0, exchangeShippingFee: 0,
    reasonShippingPayers: PAYERS, reasonOutOfStockExchange: OUT_OF_STOCK,
  },
};

// 一覧の窓口が設定から読むのは要検品（inspectionEnabled）だけ。ほかの欄は窓口が使わないので、型だけ ShopReturnSettings に寄せる
const settingsOf = (inspectionEnabled: boolean) => ({ inspectionEnabled }) as ShopReturnSettings;

const REFUND_LINE = {
  fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_ID, quantity: 1, reason: 'defective', reasonNote: '袖に穴',
  resolution: 'refund', exchangeVariantId: null, exchangeMethod: null,
};
const EXCHANGE_LINE = {
  fulfillmentId: FULFILLMENT_ID, orderItemId: ITEM_ID_2, quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'exchange', exchangeVariantId: 101, exchangeMethod: 'stock',
};
const CREATE_BODY = {
  requestKey: REQUEST_KEY,
  lines: [REFUND_LINE, EXCHANGE_LINE],
  returnMethod: 'customer_ships',
  returnShippingPayer: 'shop',
  returnCarrier: 'yamato',
  returnTrackingNumber: 'AB-123',
  returnShippingFee: 800,
  restockingFeePercent: 10,
  exchangeFee: 300,
  exchangeShippingFee: 500,
  shopNote: '電話で依頼',
  notifyCustomer: true,
};
const CREATED = { returnId: RETURN_ID, number: 1, status: 'open', replayed: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockLoadRefundMaterials.mockReset();
  mockLoadReturnableUnits.mockReset();
  mockCreateDeps.mockReset();
  mockSubmitCreate.mockReset();
  mockListOrderReturns.mockReset();
  mockLoadReturnCreateMaterials.mockReset();
  mockGetShopReturnSettings.mockReset();
  grant('admin.orders.return', 'admin.orders.refund');
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockCreateDeps.mockResolvedValue(mockDeps);
});

describe('GET /api/admin/orders/[id]/returns（返品の一覧）', () => {
  beforeEach(() => {
    mockListOrderReturns.mockResolvedValue([RETURN_DETAIL]);
    mockLoadReturnableUnits.mockResolvedValue(3);
    mockLoadRefundMaterials.mockResolvedValue({ order: { refundableAmount: 8000, refundableShipping: 500 } });
    mockGetShopReturnSettings.mockResolvedValue(settingsOf(true));
  });

  it('店長には、返品の一覧・返金できるか・返品できる数・返せる額と送料・要検品の設定を返す。読むだけなので CSRF と回数の制限は通さない', async () => {
    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      data: {
        returns: [RETURN_DETAIL],
        canRefund: true,
        returnableUnits: 3,
        refundableAmount: 8000,
        refundableShipping: 500,
        inspectionEnabled: true,
      },
    });
    expect(mockListOrderReturns).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockLoadReturnableUnits).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockLoadRefundMaterials).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockGetShopReturnSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('サポート（返金の権限が無い人）にも一覧は返す。返金できるかは偽', async () => {
    grant('admin.orders.return');

    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: expect.objectContaining({ canRefund: false }) });
  });

  // Task 9: 受け取りの画面は、この答えの inspectionEnabled で「検品待ち」を選ばせるかを決める
  it.each<[string, boolean]>([
    ['オン', true],
    ['オフ', false],
  ])('要検品の設定が%sなら、そのまま inspectionEnabled に入れる。ほかの欄は変わらない', async (_name, enabled) => {
    mockGetShopReturnSettings.mockResolvedValue(settingsOf(enabled));

    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: expect.objectContaining({
        canRefund: true, returnableUnits: 3, refundableAmount: 8000, refundableShipping: 500, inspectionEnabled: enabled,
      }),
    });
  });

  // サポートは設定の窓口（admin.settings.manage）を読めないが、受け取りの画面を開く。この窓口が設定から読んで入れる
  it('サポート（返金の権限が無い人）にも inspectionEnabled を返す。設定の窓口の権限は確かめない', async () => {
    grant('admin.orders.return');

    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: expect.objectContaining({ canRefund: false, inspectionEnabled: true }) });
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
  });

  it('権限 admin.orders.return が無ければ認可の応答を返し、DB を読まない', async () => {
    grant();

    expect((await getReturns(listRequest(), ORDER_CONTEXT)).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockListOrderReturns).not.toHaveBeenCalled();
    expect(mockGetShopReturnSettings).not.toHaveBeenCalled();
  });

  // 返金の権限を確かめられなかった（セッションの確認が一時的に使えない）だけの人を、黙ってサポートの扱いにしない
  it.each([401, 503])('返金の権限を確かめられなかった（%i）時は、その応答をそのまま返し、DB を読まない', async (status) => {
    mockAuthorize
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status }) });

    expect((await getReturns(listRequest(), ORDER_CONTEXT)).status).toBe(status);
    expect(mockListOrderReturns).not.toHaveBeenCalled();
    expect(mockGetShopReturnSettings).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400。DB を読まない', async () => {
    const response = await getReturns(listRequest(), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockListOrderReturns).not.toHaveBeenCalled();
    expect(mockGetShopReturnSettings).not.toHaveBeenCalled();
  });

  it('注文が無ければ（返金の材料が null）404。E-2 の言葉', async () => {
    mockLoadRefundMaterials.mockResolvedValue(null);

    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('DB が決まった言葉で断ったら、その HTTP と C-4 の言葉', async () => {
    mockListOrderReturns.mockRejectedValue(new ReturnStoreError('RETURN_NOT_FOUND'));

    const response = await getReturns(listRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' });
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    mockListOrderReturns.mockRejectedValue(new RefundStoreError('list_order_returns', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getReturns(listRequest(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の一覧を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.list] Failed to load returns', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });

  // 設定だけ読めなかった時に inspectionEnabled を偽にして返すと、要検品がオンの店でサポートが検品待ちを選べなくなり、気づけない（T7-15）
  it('設定だけ読めなかった時も、inspectionEnabled を偽にして返さず、一覧全体を 500 にする', async () => {
    mockGetShopReturnSettings.mockRejectedValue(
      new RefundStoreError('get_shop_return_settings', { message: '宛先・氏名を含む DB の文', code: '08006' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getReturns(listRequest(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の一覧を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.list] Failed to load returns', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('GET /api/admin/orders/[id]/returns/materials（返品を作る画面の材料）', () => {
  it('返品の権限で材料を返す。読むだけなので CSRF と回数の制限は通さない。返金の権限は確かめない', async () => {
    mockLoadReturnCreateMaterials.mockResolvedValue(MATERIALS);

    const response = await getMaterials(materialsRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: MATERIALS });
    expect(mockLoadReturnCreateMaterials).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、DB を読まない', async () => {
    grant();

    expect((await getMaterials(materialsRequest(), ORDER_CONTEXT)).status).toBe(403);
    expect(mockLoadReturnCreateMaterials).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400', async () => {
    const response = await getMaterials(materialsRequest(), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockLoadReturnCreateMaterials).not.toHaveBeenCalled();
  });

  it('返品を作れない注文は 409 ORDER_NOT_RETURNABLE（C-4 の言葉）、注文が無ければ E-2 の 404', async () => {
    mockLoadReturnCreateMaterials.mockRejectedValueOnce(new ReturnStoreError('ORDER_NOT_RETURNABLE'));
    const notReturnable = await getMaterials(materialsRequest(), ORDER_CONTEXT);
    expect(notReturnable.status).toBe(409);
    await expect(notReturnable.json()).resolves.toEqual({ error: 'この注文は返品を作れません。', code: 'ORDER_NOT_RETURNABLE' });

    mockLoadReturnCreateMaterials.mockRejectedValueOnce(new ReturnStoreError('order_not_found'));
    const missing = await getMaterials(materialsRequest(), ORDER_CONTEXT);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ', async () => {
    mockLoadReturnCreateMaterials.mockRejectedValue(
      new RefundStoreError('get_order_return_materials', { message: '宛先・氏名を含む DB の文', code: '08006' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getMaterials(materialsRequest(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の材料を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([
        ['[admin.orders.return.materials] Failed to load materials', 'RefundStoreError', '08006'],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// 書く窓口は、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる
describe('POST /api/admin/orders/[id]/returns の守り', () => {
  beforeEach(() => {
    mockSubmitCreate.mockResolvedValue({ kind: 'done', ...CREATED });
  });

  it('権限 admin.orders.return が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    grant();

    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(403);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('サポート（返金の権限が無い人）も返品を作れる。返金の権限は確かめない', async () => {
    grant('admin.orders.return');

    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、返品を作る窓口の名前と回数（10分に30回）で数える', async () => {
    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:returns:create', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:returns:create', limit: 30, windowSeconds: 600, subject: 'admin-1',
    });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(429);
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/returns（返品を作る）', () => {
  const INVALID_BODIES: Array<[string, unknown]> = [
    ['requestKey が無い', { ...CREATE_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...CREATE_BODY, requestKey: 'abc' }],
    ['品の行が無い', { ...CREATE_BODY, lines: undefined }],
    ['品の行が空', { ...CREATE_BODY, lines: [] }],
    ['品の行が配列でない', { ...CREATE_BODY, lines: 'x' }],
    ['品の行が101行', { ...CREATE_BODY, lines: Array.from({ length: 101 }, () => REFUND_LINE) }],
    ['発送の番号が UUID でない', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, fulfillmentId: 'f-1' }] }],
    ['商品の番号が UUID でない', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, orderItemId: 'item-1' }] }],
    ['数が0', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, quantity: 0 }] }],
    ['数が1000', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, quantity: 1000 }] }],
    ['数が小数', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, quantity: 1.5 }] }],
    ['理由が知らない値', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, reason: 'broken' }] }],
    ['理由が無い', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, reason: undefined }] }],
    ['理由のメモが256文字', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, reasonNote: 'あ'.repeat(256) }] }],
    ['解決の方法が知らない値', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, resolution: 'replace' }] }],
    ['交換なのに色・サイズが無い', { ...CREATE_BODY, lines: [{ ...EXCHANGE_LINE, exchangeVariantId: null }] }],
    ['交換なのに送り方が無い', { ...CREATE_BODY, lines: [{ ...EXCHANGE_LINE, exchangeMethod: null }] }],
    ['返金なのに交換の色・サイズがある', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, exchangeVariantId: 101 }] }],
    ['返金なのに交換の送り方がある', { ...CREATE_BODY, lines: [{ ...REFUND_LINE, exchangeMethod: 'stock' }] }],
    ['交換の色・サイズの番号が0', { ...CREATE_BODY, lines: [{ ...EXCHANGE_LINE, exchangeVariantId: 0 }] }],
    ['交換の色・サイズの番号が小数', { ...CREATE_BODY, lines: [{ ...EXCHANGE_LINE, exchangeVariantId: 1.5 }] }],
    ['交換の送り方が知らない値', { ...CREATE_BODY, lines: [{ ...EXCHANGE_LINE, exchangeMethod: 'ship' }] }],
    ['返送の方法が知らない値', { ...CREATE_BODY, returnMethod: 'pickup' }],
    ['返送の方法が無い', { ...CREATE_BODY, returnMethod: undefined }],
    ['返送料の負担が知らない値', { ...CREATE_BODY, returnShippingPayer: 'both' }],
    ['返送料の負担が無い', { ...CREATE_BODY, returnShippingPayer: undefined }],
    ['返送の配送業者が知らない値', { ...CREATE_BODY, returnCarrier: 'fedex' }],
    ['返送の伝票番号に空白', { ...CREATE_BODY, returnTrackingNumber: 'AB 123' }],
    ['返送の伝票番号が65文字', { ...CREATE_BODY, returnTrackingNumber: 'a'.repeat(65) }],
    // 手数料の4つは必須（画面は使わない手数料を 0 にして送る。Task 10）
    ['返送料が無い', { ...CREATE_BODY, returnShippingFee: undefined }],
    ['返送料が null', { ...CREATE_BODY, returnShippingFee: null }],
    ['返送料が負', { ...CREATE_BODY, returnShippingFee: -1 }],
    ['返送料が小数', { ...CREATE_BODY, returnShippingFee: 1.5 }],
    ['返送料が1000000を超える', { ...CREATE_BODY, returnShippingFee: 1000001 }],
    ['交換の手数料が1000000を超える', { ...CREATE_BODY, exchangeFee: 1000001 }],
    ['交換の送料が1000000を超える', { ...CREATE_BODY, exchangeShippingFee: 1000001 }],
    ['返品の手数料が無い', { ...CREATE_BODY, restockingFeePercent: undefined }],
    ['返品の手数料が101%', { ...CREATE_BODY, restockingFeePercent: 101 }],
    ['返品の手数料が負', { ...CREATE_BODY, restockingFeePercent: -1 }],
    ['返品の手数料が小数', { ...CREATE_BODY, restockingFeePercent: 10.5 }],
    ['交換の手数料が無い', { ...CREATE_BODY, exchangeFee: undefined }],
    ['交換の手数料が負', { ...CREATE_BODY, exchangeFee: -1 }],
    ['交換の送料が無い', { ...CREATE_BODY, exchangeShippingFee: undefined }],
    ['交換の送料が負', { ...CREATE_BODY, exchangeShippingFee: -1 }],
    ['店のメモが501文字', { ...CREATE_BODY, shopNote: 'あ'.repeat(501) }],
    ['店のメモが文字でない', { ...CREATE_BODY, shopNote: 5 }],
    ['お客様に知らせるが無い', { ...CREATE_BODY, notifyCustomer: undefined }],
    ['お客様に知らせるが真偽でない', { ...CREATE_BODY, notifyCustomer: 'yes' }],
  ];

  beforeEach(() => {
    mockSubmitCreate.mockResolvedValue({ kind: 'done', ...CREATED });
  });

  it('実行した人と中身を入口に渡し、番号・状態を data で返す。監査にメモ・伝票番号を入れず、鍵も伏せられない', async () => {
    const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: CREATED });
    expect(mockCreateDeps).toHaveBeenCalledTimes(1);
    expect(mockSubmitCreate).toHaveBeenCalledTimes(1);
    expect(mockSubmitCreate).toHaveBeenCalledWith(mockDeps, { orderId: ORDER_ID, actorId: 'admin-1', ...CREATE_BODY });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.return.create',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Return created',
      ip: '203.0.113.5',
      user_agent: 'jest',
      // 返品の番号の鍵は number でなく sequence（maskAuditEvent が number を含む鍵を伏せるため）
      metadata: { return_id: RETURN_ID, sequence: 1, status: 'open', replayed: false, line_count: 2, notify_customer: true },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('電話で依頼');
    expect(audited).not.toContain('袖に穴');
    expect(audited).not.toContain('AB-123');
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('省ける欄は null にして渡す。空・空白だけの文と伝票番号は null、メモの前後の空白は除く', async () => {
    const body = {
      ...CREATE_BODY,
      lines: [{ ...REFUND_LINE, reasonNote: '  ' }],
      returnCarrier: undefined,
      returnTrackingNumber: '',
      shopNote: '  電話で依頼  ',
    };

    const response = await postReturn(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitCreate).toHaveBeenCalledWith(mockDeps, {
      orderId: ORDER_ID,
      actorId: 'admin-1',
      ...CREATE_BODY,
      lines: [{ ...REFUND_LINE, reasonNote: null }],
      returnCarrier: null,
      returnTrackingNumber: null,
      shopNote: '電話で依頼',
    });
  });

  it('画面が使わない手数料を 0 にして送る本文（Task 10）を受け、0 のまま入口に渡す。交換でない行の交換の欄は null', async () => {
    const body = {
      ...CREATE_BODY,
      lines: [{ ...REFUND_LINE, reasonNote: null }],
      returnCarrier: null,
      returnTrackingNumber: null,
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      shopNote: null,
    };

    const response = await postReturn(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitCreate).toHaveBeenCalledWith(mockDeps, { orderId: ORDER_ID, actorId: 'admin-1', ...body });
  });

  // Global Constraints の金額の上限（1,000,000 円）。DB の RETURN_FEE_INVALID・画面（Task 10）と同じ値で、上限ちょうどは通す
  it('円の手数料（返送料・交換の手数料・交換の送料）は 1000000 まで受け、そのまま入口に渡す', async () => {
    const body = { ...CREATE_BODY, returnShippingFee: 1000000, exchangeFee: 1000000, exchangeShippingFee: 1000000 };

    const response = await postReturn(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitCreate).toHaveBeenCalledWith(mockDeps, { orderId: ORDER_ID, actorId: 'admin-1', ...body });
  });

  it('同じ発送の同じ品を、理由を変えて2行にできる（2点は不良、1点は不要）', async () => {
    const lines = [
      { ...REFUND_LINE, quantity: 2 },
      { ...REFUND_LINE, quantity: 1, reason: 'unwanted', reasonNote: null },
    ];

    const response = await postReturn(createRequest({ ...CREATE_BODY, lines }), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockSubmitCreate).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ lines }));
  });

  it('同じ番号の送り直しの答え（replayed）は、200 のまま写す。メールの送る処理は入口が決める（窓口は動かさない）', async () => {
    mockSubmitCreate.mockResolvedValue({ kind: 'done', ...CREATED, replayed: true });

    const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ...CREATED, replayed: true } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ replayed: true }),
    }));
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。入口を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postReturn(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.return.create', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postReturn(createRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockSubmitCreate).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400。入口を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postReturn(createRequest(CREATE_BODY), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockSubmitCreate).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      resource_id: 'x', outcome: 'failure', detail: 'Invalid order id', metadata: null,
    }));
  });

  it.each(C4_CASES)('入口が %s で断った（答えで返した）ら HTTP %i と C-4 の言葉。409 は衝突、ほかは失敗として監査に残す', async (code, status, message) => {
    mockSubmitCreate.mockResolvedValue({ kind: 'refused', code });

    const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message, code });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.return.create',
      outcome: status === 409 ? 'conflict' : 'failure',
      detail: 'Return create refused',
      metadata: { code },
    }));
  });

  it('断りが投げられても（入口は答えで返すので本来は来ない）、答えで返された時と同じ HTTP と言葉', async () => {
    mockSubmitCreate.mockRejectedValue(new ReturnStoreError('RETURN_ADDRESS_REQUIRED'));

    const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。',
      code: 'RETURN_ADDRESS_REQUIRED',
    });
  });

  it('E-2 の記号で断られたら（入口が E-2 の言葉をそのまま渡した時）、E-2 の言葉と HTTP', async () => {
    mockSubmitCreate.mockResolvedValue({ kind: 'refused', code: 'order_not_found' });

    const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    mockSubmitCreate.mockRejectedValue(new RefundStoreError('admin_create_return', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.create] Failed to create return', 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin.orders.return.create', outcome: 'error', detail: 'Failed to create return', metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('入口に渡す道具を作れなかった（環境の値が無い）時も、決まった 500。ログは例外名だけ', async () => {
    mockCreateDeps.mockRejectedValue(new TypeError('STRIPE_SECRET_KEY is not set'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postReturn(createRequest(CREATE_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.create] Failed to create return', 'TypeError']]);
      expect(mockSubmitCreate).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
