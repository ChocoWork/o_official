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
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockDeps = { name: 'refund-deps' };
const mockCreateDeps = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: (...args: unknown[]) => mockCreateDeps(...args),
}));
const mockCancel = jest.fn();
const mockReopen = jest.fn();
const mockCloseMissing = jest.fn();
const mockInspect = jest.fn();
const mockFeePayment = jest.fn();
const mockRelease = jest.fn();
jest.mock('@/lib/orders/returns/return-service', () => ({
  submitCancelReturn: (...args: unknown[]) => mockCancel(...args),
  submitReopenReturn: (...args: unknown[]) => mockReopen(...args),
  submitCloseReturnMissing: (...args: unknown[]) => mockCloseMissing(...args),
  submitInspectReturn: (...args: unknown[]) => mockInspect(...args),
  submitRecordReturnFeePayment: (...args: unknown[]) => mockFeePayment(...args),
  submitReleaseReturnExchange: (...args: unknown[]) => mockRelease(...args),
}));

import { POST as postCancel } from '@/app/api/admin/returns/[returnId]/cancel/route';
import { POST as postCloseMissing } from '@/app/api/admin/returns/[returnId]/close-missing/route';
import { POST as postFeePayment } from '@/app/api/admin/returns/[returnId]/fee-payment/route';
import { POST as postInspect } from '@/app/api/admin/returns/[returnId]/inspect/route';
import { POST as postReleaseExchange } from '@/app/api/admin/returns/[returnId]/release-exchange/route';
import { POST as postReopen } from '@/app/api/admin/returns/[returnId]/reopen/route';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { C4_CASES, HEADERS, LINE_ID, LINE_ID_2, RECEIPT_ID, REQUEST_KEY, RETURN_ID } from '../../lib/orders/returns/return-route-fixtures';

const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const RETURN_CONTEXT = { params: Promise.resolve({ returnId: RETURN_ID }) };
const BAD_RETURN_CONTEXT = { params: Promise.resolve({ returnId: 'x' }) };

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

type UpdateEndpoint = {
  name: string;
  path: string;
  post: (request: Request, context: { params: Promise<{ returnId: string }> }) => Promise<Response>;
  action: string;
  /** 手数料の記録と支払いを待たずに送るは、お金に関わるので返金の権限も求める */
  requiresRefund: boolean;
  service: jest.Mock;
  /** 正しい本文。本文を読まない窓口（取消・支払いを待たずに送る）は undefined で、本文を付けずに送る */
  validBody: unknown;
  invalidBodies: Array<[string, unknown]>;
  serviceInput: Record<string, unknown>;
  doneResult: Record<string, unknown>;
  data: Record<string, unknown>;
  successDetail: string;
  successMetadata: Record<string, unknown>;
  refusedDetail: string;
  failureDetail: string;
};

const REQUEST_KEY_BODY = { requestKey: REQUEST_KEY };
const REQUEST_KEY_INVALID: Array<[string, unknown]> = [
  ['requestKey が無い', {}],
  ['requestKey が UUID でない', { requestKey: 'abc' }],
  ['requestKey が文字でない', { requestKey: 5 }],
];
const RECEIPT_DONE = { kind: 'done', receiptId: RECEIPT_ID, returnStatus: 'open', replayed: false };
const RECEIPT_DATA = { returnStatus: 'open', receiptId: RECEIPT_ID, replayed: false };
const RECEIPT_AUDIT = { receipt_id: RECEIPT_ID, return_status: 'open', replayed: false };
const INSPECT_LINES = [{ returnLineId: LINE_ID, restocked: 1, notRestocked: 1 }];
const INSPECT_LINE = INSPECT_LINES[0];

