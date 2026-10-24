/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { inspect } from 'util';
import { GET } from '@/app/api/admin/purchase-orders/[id]/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { confirmedDetail, ORDER_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermission as jest.Mock;

async function get(id: string = ORDER_ID) {
  const request = new Request(`https://example.test/api/admin/purchase-orders/${id}`);
  const response = await GET(request, { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { request, response, status: response.status, text, json: text ? JSON.parse(text) : null };
}

/** 本物の authorizeAdminPermission と同じ規則の代役: 要る権限が無ければ 403 */
function grantOnly(...held: string[]) {
  authorize.mockImplementation(async (required: string) =>
    held.includes(required)
      ? { ok: true, userId: 'authorized-actor', role: 'supporter' }
      : { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: required }), { status: 403 }) });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: confirmedDetail(), error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/purchase-orders/[id]', () => {
  test('FREQ-526-AC-05: 200 で { purchaseOrder } を返し no-store。認可は admin.purchase_orders.read、RPC は発注書の id と認可結果の userId で1回だけ', async () => {
    const { request, response, json } = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ purchaseOrder: confirmedDetail() });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith('admin.purchase_orders.read', request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_admin_purchase_order', { _purchase_order_id: ORDER_ID, _actor_id: 'authorized-actor' });
  });

  test('FREQ-526-AC-05: 保存先の鍵など DB の余分な項目は応答に出さない', async () => {
    rpc.mockResolvedValue({ data: { ...confirmedDetail(), storage_path: 'PRIVATE-MARKER' }, error: null });
    const { text } = await get();
    expect(text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['abc', '123', 'not-a-uuid', '2222222222222222222222222222222222222', '22222222-2222-4222-8222-22222222222Z', '../orders'])(
    'FREQ-526-AC-05: id が uuid でない（%s）は400で no-store、RPC は呼ばない', async (id) => {
      const { response, status, json } = await get(id);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

  test('FREQ-526-AC-05: 発注書が無ければ404の { error: "発注書が見つかりません。" } で no-store', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const { response, status, json } = await get();
    expect(status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: '発注書が見つかりません。' });
  });

  test('FREQ-540-AC-07: admin.purchase_orders.read だけを持つ人は200（manage は要らない）', async () => {
    grantOnly('admin.purchase_orders.read');
    expect((await get()).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage']],
    ['admin.purchase_orders.manage だけ', ['admin.purchase_orders.manage']],
    ['admin.stock.read と admin.stock.manage だけ', ['admin.stock.read', 'admin.stock.manage']],
    ['何も無い', []],
  ])('FREQ-540-AC-07: %s の人は403（permission は admin.purchase_orders.read）で no-store。RPC は呼ばない', async (_name, held) => {
    grantOnly(...held);
    const { response, status, json } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Forbidden', permission: 'admin.purchase_orders.read' });
    expect(rpc).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store、RPC は呼ばない', async (status, body) => {
    authorize.mockResolvedValue({
      ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }),
    });
    const result = await get();
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: 認可が通らなければ、id が uuid でなくても400でなく認可の拒否を返す', async () => {
    grantOnly();
    expect((await get('abc')).status).toBe(403);
  });

  test('FREQ-540-AC-07: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の固定の文と code（生の文は返さない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const { response, status, json, text } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' });
    expect(text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['rpc', 'malformed', 'client'] as const)(
    'FREQ-526-AC-05: 内部の失敗(%s)は固定の500。DB の生の誤りを本文にもログにも出さない', async (source) => {
      if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '57014', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
      if (source === 'malformed') rpc.mockResolvedValue({ data: { ...confirmedDetail(), stage: 'PRIVATE-MARKER' }, error: null });
      if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
      const { response, status, json, text } = await get();
      expect(status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: '発注書を読み込めませんでした。' });
      expect(text).not.toContain('PRIVATE-MARKER');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('[admin.purchase_orders] detail failed');
      expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    });
});
