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
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));
const mockSchedule = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockSchedule(...args),
}));
// DB の行の写し方は Task 4 の試験の持ち場。窓口の試験では、4つの呼び出しだけを差し替える
const mockListCancelRequests = jest.fn();
const mockDeclineCancelRequest = jest.fn();
const mockCloseCancelRequest = jest.fn();
const mockResolveCancelRequest = jest.fn();
jest.mock('@/lib/orders/returns/cancel-request-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/cancel-request-store'),
  listOrderCancelRequests: (...args: unknown[]) => mockListCancelRequests(...args),
  declineCancelRequest: (...args: unknown[]) => mockDeclineCancelRequest(...args),
  closeCancelRequest: (...args: unknown[]) => mockCloseCancelRequest(...args),
  resolveCancelRequest: (...args: unknown[]) => mockResolveCancelRequest(...args),
}));
// 注文の状態と発送した数の読み出しの試験は cancel-request-reads.test.ts の持ち場
const mockLoadContext = jest.fn();
jest.mock('@/lib/orders/returns/cancel-request-reads', () => ({
  loadCancelRequestOrderContext: (...args: unknown[]) => mockLoadContext(...args),
}));

import { GET as getCancelRequests } from '@/app/api/admin/orders/[id]/cancel-requests/route';
import { POST as postClose } from '@/app/api/admin/cancel-requests/[cancelRequestId]/close/route';
import { POST as postDecline } from '@/app/api/admin/cancel-requests/[cancelRequestId]/decline/route';
import { POST as postResolve } from '@/app/api/admin/cancel-requests/[cancelRequestId]/resolve/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import type { AdminCancelRequest } from '@/lib/orders/returns/return-types';
import { C4_CASES, HEADERS, ITEM_ID, ORDER_ID, REFUND_ID } from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const CANCEL_REQUEST_ID = 'a4b2c3d4-1111-4222-8333-444455556666';
const CANCEL_CONTEXT = { params: Promise.resolve({ cancelRequestId: CANCEL_REQUEST_ID }) };
const BAD_CANCEL_CONTEXT = { params: Promise.resolve({ cancelRequestId: 'x' }) };

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

const CANCEL_REQUEST: AdminCancelRequest = {
  id: CANCEL_REQUEST_ID,
  status: 'requested',
  requestedAt: '2026-10-14T01:00:00.000Z',
  customerNote: 'サイズを間違えました',
  lines: [{ orderItemId: ITEM_ID, itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 1, unshipped: 1 }],
  declineReason: null,
  declineMessage: null,
  declinedAt: null,
  declinedByEmail: null,
  resolvedAt: null,
  resolvedByEmail: null,
  resolvedRefundId: null,
  resolvedByCancelAt: null,
  closedAt: null,
  closedByEmail: null,
};

const DECLINE_BODY = {
  declineReason: 'other',
  declineMessage: 'ご注文はすでに発送の準備に入っているため、キャンセルをお受けできませんでした。',
};
const DECLINE_INVALID: Array<[string, unknown]> = [
  ['本文が配列', []],
  ['理由が無い', { declineMessage: DECLINE_BODY.declineMessage }],
  ['理由が知らない値', { ...DECLINE_BODY, declineReason: 'unknown' }],
  ['理由が文字でない', { ...DECLINE_BODY, declineReason: 1 }],
  ['メッセージが無い', { declineReason: 'other' }],
  ['メッセージが空', { ...DECLINE_BODY, declineMessage: '' }],
  ['メッセージが空白と改行だけ', { ...DECLINE_BODY, declineMessage: '  \n ' }],
  ['メッセージが1001文字', { ...DECLINE_BODY, declineMessage: 'あ'.repeat(1001) }],
  ['メッセージが文字でない', { ...DECLINE_BODY, declineMessage: 5 }],
];