const ENDPOINTS: UpdateEndpoint[] = [
  {
    name: '取消',
    path: 'cancel',
    post: postCancel,
    action: 'admin.orders.return.cancel',
    requiresRefund: false,
    service: mockCancel,
    validBody: undefined,
    invalidBodies: [],
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1' },
    doneResult: { kind: 'done', returnId: RETURN_ID, status: 'cancelled' },
    data: { returnStatus: 'cancelled' },
    successDetail: 'Return cancelled',
    successMetadata: { return_status: 'cancelled' },
    refusedDetail: 'Return cancel refused',
    failureDetail: 'Failed to cancel return',
  },
  {
    name: '開き直し',
    path: 'reopen',
    post: postReopen,
    action: 'admin.orders.return.reopen',
    requiresRefund: false,
    service: mockReopen,
    validBody: REQUEST_KEY_BODY,
    invalidBodies: REQUEST_KEY_INVALID,
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', requestKey: REQUEST_KEY },
    doneResult: RECEIPT_DONE,
    data: RECEIPT_DATA,
    successDetail: 'Return reopened',
    successMetadata: RECEIPT_AUDIT,
    refusedDetail: 'Return reopen refused',
    failureDetail: 'Failed to reopen return',
  },
  {
    name: '届かないで終える',
    path: 'close-missing',
    post: postCloseMissing,
    action: 'admin.orders.return.close_missing',
    requiresRefund: false,
    service: mockCloseMissing,
    validBody: REQUEST_KEY_BODY,
    invalidBodies: REQUEST_KEY_INVALID,
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', requestKey: REQUEST_KEY },
    doneResult: { ...RECEIPT_DONE, returnStatus: 'closed' },
    data: { ...RECEIPT_DATA, returnStatus: 'closed' },
    successDetail: 'Return closed as missing',
    successMetadata: { ...RECEIPT_AUDIT, return_status: 'closed' },
    refusedDetail: 'Return close-missing refused',
    failureDetail: 'Failed to close return as missing',
  },
  {
    name: '検品を終える',
    path: 'inspect',
    post: postInspect,
    action: 'admin.orders.return.inspect',
    requiresRefund: false,
    service: mockInspect,
    validBody: { requestKey: REQUEST_KEY, lines: INSPECT_LINES },
    invalidBodies: [
      ...REQUEST_KEY_INVALID.map(([name, body]): [string, unknown] => [name, { ...(body as object), lines: INSPECT_LINES }]),
      ['品の行が無い', { requestKey: REQUEST_KEY }],
      ['品の行が空', { requestKey: REQUEST_KEY, lines: [] }],
      ['品の行が配列でない', { requestKey: REQUEST_KEY, lines: 'x' }],
      [
        '品の行が101行',
        {
          requestKey: REQUEST_KEY,
          lines: Array.from({ length: 101 }, (_, index) => ({
            ...INSPECT_LINE, returnLineId: `a3b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`,
          })),
        },
      ],
      ['返品の行の番号が UUID でない', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, returnLineId: 'line-1' }] }],
      ['戻す数が負', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, restocked: -1 }] }],
      ['戻す数が小数', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, restocked: 1.5 }] }],
      ['戻す数が1000', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, restocked: 1000 }] }],
      ['戻さない数が負', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, notRestocked: -1 }] }],
      ['戻す数も戻さない数も0', { requestKey: REQUEST_KEY, lines: [{ ...INSPECT_LINE, restocked: 0, notRestocked: 0 }] }],
      ['同じ返品の行が2行', { requestKey: REQUEST_KEY, lines: [INSPECT_LINE, { ...INSPECT_LINE, restocked: 2 }] }],
    ],
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', requestKey: REQUEST_KEY, lines: INSPECT_LINES },
    doneResult: { ...RECEIPT_DONE, returnStatus: 'closed' },
    data: { ...RECEIPT_DATA, returnStatus: 'closed' },
    successDetail: 'Return inspected',
    successMetadata: { ...RECEIPT_AUDIT, return_status: 'closed', line_count: 1 },
    refusedDetail: 'Return inspect refused',
    failureDetail: 'Failed to inspect return',
  },
  {
    name: '手数料の受け取りの記録',
    path: 'fee-payment',
    post: postFeePayment,
    action: 'admin.orders.return.fee_payment',
    requiresRefund: true,
    service: mockFeePayment,
    validBody: { note: '銀行振込を確認', waive: false },
    invalidBodies: [
      ['メモが501文字', { note: 'あ'.repeat(501), waive: false }],
      ['メモが文字でない', { note: 5, waive: false }],
      // 計画の冒頭 P27: waive は必須の真偽（画面は「受け取りを記録する」で false、「いただかないで終える」で true を送る）
      ['いただかないで終えるが無い', { note: '銀行振込を確認' }],
      ['いただかないで終えるが真偽でない', { note: '銀行振込を確認', waive: 'true' }],
      ['いただかないで終えるが null', { note: '銀行振込を確認', waive: null }],
      ['本文が配列', ['銀行振込']],
    ],
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1', note: '銀行振込を確認', waive: false },
    doneResult: { kind: 'done', returnId: RETURN_ID, returnStatus: 'closed' },
    data: { returnStatus: 'closed' },
    successDetail: 'Return fee payment recorded',
    successMetadata: { return_status: 'closed', waive: false },
    refusedDetail: 'Return fee payment refused',
    failureDetail: 'Failed to record return fee payment',
  },
  {
    name: '支払いを待たずに送る',
    path: 'release-exchange',
    post: postReleaseExchange,
    action: 'admin.orders.return.release_exchange',
    requiresRefund: true,
    service: mockRelease,
    validBody: undefined,
    invalidBodies: [],
    serviceInput: { returnId: RETURN_ID, actorId: 'admin-1' },
    doneResult: { kind: 'done', returnId: RETURN_ID, returnStatus: 'open' },
    data: { returnStatus: 'open' },
    successDetail: 'Return exchange released',
    successMetadata: { return_status: 'open' },
    refusedDetail: 'Return exchange release refused',
    failureDetail: 'Failed to release return exchange',
  },
];

