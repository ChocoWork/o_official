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
// DB の行の写し方は Task 4 の試験の持ち場。窓口の試験では、承認・お断り・写真の一覧の呼び出しだけを差し替える
const mockApprove = jest.fn();
const mockDecline = jest.fn();
const mockListPhotos = jest.fn();
jest.mock('@/lib/orders/returns/return-store', () => ({
  ...jest.requireActual('@/lib/orders/returns/return-store'),
  approveReturn: (...args: unknown[]) => mockApprove(...args),
  declineReturn: (...args: unknown[]) => mockDecline(...args),
  listReturnPhotos: (...args: unknown[]) => mockListPhotos(...args),
}));
// 署名つきのリンクを作る部品は Task 5 の試験の持ち場。窓口の試験では差し替える
const mockSignPhotoUrls = jest.fn();
jest.mock('@/lib/orders/returns/return-photo-storage', () => ({
  signReturnPhotoUrls: (...args: unknown[]) => mockSignPhotoUrls(...args),
}));

import { POST as postApprove } from '@/app/api/admin/returns/[returnId]/approve/route';
import { POST as postDecline } from '@/app/api/admin/returns/[returnId]/decline/route';
import { GET as getPhotos } from '@/app/api/admin/returns/[returnId]/photos/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { C4_CASES, HEADERS, LINE_ID, LINE_ID_2, RETURN_ID } from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const RETURN_CONTEXT = { params: Promise.resolve({ returnId: RETURN_ID }) };
const BAD_RETURN_CONTEXT = { params: Promise.resolve({ returnId: 'x' }) };
const PHOTO_ID = 'b4b2c3d4-1111-4222-8333-444455556661';
const PHOTO_ID_2 = 'b4b2c3d4-1111-4222-8333-444455556662';

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

// ---- 承認の本文 ----

const REFUND_LINE = { returnLineId: LINE_ID, resolution: 'refund', exchangeVariantId: null, exchangeMethod: null };
const EXCHANGE_LINE = { returnLineId: LINE_ID_2, resolution: 'exchange', exchangeVariantId: 31, exchangeMethod: 'stock' };
const APPROVE_BODY = {
  lines: [REFUND_LINE, EXCHANGE_LINE],
  returnMethod: 'customer_ships',
  returnShippingPayer: 'customer',
  returnCarrier: null,
  returnTrackingNumber: null,
  returnShippingFee: 0,
  restockingFeePercent: 10,
  exchangeFee: 300,
  exchangeShippingFee: 500,
  shopNote: '承認のメモ',
  notifyCustomer: true,
};

function approveWith(change: Record<string, unknown>) {
  return { ...APPROVE_BODY, ...change };
}

