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

const mockRetrieve = jest.fn();
const mockResolveCheckoutBuyer = jest.fn();
jest.mock('@/features/checkout/services/checkout-buyer', () => ({
  ...jest.requireActual('@/features/checkout/services/checkout-buyer'),
  resolveCheckoutBuyer: (...args: unknown[]) => mockResolveCheckoutBuyer(...args),
}));

const mockGetStripeServerClient = jest.fn(() => ({ checkout: { sessions: { retrieve: mockRetrieve } } }));
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: () => mockGetStripeServerClient(),
}));

const mockFindPaidCheckoutSession = jest.fn();
jest.mock('@/features/checkout/services/checkout-session-lifecycle.service', () => ({
  findPaidCheckoutSession: (...args: unknown[]) => mockFindPaidCheckoutSession(...args),
}));

const mockBuildCheckoutConfirmation = jest.fn();
jest.mock('@/features/checkout/services/checkout-confirmation.service', () => ({
  buildCheckoutConfirmation: (...args: unknown[]) => mockBuildCheckoutConfirmation(...args),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: async (_client: unknown, raw: string | null) => raw,
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

let mockDraftResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockPaidDraftResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockOrderResult: { data: unknown; error: unknown } = { data: null, error: null };
const mockDraftQueries: Array<Array<[string, unknown[]]>> = [];
const mockFrom = jest.fn((table: string) => {
  const calls: Array<[string, unknown[]]> = [];
  if (table === 'checkout_drafts') mockDraftQueries.push(calls);
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(table === 'orders' ? mockOrderResult
    : calls.some(([method, args]) => method === 'eq' && args[0] === 'checkout_session_id') ? mockPaidDraftResult : mockDraftResult);
  return chain;
});
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => mockFrom(table),
  }),
}));

