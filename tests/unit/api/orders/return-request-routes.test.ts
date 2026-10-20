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
// 写真の確かめ（Task 5）は差し替える。置き場を読み書きするので、この試験では使わない
const mockVerifyPhotos = jest.fn();
jest.mock('@/lib/orders/returns/return-photo-storage', () => ({
  // 誤りの型は本物を残し、窓口が実物の ReturnPhotoStorageError を 500 にすることを確かめる
  ...jest.requireActual('@/lib/orders/returns/return-photo-storage'),
  verifyReturnPhotoUploads: (...args: unknown[]) => mockVerifyPhotos(...args),
}));
// 誤りの型（CustomerOrderNotFoundError）は本物を残し、DB を呼ぶ2つの関数だけを差し替える
const mockLoadMaterials = jest.fn();
const mockRequestReturn = jest.fn();
jest.mock('@/lib/orders/returns/customer-return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/customer-return-store'),
  loadCustomerReturnRequestMaterials: (...args: unknown[]) => mockLoadMaterials(...args),
  requestCustomerReturn: (...args: unknown[]) => mockRequestReturn(...args),
}));

import { GET, POST } from '@/app/api/orders/[id]/return-request/route';
import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';
import { ReturnPhotoStorageError } from '@/lib/orders/returns/return-photo-storage';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import {
  CUSTOMER_C4_CASES,
  CUSTOMER_ID,
  FAILURE_MESSAGE,
  FULFILLMENT_ID,
  HEADERS,
  ORDER_ID,
  ORDER_ITEM_ID,
  ORDER_ITEM_ID_2,
  REQUEST_KEY,
  RETURN_ID,
  UPLOAD_ID,
  UPLOAD_ID_2,
  expectNoKeyIsRedacted,
} from '../../lib/orders/returns/customer-return-route-fixtures';

const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const BAD_ORDER_CONTEXT = { params: Promise.resolve({ id: 'order-1' }) };
const AUTH_OK = { ok: true, claims: { sub: CUSTOMER_ID, session_id: 'session-1', email: 'customer@example.com' } };
const PHOTO_INVALID_MESSAGE = '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。';

function getRequest(query = '') {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/return-request${query}`);
}

function postRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/return-request`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

const MATERIALS: CustomerReturnRequestMaterials = {
  order: { id: ORDER_ID, status: 'shipped' },
  availability: { returns: 'available', endedOn: null },
  noticeText: '',
  shipments: [
    {
      fulfillmentId: FULFILLMENT_ID, number: 1, shippedAt: '2026-10-05T03:00:00.000Z', deadlineDate: '2026-10-19', pastDeadline: false,
      lines: [
        {
          orderItemId: ORDER_ITEM_ID, itemId: 10, itemName: 'シルクブラウス', color: '白', size: 'M',
          lineKind: 'order', quantity: 2, selectable: 2, state: 'selectable', returnIneligible: false,
        },
      ],
    },
  ],
  reasons: [
    {
      reason: 'defective', resolutions: 'refund_and_exchange', outOfStockExchange: 'decline',
      photo: 'optional', photoInstructions: '', shippingPayer: 'shop',
    },
  ],
  exchangeOptions: [
    { itemId: 10, variants: [{ variantId: 101, color: '白', size: 'L', stockQuantity: 3, madeToOrderLeadDays: null }] },
  ],
  fees: { customerPaidMethod: 'customer_ships', shopLabelFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0 },
};

const REFUND_LINE = {
  fulfillmentId: FULFILLMENT_ID,
  orderItemId: ORDER_ITEM_ID,
  quantity: 1,
  reason: 'defective',
  customerNote: '袖に穴があります',
  requestedResolution: 'refund',
  requestedExchangeVariantId: null,
  photoUploadIds: [UPLOAD_ID, UPLOAD_ID_2],
};
const EXCHANGE_LINE = {
  fulfillmentId: FULFILLMENT_ID,
  orderItemId: ORDER_ITEM_ID_2,
  quantity: 2,
  reason: 'size_too_small',
  customerNote: null,
  requestedResolution: 'exchange',
  requestedExchangeVariantId: 101,
  photoUploadIds: [] as string[],
};
const BODY = { requestKey: REQUEST_KEY, lines: [REFUND_LINE, EXCHANGE_LINE] };

/** 窓口が DB に渡す物。写真の種類と大きさは、本文ではなく、窓口が置き場を読んで決めた値 */
const EXPECTED_DB_INPUT = {
  orderId: ORDER_ID,
  customerId: CUSTOMER_ID,
  requestKey: REQUEST_KEY,
  lines: [
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ORDER_ITEM_ID, quantity: 1, reason: 'defective',
      customerNote: '袖に穴があります', requestedResolution: 'refund', requestedExchangeVariantId: null,
      photos: [
        { uploadId: UPLOAD_ID, contentType: 'image/jpeg', sizeBytes: 123456 },
        { uploadId: UPLOAD_ID_2, contentType: 'image/png', sizeBytes: 7890 },
      ],
    },
    {
      fulfillmentId: FULFILLMENT_ID, orderItemId: ORDER_ITEM_ID_2, quantity: 2, reason: 'size_too_small',
      customerNote: null, requestedResolution: 'exchange', requestedExchangeVariantId: 101,
      photos: [],
    },
  ],
};

