import { NextRequest, NextResponse } from 'next/server';
import { POST } from '@/app/api/cart/change/route';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';

jest.mock('@/features/cart/services/shopping-context', () => ({
  openShoppingContext: jest.fn(),
  denyIfCsrfInvalid: jest.fn(),
}));
jest.mock('@/features/cart/services/cart-view', () => ({ buildCartJson: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

// 既存の Jest の Response は json() を持たないため、実際の NextResponse を使えるよう補う。
if (typeof Response.json !== 'function') {
  Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

const lineId = '6f1c2d3e-1234-4567-89ab-0123456789ab';
const supabase = { rpc: jest.fn() };
const context = {
  kind: 'cart',
  owner: { kind: 'guest', tokenHash: 'f'.repeat(64) },
  rateLimitSubject: `guest:${'f'.repeat(64)}` as string | null,
  auditOwner: { owner: 'guest', guest_hash_prefix: 'ffffffffffff' },
  findOwnerId: jest.fn(),
  ensureOwnerId: jest.fn(),
  finish: jest.fn((res: NextResponse) => res),
};
const emptyCart = { item_count: 0, currency: 'JPY', items_subtotal_price: 0, total_price: 0, items: [] };

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/cart/change', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    context.rateLimitSubject = `guest:${'f'.repeat(64)}`;
    context.findOwnerId.mockResolvedValue('cart-1');
    context.ensureOwnerId.mockResolvedValue('cart-1');
    context.finish.mockImplementation((res: NextResponse) => res);
    (createServiceRoleClient as jest.Mock).mockResolvedValue(supabase);
    (openShoppingContext as jest.Mock).mockResolvedValue({ ok: true, context });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValue(null);
    (enforceRateLimit as jest.Mock).mockResolvedValue(undefined);
    (logAudit as jest.Mock).mockResolvedValue(undefined);
    (buildCartJson as jest.Mock).mockResolvedValue(emptyCart);
    supabase.rpc.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['UUID でない番号', { id: 'not-uuid', quantity: 1 }],
    ['数量21', { id: lineId, quantity: 21 }],
    ['負の数量', { id: lineId, quantity: -1 }],
    ['壊れた JSON', '{'],
    ['余分な項目', { id: lineId, quantity: 1, cart_id: 'other-cart' }],
  ])('%s は 400 にして DB を呼ばない', async (_name, body) => {
    const res = await POST(post('/api/cart/change', body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: 400, message: 'Cart Error', description: '送った内容を確認できませんでした。' });
    expect(context.findOwnerId).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('持ち主の行が無ければ DB の関数を呼ばず 404 を返す', async () => {
    context.findOwnerId.mockResolvedValueOnce(null);

    const res = await POST(post('/api/cart/change', { id: lineId, quantity: 1 }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      status: 404, message: 'Cart Error',
      description: 'カートの商品が見つかりません。ページを読み込み直してください。',
    });
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(buildCartJson).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('数量0で RPC を呼び、カート全体を 200 で返す', async () => {
    const req = post('/api/cart/change', { id: lineId, quantity: 0 });
    const res = await POST(req);

    expect(openShoppingContext).toHaveBeenCalledWith(req, 'cart', supabase, { write: true });
    expect(supabase.rpc).toHaveBeenCalledWith('cart_change_line', {
      _cart_id: 'cart-1', _line_id: lineId, _quantity: 0,
    });
    expect(buildCartJson).toHaveBeenCalledWith(supabase, 'cart-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyCart);
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test.each([
    ['CART_LINE_NOT_FOUND', 404, 'カートの商品が見つかりません。ページを読み込み直してください。'],
    ['CART_LINE_QUANTITY_LIMIT', 422, '1つの商品は20個までです。'],
    ['unknown failure', 500, 'カートを更新できませんでした。時間をおいてもう一度お試しください。'],
  ])('RPC の %s は Shopify の形の %i を返す', async (message, status, description) => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message } });

    const res = await POST(post('/api/cart/change', { id: lineId, quantity: 1 }));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ status, message: 'Cart Error', description });
    expect(buildCartJson).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('IP は 120 回・60 秒、持ち主ごとは subject と 60 回・60 秒を使う', async () => {
    const req = post('/api/cart/change', { id: lineId, quantity: 0 });
    await POST(req);

    expect(enforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: req, endpoint: 'cart:change', limit: 120, windowSeconds: 60,
    });
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: req, endpoint: 'cart:change', limit: 60, windowSeconds: 60, subject: context.rateLimitSubject,
    });
  });

  test('IP の制限が 429 ならその応答を返し、持ち主を決めない', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(denied);

    expect(await POST(post('/api/cart/change', { id: lineId, quantity: 0 }))).toBe(denied);
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('CSRF の確認が 403 ならその応答を返す', async () => {
    const denied = NextResponse.json({ error: 'CSRF token invalid' }, { status: 403 });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValueOnce(denied);

    expect(await POST(post('/api/cart/change', { id: lineId, quantity: 0 }))).toBe(denied);
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('印の無いゲストには持ち主ごとの制限を呼ばない', async () => {
    context.rateLimitSubject = null;

    const res = await POST(post('/api/cart/change', { id: lineId, quantity: 0 }));

    expect(res.status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
  });

  test.each([0, 3])('数量%iへの変更の成功時に明細と持ち主と数量を監査へ残す', async (quantity) => {
    const req = post('/api/cart/change', { id: lineId, quantity });
    const token = 'private-guest-cookie-value';
    req.headers.set('cookie', `cart=${token}`);

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cart.change', outcome: 'success', resource: 'cart_lines', resource_id: lineId,
      metadata: { owner: 'guest', guest_hash_prefix: 'ffffffffffff', quantity },
    }));
    const audit = JSON.stringify((logAudit as jest.Mock).mock.calls);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(context.owner.tokenHash);
    expect(audit).not.toContain('guest_token_hash');
    const response = await res.text();
    expect(response).not.toContain(token);
    expect(response).not.toContain(context.owner.tokenHash);
    expect(response).not.toContain('guest_token_hash');
  });

  test('途中でカートの組み立てが投げたら Global Constraints の文言で 500 を返す', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (buildCartJson as jest.Mock).mockRejectedValueOnce(new Error('DB unavailable'));

    const res = await POST(post('/api/cart/change', { id: lineId, quantity: 1 }));

    expect(buildCartJson).toHaveBeenCalledWith(supabase, 'cart-1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500, message: 'Cart Error',
      description: 'カートを更新できませんでした。時間をおいてもう一度お試しください。',
    });
    expect(spy).toHaveBeenCalledWith('Cart change error:', expect.any(Error));
    spy.mockRestore();
  });
});