const RESOLVE_BODY = { refundId: REFUND_ID, orderCancelled: false };
const RESOLVE_INVALID: Array<[string, unknown]> = [
  ['本文が配列', []],
  ['返金の番号も取消の確かめも無い', { refundId: null, orderCancelled: false }],
  ['返金の番号があり、取消の確かめもある（どちらか1つだけ）', { refundId: REFUND_ID, orderCancelled: true }],
  ['取消の確かめが無い', { refundId: REFUND_ID }],
  ['取消の確かめが真偽でない', { refundId: null, orderCancelled: 'yes' }],
  ['返金の番号が UUID でない', { refundId: 'refund-1', orderCancelled: false }],
  ['返金の番号が文字でない', { refundId: 5, orderCancelled: false }],
];

type CancelRequestEndpoint = {
  name: string;
  path: string;
  post: (request: Request, context: { params: Promise<{ cancelRequestId: string }> }) => Promise<Response>;
  action: string;
  service: jest.Mock;
  /** 正しい本文。本文を読まない窓口（解決済みにする）は undefined で、本文を付けずに送る */
  validBody: unknown;
  invalidBodies: Array<[string, unknown]>;
  serviceInput: Record<string, unknown>;
  doneResult: Record<string, unknown>;
  data: Record<string, unknown>;
  successDetail: string;
  successMetadata: Record<string, unknown>;
  refusedDetail: string;
  failureDetail: string;
  /** お客様へのメールの予定を DB が書く窓口（お断りだけ）は、成功の後に送る処理を動かす */
  sendsEmail: boolean;
};

const ENDPOINTS: CancelRequestEndpoint[] = [
  {
    name: 'お断り',
    path: 'decline',
    post: postDecline,
    action: 'admin.orders.cancel_request.decline',
    service: mockDeclineCancelRequest,
    validBody: DECLINE_BODY,
    invalidBodies: DECLINE_INVALID,
    serviceInput: { cancelRequestId: CANCEL_REQUEST_ID, actorId: 'admin-1', ...DECLINE_BODY },
    doneResult: { cancelRequestId: CANCEL_REQUEST_ID, status: 'declined' },
    data: { status: 'declined' },
    successDetail: 'Cancel request declined',
    successMetadata: { status: 'declined', decline_reason: 'other' },
    refusedDetail: 'Cancel request decline refused',
    failureDetail: 'Failed to decline cancel request',
    sendsEmail: true,
  },
  {
    name: '解決済みにする',
    path: 'close',
    post: postClose,
    action: 'admin.orders.cancel_request.close',
    service: mockCloseCancelRequest,
    validBody: undefined,
    invalidBodies: [],
    serviceInput: { cancelRequestId: CANCEL_REQUEST_ID, actorId: 'admin-1' },
    doneResult: { cancelRequestId: CANCEL_REQUEST_ID, status: 'closed' },
    data: { status: 'closed' },
    successDetail: 'Cancel request closed',
    successMetadata: { status: 'closed' },
    refusedDetail: 'Cancel request close refused',
    failureDetail: 'Failed to close cancel request',
    sendsEmail: false,
  },
  {
    name: '解決',
    path: 'resolve',
    post: postResolve,
    action: 'admin.orders.cancel_request.resolve',
    service: mockResolveCancelRequest,
    validBody: RESOLVE_BODY,
    invalidBodies: RESOLVE_INVALID,
    serviceInput: { cancelRequestId: CANCEL_REQUEST_ID, actorId: 'admin-1', refundId: REFUND_ID, orderCancelled: false },
    doneResult: { cancelRequestId: CANCEL_REQUEST_ID, status: 'resolved' },
    data: { status: 'resolved' },
    successDetail: 'Cancel request resolved',
    successMetadata: { status: 'resolved', refund_id: REFUND_ID, order_cancelled: false },
    refusedDetail: 'Cancel request resolve refused',
    failureDetail: 'Failed to resolve cancel request',
    sendsEmail: false,
  },
];

