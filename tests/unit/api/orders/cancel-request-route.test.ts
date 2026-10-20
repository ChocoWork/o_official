/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  // 本物と同じく headers を通す（落とすと no-store の確かめがすり抜ける）
  authFailureResponse: (reason: string, headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({ error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' }),
      { status: reason === 'unavailable' ? 503 : 401, headers: { 'content-type': 'application/json', ...headers } },
    ),
}));
const mockDenyIfCsrfInvalid = jest.fn();
jest.mock('@/features/cart/services/shopping-context', () => ({
  denyIfCsrfInvalid: (...args: unknown[]) => mockDenyIfCsrfInvalid(...args),
}));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockServiceClient = { name: 'service-client' };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));
const mockScheduleDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockScheduleDelivery(...args),
}));
// 誤りの型（CustomerOrderNotFoundError）は本物を残し、DB を呼ぶ関数だけを差し替える
const mockRequestCancel = jest.fn();
jest.mock('@/lib/orders/returns/customer-return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/customer-return-store'),
  requestCustomerCancel: (...args: unknown[]) => mockRequestCancel(...args),
}));

import { POST } from '@/app/api/orders/[id]/cancel-request/route';
import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import {
  CANCEL_REQUEST_ID,
  CUSTOMER_C4_CASES,
  CUSTOMER_ID,
  FAILURE_MESSAGE,
  HEADERS,
  ORDER_ID,
  ORDER_ITEM_ID,
  ORDER_ITEM_ID_2,
  REQUEST_KEY,
  expectNoKeyIsRedacted,
} from '../../lib/orders/returns/customer-return-route-fixtures';

const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const BAD_ORDER_CONTEXT = { params: Promise.resolve({ id: 'order-1' }) };
const AUTH_OK = { ok: true, claims: { sub: CUSTOMER_ID, session_id: 'session-1', email: 'customer@example.com' } };

function postRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/cancel-request`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

const LINES = [
  { orderItemId: ORDER_ITEM_ID, quantity: 1 },
  { orderItemId: ORDER_ITEM_ID_2, quantity: 2 },
];
const BODY = { requestKey: REQUEST_KEY, lines: LINES, customerNote: 'サイズを間違えて注文しました' };
const CREATED = { cancelRequestId: CANCEL_REQUEST_ID, status: 'requested', replayed: false };

beforeEach(() => {
  jest.resetAllMocks();
  mockAuthenticate.mockResolvedValue(AUTH_OK);
  mockDenyIfCsrfInvalid.mockResolvedValue(null);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockLogAudit.mockResolvedValue(undefined);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockRequestCancel.mockResolvedValue(CREATED);
});

describe('POST /api/orders/[id]/cancel-request（キャンセルを申し込む）の守り', () => {
  it('ログインしていなければ 401 で、後の確かめも DB も監査も通さない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(401);
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF が断られたら 403 で、回数の制限も DB も通さない', async () => {
    mockDenyIfCsrfInvalid.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden', reason: 'CSRF validation failed' }), { status: 403 }),
    );

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });

  it('回数の制限は、窓口名 account:cancel-requests:create・1時間に10回を、送信元ごとと、お客様ごとの2つで数える', async () => {
    const request = postRequest(BODY);

    await POST(request, ORDER_CONTEXT);

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [{ request, endpoint: 'account:cancel-requests:create', limit: 10, windowSeconds: 3600 }],
      [{ request, endpoint: 'account:cancel-requests:create', limit: 10, windowSeconds: 3600, subject: CUSTOMER_ID }],
    ]);
  });

  it.each<[string, number]>([
    ['送信元ごと', 0],
    ['お客様ごと', 1],
  ])('%sの制限が 429 なら、その応答を返し、DB を通さない', async (_name, index) => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '3600' } });
    for (let call = 0; call < index; call += 1) {
      mockEnforceRateLimit.mockResolvedValueOnce(undefined);
    }
    mockEnforceRateLimit.mockResolvedValueOnce(limited);

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response).toBe(limited);
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('注文の番号が uuid でなければ 404 Order not found で、DB を通さない', async () => {
    const response = await POST(postRequest(BODY), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/[id]/cancel-request の本文の形', () => {
  const BAD_BODIES: Array<[string, unknown]> = [
    ['本文が配列', []],
    ['本文が null', null],
    ['requestKey が無い', { lines: LINES }],
    ['requestKey が uuid でない', { ...BODY, requestKey: 'not-a-uuid' }],
    ['lines が無い', { requestKey: REQUEST_KEY }],
    ['lines が空', { ...BODY, lines: [] }],
    ['lines が101行', { ...BODY, lines: Array.from({ length: 101 }, () => LINES[0]) }],
    ['orderItemId が uuid でない', { ...BODY, lines: [{ orderItemId: 'x', quantity: 1 }] }],
    ['quantity が 0', { ...BODY, lines: [{ orderItemId: ORDER_ITEM_ID, quantity: 0 }] }],
    ['quantity が 1000', { ...BODY, lines: [{ orderItemId: ORDER_ITEM_ID, quantity: 1000 }] }],
    ['quantity が小数', { ...BODY, lines: [{ orderItemId: ORDER_ITEM_ID, quantity: 1.5 }] }],
    ['customerNote が301字', { ...BODY, customerNote: 'あ'.repeat(301) }],
    ['customerNote が文字でない', { ...BODY, customerNote: 12 }],
  ];

  it.each(BAD_BODIES)('%s なら 400 RETURN_ARGUMENT_INVALID。DB を通さず、監査は固定の文だけ', async (_name, body) => {
    const response = await POST(postRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.orders.cancel_request.create',
        outcome: 'failure',
        detail: 'Invalid request body',
        metadata: null,
      }),
    );
  });

  it('壊れた JSON は 400 RETURN_ARGUMENT_INVALID', async () => {
    const response = await POST(postRequest(null, '{ not json'), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/[id]/cancel-request の成功と送り直し', () => {
  it('新しく申し込めた時は、cancelRequestId と replayed:false だけを返し、メールの送る処理を1回動かす', async () => {
    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: { cancelRequestId: CANCEL_REQUEST_ID, replayed: false } });
    expect(mockScheduleDelivery).toHaveBeenCalledTimes(1);
  });

  it('DB には、service_role の client・トークンの claims.sub・本文の番号と品を渡す。ご連絡事項は前後の空白を外す', async () => {
    await POST(postRequest({ ...BODY, customerNote: '  サイズを間違えて注文しました  ', customerId: 'someone-else' }), ORDER_CONTEXT);

    expect(mockRequestCancel).toHaveBeenCalledTimes(1);
    expect(mockRequestCancel).toHaveBeenCalledWith(mockServiceClient, {
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      requestKey: REQUEST_KEY,
      lines: LINES,
      customerNote: 'サイズを間違えて注文しました',
    });
  });

  it('ご連絡事項が空・空白だけ・省略・null なら null にして渡す', async () => {
    for (const customerNote of ['', '   ', undefined, null]) {
      mockRequestCancel.mockClear();

      const response = await POST(postRequest({ requestKey: REQUEST_KEY, lines: LINES, customerNote }), ORDER_CONTEXT);

      expect(response.status).toBe(200);
      expect(mockRequestCancel.mock.calls[0][1].customerNote).toBeNull();
    }
  });

  it('監査は番号と数だけ（申し込みの番号・行の数・送り直しか）。ご連絡事項・お客様のメールを入れない', async () => {
    await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const event = mockLogAudit.mock.calls[0][0];
    expect(event).toEqual({
      action: 'account.orders.cancel_request.create',
      actor_id: CUSTOMER_ID,
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Cancel request created',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { cancel_request_id: CANCEL_REQUEST_ID, line_count: 2, replayed: false },
    });
    expectNoKeyIsRedacted(event.metadata);
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    expect(logged).not.toContain('サイズを間違えて');
    expect(logged).not.toContain('customer@example.com');
  });

  it('通信が切れた後の送り直し（同じ番号・同じ中身）は、前の申し込みを返し（replayed）、メールの送る処理は動かさない（Review Focus 1）', async () => {
    mockRequestCancel
      .mockResolvedValueOnce({ cancelRequestId: CANCEL_REQUEST_ID, status: 'requested', replayed: false })
      .mockResolvedValueOnce({ cancelRequestId: CANCEL_REQUEST_ID, status: 'requested', replayed: true });

    const first = await POST(postRequest(BODY), ORDER_CONTEXT);
    const second = await POST(postRequest(BODY), ORDER_CONTEXT);

    await expect(first.json()).resolves.toEqual({ data: { cancelRequestId: CANCEL_REQUEST_ID, replayed: false } });
    await expect(second.json()).resolves.toEqual({ data: { cancelRequestId: CANCEL_REQUEST_ID, replayed: true } });
    expect(mockRequestCancel.mock.calls[1][1]).toEqual(mockRequestCancel.mock.calls[0][1]);
    expect(mockScheduleDelivery).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[1][0].metadata).toMatchObject({ replayed: true });
  });
});

describe('POST /api/orders/[id]/cancel-request の DB の断りと失敗', () => {
  it.each(CUSTOMER_C4_CASES)('DB が %s で断ったら、HTTP %i とお客様の言葉（C-4）で返す。メールは送らない', async (code, status, message) => {
    mockRequestCancel.mockRejectedValue(new ReturnStoreError(code));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(
      code === 'RETURN_PHOTO_INVALID' ? { error: message, code, invalidPhotoUploadIds: [] } : { error: message, code },
    );
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.orders.cancel_request.create',
        outcome: status === 409 ? 'conflict' : 'failure',
        detail: 'Cancel request refused',
        metadata: { code },
      }),
    );
  });

  it('持ち主でない・無い・隠す状態の注文は、DB が CustomerOrderNotFoundError で断り、404 Order not found', async () => {
    mockRequestCancel.mockRejectedValue(new CustomerOrderNotFoundError());

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
  });

  it('管理画面だけの記号（キャンセルの申し込みの状態の食い違いなど）は出さず、500 の言葉にする', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequestCancel.mockRejectedValue(new ReturnStoreError('CANCEL_REQUEST_STATE_CONFLICT'));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    consoleError.mockRestore();
  });

  it('想定外の失敗は 500 の言葉。ログは窓口名と誤りの名前だけで、DB の文やご連絡事項を出さない。メールは送らない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequestCancel.mockRejectedValue(new Error('DB-MESSAGE 〒1500001 神宮前1-2-3 サイズを間違えて注文しました'));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.cancel_request.create] Failed to create cancel request', 'Error');
    const logged = consoleError.mock.calls.flat().map(String).join(' ') + JSON.stringify(mockLogAudit.mock.calls);
    expect(logged).not.toContain('DB-MESSAGE');
    expect(logged).not.toContain('神宮前');
    expect(logged).not.toContain('サイズを間違えて');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to create cancel request' }));
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