const VERIFIED_OK = {
  ok: true,
  photos: {
    [UPLOAD_ID]: { contentType: 'image/jpeg', sizeBytes: 123456 },
    [UPLOAD_ID_2]: { contentType: 'image/png', sizeBytes: 7890 },
  },
};
const CREATED = { returnId: RETURN_ID, number: 3, status: 'requested', replayed: false };

beforeEach(() => {
  jest.resetAllMocks();
  mockAuthenticate.mockResolvedValue(AUTH_OK);
  mockDenyIfCsrfInvalid.mockResolvedValue(null);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockLogAudit.mockResolvedValue(undefined);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockLoadMaterials.mockResolvedValue(MATERIALS);
  mockVerifyPhotos.mockResolvedValue(VERIFIED_OK);
  mockRequestReturn.mockResolvedValue(CREATED);
});

describe('GET /api/orders/[id]/return-request（申し込みの材料）', () => {
  it('持ち主の確かめを通れば、材料を {data} で no-store で返す。お客様の番号はトークンの claims.sub で、問い合わせの文字は使わない', async () => {
    const response = await GET(getRequest(`?customerId=someone-else`), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: MATERIALS });
    expect(mockLoadMaterials).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID });
    // 読むだけなので CSRF と回数の制限は通さず、監査も書かない
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('ログインしていなければ 401（no-store）で、DB を読まない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });

    const response = await GET(getRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockLoadMaterials).not.toHaveBeenCalled();
  });

  it('DB が注文なし（持ち主でない・お客様に隠す状態）と答えた時（null）は、404 Order not found', async () => {
    mockLoadMaterials.mockResolvedValue(null);

    const response = await GET(getRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
  });

  it('注文の番号が uuid でなければ 404 で、DB を読まない', async () => {
    const response = await GET(getRequest(), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('読み取りが落ちたら 500 の言葉。ログは窓口名と誤りの名前だけで、DB の文を出さない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadMaterials.mockRejectedValue(new Error('DB-MESSAGE 〒1500001 神宮前1-2-3'));

    const response = await GET(getRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.materials] Failed to load return materials', 'Error');
    expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain('DB-MESSAGE');
    consoleError.mockRestore();
  });
});

describe('POST /api/orders/[id]/return-request（返品・交換を申し込む）の守り', () => {
  it('ログインしていなければ 401 で、後の確かめも DB も監査も通さない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'invalid' });

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(401);
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('CSRF が断られたら、その 403 を返し、回数の制限・写真・DB を通さない', async () => {
    mockDenyIfCsrfInvalid.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden', reason: 'CSRF validation failed' }), { status: 403 }),
    );

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockRequestReturn).not.toHaveBeenCalled();
  });

  it('回数の制限は、窓口名 account:returns:request・1時間に10回を、送信元ごとと、お客様ごとの2つで数える', async () => {
    const request = postRequest(BODY);

    await POST(request, ORDER_CONTEXT);

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [{ request, endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600 }],
      [{ request, endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600, subject: CUSTOMER_ID }],
    ]);
  });

  it.each<[string, number]>([
    ['送信元ごと', 0],
    ['お客様ごと', 1],
  ])('%sの制限が 429 なら、その応答を返し、写真も DB も通さない', async (_name, index) => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '3600' } });
    for (let call = 0; call < index; call += 1) {
      mockEnforceRateLimit.mockResolvedValueOnce(undefined);
    }
    mockEnforceRateLimit.mockResolvedValueOnce(limited);

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response).toBe(limited);
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('注文の番号が uuid でなければ 404 Order not found で、写真も DB も通さない', async () => {
    const response = await POST(postRequest(BODY), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/[id]/return-request の本文の形', () => {
  const lineWith = (patch: Record<string, unknown>) => ({ requestKey: REQUEST_KEY, lines: [{ ...REFUND_LINE, ...patch }] });
  const uploadIdOf = (index: number) => `9a9a9a9a-1111-4222-8333-${String(index).padStart(12, '0')}`;
  const SIX_UPLOAD_IDS = Array.from({ length: 6 }, (_, index) => uploadIdOf(index + 1));
  // 13行 × 5枚 = 65個の送り先（重ならない）。1日に出せる数（60）を超える
  const SIXTY_FIVE_UPLOADS = Array.from({ length: 13 }, (_, lineIndex) => ({
    ...REFUND_LINE,
    photoUploadIds: Array.from({ length: 5 }, (_unused, photoIndex) => uploadIdOf(lineIndex * 5 + photoIndex + 1)),
  }));

  const BAD_BODIES: Array<[string, unknown]> = [
    ['本文が配列', []],
    ['本文が null', null],
    ['requestKey が無い', { lines: BODY.lines }],
    ['requestKey が uuid でない', { ...BODY, requestKey: 'not-a-uuid' }],
    ['lines が空', { requestKey: REQUEST_KEY, lines: [] }],
    ['lines が101行', { requestKey: REQUEST_KEY, lines: Array.from({ length: 101 }, () => REFUND_LINE) }],
    ['fulfillmentId が uuid でない', lineWith({ fulfillmentId: 'x' })],
    ['orderItemId が uuid でない', lineWith({ orderItemId: 'x' })],
    ['quantity が 0', lineWith({ quantity: 0 })],
    ['quantity が 1000', lineWith({ quantity: 1000 })],
    ['quantity が小数', lineWith({ quantity: 1.5 })],
    ['reason が unknown（お客様には出さない理由）', lineWith({ reason: 'unknown' })],
    ['reason が知らない記号', lineWith({ reason: 'bogus' })],
    ['customerNote が301字', lineWith({ customerNote: 'あ'.repeat(301) })],
    ['customerNote が文字でない', lineWith({ customerNote: 12 })],
    ['requestedResolution が知らない値', lineWith({ requestedResolution: 'credit' })],
    ['requestedExchangeVariantId が文字', lineWith({ requestedExchangeVariantId: '101' })],
    ['photoUploadIds が6枚', lineWith({ photoUploadIds: SIX_UPLOAD_IDS })],
    ['photoUploadIds に uuid でない物', lineWith({ photoUploadIds: ['x'] })],
    ['photoUploadIds が無い', lineWith({ photoUploadIds: undefined })],
    ['送り先が全部で65個（1日に出せる数 60 を超える）', { requestKey: REQUEST_KEY, lines: SIXTY_FIVE_UPLOADS }],
  ];

  it.each(BAD_BODIES)('%s なら 400 RETURN_ARGUMENT_INVALID。写真も DB も通さず、監査は固定の文だけ', async (_name, body) => {
    const response = await POST(postRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.orders.return.request', outcome: 'failure', detail: 'Invalid request body', metadata: null }),
    );
  });

  it('壊れた JSON は 400 RETURN_ARGUMENT_INVALID', async () => {
    const response = await POST(postRequest(null, '{ not json'), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' });
    expect(mockRequestReturn).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/[id]/return-request の写真の確かめ（DB の前）', () => {
  it('写真が無ければ確かめを呼ばず、photos を空にして DB に渡す', async () => {
    const body = { requestKey: REQUEST_KEY, lines: [{ ...EXCHANGE_LINE }] };

    const response = await POST(postRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockRequestReturn).toHaveBeenCalledWith(mockServiceClient, {
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      requestKey: REQUEST_KEY,
      lines: [EXPECTED_DB_INPUT.lines[1]],
    });
  });

  it('送り先の番号を重ならないように1回ずつ確かめ、種類と大きさは確かめた結果（撮影の情報を消した後の物）を DB に渡す', async () => {
    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockVerifyPhotos).toHaveBeenCalledTimes(1);
    expect(mockVerifyPhotos).toHaveBeenCalledWith(mockServiceClient, {
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      uploadIds: [UPLOAD_ID, UPLOAD_ID_2],
    });
    // 成功の道では持ち主の読み直しを増やさず、申し込みの DB の関数が持ち主を確かめる
    expect(mockLoadMaterials).not.toHaveBeenCalled();
    expect(mockRequestReturn).toHaveBeenCalledWith(mockServiceClient, EXPECTED_DB_INPUT);
  });

  it('本文に写真の種類・大きさ・お客様の番号を書いても使わない（確かめた結果とトークンの claims.sub だけを使う）', async () => {
    const forged = {
      ...BODY,
      customerId: 'someone-else',
      lines: [
        { ...REFUND_LINE, photos: [{ uploadId: UPLOAD_ID, contentType: 'image/gif', sizeBytes: 1 }], customerId: 'someone-else' },
        EXCHANGE_LINE,
      ],
    };

    const response = await POST(postRequest(forged), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockRequestReturn).toHaveBeenCalledWith(mockServiceClient, EXPECTED_DB_INPUT);
  });

  it('同じ送り先を2つの行に付けた本文でも、確かめは1回。2回使うことは DB が RETURN_PHOTO_INVALID で断り、答えは合わない送り先の番号が空の 400', async () => {
    const body = {
      requestKey: REQUEST_KEY,
      lines: [{ ...REFUND_LINE, photoUploadIds: [UPLOAD_ID] }, { ...REFUND_LINE, orderItemId: ORDER_ITEM_ID_2, photoUploadIds: [UPLOAD_ID] }],
    };
    mockRequestReturn.mockRejectedValue(new ReturnStoreError('RETURN_PHOTO_INVALID'));

    const response = await POST(postRequest(body), ORDER_CONTEXT);

    expect(mockVerifyPhotos).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID, uploadIds: [UPLOAD_ID] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: PHOTO_INVALID_MESSAGE, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: [] });
  });

  it('合わない写真（23時間の期限切れなど）があれば、持ち主を確かめて 400 RETURN_PHOTO_INVALID と合わない送り先の番号を返し、申し込みの DB の関数を呼ばない（Review Focus 2）', async () => {
    mockVerifyPhotos.mockResolvedValue({ ok: false, invalidUploadIds: [UPLOAD_ID_2] });

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: PHOTO_INVALID_MESSAGE,
      code: 'RETURN_PHOTO_INVALID',
      invalidPhotoUploadIds: [UPLOAD_ID_2],
    });
    expect(mockLoadMaterials).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID });
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    // 監査は記号と数だけ。送り先の番号・場所は入れない
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'account.orders.return.request',
        outcome: 'failure',
        detail: 'Return photos invalid',
        metadata: { code: 'RETURN_PHOTO_INVALID', invalid_photo_count: 1 },
      }),
    );
  });

  it('持ち主でない・無い・隠す状態の注文では、写真がどれも合わなくても写真の断りにせず、404 Order not found（有無を漏らさない）', async () => {
    mockVerifyPhotos.mockResolvedValue({ ok: false, invalidUploadIds: [UPLOAD_ID, UPLOAD_ID_2] });
    mockLoadMaterials.mockResolvedValue(null);

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockLoadMaterials).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID });
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'account.orders.return.request', outcome: 'failure', detail: 'Order not found', metadata: null }),
    );
  });

  it('確かめの結果に、渡した送り先が欠けていたら、その写真を合わない物として断る（DB に推測した種類・大きさを渡さない）', async () => {
    mockVerifyPhotos.mockResolvedValue({ ok: true, photos: { [UPLOAD_ID]: { contentType: 'image/jpeg', sizeBytes: 100 } } });

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: PHOTO_INVALID_MESSAGE,
      code: 'RETURN_PHOTO_INVALID',
      invalidPhotoUploadIds: [UPLOAD_ID_2],
    });
    expect(mockRequestReturn).not.toHaveBeenCalled();
  });

  it.each([
    ['storage_unavailable', 'download'],
    ['db_unavailable', 'read_uploads'],
  ] as const)('写真の確かめが ReturnPhotoStorageError（%s・%s）で落ちたら 500 の言葉。写真の断りにせず、申し込みの DB の関数を呼ばない', async (code, operation) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockVerifyPhotos.mockRejectedValue(new ReturnPhotoStorageError(code, operation));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(mockLoadMaterials).not.toHaveBeenCalled();
    expect(mockRequestReturn).not.toHaveBeenCalled();
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.request] Failed to request return', 'ReturnPhotoStorageError', code);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to request return' }));
    consoleError.mockRestore();
  });
});