const APPROVE_INVALID: Array<[string, unknown]> = [
  ['本文が配列', []],
  ['行が無い', approveWith({ lines: undefined })],
  ['行が空', approveWith({ lines: [] })],
  ['行が配列でない', approveWith({ lines: 'x' })],
  [
    '行が101行',
    approveWith({
      lines: Array.from({ length: 101 }, (_, index) => ({
        ...REFUND_LINE, returnLineId: `a3b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`,
      })),
    }),
  ],
  ['同じ返品の行が2行', approveWith({ lines: [REFUND_LINE, { ...EXCHANGE_LINE, returnLineId: LINE_ID }] })],
  ['返品の行の番号が UUID でない', approveWith({ lines: [{ ...REFUND_LINE, returnLineId: 'line-1' }] })],
  ['解決の方法が知らない値', approveWith({ lines: [{ ...REFUND_LINE, resolution: 'credit' }] })],
  ['解決の方法が無い', approveWith({ lines: [{ ...REFUND_LINE, resolution: undefined }] })],
  ['交換なのに色・サイズが無い', approveWith({ lines: [{ ...EXCHANGE_LINE, exchangeVariantId: null }] })],
  ['交換なのに送り方が無い', approveWith({ lines: [{ ...EXCHANGE_LINE, exchangeMethod: null }] })],
  ['返金なのに色・サイズがある', approveWith({ lines: [{ ...REFUND_LINE, exchangeVariantId: 31 }] })],
  ['返金なのに送り方がある', approveWith({ lines: [{ ...REFUND_LINE, exchangeMethod: 'make' }] })],
  ['交換の色・サイズの番号が0', approveWith({ lines: [{ ...EXCHANGE_LINE, exchangeVariantId: 0 }] })],
  ['交換の色・サイズの番号が小数', approveWith({ lines: [{ ...EXCHANGE_LINE, exchangeVariantId: 1.5 }] })],
  ['交換の送り方が知らない値', approveWith({ lines: [{ ...EXCHANGE_LINE, exchangeMethod: 'wait' }] })],
  ['返送の方法が知らない値', approveWith({ returnMethod: 'pickup' })],
  ['返送の方法が無い', approveWith({ returnMethod: undefined })],
  ['返送料の負担が知らない値', approveWith({ returnShippingPayer: 'both' })],
  ['返送料の負担が無い', approveWith({ returnShippingPayer: undefined })],
  ['配送業者が知らない値', approveWith({ returnCarrier: 'fedex' })],
  ['伝票番号に使えない文字（空白）', approveWith({ returnTrackingNumber: 'AB 123' })],
  ['伝票番号が65文字', approveWith({ returnTrackingNumber: 'a'.repeat(65) })],
  ['返送料が負', approveWith({ returnShippingFee: -1 })],
  ['返送料が小数', approveWith({ returnShippingFee: 1.5 })],
  ['返送料が1000001', approveWith({ returnShippingFee: 1000001 })],
  ['返送料が無い', approveWith({ returnShippingFee: undefined })],
  ['返品の手数料の%が負', approveWith({ restockingFeePercent: -1 })],
  ['返品の手数料の%が101', approveWith({ restockingFeePercent: 101 })],
  ['返品の手数料の%が小数', approveWith({ restockingFeePercent: 10.5 })],
  ['返品の手数料の%が無い', approveWith({ restockingFeePercent: undefined })],
  ['交換の手数料が負', approveWith({ exchangeFee: -1 })],
  ['交換の手数料が1000001', approveWith({ exchangeFee: 1000001 })],
  ['交換の手数料が無い', approveWith({ exchangeFee: undefined })],
  ['交換の送料が負', approveWith({ exchangeShippingFee: -1 })],
  ['交換の送料が1000001', approveWith({ exchangeShippingFee: 1000001 })],
  ['交換の送料が無い', approveWith({ exchangeShippingFee: undefined })],
  ['メモが501文字', approveWith({ shopNote: 'あ'.repeat(501) })],
  ['メモが文字でない', approveWith({ shopNote: 5 })],
  ['お客様に知らせるが無い', approveWith({ notifyCustomer: undefined })],
  ['お客様に知らせるが真偽でない', approveWith({ notifyCustomer: 'yes' })],
];

// ---- お断りの本文 ----

