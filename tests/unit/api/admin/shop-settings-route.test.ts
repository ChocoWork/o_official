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
// DB の行の写し方は Task 4 の試験の持ち場。窓口の試験では、設定の読み書きの呼び出しだけを差し替える
const mockGetShopSettings = jest.fn();
const mockUpdateShopSettings = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  ...jest.requireActual('@/lib/orders/refund/refund-store'),
  getShopSettings: (...args: unknown[]) => mockGetShopSettings(...args),
  updateShopSettings: (...args: unknown[]) => mockUpdateShopSettings(...args),
}));
const mockGetShopReturnSettings = jest.fn();
const mockUpdateShopReturnSettings = jest.fn();
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  getShopReturnSettings: (...args: unknown[]) => mockGetShopReturnSettings(...args),
  updateShopReturnSettings: (...args: unknown[]) => mockUpdateShopReturnSettings(...args),
}));

import { GET, PUT } from '@/app/api/admin/settings/shop/route';
import { RefundOperationError, RefundStoreError, type ShopSettingsRow } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { RETURN_REASONS, type ShopReturnSettings } from '@/lib/orders/returns/return-types';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

// 保存の前: 自動の返金①はオン（変えた人はまだ無い）、②はオフ（前に別の店長が変えた）
const BEFORE: ShopSettingsRow = {
  autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
  autoCancelAmountMismatch: { enabled: false, updatedAt: '2026-10-11T03:00:00.000Z', updatedByEmail: 'owner@example.com' },
  refundLedgerStartedAt: '2026-10-11T00:00:00.000Z',
};
// 保存の後: 両方を admin@example.com が変えた
const AFTER: ShopSettingsRow = {
  autoRefundCancelledOrderPayment: { enabled: false, updatedAt: '2026-10-11T04:00:00.000Z', updatedByEmail: 'admin@example.com' },
  autoCancelAmountMismatch: { enabled: true, updatedAt: '2026-10-11T04:00:00.000Z', updatedByEmail: 'admin@example.com' },
  refundLedgerStartedAt: '2026-10-11T00:00:00.000Z',
};
const NEXT = { autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: true };

const NEVER = { at: null, byEmail: null };
const CHANGED = { at: '2026-10-12T04:00:00.000Z', byEmail: 'admin@example.com' };
const REASON_BASE = { shown: false, resolutions: 'refund_and_exchange', photo: 'none', photoInstructions: '' } as const;

// 保存の前の返品の設定（移行 A の最初の値に近い形。理由はどれも お客様の負担・在庫が無ければ受けない）
const RETURNS_BEFORE: ShopReturnSettings = {
  requestsEnabled: true,
  requestTypes: 'returns_only',
  noticeText: '',
  windowDays: 7,
  windowStart: 'each_item',
  deliveryBufferDays: 3,
  returnAddress: null,
  customerPaidMethod: 'customer_ships',
  shopLabelFee: 0,
  noReturnNeededEnabled: false,
  restockingFeeEnabled: false,
  restockingFeePercent: 0,
  exchangeFeesEnabled: false,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  inspectionEnabled: false,
  reasons: RETURN_REASONS.map((reason) => ({
    reason, ...REASON_BASE, outOfStockExchange: 'decline' as const, shippingPayer: 'customer' as const,
  })),
  updated: { requests: NEVER, window: NEVER, shipping: NEVER, reasons: NEVER, fees: NEVER, receiving: NEVER },
};

// テスト用の返送先（本物の住所ではない）。監査に値が入らないことを確かめるのにも使う
const ADDRESS = { name: 'テスト商店', postalCode: '150-0001', address: '東京都渋谷区テスト町1-2-3', phone: '03-1234-5678' };