describe('POST /api/orders/[id]/return-request の成功と送り直し', () => {
  it('新しく申し込めた時は、番号・返品番号・replayed:false を返し、メールの送る処理を1回動かす', async () => {
    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      data: { returnId: RETURN_ID, number: 3, label: 'ORD-A1B2C3D4-R3', replayed: false },
    });
    expect(mockScheduleDelivery).toHaveBeenCalledTimes(1);
  });

  it('監査は番号と数だけ（返品の番号・何件目・行の数・写真の数・送り直しか）。詳しい内容・お客様のメール・写真の場所を入れない', async () => {
    await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const event = mockLogAudit.mock.calls[0][0];
    expect(event).toEqual({
      action: 'account.orders.return.request',
      actor_id: CUSTOMER_ID,
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Return requested',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { return_id: RETURN_ID, sequence: 3, line_count: 2, photo_count: 2, replayed: false },
    });
    expectNoKeyIsRedacted(event.metadata);
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    expect(logged).not.toContain('袖に穴');
    expect(logged).not.toContain('customer@example.com');
    expect(logged).not.toContain(UPLOAD_ID);
  });

  it('詳しい内容は前後の空白を外し、空白だけなら null にして DB に渡す。交換の色・サイズの番号が無ければ null', async () => {
    const body = {
      requestKey: REQUEST_KEY,
      lines: [
        { ...REFUND_LINE, customerNote: '  袖に穴があります  ', requestedExchangeVariantId: undefined, photoUploadIds: [] },
        { ...EXCHANGE_LINE, customerNote: '   ' },
      ],
    };

    const response = await POST(postRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    const sent = mockRequestReturn.mock.calls[0][1];
    expect(sent.lines.map((line: { customerNote: string | null }) => line.customerNote)).toEqual(['袖に穴があります', null]);
    expect(sent.lines[0].requestedExchangeVariantId).toBeNull();
  });

  it('通信が切れた後の送り直し（同じ番号・同じ中身）は、写真を確かめ直した上で前の返品を返し、メールの送る処理は動かさない（Review Focus 1）', async () => {
    mockRequestReturn
      .mockResolvedValueOnce({ returnId: RETURN_ID, number: 1, status: 'requested', replayed: false })
      .mockResolvedValueOnce({ returnId: RETURN_ID, number: 1, status: 'requested', replayed: true });

    const first = await POST(postRequest(BODY), ORDER_CONTEXT);
    const second = await POST(postRequest(BODY), ORDER_CONTEXT);

    await expect(first.json()).resolves.toEqual({ data: { returnId: RETURN_ID, number: 1, label: 'ORD-A1B2C3D4-R1', replayed: false } });
    await expect(second.json()).resolves.toEqual({ data: { returnId: RETURN_ID, number: 1, label: 'ORD-A1B2C3D4-R1', replayed: true } });
    expect(mockVerifyPhotos).toHaveBeenCalledTimes(2);
    expect(mockRequestReturn.mock.calls[1][1]).toEqual(mockRequestReturn.mock.calls[0][1]);
    expect(mockScheduleDelivery).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[1][0].metadata).toMatchObject({ replayed: true });
  });
});

