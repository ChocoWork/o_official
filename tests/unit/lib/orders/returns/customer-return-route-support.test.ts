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
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import {
  CUSTOMER_RETURN_RATE_LIMITS,
  createCustomerAudit,
  customerNoteSchema,
  customerRefusalCodeOf,
  guardCustomerRead,
  guardCustomerWrite,
  parseOrderId,
  respondToCustomerReturnError,
  type CustomerGuard,
} from '@/lib/orders/returns/customer-return-route-support';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import {
  CUSTOMER_C4_CASES,
  CUSTOMER_ID,
  FAILURE_MESSAGE,
  HEADERS,
  ORDER_ID,
  RETURN_ID,
} from './customer-return-route-fixtures';

const AUTH_OK = { ok: true, claims: { sub: CUSTOMER_ID, session_id: 'session-1', email: 'customer@example.com' } };
const RULE = CUSTOMER_RETURN_RATE_LIMITS.request;
const mockAudit = jest.fn();

function postRequest(extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/return-request`, {
    method: 'POST',
    headers: { ...HEADERS, ...extraHeaders },
    body: '{}',
  });
}

/** 断られた守りの応答を取り出す（通ってしまったら試験を落とす） */
async function deniedResponse(guard: Promise<CustomerGuard>): Promise<Response> {
  const result = await guard;
  if (result.ok) {
    throw new Error('守りが断るはずだったのに通った');
  }
  return result.response;
}

beforeEach(() => {
  jest.resetAllMocks();
  mockAuthenticate.mockResolvedValue(AUTH_OK);
  mockDenyIfCsrfInvalid.mockResolvedValue(null);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockLogAudit.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

describe('CUSTOMER_RETURN_RATE_LIMITS（Global Constraints の窓口名と回数）', () => {
  it('3つの窓口名・回数・窓の長さが決まった値。どれも1時間（3600秒）', () => {
    expect(CUSTOMER_RETURN_RATE_LIMITS).toEqual({
      request: { endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600 },
      photoUpload: { endpoint: 'account:returns:photo-upload', limit: 30, windowSeconds: 3600 },
      cancelRequest: { endpoint: 'account:cancel-requests:create', limit: 10, windowSeconds: 3600 },
    });
  });
});

describe('guardCustomerRead（読む窓口の守り）', () => {
  it('ログインできていれば、お客様の番号（トークンの claims.sub）を返す。CSRF も回数の制限も通さない', async () => {
    const request = postRequest();

    await expect(guardCustomerRead(request)).resolves.toEqual({ ok: true, customerId: CUSTOMER_ID });
    expect(mockAuthenticate).toHaveBeenCalledWith(request);
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'revoked'] as const)('ログインの確かめが %s なら 401（no-store）', async (reason) => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason });

    const response = await deniedResponse(guardCustomerRead(postRequest()));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('ログインの確かめが落ちた（unavailable）なら 503。401 にしない（画面が更新を撃たないため）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const response = await deniedResponse(guardCustomerRead(postRequest()));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('guardCustomerWrite（書く窓口の守り。決め事 T7-2）', () => {
  it('順番は ログイン → CSRF → 送信元ごと → お客様ごと。2つの制限は同じ窓口名・回数で、2つ目にだけお客様の番号を付ける', async () => {
    const order: string[] = [];
    mockAuthenticate.mockImplementation(async () => {
      order.push('auth');
      return AUTH_OK;
    });
    mockDenyIfCsrfInvalid.mockImplementation(async () => {
      order.push('csrf');
      return null;
    });
    mockEnforceRateLimit.mockImplementation(async (args: { subject?: string }) => {
      order.push(args.subject ? 'limit:customer' : 'limit:ip');
      return undefined;
    });
    const request = postRequest();

    await expect(guardCustomerWrite(request, RULE)).resolves.toEqual({ ok: true, customerId: CUSTOMER_ID });

    expect(order).toEqual(['auth', 'csrf', 'limit:ip', 'limit:customer']);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request, endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request, endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600, subject: CUSTOMER_ID,
    });
  });

  it('ログインできていなければ 401 を返し、CSRF も回数の制限も数えない（ログイン前の要求が送信元の枠を使い切れない）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });

    const response = await deniedResponse(guardCustomerWrite(postRequest(), RULE));

    expect(response.status).toBe(401);
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('CSRF が断られたら、その応答（403）を返し、回数の制限を数えない', async () => {
    const denied = new Response(JSON.stringify({ error: 'Forbidden', reason: 'CSRF validation failed' }), { status: 403 });
    mockDenyIfCsrfInvalid.mockResolvedValue(denied);

    const response = await deniedResponse(guardCustomerWrite(postRequest(), RULE));

    expect(response).toBe(denied);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('送信元ごとの制限が 429 なら、その応答を返し、お客様ごとの制限を数えない', async () => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    mockEnforceRateLimit.mockResolvedValueOnce(limited);

    const response = await deniedResponse(guardCustomerWrite(postRequest(), RULE));

    expect(response).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
  });

  it('お客様ごとの制限が 429 なら、その応答を返す', async () => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const response = await deniedResponse(guardCustomerWrite(postRequest(), RULE));

    expect(response).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
  });
});

describe('parseOrderId', () => {
  it('uuid はそのまま返し、uuid でない文字は null（どの注文にも当たらないので、注文が無いのと同じに扱う）', () => {
    expect(parseOrderId(ORDER_ID)).toBe(ORDER_ID);
    expect(parseOrderId('order-1')).toBeNull();
    expect(parseOrderId('')).toBeNull();
    expect(parseOrderId(`${ORDER_ID}x`)).toBeNull();
  });
});

describe('customerNoteSchema（詳しい内容・ご連絡事項。DB の parse と同じ決まり）', () => {
  it.each<[string, string | null | undefined, string | null]>([
    ['前後の空白を外す', '  袖に穴  ', '袖に穴'],
    ['空は null', '', null],
    ['空白と改行だけは null', ' \n ', null],
    ['null は null', null, null],
    ['省略は null', undefined, null],
    ['ちょうど300字は通す', 'あ'.repeat(300), 'あ'.repeat(300)],
  ])('%s', (_name, input, expected) => {
    expect(customerNoteSchema.parse(input)).toBe(expected);
  });

  it('301字は断る。長さは前後の空白を外してから数える', () => {
    expect(customerNoteSchema.safeParse('あ'.repeat(301)).success).toBe(false);
    expect(customerNoteSchema.safeParse(` ${'あ'.repeat(300)} `).success).toBe(true);
  });
});

describe('customerRefusalCodeOf（お客様の言葉がある断りだけを見分ける）', () => {
  it.each(CUSTOMER_C4_CASES)('お客様の欄がある記号 %s は、そのまま返す', (code) => {
    expect(customerRefusalCodeOf(new ReturnStoreError(code))).toBe(code);
  });

  it.each([
    'RETURN_DECLINE_MESSAGE_REQUIRED',
    'CANCEL_REQUEST_NOT_FOUND',
    'CANCEL_REQUEST_STATE_CONFLICT',
    'CANCEL_REQUEST_RESOLUTION_INVALID',
    'RETURN_STATE_CONFLICT',
    'RETURN_FORBIDDEN',
    'order_not_found',
    'invalid_argument',
  ] as const)('お客様の欄が「—」の記号・管理画面の記号・E-2 の記号 %s は、お客様の窓口の断りとして扱わない（null）', (code) => {
    expect(customerRefusalCodeOf(new ReturnStoreError(code))).toBeNull();
  });

  it('ReturnStoreError でない誤りは null', () => {
    expect(customerRefusalCodeOf(new Error('RETURN_NOT_ELIGIBLE'))).toBeNull();
    expect(customerRefusalCodeOf('RETURN_NOT_ELIGIBLE')).toBeNull();
    expect(customerRefusalCodeOf(null)).toBeNull();
  });
});

describe('createCustomerAudit', () => {
  it('実行したお客様・注文・送信元を付ける。メールアドレスは付けない', async () => {
    const request = postRequest({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' });
    const audit = createCustomerAudit(request, CUSTOMER_ID, { action: 'account.orders.return.request', orderId: ORDER_ID });

    await audit('success', 'Return requested', { return_id: RETURN_ID, sequence: 2 });

    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'account.orders.return.request',
      actor_id: CUSTOMER_ID,
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Return requested',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { return_id: RETURN_ID, sequence: 2 },
    });
    expect(mockLogAudit.mock.calls[0][0]).not.toHaveProperty('actor_email');
  });

  it('metadata を省くと null', async () => {
    const audit = createCustomerAudit(postRequest(), CUSTOMER_ID, { action: 'account.orders.cancel_request.create', orderId: ORDER_ID });

    await audit('failure', 'Invalid request body');

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body', metadata: null }));
  });
});

describe('respondToCustomerReturnError（窓口の catch の中身）', () => {
  const OPTIONS = {
    audit: mockAudit,
    tag: 'account.orders.return.request',
    refusedDetail: 'Return request refused',
    failureDetail: 'Failed to request return',
  };

  it('CustomerOrderNotFoundError は 404 Order not found（持ち主でない注文の有無を漏らさない）。監査は failure', async () => {
    const response = await respondToCustomerReturnError(new CustomerOrderNotFoundError(), OPTIONS);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockAudit).toHaveBeenCalledWith('failure', 'Order not found');
  });

  it('E-2 の記号 order_not_found で届いた断りも、同じ 404', async () => {
    const response = await respondToCustomerReturnError(new ReturnStoreError('order_not_found'), OPTIONS);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
  });

  it.each(CUSTOMER_C4_CASES)('%s は、HTTP %i とお客様の言葉で返す。409 は監査 conflict、ほかは failure（記号だけ残す）', async (code, status, message) => {
    const response = await respondToCustomerReturnError(new ReturnStoreError(code), OPTIONS);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(
      // 写真の断りは、窓口が DB の前に断る時と同じ形（合わない送り先の番号つき）。DB が断った時はどの写真か分からないので空
      code === 'RETURN_PHOTO_INVALID' ? { error: message, code, invalidPhotoUploadIds: [] } : { error: message, code },
    );
    expect(mockAudit).toHaveBeenCalledWith(status === 409 ? 'conflict' : 'failure', 'Return request refused', { code });
  });

  it('お客様の欄が無い記号（管理画面の言葉）は、お客様に出さず、500 の言葉にする', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await respondToCustomerReturnError(new ReturnStoreError('RETURN_STATE_CONFLICT'), OPTIONS);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.request] Failed to request return', 'ReturnStoreError', 'RETURN_STATE_CONFLICT');
    expect(mockAudit).toHaveBeenCalledWith('error', 'Failed to request return');
    consoleError.mockRestore();
  });

  it('想定外の誤りは 500 の言葉。ログは窓口名と誤りの名前・記号だけで、DB の文（住所・メール）を出さない。監査は error', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('DB-MESSAGE 〒1500001 神宮前1-2-3 customer@example.com'), {
      name: 'RefundStoreError',
      code: '57014',
    });

    const response = await respondToCustomerReturnError(failure, OPTIONS);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.request] Failed to request return', 'RefundStoreError', '57014');
    const logged = consoleError.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('DB-MESSAGE');
    expect(logged).not.toContain('神宮前');
    expect(logged).not.toContain('customer@example.com');
    expect(mockAudit).toHaveBeenCalledWith('error', 'Failed to request return');
    consoleError.mockRestore();
  });

  it('audit が null（読む窓口・写真の送り先の窓口）でも、同じ答えを返す', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const refused = await respondToCustomerReturnError(new ReturnStoreError('RETURN_REQUESTS_CLOSED'), { ...OPTIONS, audit: null });
    const failed = await respondToCustomerReturnError(new Error('boom'), { ...OPTIONS, audit: null });
    const missing = await respondToCustomerReturnError(new CustomerOrderNotFoundError(), { ...OPTIONS, audit: null });

    expect([refused.status, failed.status, missing.status]).toEqual([409, 500, 404]);
    expect(mockAudit).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