/** 保存の前と同じ値の本文（変更なし）。画面は段1の欄を全部送る */
const RETURNS_UNCHANGED = {
  returnAddress: null,
  customerPaidMethod: 'customer_ships',
  shopLabelFee: 0,
  noReturnNeededEnabled: false,
  windowDays: 7,
  windowStart: 'each_item',
  deliveryBufferDays: 3,
  reasons: RETURN_REASONS.map((reason) => ({ reason, shippingPayer: 'customer', outOfStockExchange: 'decline' })),
  restockingFeeEnabled: false,
  restockingFeePercent: 0,
  exchangeFeesEnabled: false,
  exchangeFee: 0,
  exchangeShippingFee: 0,
  inspectionEnabled: false,
};
/** 5つのまとまり（返送・受付の期限・理由ごとの設定・手数料・受け取り）が全部変わる本文 */
const RETURNS_REQUEST = {
  returnAddress: ADDRESS,
  customerPaidMethod: 'shop_label',
  shopLabelFee: 800,
  noReturnNeededEnabled: true,
  windowDays: 14,
  windowStart: 'last_item',
  deliveryBufferDays: 2,
  reasons: RETURN_REASONS.map((reason) => ({
    reason,
    shippingPayer: reason === 'defective' ? 'shop' : 'customer',
    outOfStockExchange: reason === 'defective' ? 'make' : 'decline',
  })),
  restockingFeeEnabled: true,
  restockingFeePercent: 10,
  exchangeFeesEnabled: true,
  exchangeFee: 300,
  exchangeShippingFee: 500,
  inspectionEnabled: true,
};
// 保存の後の返品の設定（RETURNS_REQUEST を保存した結果。5つのまとまりを admin@example.com が変えた）
const RETURNS_AFTER: ShopReturnSettings = {
  ...RETURNS_BEFORE,
  returnAddress: ADDRESS,
  customerPaidMethod: 'shop_label',
  shopLabelFee: 800,
  noReturnNeededEnabled: true,
  windowDays: 14,
  windowStart: 'last_item',
  deliveryBufferDays: 2,
  reasons: RETURNS_BEFORE.reasons.map((row) =>
    row.reason === 'defective' ? { ...row, shippingPayer: 'shop' as const, outOfStockExchange: 'make' as const } : row,
  ),
  restockingFeeEnabled: true,
  restockingFeePercent: 10,
  exchangeFeesEnabled: true,
  exchangeFee: 300,
  exchangeShippingFee: 500,
  inspectionEnabled: true,
  updated: { ...RETURNS_BEFORE.updated, shipping: CHANGED, window: CHANGED, reasons: CHANGED, fees: CHANGED, receiving: CHANGED },
};

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

function getRequest() {
  return new Request('http://localhost/api/admin/settings/shop');
}

