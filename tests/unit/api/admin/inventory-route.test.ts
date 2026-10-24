/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { GET } from '@/app/api/admin/inventory/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

const rpc = jest.fn();
const request = () => new Request('https://example.test/api/admin/inventory');
const dbRow = {
  variant_id: 11, item_id: 7, item_name: 'シャツ', color_name: 'BLACK', size_label: 'M', is_active: true,
  free: 0, paid_allocated: 2, payment_held: 0, on_hand: 2, order_quantity: 5, on_order: 1, required: 2,
};
const apiRow = {
  variantId: 11, itemId: 7, itemName: 'シャツ', colorName: 'BLACK', sizeLabel: 'M', isActive: true,
  free: 0, paidAllocated: 2, paymentHeld: 0, onHand: 2, orderQuantity: 5, onOrder: 1, required: 2,
};

/** 持っている権限の組から認可の答えを作る（本物の authorizeAdminPermission と同じに、必要な権限が無ければ 403） */
function grantOnly(...held: string[]) {
  (authorizeAdminPermission as jest.Mock).mockImplementation(async (required: string) =>
    held.includes(required)
      ? { ok: true, userId: 'authorized-actor', role: 'supporter' }
      : { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: required }), { status: 403 }) });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: [dbRow], error: null });
});
afterEach(() => jest.restoreAllMocks());

test('FREQ-525-AC-01: 200 で行を返し、no-store。認可は admin.stock.read、RPC は実行者つきで1回だけ', async () => {
  const req = request();
  const response = await GET(req);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ rows: [apiRow] });
  expect(authorizeAdminPermission).toHaveBeenCalledTimes(1);
  expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.stock.read', req);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('list_admin_inventory', { _actor_id: 'authorized-actor' });
});

test('FREQ-525-AC-02: 読むだけ。variant を作る backfill_item_variants を呼ばない', async () => {
  await GET(request());
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['list_admin_inventory']);
});

test('FREQ-540-AC-07: admin.stock.read だけを持つ人は 200', async () => {
  grantOnly('admin.stock.read');
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(rpc).toHaveBeenCalledTimes(1);
});

test.each([
  ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage']],
  ['admin.stock.manage だけ', ['admin.stock.manage']],
  ['何も無い', []],
])('FREQ-540-AC-07: %s の人は 403 で no-store、RPC は呼ばない', async (_name, held) => {
  grantOnly(...held);
  const response = await GET(request());
  expect(response.status).toBe(403);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'Forbidden', permission: 'admin.stock.read' });
  expect(rpc).not.toHaveBeenCalled();
  expect(createServiceRoleClient).not.toHaveBeenCalled();
});

test.each([
  [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden' }],
  [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store、RPC は呼ばない', async (status, body) => {
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({
    ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }),
  });
  const response = await GET(request());
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('retry-after')).toBe('30');
  expect(rpc).not.toHaveBeenCalled();
});

test('FREQ-540-AC-07: DB が GROUP_G_FORBIDDEN / 42501 で断ったら 403 の固定の文（生の文は返さない）', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
  const response = await GET(request());
  const text = await response.text();
  expect(response.status).toBe(403);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(JSON.parse(text)).toEqual({ error: '在庫一覧を見る権限がありません。', code: 'GROUP_G_FORBIDDEN' });
  expect(text).not.toContain('PRIVATE-MARKER');
});

test.each(['rpc', 'malformed', 'client'] as const)(
  'FREQ-525-AC-01: 内部の失敗(%s)は固定の500。DB の生の誤りを本文にもログにも出さない',
  async (source) => {
    if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '57014', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    if (source === 'malformed') rpc.mockResolvedValue({ data: [{ ...dbRow, on_hand: 99 }], error: null });
    if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
    const response = await GET(request());
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({ error: '在庫一覧を読み込めませんでした。' });
    expect(text).not.toContain('PRIVATE-MARKER');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('[admin.inventory] operation failed');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('PRIVATE-MARKER');
  },
);
