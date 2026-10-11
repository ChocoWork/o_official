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

import { GET, PUT } from '@/app/api/admin/settings/shop/route';
import { RefundOperationError, RefundStoreError, type ShopSettingsRow } from '@/lib/orders/refund/refund-store';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockGetShopSettings.mockReset();
  mockUpdateShopSettings.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe('GET /api/admin/settings/shop', () => {
  it('ショップの設定の権限で2つのトグルを返す。切り替えの時刻は返さない。読むだけなので CSRF と回数の制限は通さない', async () => {
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
      },
    });
    expect(JSON.stringify(body)).not.toContain('refundLedgerStartedAt');
    expect(mockGetShopSettings).toHaveBeenCalledWith(mockServiceClient);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ（サポートの人）認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await GET(getRequest())).status).toBe(403);
    expect(mockGetShopSettings).not.toHaveBeenCalled();
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ', async () => {
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
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も保存しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await PUT(putRequest(NEXT))).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
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

    expect((await PUT(putRequest(NEXT))).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も保存しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await PUT(putRequest(NEXT))).status).toBe(429);
    expect(mockUpdateShopSettings).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/settings/shop', () => {
  const INVALID_BODIES: Array<[string, unknown]> = [
    ['2つとも無い', {}],
    ['自動の取消が無い', { autoRefundCancelledOrderPayment: true }],
    ['自動の返金が無い', { autoCancelAmountMismatch: true }],
    ['真偽でない（文字）', { autoRefundCancelledOrderPayment: 'true', autoCancelAmountMismatch: false }],
    ['真偽でない（数）', { autoRefundCancelledOrderPayment: 1, autoCancelAmountMismatch: 0 }],
    ['null', { autoRefundCancelledOrderPayment: null, autoCancelAmountMismatch: null }],
  ];

  beforeEach(() => {
    mockGetShopSettings.mockResolvedValue(BEFORE);
    mockUpdateShopSettings.mockResolvedValue(AFTER);
  });

  it('保存の前の値を読んでから保存し、保存後の2つのトグルを返す。切り替えの時刻は返さない', async () => {
    const response = await PUT(putRequest(NEXT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        autoRefundCancelledOrderPayment: AFTER.autoRefundCancelledOrderPayment,
        autoCancelAmountMismatch: AFTER.autoCancelAmountMismatch,
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

  it('監査に、変えたトグルの名前と新しい値だけを残す（変えた人のメールや時刻は入れない）', async () => {
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