function putRequest(body: unknown, rawBody?: string) {
  return new Request('http://localhost/api/admin/settings/shop', {
    method: 'PUT',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

/** 返品の欄つきの本文。変えたい欄だけを渡す */
function withReturns(change: Record<string, unknown> = {}) {
  return { ...NEXT, returns: { ...RETURNS_REQUEST, ...change } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockGetShopSettings.mockReset();
  mockUpdateShopSettings.mockReset();
  mockGetShopReturnSettings.mockReset();
  mockUpdateShopReturnSettings.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockGetShopReturnSettings.mockResolvedValue(RETURNS_BEFORE);
});

describe('GET /api/admin/settings/shop', () => {
  it('ショップの設定の権限で、2つのトグルと返品の設定を返す。切り替えの時刻は返さない。読むだけなので CSRF と回数の制限は通さない', async () => {
    mockGetShopSettings.mockResolvedValue(BEFORE);

    const response = await GET(getRequest());

    expect(mockAuthorize).toHaveBeenCalledWith('admin.settings.manage', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      data: {
        autoRefundCancelledOrderPayment: BEFORE.autoRefundCancelledOrderPayment,
        autoCancelAmountMismatch: BEFORE.autoCancelAmountMismatch,
        returns: RETURNS_BEFORE,
      },
    });
    expect(JSON.stringify(body)).not.toContain('refundLedgerStartedAt');
    expect(mockGetShopSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockGetShopReturnSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ（サポートの人）認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await GET(getRequest())).status).toBe(403);
    expect(mockGetShopSettings).not.toHaveBeenCalled();
    expect(mockGetShopReturnSettings).not.toHaveBeenCalled();
  });

  it('自動の返金の設定を読めなければ 500。ログは例外名と DB の記号だけ', async () => {
    mockGetShopSettings.mockRejectedValue(new RefundStoreError('get_shop_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await GET(getRequest());
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'ショップの設定を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.settings.shop.read] Failed to load settings', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の設定を読めなければ 500。returns の無い答えを返さない', async () => {
    mockGetShopSettings.mockResolvedValue(BEFORE);
    mockGetShopReturnSettings.mockRejectedValue(new RefundStoreError('get_shop_return_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await GET(getRequest());
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'ショップの設定を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.settings.shop.read] Failed to load settings', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// 書く窓口は、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる
describe('PUT /api/admin/settings/shop の守り', () => {
  beforeEach(() => {
    mockGetShopSettings.mockResolvedValue(BEFORE);
    mockUpdateShopSettings.mockResolvedValue(AFTER);
  });

  it('権限 admin.settings.manage が無ければ（サポートの人）CSRF も回数の制限も確かめず、認可の応答を返す', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await PUT(putRequest(NEXT))).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.settings.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も保存しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await PUT(putRequest(withReturns()))).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、設定の保存の名前と回数で数える', async () => {
    expect((await PUT(putRequest(NEXT))).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:settings:shop-update', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:settings:shop-update', limit: 30, windowSeconds: 600, subject: 'admin-1',
    });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も保存しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await PUT(putRequest(withReturns()))).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も保存しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await PUT(putRequest(withReturns()))).status).toBe(429);
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/settings/shop（自動の返金のトグル）', () => {
  const INVALID_BODIES: Array<[string, unknown]> = [
    ['2つとも無い', {}],
    ['自動の取消が無い', { autoRefundCancelledOrderPayment: true }],
    ['自動の返金が無い', { autoCancelAmountMismatch: true }],
    ['真偽でない（文字）', { autoRefundCancelledOrderPayment: 'true', autoCancelAmountMismatch: false }],
    ['真偽でない（数）', { autoRefundCancelledOrderPayment: 1, autoCancelAmountMismatch: 0 }],
    ['null', { autoRefundCancelledOrderPayment: null, autoCancelAmountMismatch: null }],
    // 返品の欄だけの本文は受けない（今の2つは必須のまま。画面は保存の直前に読み直した値を付ける）
    ['返品の欄だけでトグルが無い', { returns: RETURNS_REQUEST }],
  ];

  beforeEach(() => {
    mockGetShopSettings.mockResolvedValue(BEFORE);
    mockUpdateShopSettings.mockResolvedValue(AFTER);
  });

  it('保存の前の値を読んでから保存し、保存後の2つのトグルと、触っていない返品の設定を返す。切り替えの時刻は返さない', async () => {
    const response = await PUT(putRequest(NEXT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        autoRefundCancelledOrderPayment: AFTER.autoRefundCancelledOrderPayment,
        autoCancelAmountMismatch: AFTER.autoCancelAmountMismatch,
        returns: RETURNS_BEFORE,
      },
    });
    expect(mockGetShopSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockUpdateShopSettings).toHaveBeenCalledWith(mockServiceClient, {
      autoRefundCancelledOrderPayment: false,
      autoCancelAmountMismatch: true,
      actorId: 'admin-1',
    });
    expect(mockGetShopSettings.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateShopSettings.mock.invocationCallOrder[0]);
  });

  it('返品の欄を付けない保存は、返品の設定に触らない（書かない）', async () => {
    await PUT(putRequest(NEXT));

    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
  });

  it('監査に、変えたトグルの名前と新しい値だけを残す（変えた人のメールや時刻は入れない）。返品の鍵は付けない', async () => {
    await PUT(putRequest(NEXT));

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.settings.shop.update',
      actor_id: 'admin-1',
      resource: 'shop_settings',
      resource_id: null,
      outcome: 'success',
      detail: 'Shop settings saved',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { changes: { auto_refund_cancelled_order_payment: false, auto_cancel_amount_mismatch: true } },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain('@example.com');
    expect(audited).not.toContain('2026-10-11T0');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('片方だけ変えた時は、変えたトグルだけを監査に残す', async () => {
    await PUT(putRequest({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: true }));

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { changes: { auto_cancel_amount_mismatch: true } },
    }));
  });

  it('何も変えない保存も 200。監査の変えたトグルは空', async () => {
    const response = await PUT(putRequest({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false }));

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { changes: {} } }));
  });

  it.each(INVALID_BODIES)('中身の誤り（%s）は 400。読み書きせず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await PUT(putRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockGetShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.settings.shop.update', actor_id: 'admin-1', resource: 'shop_settings', resource_id: null,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await PUT(putRequest(null, rawBody));

    expect(response.status).toBe(400);
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
  });

  it('保存の前の値を読めなければ 500。保存せず、ログは例外名と DB の記号だけ', async () => {
    mockGetShopSettings.mockRejectedValue(new RefundStoreError('get_shop_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await PUT(putRequest(NEXT));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'ショップの設定を保存できませんでした。', code: 'failed' });
      expect(mockUpdateShopSettings).not.toHaveBeenCalled();
      expect(consoleError.mock.calls).toEqual([['[admin.settings.shop.update] Failed to save settings', 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', detail: 'Failed to save shop settings', metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の設定の保存の前の値を読めなければ 500。どちらも保存しない', async () => {
    mockGetShopReturnSettings.mockRejectedValue(new RefundStoreError('get_shop_return_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await PUT(putRequest(withReturns()));
      expect(response.status).toBe(500);
      expect(mockUpdateShopSettings).not.toHaveBeenCalled();
      expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // 本文は窓口の zod で確かめ済みなのでふつうは起きない。起きても C-2 の対応（SETTINGS_ARGUMENT_INVALID → invalid_argument → 400）で返す
  it('DB が決まった言葉で断ったら（設定の引数の誤り）、400 と画面の言葉を返し、監査は失敗', async () => {
    mockUpdateShopSettings.mockRejectedValue(new RefundOperationError('invalid_argument'));

    const response = await PUT(putRequest(NEXT));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_argument' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', detail: 'Shop settings refused', metadata: { code: 'invalid_argument' },
    }));
  });

  it('保存に失敗したら 500。ログは例外名と DB の記号だけ', async () => {
    mockUpdateShopSettings.mockRejectedValue(new RefundStoreError('admin_update_shop_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await PUT(putRequest(NEXT));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'ショップの設定を保存できませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.settings.shop.update] Failed to save settings', 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', detail: 'Failed to save shop settings', metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('PUT /api/admin/settings/shop（返品の欄）', () => {
  const REASONS = RETURNS_REQUEST.reasons;
  const INVALID_RETURNS: Array<[string, unknown]> = [
    ['返品の欄が null', { ...NEXT, returns: null }],
    ['返品の欄が空', { ...NEXT, returns: {} }],
    ['返品の欄の項目が欠けている（要検品）', withReturns({ inspectionEnabled: undefined })],
    ['返品の欄の項目が欠けている（返送先）', withReturns({ returnAddress: undefined })],
    ['返品の欄の項目が欠けている（理由の行）', withReturns({ reasons: undefined })],
    ['段2の欄（申し込みの受付）は送れない', withReturns({ requestsEnabled: false })],
    ['段2の欄（注意書き）は送れない', withReturns({ noticeText: '注意' })],
    ['返送先の郵便番号の形が違う', withReturns({ returnAddress: { ...ADDRESS, postalCode: '12345' } })],
    ['返送先の電話番号の形が違う', withReturns({ returnAddress: { ...ADDRESS, phone: 'abc' } })],
    ['返送先の名前が空白だけ', withReturns({ returnAddress: { ...ADDRESS, name: '   ' } })],
    ['返送先の名前が201文字', withReturns({ returnAddress: { ...ADDRESS, name: 'あ'.repeat(201) } })],
    ['返送先の住所が空', withReturns({ returnAddress: { ...ADDRESS, address: '' } })],
    ['返送先の住所が201文字', withReturns({ returnAddress: { ...ADDRESS, address: 'あ'.repeat(201) } })],
    ['返送先の電話番号が欠けている', withReturns({ returnAddress: { ...ADDRESS, phone: undefined } })],
    ['返送先に知らない欄', withReturns({ returnAddress: { ...ADDRESS, country: 'JP' } })],
    ['お客様の負担の時の送り方が知らない値', withReturns({ customerPaidMethod: 'pickup' })],
    ['返送料の定額が負', withReturns({ shopLabelFee: -1 })],
    ['返送料の定額が小数', withReturns({ shopLabelFee: 1.5 })],
    ['返送料の定額が1000000を超える', withReturns({ shopLabelFee: 1000001 })],
    ['交換の手数料が1000000を超える', withReturns({ exchangeFee: 1000001 })],
    ['交換の送料が1000000を超える', withReturns({ exchangeShippingFee: 1000001 })],
    ['返送不要が真偽でない', withReturns({ noReturnNeededEnabled: 'yes' })],
    ['日数が0', withReturns({ windowDays: 0 })],
    ['日数が366', withReturns({ windowDays: 366 })],
    ['日数が小数', withReturns({ windowDays: 1.5 })],
    ['日数が文字', withReturns({ windowDays: '7' })],
    ['数え始めが知らない値', withReturns({ windowStart: 'first_item' })],
    ['届いた日の目安が負', withReturns({ deliveryBufferDays: -1 })],
    ['届いた日の目安が15', withReturns({ deliveryBufferDays: 15 })],
    ['届いた日の目安が小数', withReturns({ deliveryBufferDays: 1.5 })],
    ['理由が9行', withReturns({ reasons: REASONS.slice(1) })],
    ['理由が11行', withReturns({ reasons: [...REASONS, REASONS[0]] })],
    ['理由が重なる（10行のうち同じ理由が2行）', withReturns({ reasons: [REASONS[0], ...REASONS.slice(0, 9)] })],
    ['知らない理由', withReturns({ reasons: [{ ...REASONS[0], reason: 'broken' }, ...REASONS.slice(1)] })],
    ['理由の行の返送料の負担が知らない値', withReturns({ reasons: [{ ...REASONS[0], shippingPayer: 'both' }, ...REASONS.slice(1)] })],
    ['理由の行の在庫の無い交換が知らない値', withReturns({ reasons: [{ ...REASONS[0], outOfStockExchange: 'wait' }, ...REASONS.slice(1)] })],
    [
      '理由の行の項目が欠けている',
      withReturns({ reasons: [{ reason: REASONS[0].reason, shippingPayer: 'shop' }, ...REASONS.slice(1)] }),
    ],
    ['理由の行に知らない欄（写真）', withReturns({ reasons: [{ ...REASONS[0], photo: 'required' }, ...REASONS.slice(1)] })],
    ['返品の手数料を使うが真偽でない', withReturns({ restockingFeeEnabled: 'yes' })],
    ['返品の手数料が101%', withReturns({ restockingFeePercent: 101 })],
    ['返品の手数料が負', withReturns({ restockingFeePercent: -1 })],
    ['返品の手数料が小数', withReturns({ restockingFeePercent: 10.5 })],
    ['交換の手数料と送料を使うが真偽でない', withReturns({ exchangeFeesEnabled: 'yes' })],
    ['交換の手数料が負', withReturns({ exchangeFee: -1 })],
    ['交換の送料が負', withReturns({ exchangeShippingFee: -1 })],
    ['要検品が真偽でない', withReturns({ inspectionEnabled: 'yes' })],
  ];

  beforeEach(() => {
    mockGetShopSettings.mockResolvedValue(BEFORE);
    mockUpdateShopSettings.mockResolvedValue(AFTER);
    mockUpdateShopReturnSettings.mockResolvedValue(RETURNS_AFTER);
  });

  it('保存の前の値を両方読み、返品の欄 → トグルの順に保存する。答えは保存後の値で、returns を必ず含む', async () => {
    const response = await PUT(putRequest(withReturns()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        autoRefundCancelledOrderPayment: AFTER.autoRefundCancelledOrderPayment,
        autoCancelAmountMismatch: AFTER.autoCancelAmountMismatch,
        returns: RETURNS_AFTER,
      },
    });
    expect(mockGetShopSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockGetShopReturnSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockUpdateShopReturnSettings).toHaveBeenCalledWith(mockServiceClient, { settings: RETURNS_REQUEST, actorId: 'admin-1' });
    expect(mockUpdateShopSettings).toHaveBeenCalledWith(mockServiceClient, { ...NEXT, actorId: 'admin-1' });
    const readOrder = Math.max(mockGetShopSettings.mock.invocationCallOrder[0], mockGetShopReturnSettings.mock.invocationCallOrder[0]);
    expect(readOrder).toBeLessThan(mockUpdateShopReturnSettings.mock.invocationCallOrder[0]);
    expect(mockUpdateShopReturnSettings.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateShopSettings.mock.invocationCallOrder[0]);
  });

  it('返送先・名前・住所の前後の空白は除いて保存に渡す。返送先を消す（null）も渡せる', async () => {
    await PUT(putRequest(withReturns({ returnAddress: { ...ADDRESS, name: '  テスト商店  ', address: ' 東京都渋谷区テスト町1-2-3 ' } })));
    expect(mockUpdateShopReturnSettings).toHaveBeenLastCalledWith(mockServiceClient, {
      settings: RETURNS_REQUEST, actorId: 'admin-1',
    });

    await PUT(putRequest(withReturns({ returnAddress: null, windowDays: null })));
    expect(mockUpdateShopReturnSettings).toHaveBeenLastCalledWith(mockServiceClient, {
      settings: { ...RETURNS_REQUEST, returnAddress: null, windowDays: null }, actorId: 'admin-1',
    });
  });

  it('監査に、変えたトグル（changes）と、変わったまとまりの名前だけ（returns_changed_groups）を残す。返送先の値は入れない', async () => {
    await PUT(putRequest(withReturns()));

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.settings.shop.update',
      actor_id: 'admin-1',
      resource: 'shop_settings',
      resource_id: null,
      outcome: 'success',
      detail: 'Shop settings saved',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: {
        changes: { auto_refund_cancelled_order_payment: false, auto_cancel_amount_mismatch: true },
        returns_changed_groups: ['shipping', 'window', 'reasons', 'fees', 'receiving'],
      },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['テスト商店', '東京都渋谷区', '150-0001', '03-1234-5678', '@example.com']) {
      expect(audited).not.toContain(secret);
    }
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['何も変えない', {}, []],
    ['受付の期限だけ', { windowDays: 14 }, ['window']],
    ['返送料の定額だけ', { shopLabelFee: 500 }, ['shipping']],
    ['数え始めと届いた日の目安', { windowStart: 'last_item', deliveryBufferDays: 0 }, ['window']],
    ['手数料だけ', { restockingFeeEnabled: true, restockingFeePercent: 5 }, ['fees']],
    ['要検品だけ', { inspectionEnabled: true }, ['receiving']],
    [
      '1つの理由の返送料の負担だけ',
      { reasons: RETURNS_UNCHANGED.reasons.map((row) => (row.reason === 'color' ? { ...row, shippingPayer: 'shop' } : row)) },
      ['reasons'],
    ],
    ['返送先を入れる', { returnAddress: ADDRESS }, ['shipping']],
  ])('変わったまとまりだけを監査に残す（%s）', async (_name, change, groups) => {
    await PUT(putRequest({ ...NEXT, returns: { ...RETURNS_UNCHANGED, ...change } }));

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      metadata: expect.objectContaining({ returns_changed_groups: groups }),
    }));
  });

  it('返送先を消した（null）保存は、返送のまとまりが変わったと残す（値は入れない）', async () => {
    mockGetShopReturnSettings.mockResolvedValue({ ...RETURNS_BEFORE, returnAddress: ADDRESS });

    await PUT(putRequest({ ...NEXT, returns: { ...RETURNS_UNCHANGED, returnAddress: null } }));

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ returns_changed_groups: ['shipping'] }),
    }));
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('テスト商店');
  });

  // Global Constraints の金額の上限（1,000,000 円）。DB の admin_update_shop_return_settings・画面（Task 12）と同じ値で、上限ちょうどは通す
  it('円の3つの欄（返送料の定額・交換の手数料・交換の送料）は 1000000 まで受け、そのまま保存に渡す', async () => {
    const returns = { ...RETURNS_REQUEST, shopLabelFee: 1000000, exchangeFee: 1000000, exchangeShippingFee: 1000000 };

    const response = await PUT(putRequest({ ...NEXT, returns }));

    expect(response.status).toBe(200);
    expect(mockUpdateShopReturnSettings).toHaveBeenCalledWith(mockServiceClient, { settings: returns, actorId: 'admin-1' });
  });

  // 実際の DB は設定の引数の誤りを SETTINGS_ARGUMENT_INVALID で断り、store が E-2 の記号 invalid_argument の ReturnStoreError にする（Task 4）
  it('DB が設定の引数の誤り（SETTINGS_ARGUMENT_INVALID）で断ったら、400 の invalid_argument を返し、トグルは保存しない。監査は失敗', async () => {
    mockUpdateShopReturnSettings.mockRejectedValue(new ReturnStoreError('invalid_argument'));

    const response = await PUT(putRequest(withReturns()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_argument' });
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', detail: 'Shop settings refused', metadata: { code: 'invalid_argument' },
    }));
  });

  it.each(INVALID_RETURNS)('中身の誤り（%s）は 400。読み書きせず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await PUT(putRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockGetShopSettings).not.toHaveBeenCalled();
    expect(mockGetShopReturnSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockUpdateShopReturnSettings).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.settings.shop.update', actor_id: 'admin-1', resource: 'shop_settings', resource_id: null,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it('DB が決まった言葉で断ったら（返品の設定の引数の誤り）、400 と C-4 の言葉を返し、トグルは保存しない。監査は失敗', async () => {
    mockUpdateShopReturnSettings.mockRejectedValue(new ReturnStoreError('RETURN_ARGUMENT_INVALID'));

    const response = await PUT(putRequest(withReturns()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', detail: 'Shop settings refused', metadata: { code: 'RETURN_ARGUMENT_INVALID' },
    }));
  });

  it('返品の設定の保存が思いがけず失敗したら 500。トグルは保存しない。ログは例外名と DB の記号だけ（返送先は出さない）', async () => {
    mockUpdateShopReturnSettings.mockRejectedValue(
      new RefundStoreError('admin_update_shop_return_settings', { message: '東京都渋谷区テスト町を含む DB の文', code: '08006' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await PUT(putRequest(withReturns()));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'ショップの設定を保存できませんでした。', code: 'failed' });
      expect(mockUpdateShopSettings).not.toHaveBeenCalled();
      expect(consoleError.mock.calls).toEqual([['[admin.settings.shop.update] Failed to save settings', 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', detail: 'Failed to save shop settings', metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の設定は保存できたがトグルの保存が失敗したら 500。画面は同じ本文を送り直せる（同じ値の保存は何も変えない）', async () => {
    mockUpdateShopSettings.mockRejectedValue(new RefundStoreError('admin_update_shop_settings', { message: 'DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await PUT(putRequest(withReturns()));
      expect(response.status).toBe(500);
      expect(mockUpdateShopReturnSettings).toHaveBeenCalledTimes(1);
      // 返品の設定はもう変わったので、変わったまとまりを監査に残す（送り直しでは前の値が新しくなり、空になるため）
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to save shop settings',
        metadata: { returns_changed_groups: ['shipping', 'window', 'reasons', 'fees', 'receiving'] },
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の設定は保存できたがトグルの保存を DB が決まった言葉で断った時も、変わったまとまりを監査に残す', async () => {
    mockUpdateShopSettings.mockRejectedValue(new RefundOperationError('invalid_argument'));

    const response = await PUT(putRequest(withReturns()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_argument' });
    expect(mockUpdateShopReturnSettings).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      detail: 'Shop settings refused',
      metadata: { code: 'invalid_argument', returns_changed_groups: ['shipping', 'window', 'reasons', 'fees', 'receiving'] },
    }));
  });
});