function call(
  endpoint: CancelRequestEndpoint,
  options: { body?: unknown; rawBody?: string; context?: typeof CANCEL_CONTEXT } = {},
) {
  const body = 'body' in options ? options.body : endpoint.validBody;
  const init: RequestInit = { method: 'POST', headers: HEADERS };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const request = new Request(`http://localhost/api/admin/cancel-requests/${CANCEL_REQUEST_ID}/${endpoint.path}`, init);
  return endpoint.post(request, options.context ?? CANCEL_CONTEXT);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockCreateServiceRoleClient.mockReset();
  mockSchedule.mockReset();
  mockListCancelRequests.mockReset();
  mockLoadContext.mockReset();
  for (const endpoint of ENDPOINTS) {
    endpoint.service.mockReset();
    endpoint.service.mockResolvedValue(endpoint.doneResult);
  }
  grant('admin.orders.return');
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
});

// 書く窓口は、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる
describe.each(ENDPOINTS)('キャンセルの申し込みの$nameの窓口の守り', (endpoint) => {
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

  it('送信元ごと・管理者ごとの回数の制限を、キャンセルの申し込みの更新の名前と回数（10分に60回）で数える', async () => {
    expect((await call(endpoint)).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:cancel-requests:update', limit: 60, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:cancel-requests:update', limit: 60, windowSeconds: 600, subject: 'admin-1',
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

  it('サポート（返金の権限が無い人）も使える。返金の権限は確かめない', async () => {
    grant('admin.orders.return');

    expect((await call(endpoint)).status).toBe(200);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
  });
});

describe.each(ENDPOINTS)('キャンセルの申し込みの$nameの窓口の答え', (endpoint) => {
  it('実行した人と本文を store に渡し、答えを data で返す。監査に申し込みの番号・状態・記号だけを残し、鍵も伏せられない', async () => {
    const response = await call(endpoint);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: endpoint.data });
    expect(endpoint.service).toHaveBeenCalledTimes(1);
    expect(endpoint.service).toHaveBeenCalledWith(mockServiceClient, endpoint.serviceInput);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: endpoint.action,
      actor_id: 'admin-1',
      resource: 'order_cancel_requests',
      resource_id: CANCEL_REQUEST_ID,
      outcome: 'success',
      detail: endpoint.successDetail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: endpoint.successMetadata,
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('発送の準備');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  it('お客様へのメールの予定を DB が書く窓口（お断りだけ）は、成功の後にメールの送る処理を1回動かす', async () => {
    await call(endpoint);

    expect(mockSchedule).toHaveBeenCalledTimes(endpoint.sendsEmail ? 1 : 0);
  });

  it.each(C4_CASES)('store が %s で断ったら HTTP %i と C-4 の言葉。409 は衝突、ほかは失敗として監査に残し、メールの送る処理は動かさない', async (code, status, message) => {
    endpoint.service.mockRejectedValue(new ReturnStoreError(code));

    const response = await call(endpoint);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message, code });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: endpoint.action,
      actor_id: 'admin-1',
      resource: 'order_cancel_requests',
      resource_id: CANCEL_REQUEST_ID,
      outcome: status === 409 ? 'conflict' : 'failure',
      detail: endpoint.refusedDetail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { code },
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('2回目（DB が CANCEL_REQUEST_STATE_CONFLICT で断る）は 409 と「キャンセルの申し込みの状態が変わりました。画面を開き直してください。」', async () => {
    endpoint.service.mockRejectedValue(new ReturnStoreError('CANCEL_REQUEST_STATE_CONFLICT'));

    const response = await call(endpoint);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'キャンセルの申し込みの状態が変わりました。画面を開き直してください。',
      code: 'CANCEL_REQUEST_STATE_CONFLICT',
    });
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    endpoint.service.mockRejectedValue(new RefundStoreError('admin_update_cancel_request', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'キャンセルの申し込みの更新に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[`[${endpoint.action}] ${endpoint.failureDetail}`, 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: endpoint.action, outcome: 'error', detail: endpoint.failureDetail, metadata: null,
      }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB の道具を作れなかった（環境の値が無い）時も、決まった 500。ログは例外名だけ', async () => {
    mockCreateServiceRoleClient.mockRejectedValue(new TypeError('SUPABASE_SERVICE_ROLE_KEY is not set'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([[`[${endpoint.action}] ${endpoint.failureDetail}`, 'TypeError']]);
      expect(endpoint.service).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('申し込みの番号の形が違えば 400。store を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await call(endpoint, { context: BAD_CANCEL_CONTEXT });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: endpoint.action, actor_id: 'admin-1', resource: 'order_cancel_requests', resource_id: 'x',
      outcome: 'failure', detail: 'Invalid cancel request id', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });
});

// 本文を読む窓口（お断り・解決）は、形の誤りを 400 にする。store を呼ばず、固定の文だけを監査に残す
describe.each(ENDPOINTS.filter((endpoint) => endpoint.validBody !== undefined))('キャンセルの申し込みの$nameの窓口の本文', (endpoint) => {
  it.each(endpoint.invalidBodies)('中身の誤り（%s）は 400。store を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await call(endpoint, { body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: endpoint.action, actor_id: 'admin-1', resource: 'order_cancel_requests', resource_id: CANCEL_REQUEST_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await call(endpoint, { body: null, rawBody });

    expect(response.status).toBe(400);
    expect(endpoint.service).not.toHaveBeenCalled();
  });
});

// 解決済みにするは、本文を読まない（番号も中身も無い）。本文が無くても、壊れていても通る
describe.each(ENDPOINTS.filter((endpoint) => endpoint.validBody === undefined))('キャンセルの申し込みの$nameの窓口は本文を読まない', (endpoint) => {
  it.each<[string, string | undefined]>([
    ['本文なし', undefined],
    ['壊れた JSON', '{'],
    ['null', 'null'],
  ])('%s でも通る', async (_name, rawBody) => {
    const response = await call(endpoint, rawBody === undefined ? {} : { rawBody });

    expect(response.status).toBe(200);
    expect(endpoint.service).toHaveBeenCalledWith(mockServiceClient, endpoint.serviceInput);
  });
});

describe('キャンセルの申し込みのお断り（POST /api/admin/cancel-requests/[cancelRequestId]/decline）の個別', () => {
  const decline = ENDPOINTS[0];

  it.each(['window_passed', 'final_sale', 'other'])('理由 %s を受けて、そのまま渡す。監査には理由の記号だけを残す', async (declineReason) => {
    const response = await call(decline, { body: { ...DECLINE_BODY, declineReason } });

    expect(response.status).toBe(200);
    expect(mockDeclineCancelRequest).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({ declineReason }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { status: 'declined', decline_reason: declineReason },
    }));
  });

  it('メッセージは前後の空白だけ除き、書かれたまま（改行・記号）を渡す。1000字ちょうどは通る', async () => {
    await call(decline, { body: { ...DECLINE_BODY, declineMessage: '  <b>発送済み</b>\nです。  ' } });
    expect(mockDeclineCancelRequest).toHaveBeenLastCalledWith(mockServiceClient, expect.objectContaining({
      declineMessage: '<b>発送済み</b>\nです。',
    }));

    const response = await call(decline, { body: { ...DECLINE_BODY, declineMessage: 'あ'.repeat(1000) } });
    expect(response.status).toBe(200);
  });
});

describe('キャンセルの申し込みの解決（POST /api/admin/cancel-requests/[cancelRequestId]/resolve）の個別', () => {
  const resolve = ENDPOINTS[2];

  it('取消の確かめだけ（refundId が null）も受け、返金の番号なしで store に渡す。監査には返金の番号（null）と取消の真偽だけ', async () => {
    const response = await call(resolve, { body: { refundId: null, orderCancelled: true } });

    expect(response.status).toBe(200);
    expect(mockResolveCancelRequest).toHaveBeenCalledWith(mockServiceClient, {
      cancelRequestId: CANCEL_REQUEST_ID, actorId: 'admin-1', refundId: null, orderCancelled: true,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { status: 'resolved', refund_id: null, order_cancelled: true },
    }));
  });

  it('refundId を省いても、取消の確かめがあれば通る（null と同じ）', async () => {
    const response = await call(resolve, { body: { orderCancelled: true } });

    expect(response.status).toBe(200);
    expect(mockResolveCancelRequest).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({ refundId: null, orderCancelled: true }));
  });

  it('返金の番号があり、取消の確かめが偽なら、返金の番号を渡す（返金が同じ注文で申し込みの後かは DB が確かめる）', async () => {
    await call(resolve);

    expect(mockResolveCancelRequest).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({ refundId: REFUND_ID, orderCancelled: false }));
  });

  it('DB が返金・取消の確かめを断ったら（CANCEL_REQUEST_RESOLUTION_INVALID）、409 と C-4 の言葉', async () => {
    mockResolveCancelRequest.mockRejectedValue(new ReturnStoreError('CANCEL_REQUEST_RESOLUTION_INVALID'));

    const response = await call(resolve);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '返金・キャンセルの記録を確かめられませんでした。画面を開き直してください。',
      code: 'CANCEL_REQUEST_RESOLUTION_INVALID',
    });
  });
});