function call(endpoint: UpdateEndpoint, options: { body?: unknown; rawBody?: string; context?: typeof RETURN_CONTEXT } = {}) {
  const body = 'body' in options ? options.body : endpoint.validBody;
  const init: RequestInit = { method: 'POST', headers: HEADERS };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const request = new Request(`http://localhost/api/admin/returns/${RETURN_ID}/${endpoint.path}`, init);
  return endpoint.post(request, options.context ?? RETURN_CONTEXT);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  mockCreateDeps.mockReset();
  for (const endpoint of ENDPOINTS) {
    endpoint.service.mockReset();
    endpoint.service.mockResolvedValue(endpoint.doneResult);
  }
  grant('admin.orders.return', 'admin.orders.refund');
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockCreateDeps.mockResolvedValue(mockDeps);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる
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

  it('送信元ごと・管理者ごとの回数の制限を、取消などの窓口の名前と回数（10分に60回）で数える', async () => {
    expect((await call(endpoint)).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600, subject: 'admin-1',
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
});

describe.each(ENDPOINTS.filter((endpoint) => endpoint.requiresRefund))('$name の窓口は返金の権限も求める', (endpoint) => {
  it('権限 admin.orders.refund が無ければ（サポートの人）CSRF も回数の制限も確かめず、認可の応答を返す', async () => {
    grant('admin.orders.return');

    expect((await call(endpoint)).status).toBe(403);
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(endpoint.service).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe.each(ENDPOINTS.filter((endpoint) => !endpoint.requiresRefund))('$name の窓口は返品の権限だけで通る', (endpoint) => {
  it('サポート（返金の権限が無い人）も使える。返金の権限は確かめない', async () => {
    grant('admin.orders.return');

    expect((await call(endpoint)).status).toBe(200);
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
  });
});

describe.each(ENDPOINTS)('$name の窓口の答え', (endpoint) => {
  it('実行した人と本文を入口に渡し、答えを data で返す。監査に番号・状態だけを残し、鍵も伏せられない', async () => {
    const response = await call(endpoint);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: endpoint.data });
    expect(mockCreateDeps).toHaveBeenCalledTimes(1);
    expect(endpoint.service).toHaveBeenCalledTimes(1);
    expect(endpoint.service).toHaveBeenCalledWith(mockDeps, endpoint.serviceInput);
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
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
  });

  // Task 9 の画面は、どの窓口の答えからも data.returnStatus を読む。取消だけ入口の答えの項目が status なので、窓口が直す（T7-16）
  it('答えの data に必ず returnStatus がある。取消は入口の status を returnStatus に直し、status は返さない', async () => {
    const response = await call(endpoint);
    const { data } = (await response.json()) as { data: Record<string, unknown> };

    expect(data.returnStatus).toBe(endpoint.doneResult.returnStatus ?? endpoint.doneResult.status);
    expect(data).not.toHaveProperty('status');
  });

  it.each(C4_CASES)('入口が %s で断った（答えで返した）ら HTTP %i と C-4 の言葉。409 は衝突、ほかは失敗として監査に残す', async (code, status, message) => {
    endpoint.service.mockResolvedValue({ kind: 'refused', code });

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
  });

  it('断りが投げられても（入口は答えで返すので本来は来ない）、答えで返された時と同じ HTTP と言葉', async () => {
    endpoint.service.mockRejectedValue(new ReturnStoreError('RETURN_STATE_CONFLICT'));

    const response = await call(endpoint);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '返品の状態が変わりました。画面を開き直してください。',
      code: 'RETURN_STATE_CONFLICT',
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'conflict', detail: endpoint.refusedDetail, metadata: { code: 'RETURN_STATE_CONFLICT' },
    }));
  });

  it('E-2 の記号で断られたら（入口が E-2 の言葉をそのまま渡した時）、E-2 の言葉と HTTP', async () => {
    endpoint.service.mockResolvedValue({ kind: 'refused', code: 'order_not_found' });

    const response = await call(endpoint);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('思いがけない失敗は 500。ログは例外名と DB の記号だけ（DB の文は出さない）', async () => {
    endpoint.service.mockRejectedValue(new RefundStoreError('admin_update_return', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await call(endpoint);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の更新に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([[`[${endpoint.action}] ${endpoint.failureDetail}`, 'RefundStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: endpoint.action, outcome: 'error', detail: endpoint.failureDetail, metadata: null,
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('入口に渡す道具を作れなかった（環境の値が無い）時も、決まった 500。ログは例外名だけ', async () => {
    mockCreateDeps.mockRejectedValue(new TypeError('STRIPE_SECRET_KEY is not set'));
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

  it('返品の番号の形が違えば 400。入口を呼ばず、固定の文だけを監査に残す', async () => {
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

// 二重防止の番号を持つ3つ（開き直し・届かないで終える・検品）は、同じ番号の送り直しの答え（replayed）をそのまま写す
describe.each(ENDPOINTS.filter((endpoint) => 'replayed' in endpoint.doneResult))('$name の窓口の送り直し', (endpoint) => {
  it('同じ二重防止の番号の送り直しの答え（replayed）は、200 のまま写す', async () => {
    endpoint.service.mockResolvedValue({ ...endpoint.doneResult, replayed: true });

    const response = await call(endpoint);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { ...endpoint.data, replayed: true } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ replayed: true }),
    }));
  });
});

// 本文を読む窓口は、形の誤りを 400 にする。入口を呼ばず、固定の文だけを監査に残す
describe.each(ENDPOINTS.filter((endpoint) => endpoint.validBody !== undefined))('$name の窓口の本文', (endpoint) => {
  it.each(endpoint.invalidBodies)('中身の誤り（%s）は 400。入口を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await call(endpoint, { body });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(endpoint.service).not.toHaveBeenCalled();
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

// 取消と支払いを待たずに送るは、本文を読まない（番号も中身も無い）。本文が無くても、壊れていても通る
describe.each(ENDPOINTS.filter((endpoint) => endpoint.validBody === undefined))('$name の窓口は本文を読まない', (endpoint) => {
  it.each<[string, string | undefined]>([
    ['本文なし', undefined],
    ['壊れた JSON', '{'],
    ['null', 'null'],
  ])('%s でも通る', async (_name, rawBody) => {
    const response = await call(endpoint, rawBody === undefined ? {} : { rawBody });

    expect(response.status).toBe(200);
    expect(endpoint.service).toHaveBeenCalledWith(mockDeps, endpoint.serviceInput);
  });
});

describe('検品を終える（POST /api/admin/returns/[returnId]/inspect）の個別', () => {
  const inspect = ENDPOINTS[3];

  it('戻す数だけ・戻さない数だけの行も受け、複数の行をそのまま渡す。監査の行の数は行の数', async () => {
    const lines = [
      { returnLineId: LINE_ID, restocked: 2, notRestocked: 0 },
      { returnLineId: LINE_ID_2, restocked: 0, notRestocked: 1 },
    ];

    const response = await call(inspect, { body: { requestKey: REQUEST_KEY, lines } });

    expect(response.status).toBe(200);
    expect(mockInspect).toHaveBeenCalledWith(mockDeps, expect.objectContaining({ lines }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ line_count: 2 }),
    }));
  });
});

describe('手数料の受け取りの記録（POST /api/admin/returns/[returnId]/fee-payment）の個別', () => {
  const feePayment = ENDPOINTS[4];

  it('メモは省ける。null（画面が送る本文は { note: null, waive: false }）・空・空白だけのメモは null、前後の空白は除く', async () => {
    await call(feePayment, { body: { waive: false } });
    expect(mockFeePayment).toHaveBeenLastCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', note: null, waive: false });

    await call(feePayment, { body: { note: null, waive: false } });
    expect(mockFeePayment).toHaveBeenLastCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', note: null, waive: false });

    await call(feePayment, { body: { note: '   ', waive: false } });
    expect(mockFeePayment).toHaveBeenLastCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', note: null, waive: false });

    await call(feePayment, { body: { note: '  銀行振込を確認  ', waive: false } });
    expect(mockFeePayment).toHaveBeenLastCalledWith(mockDeps, {
      returnId: RETURN_ID, actorId: 'admin-1', note: '銀行振込を確認', waive: false,
    });
  });

  // 計画の冒頭 P27: 「いただかないで終える」（waive: true）も、記録と同じ窓口・同じ権限・同じ回数の制限・同じ action。新しい action は作らない
  it.each([true, false])('waive が %s なら、そのまま入口に渡し、同じ action の監査に waive の真偽を残す', async (waive) => {
    const response = await call(feePayment, { body: { note: null, waive } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { returnStatus: 'closed' } });
    expect(mockFeePayment).toHaveBeenCalledWith(mockDeps, { returnId: RETURN_ID, actorId: 'admin-1', note: null, waive });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.orders.return.fee_payment',
      outcome: 'success',
      detail: 'Return fee payment recorded',
      metadata: { return_status: 'closed', waive },
    }));
  });

  it('監査に受け取りの方法のメモを入れない', async () => {
    await call(feePayment);

    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('銀行振込');
  });
});
