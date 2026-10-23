jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args),
}));

const mockRpc = jest.fn();
const mockSelectColumns: string[] = [];
let exceptionRows: unknown[] = [];
let reviewRows: unknown[] = [];
// 要対応 1 件と、それに付いた注文。「注文を取り消して解決」が取り消しの前に読む
let attachedExists = true;
let attachedResolvedAt: string | null = null;
let attachedOrder: Record<string, unknown> | null = null;
let attachedOrderError: unknown = null;
// 一覧の読み込みが DB に断られた時の error。null なら成功
let listError: unknown = null;
// 返金の失敗の要対応が指す返金の記録（order_refunds に order_refund_lines と order_items を埋め込んだ、PostgREST が返す形）
let refundRecords: Array<Record<string, unknown>> = [];
// 返金の記録の読み込みが DB に断られた時の error。null なら成功
let refundLookupError: unknown = null;
// 返金の記録を読んだ呼び出し（どの列で、どの値を探したか）
const refundLookupCalls: Array<{ column: string; values: string[] }> = [];

function listQuery(rows: () => unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ['is', 'not', 'order', 'eq']) {
    query[method] = () => query;
  }
  query.limit = async () => ({ data: rows(), count: rows().length, error: listError });
  query.maybeSingle = async () => ({
    data: attachedOrderError || !attachedExists ? null : { resolved_at: attachedResolvedAt, orders: attachedOrder },
    error: attachedOrderError,
  });
  return query;
}

// 返金の記録の読み込み: select(列).in(列, 値)。列の値が探す値の中にある記録だけ返す
function refundLookupQuery() {
  return {
    in: async (column: string, values: string[]) => {
      refundLookupCalls.push({ column, values });
      return {
        data: refundLookupError ? null : refundRecords.filter((record) => values.includes(String(record[column]))),
        error: refundLookupError,
      };
    },
  };
}

const mockServiceClient = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (table: string) => ({
    select: (columns: string) => {
      mockSelectColumns.push(columns);
      if (table === 'order_refunds') {
        return refundLookupQuery();
      }
      return table === 'payment_exceptions' ? listQuery(() => exceptionRows) : listQuery(() => reviewRows);
    },
  }),
};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

const mockStripe = { name: 'stripe' };
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockStripe,
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReadCheckoutPayment = jest.fn();
jest.mock('@/lib/stripe/checkout-payment-reader', () => ({
  ...jest.requireActual('@/lib/stripe/checkout-payment-reader'),
  readCheckoutPayment: (...args: unknown[]) => mockReadCheckoutPayment(...args),
}));

// 取消のメールの行を書いた後に、返事の後の送信を予約する（after() を使うので、試験では差し替える）
const mockScheduleOrderEmailDelivery = jest.fn();
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockScheduleOrderEmailDelivery(...args),
}));

const mockDeliverySettings = jest.fn();
const mockDeliveryAttention = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  ...jest.requireActual('@/lib/orders/tracking/delivery-store'),
  getDeliveryTrackingSettings: () => mockDeliverySettings(),
  listDeliveryAttention: (...args: unknown[]) => mockDeliveryAttention(...args),
}));

import { GET as getAttention } from '@/app/api/admin/order-attention/route';
import { POST as postReview } from '@/app/api/admin/orders/[id]/review/route';
import { POST as postResolve } from '@/app/api/admin/payment-exceptions/[id]/resolve/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';
import { ORDER_EMAIL_ERROR_LABELS } from '@/lib/orders/email/order-email-types';

type RouteResponse = { status: number; body: Record<string, any> };

describe('配送の要対応', () => {
  test('配送だけある時も他の組の既存値を保ち、limit前の数を返す', async () => {
    const item = { id: 'attention-1', orderId: 'order-1', kind: 'delivery_failure' };
    mockDeliveryAttention.mockResolvedValue({ items: [item], total: 101 });
    const response = await getAttention(new Request('http://localhost/api/admin/order-attention')) as unknown as RouteResponse;
    expect(response.body.data).toMatchObject({ exceptions: [], reviews: [], deliveries: [item], counts: { exceptions: 0, reviews: 0, deliveries: 101 } });
    expect(mockDeliveryAttention).toHaveBeenCalledWith(mockServiceClient, 100);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
  });
  test('OFFならdeliveries空/count0（古い開いた行も返さない）', async () => {
    mockDeliverySettings.mockResolvedValue({ enabled: false });
    mockDeliveryAttention.mockResolvedValue({ items: [{ id: 'old' }], total: 100 });
    const response = await getAttention(new Request('http://localhost/api/admin/order-attention')) as unknown as RouteResponse;
    expect(response.body.data).toMatchObject({ deliveries: [], counts: { deliveries: 0 } });
    expect(mockDeliveryAttention).not.toHaveBeenCalled();
  });
});

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const EXCEPTION_ID = 'b1b2c3d4-1111-2222-8333-444455556666';
const RESOLVE_URL = `http://localhost/api/admin/payment-exceptions/${EXCEPTION_ID}/resolve`;
const RESOLVE_CONTEXT = { params: Promise.resolve({ id: EXCEPTION_ID }) };

