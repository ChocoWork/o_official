/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));

import { inspect } from 'util';
import { GET } from '@/app/api/admin/shipment-slips/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { dbSlipListRow, slipListRow } from '../../lib/orders/shipment-slips/shipment-slip-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

async function get(query = '') {
  const request = new Request(`https://example.test/api/admin/shipment-slips${query}`);
  const response = await GET(request);
  const text = await response.text();
  return { request, response, status: response.status, text, json: text ? JSON.parse(text) : null };
}

/** 本物の authorizeAdminPermissions と同じ規則の代役: 要る権限を全部持つ時だけ通し、足りない最初の権限を 403 に入れる */
function useAcl(granted: readonly string[]) {
  authorize.mockImplementation(async (required: readonly string[]) => {
    const missing = required.find((code) => !granted.includes(code));
    return missing === undefined
      ? { ok: true, userId: 'authorized-actor', role: 'supporter' }
      : { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: missing, role: 'supporter' }), { status: 403 }) };
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: [dbSlipListRow({ total_count: 1 })], error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/shipment-slips', () => {
  test('FREQ-531-AC-01: 200 で { rows, total, page, limit } を返し no-store。認可は shipping.read + orders.read、RPC は全段階・既定の20件・1頁目と認可結果の userId で1回だけ', async () => {
    const { request, response, json } = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ rows: [slipListRow()], total: 1, page: 1, limit: 20 });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.shipping.read', 'admin.orders.read'], request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: null, _limit: 20, _offset: 0, _actor_id: 'authorized-actor' });
  });

  test.each(['draft', 'confirmed', 'cancelled', 'discarded'])('FREQ-531-AC-01: stage=%s で絞れる。limit・page も渡せる', async (stage) => {
    await get(`?stage=${stage}&limit=5&page=4`);
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: stage, _limit: 5, _offset: 15, _actor_id: 'authorized-actor' });
  });

  test.each([
    '?stage=unknown', '?stage=', '?stage=DRAFT', '?stage=draft,confirmed', '?stage=toString',
    '?limit=0', '?limit=101', '?limit=abc', '?limit=', '?limit=1.5',
    '?page=0', '?page=100001', '?page=abc', '?page=',
  ])('FREQ-531-AC-01: 不正な指定（%s）は400で no-store、RPC は呼ばない', async (query) => {
    const { response, status, json } = await get(query);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Invalid request' });
    expect(rpc).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.shipping.read'],
    ['admin.orders.read だけ', ['admin.orders.read'], 'admin.shipping.read'],
    ['admin.shipping.read だけ', ['admin.shipping.read'], 'admin.orders.read'],
  ])('FREQ-540-AC-10: %s の人は 403（足りない最初の権限が permission）で no-store。RPC には進まない', async (_name, held, missing) => {
    useAcl(held);
    const { response, status, json } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Forbidden', permission: missing, role: 'supporter' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-10: 認可の拒否 %s は状態と本文をそのまま返し no-store、RPC は呼ばない', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await get();
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-10: 認可が通らなければ、指定が不正でも400でなく認可の拒否を返す。読むだけの窓口なので CSRF の確かめも回数制限もしない', async () => {
    useAcl([]);
    expect((await get('?stage=unknown')).status).toBe(403);
    useAcl(['admin.shipping.read', 'admin.orders.read']);
    expect((await get()).status).toBe(200);
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-10: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の固定の文と code（生の文は返さない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const { response, status, json, text } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発送を扱う権限がありません。' });
    expect(text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['rpc', 'malformed', 'client'] as const)(
    'FREQ-531-AC-04: 内部の失敗(%s)は固定の500。DB の生の誤りを本文にもログにも出さない', async (source) => {
      if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '57014', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
      if (source === 'malformed') rpc.mockResolvedValue({ data: [dbSlipListRow({ stage: 'PRIVATE-MARKER', total_count: 1 })], error: null });
      if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
      const { response, status, json, text } = await get();
      expect(status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: '発送の記録に失敗しました' });
      expect(text).not.toContain('PRIVATE-MARKER');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      expect((console.error as jest.Mock).mock.calls[0][0]).toBe('GET /api/admin/shipment-slips error:');
    });
});
