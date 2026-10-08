/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockGuard = jest.fn();
jest.mock('@/features/checkout/services/checkout-route-guard', () => ({
  ...jest.requireActual('@/features/checkout/services/checkout-route-guard'),
  guardCheckoutPost: (...args: unknown[]) => mockGuard(...args),
}));

const mockResolveCheckoutBuyer = jest.fn();
jest.mock('@/features/checkout/services/checkout-buyer', () => ({
  ...jest.requireActual('@/features/checkout/services/checkout-buyer'),
  resolveCheckoutBuyer: (...args: unknown[]) => mockResolveCheckoutBuyer(...args),
}));

const mockRetrieve = jest.fn();
const mockGetStripeServerClient = jest.fn(() => ({ checkout: { sessions: { retrieve: mockRetrieve } } }));
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockGetStripeServerClient(),
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

const mockReconcileCheckoutSession = jest.fn();
const mockFindPaidCheckoutSession = jest.fn();
jest.mock('@/features/checkout/services/checkout-session-lifecycle.service', () => ({
  findPaidCheckoutSession: (...args: unknown[]) => mockFindPaidCheckoutSession(...args),
  reconcileCheckoutSession: (...args: unknown[]) => mockReconcileCheckoutSession(...args),
}));

const mockPreviewFulfillment = jest.fn();
jest.mock('@/features/checkout/services/checkout-fulfillment.service', () => ({
  previewFulfillment: (...args: unknown[]) => mockPreviewFulfillment(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

/** checkout_drafts への問い合わせ。maybeSingle は下書きの読み出し、await は新しい下書きの有無 */
let mockDraftResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockPaidDraftResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockNewerDraftResult: { data: unknown; error: unknown } = { data: [], error: null };
const mockDraftQueries: Array<Array<[string, unknown[]]>> = [];
function mockDraftsChain() {
  const calls: Array<[string, unknown[]]> = [];
  mockDraftQueries.push(calls);
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gt', 'not', 'neq', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(
    calls.some(([method, args]) => method === 'eq' && args[0] === 'checkout_session_id')
      ? mockPaidDraftResult : mockDraftResult,
  );
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(mockNewerDraftResult).then(resolve, reject);
  return chain;
}
const mockRpc = jest.fn();
const mockFrom = jest.fn(() => mockDraftsChain());
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => mockFrom(),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

import { POST } from '@/app/api/checkout/place-order/route';

const ITEMS = [
  {
    source_cart_line_id: 'cart-1',
    item_id: 1,
    item_name: 'シャツ',
    item_price: 5000,
    item_image_url: null,
    color: 'BLACK',
    size: 'M',
    quantity: 1,
    line_total: 5000,
  },
  {
    source_cart_line_id: 'cart-2',
    item_id: 2,
    item_name: 'パンツ',
    item_price: 8000,
    item_image_url: null,
    color: 'NAVY',
    size: 'L',
    quantity: 2,
    line_total: 16000,
  },
];

const DRAFT = {
  id: 'draft-1',
  session_id: 'sess-abc',
  checkout_session_id: 'cs_test_abc',
  buyer_user_id: null,
  created_at: '2026-10-08T01:00:00.000Z',
  items_snapshot: ITEMS,
};

function openSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_abc',
    status: 'open',
    payment_status: 'unpaid',
    livemode: false,
    expires_at: Math.floor(Date.now() / 1000) + 25 * 60,
    created: 1791000000,
    amount_total: 21000,
    currency: 'jpy',
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    payment_intent: null,
    metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    ...overrides,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/checkout/place-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { checkoutSessionId: 'cs_test_abc', inStockVariantIds: [11] };

describe('POST /api/checkout/place-order', () => {
  const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExpireOpenCheckoutSession.mockReset();
    mockReconcileCheckoutSession.mockReset();
    mockDraftQueries.length = 0;
    mockResolveCheckoutBuyer.mockReset().mockResolvedValue({ kind: 'guest' });
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    mockGuard.mockResolvedValue({
      ok: true,
      sessionId: 'sess-abc',
      clientIp: '203.0.113.5',
      userAgent: 'jest',
      finish: (response: NextResponse) => response,
    });
    mockRetrieve.mockResolvedValue(openSession());
    mockFindPaidCheckoutSession.mockResolvedValue(null);
    mockDraftResult = { data: DRAFT, error: null };
    mockPaidDraftResult = { data: { buyer_user_id: null }, error: null };
    mockNewerDraftResult = { data: [], error: null };
    mockRpc.mockResolvedValue({
      data: [{ order_id: 'order-1', order_status: 'payment_in_progress', created: true, rejection: null }],
      error: null,
    });
    mockExpireOpenCheckoutSession.mockResolvedValue('expired');
    mockReconcileCheckoutSession.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  });

  test('守りで断られたら、その応答を返す', async () => {
    const denied = new Response(null, { status: 429 });
    mockGuard.mockResolvedValue({ ok: false, response: denied });

    await expect(POST(makeRequest(VALID_BODY))).resolves.toBe(denied);
    expect(mockResolveCheckoutBuyer).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test.each([
    ['ゲスト', { kind: 'guest' }, null],
    ['別の会員', { kind: 'member', userId: 'member-b', email: 'member-b@example.com' }, 'member-b'],
    ['会員', { kind: 'member', userId: 'member-a', email: 'member-a@example.com' }, 'member-a'],
  ])('下書きの買い手と違う%sなら 409 login_changed、失効して ID だけを監査に残す', async (_label, buyer, buyerUserId) => {
    const draftBuyerUserId = buyerUserId === 'member-a' ? null : 'member-a';
    mockResolveCheckoutBuyer.mockResolvedValue(buyer);
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: draftBuyerUserId }, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。',
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFindPaidCheckoutSession).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.place_order', outcome: 'failure',
      metadata: {
        session_id: 'sess-abc', reason: 'login_changed', checkout_session_id: 'cs_test_abc',
        draft_id: 'draft-1', draft_buyer_user_id: draftBuyerUserId, buyer_user_id: buyerUserId,
      },
    }));
  });

  test.each(['complete', '残り10分未満', '別タブの支払い済み'])('買い手が違えば%sより先に login_changed を返す', async (state) => {
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    if (state === 'complete') mockRetrieve.mockResolvedValue(openSession({ status: 'complete', payment_status: 'paid' }));
    if (state === '残り10分未満') mockRetrieve.mockResolvedValue(openSession({ expires_at: Math.floor(Date.now() / 1000) + 9 * 60 }));
    if (state === '別タブの支払い済み') mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'login_changed' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFindPaidCheckoutSession).not.toHaveBeenCalled();
  });

  test('別タブの支払い済みの下書きがゲストで今は会員なら、payment_done や画面の ID を返さず login_changed', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: { buyer_user_id: null }, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。',
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_paid');
  });

  test.each(['member-a', undefined])('別タブの支払い済みの下書きの買い手が違う・無い（%s）なら login_changed', async (paidBuyer) => {
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: paidBuyer === undefined ? null : { buyer_user_id: paidBuyer }, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。',
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_paid');
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockDraftQueries).toContainEqual([
      ['select', ['buyer_user_id']], ['eq', ['checkout_session_id', 'cs_test_paid']],
    ]);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        session_id: 'sess-abc', reason: 'login_changed', checkout_session_id: 'cs_test_abc',
        draft_id: 'draft-1', draft_buyer_user_id: null, buyer_user_id: null,
        paid_checkout_session_id: 'cs_test_paid', paid_draft_found: paidBuyer !== undefined,
        ...(paidBuyer !== undefined ? { paid_draft_buyer_user_id: paidBuyer } : {}),
      },
    }));
  });

  test.each(['member-a', undefined])('別タブの支払い済みの照合が失敗しても、買い手が違う・無い（%s）なら 409 login_changed のまま', async (paidBuyer) => {
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: paidBuyer === undefined ? null : { buyer_user_id: paidBuyer }, error: null };
    const failure = new Error('照合失敗');
    mockReconcileCheckoutSession.mockImplementation(async (id: string) => {
      if (id === 'cs_test_paid') throw failure;
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await POST(makeRequest(VALID_BODY));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。',
      });
      expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_paid');
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure);
      expect(mockRpc).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test('別タブの監査では、今の下書き A と支払い済みの下書き B の買い手を分けて残す', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    mockPaidDraftResult = { data: { buyer_user_id: 'member-b' }, error: null };
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.place_order', outcome: 'failure',
      metadata: {
        session_id: 'sess-abc', reason: 'login_changed', checkout_session_id: 'cs_test_abc',
        draft_id: 'draft-1', draft_buyer_user_id: 'member-a', buyer_user_id: 'member-a',
        paid_checkout_session_id: 'cs_test_paid', paid_draft_found: true, paid_draft_buyer_user_id: 'member-b',
      },
    }));
  });

  test('別タブの支払い済みの画面も会員 A の下書きなら、会員 A に payment_done を返す', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    mockPaidDraftResult = { data: { buyer_user_id: 'member-a' }, error: null };
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'payment_done', checkoutSessionId: 'cs_test_paid' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test.each([null, 'member-a'])('同じ買い手（%s）なら受付 RPC に _buyer_user_id を渡す', async (buyerUserId) => {
    mockResolveCheckoutBuyer.mockResolvedValue(buyerUserId ? { kind: 'member', userId: buyerUserId, email: 'member-a@example.com' } : { kind: 'guest' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: buyerUserId }, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('place_order_from_checkout_draft', expect.objectContaining({ _buyer_user_id: buyerUserId }));
  });

  test('受付 RPC の login_changed は 409 として返し、決済の画面を閉じる', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    mockRpc.mockResolvedValue({ data: [{ order_id: null, order_status: null, created: false, rejection: 'login_changed' }], error: null });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。' });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.place_order', outcome: 'failure',
      metadata: {
        session_id: 'sess-abc', checkout_session_id: 'cs_test_abc', draft_id: 'draft-1',
        reason: 'login_changed', rpc_rejection: 'login_changed', draft_buyer_user_id: 'member-a', buyer_user_id: 'member-a',
      },
    }));
  });

  test.each([['expired', 401, 'auth_expired'], ['unavailable', 503, 'Service temporarily unavailable']])('認証が %s なら %s、本文・Stripe・DB に触れる前に守り付きで返す', async (kind, status, error) => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind });
    const finish = jest.fn((response: NextResponse) => response);
    mockGuard.mockResolvedValue({ ok: true, sessionId: 'sess-abc', finish });
    const request = makeRequest(VALID_BODY);
    const readBody = jest.spyOn(request, 'json');

    const res = await POST(request);

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ error });
    expect(mockResolveCheckoutBuyer).toHaveBeenCalledWith(request);
    expect(finish).toHaveBeenCalledWith(res);
    expect(readBody).not.toHaveBeenCalled();
    expect(mockGetStripeServerClient).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('下書きが無ければ会員でも買い手を比べず superseded を返す', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: null, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'superseded' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test.each([
    [{ checkoutSessionId: 'not-a-session', inStockVariantIds: [] }],
    [{ checkoutSessionId: 'cs_test_abc' }],
    [{ checkoutSessionId: 'cs_test_abc', inStockVariantIds: [0] }],
    [{ checkoutSessionId: 'cs_test_abc', inStockVariantIds: Array.from({ length: 101 }, (_, i) => i + 1) }],
    [{ checkoutSessionId: 'cs_test_abc', inStockVariantIds: [], amount: 1 }],
  ])('要求の形が違えば 400（%j）', async (body) => {
    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('ほかのお客様の決済の画面なら 403。受け付けない', async () => {
    mockRetrieve.mockResolvedValue(openSession({ metadata: { draft_id: 'draft-1', session_id: 'sess-other' } }));

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.place_order',
        outcome: 'failure',
        metadata: expect.objectContaining({ reason: 'not_owner' }),
      }),
    );
  });

  test('決済の画面のモードが鍵と合わなければ 500。受け付けない', async () => {
    mockRetrieve.mockResolvedValue(openSession({ livemode: true }));

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('もう支払いが済んでいれば 409 payment_done（画面は完了の処理へ進む）', async () => {
    mockRetrieve.mockResolvedValue(openSession({ status: 'complete', payment_status: 'paid' }));

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'payment_done', checkoutSessionId: 'cs_test_abc' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('別の支払い済みの画面があれば、受付 RPC を呼ばずにその ID を返す', async () => {
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'payment_done', checkoutSessionId: 'cs_test_paid' });
    expect(mockFindPaidCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: expect.anything(), stripe: expect.anything() }), 'sess-abc',
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_abc');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.place_order',
      outcome: 'failure',
      detail: 'Place order rejected',
      metadata: {
        session_id: 'sess-abc',
        reason: 'payment_done',
        checkout_session_id: 'cs_test_abc',
        draft_id: 'draft-1',
        paid_checkout_session_id: 'cs_test_paid',
      },
    }));
  });

  test('見つかった支払い済みの画面が同じ ID なら、今までどおり受け付ける', async () => {
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_abc');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalled();
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockReconcileCheckoutSession).not.toHaveBeenCalled();
  });

  test('cart_changed で断るときは、この画面を失効させて照合する', async () => {
    mockRpc.mockResolvedValue({
      data: [{ order_id: null, order_status: null, created: false, rejection: 'cart_changed' }],
      error: null,
    });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'cart_changed',
      message: 'カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。',
    });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_abc');
  });

  test.each([
    ['payment_done', 'expire'],
    ['payment_done', 'reconcile'],
    ['cart_changed', 'expire'],
    ['cart_changed', 'reconcile'],
    ['superseded', 'expire'],
    ['superseded', 'reconcile'],
  ])('%s で断るときに %s が失敗しても、ログに残して同じ 409 を返す', async (code, failureAt) => {
    if (code === 'payment_done') {
      mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    } else if (code === 'superseded') {
      mockNewerDraftResult = { data: [{ id: 'draft-2' }], error: null };
    } else {
      mockRpc.mockResolvedValue({
        data: [{ order_id: null, order_status: null, created: false, rejection: 'cart_changed' }],
        error: null,
      });
    }
    const failure = new Error(`${failureAt} failed`);
    if (failureAt === 'expire') {
      mockExpireOpenCheckoutSession.mockRejectedValueOnce(failure);
    } else {
      mockReconcileCheckoutSession.mockRejectedValueOnce(failure);
    }
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await POST(makeRequest(VALID_BODY));

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual(code === 'payment_done'
        ? { error: 'payment_done', checkoutSessionId: 'cs_test_paid' }
        : code === 'superseded'
          ? { error: 'superseded', message: '別の画面で手続きが進んでいます。画面を読み込み直してください' }
          : { error: 'cart_changed', message: 'カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。' });
      expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
      if (failureAt === 'expire') {
        expect(mockReconcileCheckoutSession).not.toHaveBeenCalled();
      } else {
        expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_abc');
      }
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  test.each(['payment_done', 'cart_changed', 'superseded'])('失効しなかったときは照合せず、409 %s を返す', async (code) => {
    if (code === 'payment_done') {
      mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    } else if (code === 'superseded') {
      mockNewerDraftResult = { data: [{ id: 'draft-2' }], error: null };
    } else {
      mockRpc.mockResolvedValue({
        data: [{ order_id: null, order_status: null, created: false, rejection: 'cart_changed' }],
        error: null,
      });
    }
    mockExpireOpenCheckoutSession.mockResolvedValueOnce('not_open');

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: code });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockReconcileCheckoutSession).not.toHaveBeenCalled();
  });

  test('後から別のタブで「確認へ進む」を押していれば、別の画面で進んでいると断る', async () => {
    mockNewerDraftResult = { data: [{ id: 'draft-2' }], error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'superseded',
      message: '別の画面で手続きが進んでいます。画面を読み込み直してください',
    });
    expect(mockDraftQueries[1]).toEqual([
      ['select', ['id']],
      ['eq', ['session_id', 'sess-abc']],
      ['gt', ['created_at', '2026-10-08T01:00:00.000Z']],
      ['not', ['checkout_session_id', 'is', null]],
      ['neq', ['checkout_session_id', 'cs_test_abc']],
      ['limit', [1]],
    ]);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test.each(['missing', 'different_checkout_session', 'different_cookie_session', 'newer', 'rpc'])('superseded（%s）で断るときは失効してから照合する', async (source) => {
    if (source === 'missing') mockDraftResult = { data: null, error: null };
    if (source === 'different_checkout_session') mockDraftResult = { data: { ...DRAFT, checkout_session_id: 'cs_test_other' }, error: null };
    if (source === 'different_cookie_session') mockDraftResult = { data: { ...DRAFT, session_id: 'sess-other' }, error: null };
    if (source === 'newer') mockNewerDraftResult = { data: [{ id: 'draft-2' }], error: null };
    if (source === 'rpc') mockRpc.mockResolvedValue({
      data: [{ order_id: null, order_status: null, created: false, rejection: 'draft_not_found' }], error: null,
    });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'superseded' });
    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'cs_test_abc');
    expect(mockReconcileCheckoutSession).toHaveBeenCalledWith('cs_test_abc');
    expect(mockExpireOpenCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(mockReconcileCheckoutSession.mock.invocationCallOrder[0]);
    if (source !== 'rpc') expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.place_order', outcome: 'failure',
      metadata: expect.objectContaining({ reason: 'superseded', checkout_session_id: 'cs_test_abc', draft_id: 'draft-1' }),
    }));
  });

  test('下書きが見つからない・結び付きが違えば、別の画面で進んでいると断る', async () => {
    mockDraftResult = { data: { ...DRAFT, checkout_session_id: 'cs_test_other' }, error: null };

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'superseded' });
  });

  test('決済の画面が失効していれば、時間切れとして断る', async () => {
    mockRetrieve.mockResolvedValue(openSession({ status: 'expired' }));

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'session_expired',
      message: '時間がたったため、お支払い情報をもう一度入力してください',
    });
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
  });

  test('残り10分未満なら失効も照合も呼ばず、時間切れとして断って監査ログを残す', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1791417600000);
    try {
      mockRetrieve.mockResolvedValue(openSession({ expires_at: Math.floor(Date.now() / 1000) + 9 * 60 }));

      const res = await POST(makeRequest(VALID_BODY));

      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(mockReconcileCheckoutSession).not.toHaveBeenCalled();
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: 'session_expired' });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'failure',
        metadata: expect.objectContaining({ reason: 'session_expired', draft_id: 'draft-1', remaining_seconds: 540 }),
      }));
    } finally {
      clock.mockRestore();
    }
  });

  test('受け付けたら、Stripe の金額と最終確認画面で在庫ありと見せたバリアントで受付 RPC を呼び、注文を返す', async () => {
    mockRetrieve.mockResolvedValue(
      openSession({ amount_total: 19000, total_details: { amount_discount: 2000, amount_shipping: 0, amount_tax: 0 } }),
    );

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc', inStockVariantIds: [11, 22] }));

    expect(mockRpc).toHaveBeenCalledWith('place_order_from_checkout_draft', {
      _draft_id: 'draft-1',
      _checkout_session_id: 'cs_test_abc',
      _cart_session_id: 'sess-abc',
      _stripe_amount_total: 19000,
      _stripe_amount_discount: 2000,
      _stripe_currency: 'jpy',
      _checkout_session_created_at: new Date(1791000000 * 1000).toISOString(),
      _payment_intent_id: null,
      _shown_in_stock_variant_ids: [11, 22],
      _buyer_user_id: null,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ orderId: 'order-1', orderStatus: 'payment_in_progress' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.place_order',
        outcome: 'success',
        metadata: {
          session_id: 'sess-abc',
          checkout_session_id: 'cs_test_abc',
          draft_id: 'draft-1',
          order_id: 'order-1',
          created: true,
        },
      }),
    );
  });

  test('同じ決済の画面の2回目は同じ注文を返す（二度押し）', async () => {
    mockRpc.mockResolvedValue({
      data: [{ order_id: 'order-1', order_status: 'payment_in_progress', created: false, rejection: null }],
      error: null,
    });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ orderId: 'order-1', orderStatus: 'payment_in_progress' });
  });

  test('在庫ありと見せた明細が受注生産に変わっていれば、その明細だけを添えて断る', async () => {
    mockRpc.mockResolvedValue({
      data: [{ order_id: null, order_status: null, created: false, rejection: 'stock_changed' }],
      error: null,
    });
    mockPreviewFulfillment.mockResolvedValue([
      { lineNo: 1, itemId: 1, color: 'BLACK', size: 'M', quantity: 1, variantId: 11, fulfillment: 'stock' },
      { lineNo: 2, itemId: 2, color: 'NAVY', size: 'L', quantity: 2, variantId: 22, fulfillment: 'backorder' },
    ]);

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc', inStockVariantIds: [11, 22] }));

    expect(mockPreviewFulfillment).toHaveBeenCalledWith(expect.anything(), [
      { item_id: 1, color: 'BLACK', size: 'M', quantity: 1 },
      { item_id: 2, color: 'NAVY', size: 'L', quantity: 2 },
    ]);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'stock_changed',
      message: '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）',
      changedLines: [{ itemId: 2, name: 'パンツ', color: 'NAVY', size: 'L' }],
    });
  });

  test.each([
    ['item_unavailable', 'item_unavailable', 'ご注文いただけない商品が含まれています'],
    ['price_changed', 'price_changed', '商品の価格が変わりました。内容をご確認ください'],
    ['cart_changed', 'cart_changed', 'カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。'],
    ['amount_mismatch', 'price_changed', '商品の価格が変わりました。内容をご確認ください'],
    ['currency_mismatch', 'price_changed', '商品の価格が変わりました。内容をご確認ください'],
    ['zero_amount', 'zero_amount', 'このご注文は合計が0円になるため、お受けできません'],
    ['draft_not_found', 'superseded', '別の画面で手続きが進んでいます。画面を読み込み直してください'],
  ])('受付 RPC の %s は %s として案内する（決め事 D12）', async (rejection, error, message) => {
    mockRpc.mockResolvedValue({
      data: [{ order_id: null, order_status: null, created: false, rejection }],
      error: null,
    });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error, message });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        metadata: expect.objectContaining({ reason: error, rpc_rejection: rejection }),
      }),
    );
  });

  test('受付 RPC が失敗したら 500 で、時間をおいて試すよう案内する', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'place_order_failed',
      message: 'ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。',
    });
  });
});