function jsonRequest(url: string, body: unknown = {}) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function resolve(body: Record<string, unknown>): Promise<RouteResponse> {
  return (await postResolve(jsonRequest(RESOLVE_URL, body), RESOLVE_CONTEXT)) as unknown as RouteResponse;
}

async function resolveRawBody(rawBody: string): Promise<RouteResponse> {
  const request = new Request(RESOLVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  return (await postResolve(request, RESOLVE_CONTEXT)) as unknown as RouteResponse;
}

async function review(id = ORDER_ID): Promise<RouteResponse> {
  return (await postReview(
    jsonRequest(`http://localhost/api/admin/orders/${id}/review`),
    { params: Promise.resolve({ id }) },
  )) as unknown as RouteResponse;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeliverySettings.mockReset().mockResolvedValue({ enabled: true });
  mockDeliveryAttention.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockSelectColumns.length = 0;
  exceptionRows = [];
  reviewRows = [];
  attachedExists = true;
  attachedResolvedAt = null;
  attachedOrder = null;
  attachedOrderError = null;
  listError = null;
  refundRecords = [];
  refundLookupError = null;
  refundLookupCalls.length = 0;
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'supporter', actorEmail: null });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockExpireOpenCheckoutSession.mockResolvedValue('expired');
  mockReadCheckoutPayment.mockResolvedValue({ state: { kind: 'missing' }, voucherExpiresAt: null });
  mockRpc.mockResolvedValue({ data: [{ paused: false, reason: null }], error: null });
});

