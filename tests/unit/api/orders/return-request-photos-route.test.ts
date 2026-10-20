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
// 送り先を出す部品（Task 5）は差し替える。この試験は窓口の守りと答えだけを確かめる
const mockIssueUpload = jest.fn();
jest.mock('@/lib/orders/returns/return-photo-storage', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-photo-storage'),
  issueReturnPhotoUpload: (...args: unknown[]) => mockIssueUpload(...args),
}));

import { POST } from '@/app/api/orders/[id]/return-request/photos/route';
import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import { ReturnPhotoStorageError } from '@/lib/orders/returns/return-photo-storage';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import type { ReturnErrorCode } from '@/lib/orders/returns/return-types';
import { CUSTOMER_ID, FAILURE_MESSAGE, HEADERS, ORDER_ID, UPLOAD_ID } from '../../lib/orders/returns/customer-return-route-fixtures';

const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const BAD_ORDER_CONTEXT = { params: Promise.resolve({ id: 'order-1' }) };
const AUTH_OK = { ok: true, claims: { sub: CUSTOMER_ID, session_id: 'session-1', email: 'customer@example.com' } };
// 本物の署名つきの送り先は鍵を含む。ここでは、それらしい形の見本（鍵の部分に目印の文字を入れて、出力に混ざらないことを確かめる）
const SIGNED_URL = 'https://example.invalid/storage/v1/object/upload/sign/return-photos/requests/x/y?token=SIGNED-TOKEN-MARK';

function postRequest(rawBody?: string) {
  return new Request(`http://localhost/api/orders/${ORDER_ID}/return-request/photos`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockAuthenticate.mockResolvedValue(AUTH_OK);
  mockDenyIfCsrfInvalid.mockResolvedValue(null);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockLogAudit.mockResolvedValue(undefined);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockIssueUpload.mockResolvedValue({ uploadId: UPLOAD_ID, signedUrl: SIGNED_URL });
});

describe('POST /api/orders/[id]/return-request/photos（写真の送り先）', () => {
  it('送り先を出し、{data:{uploadId, signedUrl}} を no-store で返す。service_role の client とトークンの claims.sub で呼ぶ', async () => {
    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: { uploadId: UPLOAD_ID, signedUrl: SIGNED_URL } });
    expect(mockIssueUpload).toHaveBeenCalledTimes(1);
    expect(mockIssueUpload).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: CUSTOMER_ID });
  });

  it('中身なしの窓口。本文が壊れていても、空でも、読まずに送り先を出す', async () => {
    expect((await POST(postRequest('{ not json'), ORDER_CONTEXT)).status).toBe(200);
    expect((await POST(postRequest(''), ORDER_CONTEXT)).status).toBe(200);
    expect(mockIssueUpload).toHaveBeenCalledTimes(2);
  });

  it('回数の制限は、窓口名 account:returns:photo-upload・1時間に30回を、送信元ごとと、お客様ごとの2つで数える', async () => {
    const request = postRequest();

    await POST(request, ORDER_CONTEXT);

    expect(mockEnforceRateLimit.mock.calls).toEqual([
      [{ request, endpoint: 'account:returns:photo-upload', limit: 30, windowSeconds: 3600 }],
      [{ request, endpoint: 'account:returns:photo-upload', limit: 30, windowSeconds: 3600, subject: CUSTOMER_ID }],
    ]);
  });

  it('ログインしていなければ 401 で、後の確かめも送り先も出さない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'revoked' });

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(401);
    expect(mockDenyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockIssueUpload).not.toHaveBeenCalled();
  });

  it('CSRF が断られたら 403 で、回数の制限も送り先も通さない', async () => {
    mockDenyIfCsrfInvalid.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden', reason: 'CSRF validation failed' }), { status: 403 }),
    );

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockIssueUpload).not.toHaveBeenCalled();
  });

  it.each<[string, number]>([
    ['送信元ごと', 0],
    ['お客様ごと', 1],
  ])('%sの制限が 429 なら、その応答を返し、送り先を出さない', async (_name, index) => {
    const limited = new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Retry-After': '3600' } });
    for (let call = 0; call < index; call += 1) {
      mockEnforceRateLimit.mockResolvedValueOnce(undefined);
    }
    mockEnforceRateLimit.mockResolvedValueOnce(limited);

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response).toBe(limited);
    expect(mockIssueUpload).not.toHaveBeenCalled();
  });

  it('注文の番号が uuid でなければ 404 Order not found で、送り先を出さない', async () => {
    const response = await POST(postRequest(), BAD_ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
    expect(mockIssueUpload).not.toHaveBeenCalled();
  });

  it('持ち主でない・無い・隠す状態の注文は、DB が CustomerOrderNotFoundError で断り、404 Order not found', async () => {
    mockIssueUpload.mockRejectedValue(new CustomerOrderNotFoundError());

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Order not found' });
  });

  it.each<[ReturnErrorCode, number, string, Record<string, unknown>]>([
    ['RETURN_REQUESTS_CLOSED', 409, '現在、返品・交換のお申し込みを受け付けていません。', {}],
    ['RETURN_NOT_ELIGIBLE', 409, 'お申し込みいただけない商品が含まれています。画面を開き直してください。', {}],
    [
      'RETURN_PHOTO_INVALID',
      400,
      '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。',
      { invalidPhotoUploadIds: [] },
    ],
  ])('受付が閉じている・申し込めない注文・1日に出せる数（60）を超えた時の断り %s は、HTTP %i とお客様の言葉で返す', async (code, status, message, extra) => {
    mockIssueUpload.mockRejectedValue(new ReturnStoreError(code));

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message, code, ...extra });
  });

  it('署名つきの送り先を作れず ReturnPhotoStorageError になれば 500 の言葉。署名つきの送り先・鍵を、ログ・答え・監査のどこにも出さない', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new ReturnPhotoStorageError('storage_unavailable', 'create_signed_upload_url');
    // 誤りの文に秘密を含む値が混ざっても、窓口は名前と記号だけをログに出す
    failure.message += ` ${SIGNED_URL}`;
    mockIssueUpload.mockRejectedValue(failure);

    const response = await POST(postRequest(), ORDER_CONTEXT);

    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: FAILURE_MESSAGE });
    expect(consoleError).toHaveBeenCalledWith('[account.orders.return.photo-upload] Failed to issue return photo upload', 'ReturnPhotoStorageError', 'storage_unavailable');
    expect(mockLogAudit).not.toHaveBeenCalled();
    const everything = JSON.stringify(body) + consoleError.mock.calls.flat().map(String).join(' ') + JSON.stringify(mockLogAudit.mock.calls);
    expect(everything).not.toContain('SIGNED-TOKEN-MARK');
    consoleError.mockRestore();
  });

  it('成功の時も、署名つきの送り先をログ・監査に出さない。この窓口は監査を書かない（送り先の表が記録する）', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});

    await POST(postRequest(), ORDER_CONTEXT);

    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });
});