describe('GET /api/admin/orders/[id]/cancel-requests（キャンセルの申し込みの一覧）', () => {
  const context = { params: Promise.resolve({ id: ORDER_ID }) };
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/cancel-requests`);

  beforeEach(() => {
    mockListCancelRequests.mockResolvedValue([CANCEL_REQUEST]);
    mockLoadContext.mockResolvedValue({ orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 3 });
  });

  it('権限 admin.orders.return で読める。サポートも読める。CSRF・回数の制限・監査は通さない', async () => {
    const response = await getCancelRequests(request(), context);

    expect(response.status).toBe(200);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、何も読まない', async () => {
    grant();

    expect((await getCancelRequests(request(), context)).status).toBe(403);
    expect(mockListCancelRequests).not.toHaveBeenCalled();
    expect(mockLoadContext).not.toHaveBeenCalled();
  });

  it('注文の番号の形が違えば 400。何も読まない', async () => {
    const response = await getCancelRequests(request(), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockListCancelRequests).not.toHaveBeenCalled();
  });

  it('申し込みの一覧と、注文の状態・発送した数・未発送の数の合計を返す。答えは no-store', async () => {
    mockLoadContext.mockResolvedValue({ orderStatus: 'shipped', shippedUnits: 2, unshippedUnits: 1 });

    const response = await getCancelRequests(request(), context);

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      data: { cancelRequests: [CANCEL_REQUEST], orderStatus: 'shipped', shippedUnits: 2, unshippedUnits: 1 },
    });
    expect(mockListCancelRequests).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
    expect(mockLoadContext).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
  });

  it('申し込みが無い注文も 200 と空の一覧', async () => {
    mockListCancelRequests.mockResolvedValue([]);

    const response = await getCancelRequests(request(), context);

    await expect(response.json()).resolves.toEqual({ data: { cancelRequests: [], orderStatus: 'paid', shippedUnits: 0, unshippedUnits: 3 } });
  });

  it('注文が無ければ 404 と E-2 の言葉（order_not_found）', async () => {
    mockLoadContext.mockResolvedValue(null);

    const response = await getCancelRequests(request(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('store が決まった言葉で断ったら、その HTTP と言葉。監査は書かない', async () => {
    mockListCancelRequests.mockRejectedValue(new ReturnStoreError('RETURN_ARGUMENT_INVALID'));

    const response = await getCancelRequests(request(), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけで、DB の文は出さない', async () => {
    mockLoadContext.mockRejectedValue(new RefundStoreError('load_order', { message: '宛先を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getCancelRequests(request(), context);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'キャンセルの申し込みを読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([
        ['[admin.orders.cancel-request.list] Failed to load cancel requests', 'RefundStoreError', '08006'],
      ]);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('宛先');
    } finally {
      consoleError.mockRestore();
    }
  });
});