describe('GET /api/admin/order-attention', () => {
  it.each(['config_api_key', 'config_sender_domain', 'config_provider', 'quota_daily', 'quota_monthly', null] as const)(
    '送信を止めている時は理由 %s の名前を履歴と同じ表から返す', async (reason) => {
      mockRpc.mockResolvedValue({ data: [{ paused: true, reason }], error: null });
      const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
      expect(res.status).toBe(200);
      expect(res.body.data.emailSending).toEqual({ paused: true, reasonLabel: ORDER_EMAIL_ERROR_LABELS[reason ?? 'config_provider'] });
      expect(mockRpc).toHaveBeenCalledWith('get_order_email_send_state', undefined);
    },
  );

  it('送信を止めていない時は理由なしで返す', async () => {
    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
    expect(res.status).toBe(200);
    expect(res.body.data.emailSending).toEqual({ paused: false, reasonLabel: null });
  });

  it('送信状態が読めなくても要対応は 200 のまま返し、状態は null、ログは例外名と DB の記号だけ', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: '宛先・件名・本文を含む例外' } });
    reviewRows = [{ id: ORDER_ID, status: 'paid', review_reason: 'stock_not_reserved', review_marked_at: null }];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
      expect(res.status).toBe(200);
      expect(res.body.data.emailSending).toBeNull();
      expect(res.body.data.counts).toEqual({ exceptions: 0, reviews: 1, deliveries: 0 });
      expect(res.body.data.reviews).toHaveLength(1);
      expect(warn.mock.calls).toEqual([['[admin.order-attention] Failed to fetch email sending state', 'OrderEmailStoreError', '08006']]);
    } finally {
      warn.mockRestore();
    }
  });

  it('一覧を DB に断られたら 500。ログは例外の名前と DB の記号だけで、DB の文・details・hint は出さない', async () => {
    listError = Object.assign(new Error('canceling statement for cs_1'), {
      name: 'PostgrestError',
      code: '57014',
      details: 'Key (payment_ref)=(cs_1)',
      hint: 'cs_1 を含むヒント',
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch order attention' });
      expect(error.mock.calls).toEqual([['[admin.order-attention] Failed to fetch', 'PostgrestError', '57014']]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('cs_1');
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ['DB の記号がある例外は名前と記号', { code: '08006' }, ['TypeError', '08006']],
    ['記号の無い例外は名前だけ', {}, ['TypeError']],
  ])('予期しない例外は 500。ログは例外の名前と DB の記号だけで、例外の文は出さない（%s）', async (_name, extra, fields) => {
    jest.mocked(createServiceRoleClient).mockRejectedValueOnce(Object.assign(new TypeError('fetch failed for cs_1'), extra));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(error.mock.calls).toEqual([['GET /api/admin/order-attention error:', ...fields]]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('cs_1');
    } finally {
      error.mockRestore();
    }
  });

  it('未解決の要対応と未確認の要確認を、件数と一緒に返す', async () => {
    exceptionRows = [{
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      detail: 'item_unavailable',
      order_id: null,
      payment_ref: 'cs_1',
      first_detected_at: '2026-09-27T01:00:00.000Z',
      last_detected_at: '2026-09-27T02:00:00.000Z',
      detection_count: 2,
      orders: null,
    }, {
      id: 'c1b2c3d4-1111-2222-8333-444455556666',
      reason: 'unexpected_state',
      detail: null,
      order_id: ORDER_ID,
      payment_ref: 'cs_2',
      first_detected_at: '2026-09-27T01:30:00.000Z',
      last_detected_at: '2026-09-27T01:30:00.000Z',
      detection_count: 1,
      orders: { status: 'payment_in_progress' },
    }];
    reviewRows = [{ id: ORDER_ID, status: 'paid', review_reason: 'stock_not_reserved', review_marked_at: '2026-09-27T01:00:00.000Z' }];

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ exceptions: 2, reviews: 1, deliveries: 0 });
    expect(res.body.data.exceptions[0]).toEqual({
      id: EXCEPTION_ID,
      reason: 'order_not_creatable',
      reasonLabel: '注文を作れない支払い',
      detail: 'item_unavailable',
      orderId: null,
      orderNumber: null,
      orderStatus: null,
      paymentRef: 'cs_1',
      firstDetectedAt: '2026-09-27T01:00:00.000Z',
      lastDetectedAt: '2026-09-27T02:00:00.000Z',
      detectionCount: 2,
      canCancelOrder: false,
      canRetryRefund: false,
      refundFailure: null,
    });
    expect(res.body.data.exceptions[1]).toMatchObject({
      orderNumber: 'ORD-A1B2C3D4', canCancelOrder: true, canRetryRefund: false, refundFailure: null,
    });
    expect(res.body.data.reviews[0]).toEqual({
      orderId: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'stock_not_reserved',
      reviewReasonLabel: '在庫を確保できなかった注文',
      reviewMarkedAt: '2026-09-27T01:00:00.000Z',
    });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.read', expect.any(Request));
  });

  it('支払いから作った注文の要確認を、お客様へ確認する文言で返す（FREQ-415）', async () => {
    reviewRows = [{
      id: ORDER_ID,
      status: 'paid',
      review_reason: 'recovered_from_payment',
      review_marked_at: '2026-10-05T01:00:00.000Z',
    }];

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(200);
    expect(res.body.data.reviews[0]).toEqual({
      orderId: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      orderStatus: 'paid',
      reviewReason: 'recovered_from_payment',
      reviewReasonLabel: '支払いから作った注文：お客様へ確認してください',
      reviewMarkedAt: '2026-10-05T01:00:00.000Z',
    });
  });

  it('お客様の個人情報の列を読まない', async () => {
    await getAttention(new Request('http://localhost/api/admin/order-attention'));

    expect(mockSelectColumns.join(',')).not.toMatch(/shipping_|email|name|phone/);
  });

  it('権限が無ければ認可の応答をそのまま返す', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;

    expect(res.status).toBe(403);
  });
  describe('返金の失敗の行（「もう一度返金する」を出せるか）', () => {
    const SECOND_EXCEPTION_ID = 'c1b2c3d4-1111-2222-8333-444455556666';
    const REFUND_FAILED_ROW = {
      id: EXCEPTION_ID,
      reason: 'refund_failed',
      detail: 'expired',
      order_id: ORDER_ID,
      payment_ref: 're_failed1',
      first_detected_at: '2026-10-11T01:00:00.000Z',
      last_detected_at: '2026-10-11T01:00:00.000Z',
      detection_count: 1,
      orders: { status: 'paid' },
    };

    /** 返せる額の RPC（list_order_refund_summaries）の答えを決める。ほかの RPC（メールの送信状態）は、送信を止めていない答え */
    function mockRefundableAmount(refundableAmount: number) {
      mockRpc.mockImplementation(async (name: string) =>
        name === 'list_order_refund_summaries'
          ? {
              data: [{
                order_id: ORDER_ID, paid_amount: 10_000, succeeded_amount: 0, open_amount: 0, refundable_amount: refundableAmount,
                has_open_refund: false, has_unresolved_refund_failure: true,
              }],
              error: null,
            }
          : { data: [{ paused: false, reason: null }], error: null },
      );
    }

    async function listExceptions(): Promise<Array<Record<string, any>>> {
      const res = (await getAttention(new Request('http://localhost/api/admin/order-attention'))) as unknown as RouteResponse;
      expect(res.status).toBe(200);
      return res.body.data.exceptions;
    }

    it('注文の返せる額が残っていれば、理由の名前は「返金の失敗」で、「もう一度返金する」を出せる', async () => {
      exceptionRows = [REFUND_FAILED_ROW];
      mockRefundableAmount(10_000);

      const exceptions = await listExceptions();

      expect(exceptions[0]).toMatchObject({
        reason: 'refund_failed', reasonLabel: '返金の失敗', detail: 'expired', orderNumber: 'ORD-A1B2C3D4', orderStatus: 'paid',
        paymentRef: 're_failed1', canCancelOrder: false, canRetryRefund: true,
      });
      expect(mockRpc).toHaveBeenCalledWith('list_order_refund_summaries', { _order_ids: [ORDER_ID] });
    });

    it('注文の返せる額が0なら（別の方法で返し終えた、など）「もう一度返金する」は出せない', async () => {
      exceptionRows = [REFUND_FAILED_ROW];
      mockRefundableAmount(0);

      expect((await listExceptions())[0]).toMatchObject({ reason: 'refund_failed', canRetryRefund: false });
    });

    it('同じ注文の返金の失敗が2行あっても、返せる額は注文の番号を重ねずに1回で読む', async () => {
      exceptionRows = [REFUND_FAILED_ROW, { ...REFUND_FAILED_ROW, id: SECOND_EXCEPTION_ID, payment_ref: 're_failed2' }];
      mockRefundableAmount(4_000);

      const exceptions = await listExceptions();

      expect(exceptions.map((row) => row.canRetryRefund)).toEqual([true, true]);
      expect(mockRpc.mock.calls.filter(([name]) => name === 'list_order_refund_summaries')).toEqual([
        ['list_order_refund_summaries', { _order_ids: [ORDER_ID] }],
      ]);
    });

    it('返金の失敗でない行と、注文の無い返金の失敗は、返せる額を読まずに false', async () => {
      exceptionRows = [
        { ...REFUND_FAILED_ROW, reason: 'unexpected_state', detail: null, orders: { status: 'payment_in_progress' } },
        { ...REFUND_FAILED_ROW, id: SECOND_EXCEPTION_ID, order_id: null, orders: null },
      ];
      mockRefundableAmount(10_000);

      const exceptions = await listExceptions();

      expect(exceptions.map((row) => row.canRetryRefund)).toEqual([false, false]);
      expect(mockRpc).not.toHaveBeenCalledWith('list_order_refund_summaries', expect.anything());
    });

    it('返せる額が読めなくても要対応は 200 のまま返し、「もう一度返金する」は出さない。ログは例外名と DB の記号だけ', async () => {
      exceptionRows = [REFUND_FAILED_ROW];
      mockRpc.mockImplementation(async (name: string) =>
        name === 'list_order_refund_summaries'
          ? { data: null, error: { code: '08006', message: '店のメモ・支払いの番号を含む例外' } }
          : { data: [{ paused: false, reason: null }], error: null },
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const exceptions = await listExceptions();

        expect(exceptions[0]).toMatchObject({ reason: 'refund_failed', canRetryRefund: false });
        expect(warn.mock.calls).toEqual([['[admin.order-attention] Failed to fetch refundable amounts', 'RefundStoreError', '08006']]);
      } finally {
        warn.mockRestore();
      }
    });

    describe('返金の記録（額・失敗の理由・確保し直せなかった商品）', () => {
      const RECORD_ID = 'f1b2c3d4-1111-2222-8333-444455556666';
      // PostgREST が返す形（order_refunds に order_refund_lines と order_items を埋め込んだ物）
      const REFUND_RECORD = {
        id: RECORD_ID,
        stripe_refund_id: 're_failed1',
        amount: 5_500,
        order_refund_lines: [
          { rereserve_shortage: 1, order_items: { item_name: 'シルクブラウス', color: '白', size: 'M' } },
          { rereserve_shortage: 0, order_items: { item_name: 'リネンパンツ', color: null, size: null } },
          { rereserve_shortage: 2, order_items: { item_name: 'ウールコート', color: null, size: null } },
        ],
      };

      it('返金の失敗の行は、返金の記録の額・失敗の理由の言葉・確保し直せなかった商品と数を持つ。お客様の個人情報の列は読まない', async () => {
        exceptionRows = [REFUND_FAILED_ROW];
        refundRecords = [REFUND_RECORD];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        // 確保し直せた商品（rereserve_shortage が 0）は出さない。名前は「商品名（色 / サイズ）」
        expect(exceptions[0].refundFailure).toEqual({
          amount: 5_500,
          failureReasonLabel: '口座の入力の期限が過ぎました',
          shortages: [
            { name: 'シルクブラウス（白 / M）', quantity: 1 },
            { name: 'ウールコート', quantity: 2 },
          ],
          returnId: null,
        });
        // Stripe の返金の番号は stripe_refund_id で探す
        expect(refundLookupCalls).toEqual([{ column: 'stripe_refund_id', values: ['re_failed1'] }]);
        const refundColumns = mockSelectColumns.filter((columns) => columns.includes('order_refund_lines')).join(',');
        expect(refundColumns).toContain('item_name');
        expect(refundColumns).toContain('return_id');
        expect(refundColumns).not.toMatch(/shipping_|email|phone|full_name|address/);
      });

      it('返品の返金（返金の記録が return_id を持つ）の失敗の行は返品の番号 returnId を持つ。ふつうの返金は null', async () => {
        const RETURN_ID = 'c0000000-0000-4000-8000-000000000001';
        exceptionRows = [
          REFUND_FAILED_ROW,
          { ...REFUND_FAILED_ROW, id: SECOND_EXCEPTION_ID, payment_ref: 're_failed2' },
        ];
        refundRecords = [
          { ...REFUND_RECORD, return_id: RETURN_ID },
          { id: 'a0000000-0000-4000-8000-000000000002', stripe_refund_id: 're_failed2', amount: 2_000, return_id: null, order_refund_lines: [] },
        ];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        expect(exceptions.map((row) => row.refundFailure.returnId)).toEqual([RETURN_ID, null]);
        // 「もう一度返金する」を出せるか（canRetryRefund）の決め方は、返品の返金でも変わらない。画面が returnId を見て、開く画面を選ぶ
        expect(exceptions.map((row) => row.canRetryRefund)).toEqual([true, true]);
      });

      it('支払いの番号が返金の記録の番号（Stripe の返事が来る前に失敗した返金）なら、記録の番号で探す', async () => {
        exceptionRows = [{ ...REFUND_FAILED_ROW, payment_ref: RECORD_ID, detail: 'declined' }];
        refundRecords = [{ ...REFUND_RECORD, stripe_refund_id: null }];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        expect(exceptions[0].refundFailure).toMatchObject({ amount: 5_500, failureReasonLabel: 'カード会社に断られました' });
        expect(refundLookupCalls).toEqual([{ column: 'id', values: [RECORD_ID] }]);
      });

      it('カード以外の返金の番号（pyr_ など、re_ 以外の形。本計画 P29）も Stripe の返金の番号として stripe_refund_id で探す', async () => {
        exceptionRows = [{ ...REFUND_FAILED_ROW, payment_ref: 'pyr_3AbCdEf123' }];
        refundRecords = [{ ...REFUND_RECORD, stripe_refund_id: 'pyr_3AbCdEf123' }];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        expect(exceptions[0].refundFailure).toMatchObject({ amount: 5_500, failureReasonLabel: '口座の入力の期限が過ぎました' });
        expect(refundLookupCalls).toEqual([{ column: 'stripe_refund_id', values: ['pyr_3AbCdEf123'] }]);
      });

      it('Stripe の返金の番号の行と記録の番号の行が混ざっても、それぞれ1回で読み、行ごとの額を返す', async () => {
        const OTHER_RECORD_ID = 'a0000000-0000-4000-8000-000000000001';
        exceptionRows = [
          REFUND_FAILED_ROW,
          { ...REFUND_FAILED_ROW, id: SECOND_EXCEPTION_ID, payment_ref: 're_failed2' },
          { ...REFUND_FAILED_ROW, id: 'd1b2c3d4-1111-2222-8333-444455556666', payment_ref: OTHER_RECORD_ID },
        ];
        refundRecords = [
          { id: RECORD_ID, stripe_refund_id: 're_failed1', amount: 1_000, order_refund_lines: [] },
          { id: 'a0000000-0000-4000-8000-000000000002', stripe_refund_id: 're_failed2', amount: 2_000, order_refund_lines: [] },
          { id: OTHER_RECORD_ID, stripe_refund_id: null, amount: 3_000, order_refund_lines: [] },
        ];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        expect(exceptions.map((row) => row.refundFailure.amount)).toEqual([1_000, 2_000, 3_000]);
        expect(refundLookupCalls).toEqual([
          { column: 'stripe_refund_id', values: ['re_failed1', 're_failed2'] },
          { column: 'id', values: [OTHER_RECORD_ID] },
        ]);
      });

      it('形の合わない支払いの番号（Stripe の返金の番号でも記録の番号でもない）は DB に渡さず、記録が無い物として扱う', async () => {
        // 本文に _ がある・種類が長すぎる・_ が無い（P29 の形 ^[a-z]{2,4}_[A-Za-z0-9]+$ に合わない）
        exceptionRows = [
          { ...REFUND_FAILED_ROW, payment_ref: 're_has_underscore' },
          { ...REFUND_FAILED_ROW, id: SECOND_EXCEPTION_ID, payment_ref: 'toolong_abc123' },
          { ...REFUND_FAILED_ROW, id: 'd1b2c3d4-1111-2222-8333-444455556666', payment_ref: 'not-a-uuid' },
        ];
        refundRecords = [REFUND_RECORD];
        mockRefundableAmount(10_000);

        const exceptions = await listExceptions();

        expect(exceptions.map((row) => row.refundFailure.amount)).toEqual([0, 0, 0]);
        expect(refundLookupCalls).toEqual([]);
      });

      it('返金の記録が見つからなければ、額は0・商品は空で、失敗の理由の言葉は出す', async () => {
        exceptionRows = [REFUND_FAILED_ROW];
        mockRefundableAmount(10_000);

        expect((await listExceptions())[0].refundFailure).toEqual({
          amount: 0, failureReasonLabel: '口座の入力の期限が過ぎました', shortages: [], returnId: null,
        });
      });

      it.each([
        ['表に無い記号', 'a_code_stripe_added_later'],
        ['空', null],
        // Object が持つ名前を、表の言葉として引かない
        ['Object が持つ名前', 'constructor'],
      ])('失敗の理由が%sなら「不明な理由」と出す', async (_name, detail) => {
        exceptionRows = [{ ...REFUND_FAILED_ROW, detail }];
        mockRefundableAmount(10_000);

        expect((await listExceptions())[0].refundFailure).toMatchObject({ failureReasonLabel: '不明な理由' });
      });

      it('返金の失敗でない行は refundFailure が null で、返金の記録を読まない', async () => {
        exceptionRows = [{ ...REFUND_FAILED_ROW, reason: 'unexpected_state', detail: null, orders: { status: 'payment_in_progress' } }];
        refundRecords = [REFUND_RECORD];
        mockRefundableAmount(10_000);

        expect((await listExceptions())[0].refundFailure).toBeNull();
        expect(refundLookupCalls).toEqual([]);
      });

      it('返金の記録が読めなくても要対応は 200 のまま返し、額は0・商品は空で返す。ログは例外名と DB の記号だけ', async () => {
        exceptionRows = [REFUND_FAILED_ROW];
        refundLookupError = { code: '42P01', message: '店のメモ・商品の名前を含む例外' };
        mockRefundableAmount(10_000);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const exceptions = await listExceptions();

          expect(exceptions[0]).toMatchObject({
            canRetryRefund: true,
            refundFailure: { amount: 0, failureReasonLabel: '口座の入力の期限が過ぎました', shortages: [] },
          });
          expect(warn.mock.calls).toEqual([['[admin.order-attention] Failed to fetch refund records', 'UnknownError', '42P01']]);
          expect(JSON.stringify(warn.mock.calls)).not.toContain('メモ');
        } finally {
          warn.mockRestore();
        }
      });
    });
  });
});