describe('POST /api/orders/[id]/return-request の DB の断りと失敗', () => {
  it.each(CUSTOMER_C4_CASES)('DB が %s で断ったら、HTTP %i とお客様の言葉（C-4）で返す。メールは送らない', async (code, status, message) => {
    mockRequestReturn.mockRejectedValue(new ReturnStoreError(code));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(
      code === 'RETURN_PHOTO_INVALID' ? { error: message, code, invalidPhotoUploadIds: [] } : { error: message, code },
    );
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: status === 409 ? 'conflict' : 'failure',
        detail: 'Return request refused',
        metadata: { code },
      }),
    );
  });

  it('写真なしの申し込みで、持ち主でない・無い・隠す状態の注文は、DB が CustomerOrderNotFoundError で断り、404 Order not found（有無を漏らさない）', async () => {
    mockRequestReturn.mockRejectedValue(new CustomerOrderNotFoundError());

    const response = await POST(postRequest({ requestKey: REQUEST_KEY, lines: [{ ...REFUND_LINE, photoUploadIds: [] }] }), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockVerifyPhotos).not.toHaveBeenCalled();
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
  });

  it('お客様の言葉が無い記号（管理画面の言葉）は出さず、500 の言葉にする', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequestReturn.mockRejectedValue(new ReturnStoreError('RETURN_STATE_CONFLICT'));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    consoleError.mockRestore();
  });

  it('想定外の失敗は 500 の言葉。ログは窓口名と誤りの名前だけで、DB の文（住所）や詳しい内容を出さない。メールは送らない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequestReturn.mockRejectedValue(new Error('DB-MESSAGE 〒1500001 神宮前1-2-3 袖に穴があります'));

    const response = await POST(postRequest(BODY), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.request] Failed to request return', 'Error');
    const logged = consoleError.mock.calls.flat().map(String).join(' ') + JSON.stringify(mockLogAudit.mock.calls);
    expect(logged).not.toContain('DB-MESSAGE');
    expect(logged).not.toContain('神宮前');
    expect(logged).not.toContain('袖に穴');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to request return' }));
    expect(mockScheduleDelivery).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
