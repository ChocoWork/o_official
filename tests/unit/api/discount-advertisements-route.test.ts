/** @jest-environment node */
import { NextRequest } from 'next/server';
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') (Response as unknown as { json: unknown }).json = (b: unknown, i?: ResponseInit) => new Response(JSON.stringify(b), i);
jest.mock('server-only', () => ({}), { virtual: true });
const mockBuyer = jest.fn();
jest.mock('@/features/checkout/services/checkout-buyer', () => ({ ...jest.requireActual('@/features/checkout/services/checkout-buyer'), resolveCheckoutBuyer: (...args: unknown[]) => mockBuyer(...args) }));
const mockLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockLimit(...args) }));
const mockList = jest.fn();
jest.mock('@/lib/discounts/discount-preview-store', () => ({ listDiscountAdvertisements: (...args: unknown[]) => mockList(...args) }));
const mockItem = jest.fn();
const mockClient = { from: jest.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => mockItem() }) }) })) };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => mockClient }));
import { GET } from '@/app/api/discounts/advertisements/route';

const request = (query = 'itemId=7', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/discounts/advertisements${query ? `?${query}` : ''}`, { headers });

beforeEach(() => {
  jest.clearAllMocks();
  mockBuyer.mockResolvedValue({ kind: 'guest' });
  mockLimit.mockResolvedValue(null);
  mockItem.mockResolvedValue({ data: { id: 7, status: 'published' }, error: null });
  mockList.mockResolvedValue([{ discountId: 'd1', text: '春の割引' }]);
});

test('FREQ-550-AC-03: 回数制限は呼び出し元IPだけで60回/600秒、itemIdの検証より前に数える', async () => {
  await GET(request('itemId=abc', { 'x-forwarded-for': '203.0.113.9' }));
  expect(mockLimit).toHaveBeenCalledTimes(1);
  expect(mockLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'discounts:advertisements', limit: 60, windowSeconds: 600 }));
  expect(mockLimit.mock.calls[0][0]).not.toHaveProperty('subject');
});

test('FREQ-550-AC-03: 制限に達したら429をそのまま返しno-storeにして何も読まない', async () => {
  const limited = new Response('{"error":"rate"}', { status: 429, headers: { 'Retry-After': '600' } });
  mockLimit.mockResolvedValue(limited);

  const res = await GET(request());

  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('600');
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(mockBuyer).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
});

test.each(['', 'itemId=', 'itemId=0', 'itemId=-1', 'itemId=1.5', 'itemId=abc', 'itemId=1e3', 'itemId=9007199254740993', 'itemId=1&itemId=2'])(
  'FREQ-550-AC-03: itemIdが正整数でなければ400（%s）',
  async (query) => {
    const res = await GET(request(query));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(mockList).not.toHaveBeenCalled();
  },
);

test('FREQ-550-AC-03: ゲストには{rows}を200で返し、本人はguestとしてメールなしで渡す。応答はno-store', async () => {
  const res = await GET(request());

  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(await res.json()).toEqual({ rows: [{ discountId: 'd1', text: '春の割引' }] });
  expect(mockList).toHaveBeenCalledWith(mockClient, { kind: 'guest', normalizedEmail: null }, 7, expect.any(String));
});

test('FREQ-550-AC-03: 会員は検証済みuserIdで解決し、結果は共有cacheに載せない', async () => {
  mockBuyer.mockResolvedValue({ kind: 'member', userId: 'member-1', email: 'private@example.test' });

  const res = await GET(request());

  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(mockList).toHaveBeenCalledWith(mockClient, { kind: 'member', userId: 'member-1' }, 7, expect.any(String));
  expect(JSON.stringify(mockList.mock.calls)).not.toContain('private@example.test');
});

test('FREQ-550-AC-03: 非公開または存在しない商品は404で広告を読まない', async () => {
  for (const data of [{ id: 7, status: 'draft' }, null]) {
    mockItem.mockResolvedValue({ data, error: null });
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(mockList).not.toHaveBeenCalled();
});

test.each(['expired', 'unavailable'] as const)('FREQ-550-AC-03: ログインを確かめられない(%s)ときは共通の拒否をno-storeで返す', async (kind) => {
  mockBuyer.mockResolvedValue({ kind });
  const res = await GET(request());
  expect([401, 503]).toContain(res.status);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(mockList).not.toHaveBeenCalled();
});

test('FREQ-550-AC-03: 失敗は固定の500で、生のエラー文を返さずログにも出さない', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockList.mockRejectedValue(new Error('secret SPRING10 buyer@example.test'));

  const res = await GET(request());

  expect(res.status).toBe(500);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(JSON.stringify(await res.json())).not.toContain('secret');
  expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|SPRING10|buyer@example/);
  spy.mockRestore();
});