describe('POST /api/admin/orders/:id/review', () => {
  it('確認済みにし、実行者を渡す', async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    const res = await review();

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('mark_order_reviewed', { _order_id: ORDER_ID, _actor_id: 'admin-1' });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.orders.review', actor_id: 'admin-1', outcome: 'success' }));
  });

  it('確認済みにできる要確認が無ければ 409', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });

    expect((await review()).status).toBe(409);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await review()).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('権限が無ければ CSRF を確かめず、認可の応答をそのまま返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    expect((await review()).status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('注文 ID の形が違えば 400', async () => {
    expect((await review('not-a-uuid')).status).toBe(400);
  });
});

describe('POST /api/admin/payment-exceptions/:id/resolve', () => {
  const IN_PROGRESS_ORDER = { id: ORDER_ID, status: 'payment_in_progress', checkout_session_id: 'cs_1', payment_intent_id: null };
  const PENDING_ORDER = { id: ORDER_ID, status: 'pending', checkout_session_id: 'cs_2', payment_intent_id: 'pi_2' };
  const CANCEL_BODY = { cancelOrder: true, cancelReason: 'other', note: 'Stripe に支払いが無い' };
  const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

  function cancelResolved(cancelledFrom: 'payment_in_progress' | 'pending' = 'payment_in_progress') {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: ORDER_ID, cancelled_from: cancelledFrom }], error: null });
  }

  it('メモを付けて解決済みにする', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: null, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'Stripe で返金済み' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, orderCancelled: false });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', {
      _exception_id: EXCEPTION_ID,
      _actor_id: 'admin-1',
      _note: 'Stripe で返金済み',
      _cancel_order: false,
      _cancel_reason: null,
      _notify_customer: null,
    });
    // 取り消さない解決は、注文も Stripe も読まず、メールの送信も予約しない
    expect(mockSelectColumns).toHaveLength(0);
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
  });

  it.each([{}, { note: '' }, { note: '   ' }])('RPC がメモ必須を返したら400と指定の案内を返す（%j）', async (body) => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockRpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'RPC: RESOLUTION_NOTE_REQUIRED' } });

      const res = await resolve(body);

      expect(res).toEqual({
        status: 400,
        body: { error: '返金の失敗を解決するときは、確かめた内容をメモに入力してください。' },
      });
      expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _note: null, _cancel_order: false }));
      expect(mockSelectColumns).toHaveLength(0);
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
      expect(mockScheduleOrderEmailDelivery).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each([{}, { note: '   ' }, { note: 'あ'.repeat(500) }])('RPC が許可する非取消の解決は追加の読み取りをせず成功する（ケース%#）', async (body) => {
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: null, cancelled_from: null }], error: null });

    const res = await resolve(body);

    expect(res).toEqual({ status: 200, body: { success: true, orderCancelled: false } });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _note: body.note?.trim() || null }));
    expect(mockSelectColumns).toHaveLength(0);
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
  });

  it('別の管理者が先に解決していたら 409(二重に取り消さない)', async () => {
    mockRpc.mockResolvedValue({ data: [{ resolved: false, order_id: ORDER_ID, cancelled_from: null }], error: null });

    const res = await resolve({ note: 'メモ' });

    expect(res.status).toBe(409);
  });

  it('「注文を取り消して解決」は理由とメモが要る', async () => {
    expect((await resolve({ cancelOrder: true, note: 'メモ' })).status).toBe(400);
    expect((await resolve({ cancelOrder: true, cancelReason: 'other' })).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(['payment_declined', 'shop_error'])('要対応の取消は新理由 %s をRPCへ渡す', async (cancelReason) => {
    attachedOrder = IN_PROGRESS_ORDER;
    cancelResolved();
    const res = await resolve({ cancelOrder: true, cancelReason, note: '確認済み' });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _cancel_reason: cancelReason }));
  });

  it('知らない取消理由は400でRPCを呼ばない', async () => {
    expect((await resolve({ cancelOrder: true, cancelReason: 'unknown_reason', note: '確認済み' })).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([true, false])('注文を取り消して解決するとき、取消のお知らせを送るか（notifyCustomer=%s）を DB に渡し、メールの送信を1回予約する', async (notifyCustomer) => {
    attachedOrder = IN_PROGRESS_ORDER;
    mockRpc.mockResolvedValue({ data: [{ resolved: true, order_id: ORDER_ID, cancelled_from: 'payment_in_progress' }], error: null });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'Stripe に支払いが無い', notifyCustomer });

    expect(res.body).toEqual({ success: true, orderCancelled: true });
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({
      _cancel_order: true,
      _cancel_reason: 'other',
      _notify_customer: notifyCustomer,
    }));
    // 取消のメールの行は DB の関数が書く（知らせる時だけ）。知らせるかどうかにかかわらず、窓口は送信を1回予約する
    expect(mockScheduleOrderEmailDelivery).toHaveBeenCalledTimes(1);
  });

  it('取り消すときに notifyCustomer を送らなければ、取消のお知らせを送る指定（true）を DB に渡す', async () => {
    attachedOrder = IN_PROGRESS_ORDER;
    cancelResolved();

    const res = await resolve(CANCEL_BODY);

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _notify_customer: true }));
  });

  it('未入金でない注文は取り消せず 409（Stripe には触れず、RPC が断る）', async () => {
    attachedOrder = { ...IN_PROGRESS_ORDER, status: 'paid' };
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve({ cancelOrder: true, cancelReason: 'other', note: 'メモ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('未入金');
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
  });

  it('注文が付いていない要対応も、Stripe には触れず RPC に断らせる', async () => {
    attachedOrder = null;
    mockRpc.mockResolvedValue({ data: null, error: { message: 'ORDER_NOT_CANCELLABLE' } });

    const res = await resolve(CANCEL_BODY);

    expect(res.status).toBe(409);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
  });

  it('メモは500文字まで', async () => {
    expect((await resolve({ note: 'あ'.repeat(501) })).status).toBe(400);
  });

  it('CSRF トークンが合わなければ何もしない', async () => {
    mockRequireCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    expect((await resolve({ note: 'メモ' })).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('権限が無ければ CSRF を確かめず、認可の応答をそのまま返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, body: { error: 'Forbidden' } } });

    expect((await resolve({ note: 'メモ' })).status).toBe(403);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['壊れた JSON', '{"note": '],
    ['空の本文', ''],
    ['null', 'null'],
  ])('本文が %s なら 400 で、解決しない（解決は開き直せないので既定値で補わない）', async (_name, rawBody) => {
    const res = await resolveRawBody(rawBody);

    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  describe('注文を取り消して解決するときの Stripe の確認', () => {
    // Stripe を引く ID の付き方が違う注文
    const PI_ONLY_ORDER = { id: ORDER_ID, status: 'payment_in_progress', checkout_session_id: null, payment_intent_id: 'pi_1' };
    const NO_REF_ORDER = { id: ORDER_ID, status: 'pending', checkout_session_id: null, payment_intent_id: null };
    const PAID_STATE = { kind: 'paid', amountReceived: 1000, amountRefunded: 0, currency: 'jpy' };

    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    function stripeReads(state: Record<string, unknown>, voucherExpiresAt: Date | null = null) {
      mockReadCheckoutPayment.mockResolvedValue({ state, voucherExpiresAt });
    }

    it('決済画面を失効させ、Stripe を読み直してから、取り消して解決する', async () => {
      attachedOrder = IN_PROGRESS_ORDER;
      stripeReads({ kind: 'checkout_abandoned' });
      cancelResolved();

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, orderCancelled: true });
      expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, 'cs_1');
      expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, { checkoutSessionId: 'cs_1', paymentIntentId: null });
      const [expireOrder] = mockExpireOpenCheckoutSession.mock.invocationCallOrder;
      const [readOrder] = mockReadCheckoutPayment.mock.invocationCallOrder;
      const [rpcOrder] = mockRpc.mock.invocationCallOrder;
      expect(expireOrder).toBeLessThan(readOrder);
      expect(readOrder).toBeLessThan(rpcOrder);
    });

    it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
      ['支払い手続き中で、決済画面が 0 円で完了していた（失効は何もしない）', IN_PROGRESS_ORDER, 'not_open', { kind: 'zero_amount_complete' }],
      ['支払い手続き中で、決済画面が放棄になっていた', IN_PROGRESS_ORDER, 'expired', { kind: 'checkout_abandoned' }],
      ['支払い手続き中で、Stripe に決済画面が無い', IN_PROGRESS_ORDER, 'missing', { kind: 'missing' }],
      ['入金待ちで、決済画面がまだ開いていた（失効させたので放棄と読める）', PENDING_ORDER, 'expired', { kind: 'checkout_abandoned' }],
      ['入金待ちで、払込票の期限が切れていた', PENDING_ORDER, 'not_open', { kind: 'voucher_expired' }],
      ['入金待ちで、Stripe の状態が想定外だった', PENDING_ORDER, 'not_open', { kind: 'not_applicable', reason: 'unexpected' }],
      ['入金待ちで、Stripe に決済画面が無い', PENDING_ORDER, 'missing', { kind: 'missing' }],
    ])('%s なら、取り消して解決する', async (_name, order, expireOutcome, state) => {
      attachedOrder = order;
      mockExpireOpenCheckoutSession.mockResolvedValue(expireOutcome);
      stripeReads(state);
      cancelResolved(order.status as 'payment_in_progress' | 'pending');

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, orderCancelled: true });
      expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(mockStripe, order.checkout_session_id);
      expect(mockRpc).toHaveBeenCalledWith('resolve_payment_exception', expect.objectContaining({ _cancel_order: true }));
    });

    it.each<[string, Record<string, unknown>]>([
      ['支払い手続き中', IN_PROGRESS_ORDER],
      ['入金待ち', PENDING_ORDER],
    ])('%s の注文でも、Stripe が支払い済みなら 409 で取り消さない', async (_name, order) => {
      attachedOrder = order;
      mockExpireOpenCheckoutSession.mockResolvedValue('not_open');
      stripeReads(PAID_STATE);

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('支払い済み');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin.payment_exceptions.resolve',
        outcome: 'conflict',
        resource_id: EXCEPTION_ID,
      }));
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>, Date | null, string | null]>([
      ['入金待ちで払込票が有効', PENDING_ORDER, { kind: 'awaiting_payment' }, new Date(FAR_FUTURE), FAR_FUTURE],
      ['入金待ちで状態を分類できなくても払込期限がまだ先', PENDING_ORDER, { kind: 'not_applicable', reason: 'unexpected' }, new Date(FAR_FUTURE), FAR_FUTURE],
      ['入金待ちで払込期限が読めなくても Stripe が支払いを待っている', PENDING_ORDER, { kind: 'awaiting_payment' }, null, null],
      ['支払い手続き中でも払込票が発行されている', IN_PROGRESS_ORDER, { kind: 'awaiting_payment' }, new Date(FAR_FUTURE), FAR_FUTURE],
    ])('%s なら 409 と払込期限を返し、取り消さない', async (_name, order, state, voucherExpiresAt, cancelBlockedUntil) => {
      attachedOrder = order;
      mockExpireOpenCheckoutSession.mockResolvedValue('not_open');
      stripeReads(state, voucherExpiresAt);

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(409);
      expect(res.body.cancelBlockedUntil).toBe(cancelBlockedUntil);
      expect(res.body.error).toContain('払込期限');
      expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'conflict',
        metadata: { order_id: ORDER_ID, voucher_expires_at: cancelBlockedUntil },
      }));
    });

    it('Session ID が無く PaymentIntent ID だけの注文は、失効を飛ばして PaymentIntent で読み、決済が進行中なら 409 で取り消さない', async () => {
      attachedOrder = PI_ONLY_ORDER;
      stripeReads({ kind: 'in_progress' });

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('進行中');
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReadCheckoutPayment).toHaveBeenCalledWith(mockStripe, { checkoutSessionId: null, paymentIntentId: 'pi_1' });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('Session ID が無く PaymentIntent ID だけの注文で、決済画面が放棄になっていれば、取り消して解決する', async () => {
      attachedOrder = PI_ONLY_ORDER;
      stripeReads({ kind: 'checkout_abandoned' });
      cancelResolved();

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(200);
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it('Stripe を引ける ID が無い注文は、Stripe を読まずに取り消して解決する', async () => {
      attachedOrder = NO_REF_ORDER;
      cancelResolved('pending');

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(200);
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it('解決済みの要対応は、Stripe には触れず RPC に断らせる（決済画面を失効させない）', async () => {
      attachedOrder = IN_PROGRESS_ORDER;
      attachedResolvedAt = '2026-09-27T03:00:00.000Z';
      mockRpc.mockResolvedValue({ data: [{ resolved: false, order_id: ORDER_ID, cancelled_from: null }], error: null });

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(409);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    });

    it('存在しない要対応も、Stripe には触れず RPC に断らせる', async () => {
      attachedExists = false;
      mockRpc.mockResolvedValue({ data: [{ resolved: false, order_id: null, cancelled_from: null }], error: null });

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(409);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
    });

    it('失効が一時的な Stripe の失敗なら 503 で「時間をおいて再試行」を返し、段階を監査に残して、取り消さない', async () => {
      attachedOrder = IN_PROGRESS_ORDER;
      mockExpireOpenCheckoutSession.mockRejectedValue({ type: 'StripeConnectionError' });

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('時間をおいて再試行');
      expect(mockReadCheckoutPayment).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        metadata: { order_id: ORDER_ID, step: 'expire' },
      }));
    });

    it('読み直しが一時的な Stripe の失敗なら 503 で「時間をおいて再試行」を返し、段階を監査に残して、取り消さない', async () => {
      attachedOrder = PENDING_ORDER;
      mockReadCheckoutPayment.mockRejectedValue(new ReconcileTransientError('stripe_unavailable'));

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('時間をおいて再試行');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        metadata: { order_id: ORDER_ID, step: 'read' },
      }));
    });

    it('失効が一時的でない失敗なら 500 で中立な文言を返し、段階を監査に残して、取り消さない', async () => {
      attachedOrder = IN_PROGRESS_ORDER;
      mockExpireOpenCheckoutSession.mockRejectedValue({ type: 'StripeInvalidRequestError', statusCode: 400 });

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('未入金の注文を取り消せませんでした。');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        metadata: { order_id: ORDER_ID, step: 'expire' },
      }));
    });

    it('読み直しが一時的でない失敗なら 500 で中立な文言を返し、段階を監査に残して、取り消さない', async () => {
      attachedOrder = PENDING_ORDER;
      mockReadCheckoutPayment.mockRejectedValue(new Error('unexpected'));

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('未入金の注文を取り消せませんでした。');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error',
        metadata: { order_id: ORDER_ID, step: 'read' },
      }));
    });

    it('付いている注文を読めなければ 500 で、取り消さない', async () => {
      attachedOrderError = { code: 'XX000', message: 'connection lost' };

      const res = await resolve(CANCEL_BODY);

      expect(res.status).toBe(500);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    });
  });
});
