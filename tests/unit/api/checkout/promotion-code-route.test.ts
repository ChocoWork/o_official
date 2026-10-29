/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') (Response as unknown as { json: unknown }).json = (b: unknown, i?: ResponseInit) => new Response(JSON.stringify(b), i);
jest.mock('server-only', () => ({}), { virtual: true });
const mockGuard = jest.fn();
jest.mock('@/features/checkout/services/checkout-route-guard', () => ({ ...jest.requireActual('@/features/checkout/services/checkout-route-guard'), guardCheckoutPost: (...args: unknown[]) => mockGuard(...args) }));
const mockBuyer = jest.fn();
jest.mock('@/features/checkout/services/checkout-buyer', () => ({ ...jest.requireActual('@/features/checkout/services/checkout-buyer'), resolveCheckoutBuyer: (...args: unknown[]) => mockBuyer(...args) }));
const mockCart = jest.fn();
jest.mock('@/features/checkout/services/checkout-cart.service', () => ({ loadCheckoutCart: (...args: unknown[]) => mockCart(...args) }));
jest.mock('@/features/cart/services/shopping-context', () => ({ findCartIdForBuyer: jest.fn().mockResolvedValue('cart') }));
const mockEvaluate = jest.fn();
jest.mock('@/features/checkout/services/checkout-discounts.service', () => ({ evaluateCheckoutDiscounts: (...args: unknown[]) => mockEvaluate(...args) }));
const mockLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockLimit(...args) }));
const mockAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
import { POST } from '@/app/api/checkout/promotion-code/route';
import { definition, input, line, usage } from '../../lib/discounts/fixtures';
const result = { version: 1, subtotalAmount: 40000, shippingAmount: 0, discountAmount: 3000, totalAmount: 37000, applied: [], allocations: [], unitAmounts: [], unusedCodes: [], provisional: true, calculationMode: 'exact' };
const request = (body: unknown) => new NextRequest('http://localhost/api/checkout/promotion-code', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue({ ok: true, sessionId: 'session', clientIp: '203.0.113.1', userAgent: null, finish: (r: NextResponse) => r });
  mockBuyer.mockResolvedValue({ kind: 'guest' });
  mockCart.mockResolvedValue({ kind: 'ok', cartRows: [{ id: 'line', item_id: 1, quantity: 2 }], itemMap: new Map([[1, { price: 20000 }]]) });
  mockEvaluate.mockReset().mockResolvedValue({ result, facts: { usage: [] }, refusals: [] });
  mockLimit.mockReset().mockResolvedValue(null);
});

