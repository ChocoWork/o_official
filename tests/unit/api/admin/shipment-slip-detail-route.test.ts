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
import { GET } from '@/app/api/admin/shipment-slips/[id]/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { confirmedDetail, draftDetail, SLIP_ID } from '../../lib/orders/shipment-slips/shipment-slip-fixtures';

const rpc = jest.fn();
const permissionQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), or: jest.fn() };
const from = jest.fn().mockReturnValue(permissionQuery);
const authorize = authorizeAdminPermissions as jest.Mock;

async function get(id: string = SLIP_ID) {
  const request = new Request(`https://example.test/api/admin/shipment-slips/${id}`);
  const response = await GET(request, { params: Promise.resolve({ id }) });
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
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  permissionQuery.select.mockReturnThis(); permissionQuery.eq.mockReturnThis(); from.mockReturnValue(permissionQuery);
  permissionQuery.or.mockResolvedValue({ data: [{ roles: { role_permissions: ['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'].map((code) => ({ permissions: { code } })) } }], error: null });
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, from });
  rpc.mockResolvedValue({ data: confirmedDetail(), error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/shipment-slips/[id]', () => {
  test('FREQ-531-AC-01: 200 で { slip } を返し no-store。認可は shipping.read + orders.read、RPC は票の番号と認可結果の userId で1回だけ', async () => {
    const { request, response, json } = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ slip: confirmedDetail(), canCorrectDate: true });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.shipping.read', 'admin.orders.read'], request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_admin_shipment_slip', { _slip_id: SLIP_ID, _actor_id: 'authorized-actor' });
  });

  test('FREQ-531-AC-01: 下書きの詳細も返す（問題つき）', async () => {
    rpc.mockResolvedValue({ data: draftDetail(), error: null });
    expect((await get()).json).toEqual({ slip: draftDetail(), canCorrectDate: true });
  });

  test('FREQ-531-AC-01: DB の余分な項目は応答に出さない', async () => {
    rpc.mockResolvedValue({ data: { ...confirmedDetail(), storage_path: 'PRIVATE-MARKER' }, error: null });
    expect((await get()).text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['abc', '123', 'not-a-uuid', '3333333333333333333333333333333333333', '33333333-3333-4333-8333-33333333333Z', '..%2Forders'])(
    'FREQ-531-AC-01: id が uuid でない（%s）は400で no-store、RPC は呼ばない', async (id) => {
      const { response, status, json } = await get(id);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

  test('FREQ-531-AC-01: 票が無ければ404の { code, error: "発送票が見つかりません。" } で no-store', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_SLIP_NOT_FOUND', code: 'P0002', details: 'PRIVATE-MARKER' } });
    const { response, status, json, text } = await get();
    expect(status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ code: 'GROUP_G_SLIP_NOT_FOUND', error: '発送票が見つかりません。' });
    expect(text).not.toContain('PRIVATE-MARKER');
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
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-10: shipping.read と orders.read の両方があれば200（manage は要らない）。読むだけなので CSRF の確かめも回数制限もしない', async () => {
    useAcl(['admin.shipping.read', 'admin.orders.read']);
    expect((await get()).status).toBe(200);
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
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

  test('FREQ-540-AC-10: 認可が通らなければ、id が uuid でなくても400でなく認可の拒否を返す', async () => {
    useAcl([]);
    expect((await get('abc')).status).toBe(403);
  });

  test('FREQ-540-AC-10: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の固定の文と code（生の文は返さない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const { response, status, json, text } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発送を扱う権限がありません。' });
    expect(text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['rpc', 'malformed', 'other-slip', 'client'] as const)(
    'FREQ-531-AC-04: 内部の失敗(%s)は固定の500。DB の生の誤りを本文にもログにも出さない', async (source) => {
      if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '57014', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
      if (source === 'malformed') rpc.mockResolvedValue({ data: { ...confirmedDetail(), stage: 'PRIVATE-MARKER' }, error: null });
      if (source === 'other-slip') rpc.mockResolvedValue({ data: { ...confirmedDetail(), id: '33333333-3333-4333-8333-333333333399' }, error: null });
      if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
      const { response, status, json, text } = await get();
      expect(status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: '発送の記録に失敗しました' });
      expect(text).not.toContain('PRIVATE-MARKER');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      expect((console.error as jest.Mock).mock.calls[0][0]).toBe('GET /api/admin/shipment-slips/[id] error:');
    });
});

test('FREQ-540-AC-10: 読取権限だけではcanCorrectDate=false、訂正の組が揃うとtrue', async () => {
  useAcl(['admin.shipping.read', 'admin.orders.read']);
  permissionQuery.or.mockResolvedValueOnce({ data: [], error: null });
  expect((await get()).json.canCorrectDate).toBe(false);
  expect(console.warn).not.toHaveBeenCalled();
  useAcl(['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read']);
  expect((await get()).json.canCorrectDate).toBe(true);
  expect(authorize).toHaveBeenCalledTimes(2); // 2 views, one authorization per view.
});
test('FREQ-540-AC-10: 訂正権限の照会障害はfalseに潰さず固定500を返す', async () => {
  permissionQuery.or.mockResolvedValueOnce({ data: null, error: { message: 'PRIVATE-MARKER' } });
  const answer = await get();
  expect(answer.status).toBe(500);
  expect(answer.json).toEqual({ error: '発送の記録に失敗しました' });
  expect(answer.text).not.toContain('PRIVATE-MARKER');
  expect(rpc).not.toHaveBeenCalled();
});
