import { NextRequest, NextResponse } from 'next/server';
import { POST } from '@/app/api/cart/add/route';
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
const addedLine = {
  key: 'line-1', id: 1201, variant_id: 1201, product_id: 45, quantity: 2,
  title: 'リネンシャツ - ブラック / M', product_title: 'リネンシャツ', variant_title: 'ブラック / M',
  options_with_values: [{ name: 'カラー', value: 'ブラック' }, { name: 'サイズ', value: 'M' }],
  price: 12000, line_price: 24000, image: 'items/45.png?signed', url: '/item/45', fulfillment: 'stock',
};
const otherLine = { ...addedLine, key: 'line-2', id: 1300, variant_id: 1300, quantity: 1, line_price: 12000 };

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/cart/add', () => {
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
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    (buildCartJson as jest.Mock).mockResolvedValue({
      item_count: 3, currency: 'JPY', items_subtotal_price: 36000, total_price: 36000,
      items: [otherLine, addedLine],
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('IP の制限が 429 なら持ち主を決めず、その応答を返す', async () => {
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(denied);
    const req = post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] });

    expect(await POST(req)).toBe(denied);
    expect(enforceRateLimit).toHaveBeenCalledWith({ request: req, endpoint: 'cart:add', limit: 60, windowSeconds: 60 });
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(denyIfCsrfInvalid).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test('CSRF の確認が 403 ならその応答を返す', async () => {
    const denied = NextResponse.json({ error: 'CSRF token invalid' }, { status: 403 });
    (denyIfCsrfInvalid as jest.Mock).mockResolvedValueOnce(denied);

    expect(await POST(post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }))).toBe(denied);
    expect(openShoppingContext).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('持ち主ごとの制限は subject と 30 回・60 秒を使う', async () => {
    const req = post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] });
    const denied = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    (enforceRateLimit as jest.Mock).mockResolvedValueOnce(undefined).mockResolvedValueOnce(denied);

    expect(await POST(req)).toBe(denied);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: req, endpoint: 'cart:add', limit: 30, windowSeconds: 60, subject: context.rateLimitSubject,
    });
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('印の無いゲストには持ち主ごとの制限を呼ばない', async () => {
    context.rateLimitSubject = null;

    const res = await POST(post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }));

    expect(res.status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['空の配列', { items: [] }],
    ['数量0', { items: [{ id: 1, quantity: 0 }] }],
    ['文字列の番号', { items: [{ id: '1', quantity: 1 }] }],
    ['11件', { items: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, quantity: 1 })) }],
    ['壊れた JSON', '{'],
    ['数量21', { items: [{ id: 1, quantity: 21 }] }],
    ['余分な項目', { items: [{ id: 1, quantity: 1, color: 'ブラック' }] }],
  ])('%s は 400 にして DB を呼ばない', async (_name, body) => {
    const res = await POST(post('/api/cart/add', body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: 400, message: 'Cart Error', description: '送った内容を確認できませんでした。' });
    expect(context.ensureOwnerId).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(buildCartJson).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test('持ち主の行を確保してから RPC を呼び、足したバリアントの明細だけを返す', async () => {
    const req = post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] });
    const res = await POST(req);

    expect(openShoppingContext).toHaveBeenCalledWith(req, 'cart', supabase, { write: true });
    expect(context.ensureOwnerId).toHaveBeenCalledTimes(1);
    expect(context.ensureOwnerId.mock.invocationCallOrder[0]).toBeLessThan(supabase.rpc.mock.invocationCallOrder[0]);
    expect(supabase.rpc).toHaveBeenCalledWith('cart_add_lines', {
      _cart_id: 'cart-1', _lines: [{ variant_id: 1201, quantity: 1 }],
    });
    expect(buildCartJson).toHaveBeenCalledWith(supabase, 'cart-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [addedLine] });
    expect(context.finish).toHaveBeenCalledWith(res);
  });

  test.each([
    ['CART_LINE_QUANTITY_LIMIT', 422, '1つの商品は20個までです。'],
    ['CART_LINE_LIMIT', 422, 'カートに入れられるのは50種類までです。'],
    ['CART_VARIANT_UNAVAILABLE', 404, '選んだ色・サイズは現在お求めいただけません。'],
    ['CART_INVALID_INPUT', 400, '送った内容を確認できませんでした。'],
    ['unknown failure', 500, 'カートを更新できませんでした。時間をおいてもう一度お試しください。'],
  ])('RPC の %s は Shopify の形の %i を返す', async (message, status, description) => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message } });

    const res = await POST(post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ status, message: 'Cart Error', description });
    expect(buildCartJson).not.toHaveBeenCalled();
    expect(context.finish).toHaveBeenCalledWith(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cart.add', outcome: status === 500 ? 'error' : 'failure',
      metadata: { ...context.auditOwner, lines: [{ variant_id: 1201, quantity: 1 }] },
    }));
  });

  test('監査に持ち主の情報と lines を入れ、Cookie の印と完全なハッシュは入れない', async () => {
    const req = post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] });
    const token = 'private-guest-cookie-value';
    req.headers.set('cookie', `cart=${token}`);
    const res = await POST(req);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cart.add', outcome: 'success', resource: 'cart_lines',
      metadata: { ...context.auditOwner, lines: [{ variant_id: 1201, quantity: 1 }] },
    }));
    const audit = JSON.stringify((logAudit as jest.Mock).mock.calls);
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(context.owner.tokenHash);
    expect(audit).not.toContain('"guest_token_hash"');
    const response = await res.text();
    expect(response).not.toContain(token);
    expect(response).not.toContain(context.owner.tokenHash);
    expect(response).not.toContain('guest_token_hash');
  });

  test.each([
    ['success', null, 200],
    ['failure', { message: 'CART_LINE_QUANTITY_LIMIT' }, 422],
    ['error', { message: 'unknown failure' }, 500],
  ])('同じバリアントを2回含む送信でも、%s の監査の lines は送った組のまま残る', async (outcome, error, status) => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error });
    const mergedLine = { ...addedLine, quantity: 3, line_price: 36000 };
    (buildCartJson as jest.Mock).mockResolvedValueOnce({
      item_count: 4, currency: 'JPY', items_subtotal_price: 48000, total_price: 48000,
      items: [otherLine, mergedLine],
    });

    const res = await POST(post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }, { id: 1201, quantity: 2 }] }));

    expect(res.status).toBe(status);
    expect(supabase.rpc).toHaveBeenCalledWith('cart_add_lines', {
      _cart_id: 'cart-1', _lines: [{ variant_id: 1201, quantity: 1 }, { variant_id: 1201, quantity: 2 }],
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cart.add', outcome,
      metadata: { ...context.auditOwner, lines: [{ variant_id: 1201, quantity: 1 }, { variant_id: 1201, quantity: 2 }] },
    }));
    if (status === 200) {
      expect(await res.json()).toEqual({ items: [mergedLine] });
    } else {
      expect(buildCartJson).not.toHaveBeenCalled();
    }
  });

  test('途中でカートの組み立てが投げたら Global Constraints の文言で 500 を返す', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (buildCartJson as jest.Mock).mockRejectedValueOnce(new Error('DB unavailable'));

    const res = await POST(post('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }));

    expect(buildCartJson).toHaveBeenCalledWith(supabase, 'cart-1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500, message: 'Cart Error',
      description: 'カートを更新できませんでした。時間をおいてもう一度お試しください。',
    });
    expect(spy).toHaveBeenCalledWith('Cart add error:', expect.any(Error));
    spy.mockRestore();
  });
});