const DECLINE_BODY = {
  declineReason: 'window_passed',
  declineMessage: '受付の期限を過ぎているため、今回のお申し込みはお受けできませんでした。',
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

type ReviewEndpoint = {
  name: string;
  path: string;
  post: (request: Request, context: { params: Promise<{ returnId: string }> }) => Promise<Response>;
  action: string;
  service: jest.Mock;
  validBody: unknown;
  invalidBodies: Array<[string, unknown]>;
  serviceInput: Record<string, unknown>;
  doneResult: Record<string, unknown>;
  data: Record<string, unknown>;
  successDetail: string;
  successMetadata: Record<string, unknown>;
  refusedDetail: string;
  failureDetail: string;
  failureMessage: string;
};

const ENDPOINTS: ReviewEndpoint[] = [
  {
    name: '承認',
    path: 'approve',
    post: postApprove,
    action: 'admin.orders.return.approve',
    service: mockApprove,
    validBody: APPROVE_BODY,
    invalidBodies: APPROVE_INVALID,
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', ...APPROVE_BODY },
    doneResult: { returnId: RETURN_ID, returnStatus: 'open' },
    data: { returnStatus: 'open' },
    successDetail: 'Return approved',
    successMetadata: { return_status: 'open', line_count: 2, return_method: 'customer_ships', notify_customer: true },
    refusedDetail: 'Return approve refused',
    failureDetail: 'Failed to approve return',
    failureMessage: '返品の申し込みの承認に失敗しました。',
  },
  {
    name: 'お断り',
    path: 'decline',
    post: postDecline,
    action: 'admin.orders.return.decline',
    service: mockDecline,
    validBody: DECLINE_BODY,
    invalidBodies: DECLINE_INVALID,
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', ...DECLINE_BODY },
    doneResult: { returnId: RETURN_ID, returnStatus: 'declined' },
    data: { returnStatus: 'declined' },
    successDetail: 'Return declined',
    successMetadata: { return_status: 'declined', decline_reason: 'window_passed' },
    refusedDetail: 'Return decline refused',
    failureDetail: 'Failed to decline return',
    failureMessage: '返品の申し込みのお断りに失敗しました。',
  },
];

function call(endpoint: ReviewEndpoint, options: { body?: unknown; rawBody?: string; context?: typeof RETURN_CONTEXT } = {}) {
  const body = 'body' in options ? options.body : endpoint.validBody;
  const request = new Request(`http://localhost/api/admin/returns/${RETURN_ID}/${endpoint.path}`, {
    method: 'POST',
    headers: HEADERS,
    body: options.rawBody ?? JSON.stringify(body),
  });
  return endpoint.post(request, options.context ?? RETURN_CONTEXT);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockCreateServiceRoleClient.mockReset();
  mockSchedule.mockReset();
  mockListPhotos.mockReset();
  mockSignPhotoUrls.mockReset();
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
describe.each(ENDPOINTS)('$name の窓口の守り', (endpoint) => {
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

  it('送信元ごと・管理者ごとの回数の制限を、承認・お断りの窓口の名前と回数（10分に30回）で数える', async () => {
    expect((await call(endpoint)).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:returns:review', limit: 30, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:returns:review', limit: 30, windowSeconds: 600, subject: 'admin-1',
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

describe.each(ENDPOINTS)('$name の窓口の答え', (endpoint) => {
  it('実行した人と本文を store に渡し、答えを data で返す。監査に番号・状態・記号・数だけを残し、鍵も伏せられない', async () => {
    const response = await call(endpoint);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: endpoint.data });
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(endpoint.service).toHaveBeenCalledTimes(1);
    expect(endpoint.service).toHaveBeenCalledWith(mockServiceClient, endpoint.serviceInput);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: endpoint.action,
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: 'success',
      detail: endpoint.successDetail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: endpoint.successMetadata,
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['@example.com', '承認のメモ', '受付の期限を過ぎている']) {
      expect(audited).not.toContain(secret);
    }
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
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
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: status === 409 ? 'conflict' : 'failure',
      detail: endpoint.refusedDetail,
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { code },
    });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  // 承認もお断りも状態で守る（二重防止の番号を持たない）。2回目は DB が状態に合わない誤りで断り、画面は読み直す
  it('2回目（DB が RETURN_STATE_CONFLICT で断る）は 409 と「返品の状態が変わりました。画面を開き直してください。」', async () => {
    endpoint.service.mockRejectedValue(new ReturnStoreError('RETURN_STATE_CONFLICT'));

    const response = await call(endpoint);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '返品の状態が変わりました。画面を開き直してください。',
      code: 'RETURN_STATE_CONFLICT',
    });
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    endpoint.service.mockRejectedValue(new RefundStoreError('admin_review_return', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: endpoint.failureMessage, code: 'failed' });
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
      await expect(response.json()).resolves.toEqual({ error: endpoint.failureMessage, code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[`[${endpoint.action}] ${endpoint.failureDetail}`, 'TypeError']]);
      expect(endpoint.service).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返品の番号の形が違えば 400。store を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await call(endpoint, { context: BAD_RETURN_CONTEXT });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: endpoint.action, actor_id: 'admin-1', resource: 'order_returns', resource_id: 'x',
      outcome: 'failure', detail: 'Invalid return id', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });
});

describe.each(ENDPOINTS)('$name の窓口の本文', (endpoint) => {
  it.each(endpoint.invalidBodies)('中身の誤り（%s）は 400。store を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await call(endpoint, { body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: endpoint.action, actor_id: 'admin-1', resource: 'order_returns', resource_id: RETURN_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await call(endpoint, { body: null, rawBody });

    expect(response.status).toBe(400);
    expect(endpoint.service).not.toHaveBeenCalled();
  });
});

describe('承認（POST /api/admin/returns/[returnId]/approve）の個別', () => {
  const approve = ENDPOINTS[0];

  it('知らせる（notifyCustomer: true）なら、成功の後にメールの送る処理を1回動かす（受付のお知らせの予定は DB が同じ取引で書いた）', async () => {
    await call(approve);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('知らせない（notifyCustomer: false）なら、メールの送る処理を動かさない', async () => {
    const response = await call(approve, { body: approveWith({ notifyCustomer: false }) });

    expect(response.status).toBe(200);
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ notify_customer: false }),
    }));
  });

  it('省ける欄（配送業者・伝票番号・メモ・交換の色・サイズ・送り方）は省いても通り、空・空白だけの文は null にして渡す', async () => {
    const body = {
      lines: [{ returnLineId: LINE_ID, resolution: 'refund' }],
      returnMethod: 'shop_label',
      returnShippingPayer: 'shop',
      returnTrackingNumber: '  ',
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      shopNote: '   ',
      notifyCustomer: true,
    };

    const response = await call(approve, { body });

    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith(mockServiceClient, {
      returnId: RETURN_ID,
      actorId: 'admin-1',
      lines: [{ returnLineId: LINE_ID, resolution: 'refund', exchangeVariantId: null, exchangeMethod: null }],
      returnMethod: 'shop_label',
      returnShippingPayer: 'shop',
      returnCarrier: null,
      returnTrackingNumber: null,
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      shopNote: null,
      notifyCustomer: true,
    });
  });

  it('メモ・伝票番号の前後の空白は除いて渡す。配送業者と伝票番号はそのまま渡す', async () => {
    await call(approve, {
      body: approveWith({ returnCarrier: 'yamato', returnTrackingNumber: ' AB-12 ', shopNote: '  袖を確かめました  ' }),
    });

    expect(mockApprove).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({
      returnCarrier: 'yamato', returnTrackingNumber: 'AB-12', shopNote: '袖を確かめました',
    }));
  });

  it('返送不要（not_required）と、金額・%の上限ちょうど（1000000円・100%）も受ける。返送不要を使えるかは DB が決める', async () => {
    const response = await call(approve, {
      body: approveWith({
        returnMethod: 'not_required', returnShippingFee: 1000000, restockingFeePercent: 100, exchangeFee: 1000000, exchangeShippingFee: 1000000,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({
      returnMethod: 'not_required', returnShippingFee: 1000000, restockingFeePercent: 100, exchangeFee: 1000000, exchangeShippingFee: 1000000,
    }));
  });

  it('二重防止の番号 requestKey は受けも渡しもしない（承認は状態で守る）', async () => {
    await call(approve, { body: approveWith({ requestKey: 'b1b2c3d4-1111-4222-8333-444455556666' }) });

    expect(mockApprove.mock.calls[0][1]).not.toHaveProperty('requestKey');
  });
});

describe('お断り（POST /api/admin/returns/[returnId]/decline）の個別', () => {
  const decline = ENDPOINTS[1];

  it('成功の後にメールの送る処理を1回動かす（お断りのお知らせの予定は DB がいつも書く）', async () => {
    await call(decline);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it.each(['window_passed', 'final_sale', 'other'])('理由 %s を受けて、そのまま渡す。監査には理由の記号だけを残す', async (declineReason) => {
    const response = await call(decline, { body: { ...DECLINE_BODY, declineReason } });

    expect(response.status).toBe(200);
    expect(mockDecline).toHaveBeenCalledWith(mockServiceClient, expect.objectContaining({ declineReason }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { return_status: 'declined', decline_reason: declineReason },
    }));
  });

  it('メッセージは前後の空白だけ除き、書かれたまま（改行・記号）を渡す。1000字ちょうどは通る', async () => {
    await call(decline, { body: { ...DECLINE_BODY, declineMessage: '  <b>期限</b>\nを過ぎています。  ' } });
    expect(mockDecline).toHaveBeenLastCalledWith(mockServiceClient, expect.objectContaining({
      declineMessage: '<b>期限</b>\nを過ぎています。',
    }));

    const response = await call(decline, { body: { ...DECLINE_BODY, declineMessage: 'あ'.repeat(1000) } });
    expect(response.status).toBe(200);
  });

  it('メッセージを監査にもログにも入れない', async () => {
    await call(decline);

    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('受付の期限');
  });
});

describe('GET /api/admin/returns/[returnId]/photos（申し込みの写真の一覧）', () => {
  const request = () => new Request(`http://localhost/api/admin/returns/${RETURN_ID}/photos`);
  const PHOTO_REFS = [
    { photoId: PHOTO_ID, returnLineId: LINE_ID, storagePath: 'requests/order-1/upload-1', purged: false },
    { photoId: PHOTO_ID_2, returnLineId: LINE_ID, storagePath: 'requests/order-1/upload-2', purged: true },
  ];
  const SIGNED = [
    { photoId: PHOTO_ID, returnLineId: LINE_ID, url: 'https://storage.example.test/view/1', purged: false },
    { photoId: PHOTO_ID_2, returnLineId: LINE_ID, url: null, purged: true },
  ];

  beforeEach(() => {
    mockListPhotos.mockResolvedValue(PHOTO_REFS);
    mockSignPhotoUrls.mockResolvedValue(SIGNED);
  });

  it('権限 admin.orders.return で読める。サポート（返金の権限が無い人）も読める。CSRF・回数の制限・監査は通さない', async () => {
    const response = await getPhotos(request(), RETURN_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、何も読まない', async () => {
    grant();

    expect((await getPhotos(request(), RETURN_CONTEXT)).status).toBe(403);
    expect(mockListPhotos).not.toHaveBeenCalled();
    expect(mockSignPhotoUrls).not.toHaveBeenCalled();
  });

  it('返品の番号の形が違えば 400。何も読まない', async () => {
    const response = await getPhotos(request(), BAD_RETURN_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockListPhotos).not.toHaveBeenCalled();
  });

  it('一覧を読み、署名つきのリンクを付けて返す。答えは no-store。消した写真は url が null のまま', async () => {
    const response = await getPhotos(request(), RETURN_CONTEXT);

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ data: { photos: SIGNED } });
    expect(mockListPhotos).toHaveBeenCalledWith(mockServiceClient, RETURN_ID);
    expect(mockSignPhotoUrls).toHaveBeenCalledWith(mockServiceClient, PHOTO_REFS);
  });

  it('答えの項目は 写真の番号・返品の行の番号・リンク・消したか の4つだけ。置き場の場所は返さない', async () => {
    mockSignPhotoUrls.mockResolvedValue([{ ...SIGNED[0], storagePath: 'requests/order-1/upload-1' }]);

    const response = await getPhotos(request(), RETURN_CONTEXT);

    const body = (await response.json()) as { data: { photos: Array<Record<string, unknown>> } };
    expect(Object.keys(body.data.photos[0]).sort()).toEqual(['photoId', 'purged', 'returnLineId', 'url']);
    expect(JSON.stringify(body)).not.toContain('requests/order-1');
  });

  it('写真が無い返品は、空の一覧を返す', async () => {
    mockListPhotos.mockResolvedValue([]);
    mockSignPhotoUrls.mockResolvedValue([]);

    const response = await getPhotos(request(), RETURN_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { photos: [] } });
  });

  it('store が決まった言葉で断ったら（返品が見つからない）、その HTTP と言葉。監査は書かない', async () => {
    mockListPhotos.mockRejectedValue(new ReturnStoreError('RETURN_NOT_FOUND'));

    const response = await getPhotos(request(), RETURN_CONTEXT);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('思いがけない失敗は 500 と「写真を読み込めませんでした。」。ログは例外名と DB の記号だけで、DB の文は出さない', async () => {
    mockListPhotos.mockRejectedValue(new RefundStoreError('list_return_photos', { message: '宛先を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getPhotos(request(), RETURN_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '写真を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.photos] Failed to load photos', 'RefundStoreError', '08006']]);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('宛先');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('リンクを作る部品が失敗しても 500。署名つきのリンクをログにも答えにも出さない', async () => {
    mockSignPhotoUrls.mockRejectedValue(new Error('failed https://storage.example.test/object/sign/return-photos/x?token=SECRET-TOKEN'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getPhotos(request(), RETURN_CONTEXT);
      expect(response.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.photos] Failed to load photos', 'Error']]);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET-TOKEN');
      expect(JSON.stringify(await response.json())).not.toContain('SECRET-TOKEN');
    } finally {
      consoleError.mockRestore();
    }
  });
});