test('FREQ-548-AC-01: 未ログインの使えないコードは全理由が同じ文と理由で存在を区別できない', async () => {
  for (const reason of ['not_found','not_eligible','expired','usage_limit','minimum_amount','zero_total']) {
    mockEvaluate.mockResolvedValue({ result, facts: { usage: [] }, refusals: [{ code: 'CODE', reason, minimumAmount: 10000 }] });
    const res = await POST(request({ codes: ['CODE'] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'promotion_code_invalid', refusals: [{ code: 'CODE', reason: 'not_eligible' }], message: 'このコードは使えません。会員の方はログインしてからお試しください。' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/CODE|minimumAmount|email/);
});

test('FREQ-548-AC-01: ゲストの見込みは別のメールでも同じ応答で注文の有無が分からない', async () => {
  const bodies: unknown[] = [];
  for (const guestEmail of ['paid@example.test','none@example.test','expired@example.test',undefined]) {
    const res = await POST(request({ codes: [' code ', 'CODE'], ...(guestEmail ? { guestEmail } : {}) }));
    expect(res.status).toBe(200); bodies.push(await res.json());
  }
  expect(bodies).toEqual(Array(4).fill({ result }));
  for (const call of mockEvaluate.mock.calls) expect(call.slice(1)).toEqual([{ kind: 'guest', normalizedEmail: null }, [{ lineKey: 'line', itemId: 1, unitPrice: 20000, quantity: 2, lineKind: 'order' }], ['CODE'], expect.any(String), 'preview']);
  expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/CODE|@/);
});

test('FREQ-548-AC-01: 不在と期限切れと上限超過を混ぜても入力の両順でゲスト応答の全バイトが一致する', async () => {
  const bodies: string[] = [];
  for (const reason of ['not_found', 'expired', 'usage_limit'] as const) {
    mockEvaluate.mockImplementation(async (_client, buyer, lines, codes, at, phase) => {
      const d = definition('spring', { method: 'code', ...(reason === 'expired' ? { endsAt: '2026-10-28T00:00:00Z' } : { usageLimit: 1 }) });
      const facts = { ...input([], [line('line')]).facts, at, phase, buyer, hasPreviousOrder: null, hasFirstOrderReservation: null,
        usage: reason === 'not_found' ? [] : [usage(d, { buyerUses: null, confirmed: 1 })] };
      const rpc = jest.fn().mockResolvedValue({ data: { discounts: reason === 'not_found' ? [] : [d], facts,
        refusals: reason === 'not_found' ? [{ code: 'SPRING', reason }, { code: 'ZZZZZZ', reason }] : [{ code: 'ZZZZZZ', reason: 'not_found' }] }, error: null });
      return jest.requireActual('@/features/checkout/services/checkout-discounts.service').evaluateCheckoutDiscounts({ rpc }, buyer, lines, codes, at, phase);
    });
    for (const codes of [['spring', 'ZZZZZZ'], ['ZZZZZZ', 'spring']]) {
      const res = await POST(request({ codes }));
      expect(res.status).toBe(422);
      bodies.push(await res.text());
    }
  }
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0])).toEqual({ error: 'promotion_code_invalid', refusals: [{ code: 'SPRING', reason: 'not_eligible' }, { code: 'ZZZZZZ', reason: 'not_eligible' }], message: 'このコードは使えません。会員の方はログインしてからお試しください。' });
});

test('FREQ-548-AC-01: 会員制限は検証済みuserIdを使い履歴を読む前に拒否する', async () => {
  mockBuyer.mockResolvedValue({ kind: 'member', userId: 'member', email: 'hidden@example.test' });
  mockLimit.mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
  const res = await POST(request({ codes: [] }));
  expect(res.status).toBe(429); expect(res.headers.get('Retry-After')).toBe('60');
  expect(mockLimit).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'checkout:promotion-code:member', subject: 'member', limit: 10, windowSeconds: 60 }));
  expect(mockCart).not.toHaveBeenCalled(); expect(mockEvaluate).not.toHaveBeenCalled();
});

test.each([{ codes: ['A B'] }, { codes: [] , guestEmail: 'bad' }, { codes: [], unknown: 1 }, { code: 'OLD' }])('FREQ-548-AC-01: 不正形式は400で計算しない %j', async body => {
  expect((await POST(request(body))).status).toBe(400); expect(mockEvaluate).not.toHaveBeenCalled();
});

test.each([['expired',401],['unavailable',503]])('FREQ-548-AC-01: 認証%sは%sでカートを読まない', async (kind, status) => {
  mockBuyer.mockResolvedValue({ kind }); const res = await POST(request({ codes: [] })); expect(res.status).toBe(status); expect(mockCart).not.toHaveBeenCalled();
});

test('FREQ-548-AC-01: 守りと空カートと一時失敗を区別する', async () => {
  const denied = new Response(null, { status: 429 }); mockGuard.mockResolvedValueOnce({ ok: false, response: denied }); expect(await POST(request({ codes: [] }))).toBe(denied);
  mockCart.mockResolvedValueOnce({ kind: 'empty' }); expect((await POST(request({ codes: [] }))).status).toBe(400);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockEvaluate.mockRejectedValue(new Error('secret code/email')); const res = await POST(request({ codes: [] }));
  expect(res.status).toBe(500); expect(await res.json()).toMatchObject({ error: 'promotion_code_failed' }); expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('secret'); spy.mockRestore();
});

test('FREQ-546-AC-04: fallbackも200で返し記録失敗で拒否へ変えない', async () => {
  mockEvaluate.mockResolvedValue({ result: { ...result, calculationMode: 'fallback' }, facts: { usage: [] }, refusals: [] });
  const res = await POST(request({ codes: [] })); expect(res.status).toBe(200); expect(await res.json()).toEqual({ result: { ...result, calculationMode: 'fallback' } });
});