import { POST } from '@/app/api/checkout/resume/route';

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
];
const SHIPPING = {
  email: 'a@example.com',
  fullName: '山田 花子',
  kanaName: 'ヤマダ ハナコ',
  postalCode: '1500001',
  prefecture: '東京都',
  city: '渋谷区',
  address: '神宮前1-1-1',
  building: null,
  phone: '0311112222',
};
const DRAFT = {
  id: 'draft-1',
  session_id: 'sess-abc',
  checkout_session_id: 'cs_test_abc',
  buyer_user_id: null,
  status: 'created',
  items_snapshot: ITEMS,
  shipping_snapshot: SHIPPING,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/checkout/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/checkout/resume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCheckoutBuyer.mockReset().mockResolvedValue({ kind: 'guest' });
    mockDraftQueries.length = 0;
    mockGuard.mockResolvedValue({
      ok: true,
      sessionId: 'sess-abc',
      clientIp: '203.0.113.5',
      userAgent: 'jest',
      finish: (response: NextResponse) => response,
    });
    mockFindPaidCheckoutSession.mockResolvedValue(null);
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc',
      status: 'open',
      client_secret: 'cs_test_abc_secret',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', promotion_code: 'WELCOME10' },
    });
    mockDraftResult = { data: DRAFT, error: null };
    mockPaidDraftResult = { data: { buyer_user_id: null }, error: null };
    mockOrderResult = { data: null, error: null };
    mockBuildCheckoutConfirmation.mockResolvedValue({ checkoutSessionId: 'cs_test_abc', clientSecret: 'x', shipping: SHIPPING, lines: [], promotionCode: 'WELCOME10' });
  });

  test.each([
    ['open', 'member-a', { kind: 'guest' }],
    ['complete', 'member-a', { kind: 'guest' }],
    ['open', 'member-a', { kind: 'member', userId: 'member-b', email: 'member-b@example.com' }],
    ['complete', 'member-a', { kind: 'member', userId: 'member-b', email: 'member-b@example.com' }],
    ['open', null, { kind: 'member', userId: 'member-a', email: 'member-a@example.com' }],
  ])('%s の下書きの買い手（%s）と今の買い手が違えば none を返す', async (status, draftBuyerUserId, buyer) => {
    mockResolveCheckoutBuyer.mockResolvedValue(buyer);
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: draftBuyerUserId }, error: null };
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc', status, client_secret: 'cs_test_abc_secret',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: 'none' });
    expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalledWith('orders');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('画面の ID が無く、支払い済みの下書きがゲストで今は会員なら、画面の ID を返さず none', async () => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: { buyer_user_id: null }, error: null };

    const res = await POST(makeRequest({}));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ state: 'none' });
    expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test.each(['member-a', undefined])('画面の指定が無く支払い済みの下書きの買い手が違う・無い（%s）なら none', async (paidBuyer) => {
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: paidBuyer === undefined ? null : { buyer_user_id: paidBuyer }, error: null };

    const res = await POST(makeRequest({}));

    await expect(res.json()).resolves.toEqual({ state: 'none' });
    expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test.each(['open', 'complete'])('画面の ID があり、%s の下書きと今の会員が同じなら続けられる', async (status) => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind: 'member', userId: 'member-a', email: 'member-a@example.com' });
    mockDraftResult = { data: { ...DRAFT, buyer_user_id: 'member-a' }, error: null };
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc', status, client_secret: 'cs_test_abc_secret',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    expect(res.status).toBe(200);
    if (status === 'complete') {
      await expect(res.json()).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_test_abc' });
      expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
    } else {
      await expect(res.json()).resolves.toEqual({
        state: 'resume',
        confirmation: { checkoutSessionId: 'cs_test_abc', clientSecret: 'x', shipping: SHIPPING, lines: [], promotionCode: 'WELCOME10' },
      });
      expect(mockBuildCheckoutConfirmation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        checkoutSessionId: 'cs_test_abc', clientSecret: 'cs_test_abc_secret', itemsSnapshot: ITEMS, shippingSnapshot: SHIPPING,
      }));
    }
  });

  test.each([null, 'member-a'])('画面の指定が無く支払い済みの買い手が同じ（%s）なら payment_done', async (buyerUserId) => {
    mockResolveCheckoutBuyer.mockResolvedValue(buyerUserId ? { kind: 'member', userId: buyerUserId, email: 'member-a@example.com' } : { kind: 'guest' });
    mockFindPaidCheckoutSession.mockResolvedValue('cs_test_paid');
    mockPaidDraftResult = { data: { buyer_user_id: buyerUserId }, error: null };

    const res = await POST(makeRequest({}));

    await expect(res.json()).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_test_paid' });
    expect(mockDraftQueries).toEqual([
      [['select', ['buyer_user_id']], ['eq', ['checkout_session_id', 'cs_test_paid']]],
    ]);
  });

  test.each([['expired', 401, 'auth_expired'], ['unavailable', 503, 'Service temporarily unavailable']])('認証が %s なら %s、本文・Stripe・DB に触れる前に守り付きで返す', async (kind, status, error) => {
    mockResolveCheckoutBuyer.mockResolvedValue({ kind });
    const finish = jest.fn((response: NextResponse) => response);
    mockGuard.mockResolvedValue({ ok: true, sessionId: 'sess-abc', finish });
    const request = makeRequest({});
    const readBody = jest.spyOn(request, 'json');

    const res = await POST(request);

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ error });
    expect(mockResolveCheckoutBuyer).toHaveBeenCalledWith(request);
    expect(finish).toHaveBeenCalledWith(res);
    expect(readBody).not.toHaveBeenCalled();
    expect(mockGetStripeServerClient).not.toHaveBeenCalled();
    expect(mockFindPaidCheckoutSession).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test.each(['open', 'complete'])('下書きが無い %s の画面は今までどおり扱う', async (status) => {
    mockDraftResult = { data: null, error: null };
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc', status, client_secret: 'cs_test_abc_secret',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    await expect(res.json()).resolves.toEqual(status === 'complete'
      ? { state: 'payment_done', checkoutSessionId: 'cs_test_abc' } : { state: 'none' });
  });

  test('決済の画面の指定が無ければ、支払いの済んだ画面を探す。あれば payment_done、無ければ none', async () => {
    mockFindPaidCheckoutSession.mockResolvedValueOnce('cs_test_paid').mockResolvedValueOnce(null);

    const paid = await POST(makeRequest({}));
    const none = await POST(makeRequest({}));

    expect(mockFindPaidCheckoutSession).toHaveBeenCalledWith(expect.anything(), 'sess-abc');
    await expect(paid.json()).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_test_paid' });
    await expect(none.json()).resolves.toEqual({ state: 'none' });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('ID の形が違えば 400', async () => {
    const res = await POST(makeRequest({ checkoutSessionId: 'nope' }));

    expect(res.status).toBe(400);
  });

  test('ほかのお客様の決済の画面なら 403', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc',
      status: 'open',
      client_secret: 'secret',
      metadata: { draft_id: 'draft-1', session_id: 'sess-other' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    expect(res.status).toBe(403);
    expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
  });

  test('支払いが済んでいれば payment_done', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    await expect(res.json()).resolves.toEqual({ state: 'payment_done', checkoutSessionId: 'cs_test_abc' });
  });

  test('失効していれば none（入力画面から）', async () => {
    mockRetrieve.mockResolvedValue({
      id: 'cs_test_abc',
      status: 'expired',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    await expect(res.json()).resolves.toEqual({ state: 'none' });
  });

  test('Stripe に無い決済の画面なら none', async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error('No such checkout session'), { code: 'resource_missing' }));

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    await expect(res.json()).resolves.toEqual({ state: 'none' });
  });

  test('開いていれば、下書きから最終確認画面の内容を作って返す（付けた割引コードは metadata から）', async () => {
    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    expect(mockBuildCheckoutConfirmation).toHaveBeenCalledWith(expect.objectContaining({ signImageUrl: expect.any(Function) }), {
      checkoutSessionId: 'cs_test_abc',
      clientSecret: 'cs_test_abc_secret',
      itemsSnapshot: ITEMS,
      shippingSnapshot: SHIPPING,
      promotionCode: 'WELCOME10',
      acceptedOrderId: null,
    });
    await expect(res.json()).resolves.toEqual({
      state: 'resume',
      confirmation: { checkoutSessionId: 'cs_test_abc', clientSecret: 'x', shipping: SHIPPING, lines: [], promotionCode: 'WELCOME10' },
    });
  });

  test('受け付け済みなら、その注文の明細で目安づけする', async () => {
    mockDraftResult = { data: { ...DRAFT, status: 'completed' }, error: null };
    mockOrderResult = { data: { id: 'order-1' }, error: null };

    await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));

    expect(mockBuildCheckoutConfirmation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acceptedOrderId: 'order-1' }),
    );
  });

  test('下書きが見つからない・結び付きが違う・退役していれば none', async () => {
    for (const draft of [null, { ...DRAFT, checkout_session_id: 'cs_test_other' }, { ...DRAFT, status: 'failed' }]) {
      mockDraftResult = { data: draft, error: null };
      const res = await POST(makeRequest({ checkoutSessionId: 'cs_test_abc' }));
      await expect(res.json()).resolves.toEqual({ state: 'none' });
    }
    expect(mockBuildCheckoutConfirmation).not.toHaveBeenCalled();
  });
});
