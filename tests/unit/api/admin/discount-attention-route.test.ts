/** @jest-environment node */
import { NextResponse } from 'next/server';
if (typeof Response.json !== 'function') Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const mockAuth = jest.fn(), mockCsrf = jest.fn(), mockLimit = jest.fn(), mockRpc = jest.fn(), mockAudit = jest.fn();
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: (...a: unknown[]) => mockAuth(...a) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...a: unknown[]) => mockCsrf(...a) }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...a: unknown[]) => mockLimit(...a) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => mockAudit(...a) }));
import { POST } from '@/app/api/admin/order-attention/discounts/[orderId]/resolve/route';
const orderId = 'a1b2c3d4-1111-4222-8333-444455556666';
const req = (body: unknown = {}) => new Request('http://localhost/api/admin/order-attention/discounts/'+orderId+'/resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '198.51.100.8' }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockAuth.mockResolvedValue({ ok: true, userId: 'actor' }); mockCsrf.mockResolvedValue(null); mockLimit.mockResolvedValue(null); mockRpc.mockResolvedValue({ data: { resolved: true }, error: null }); mockAudit.mockResolvedValue(undefined); });
test('FREQ-549-AC-04: 割引注意の確認は認可・CSRF・IPとactor30/600・strict・RPC・監査の順で行う', async () => {
  const res = await POST(req(), { params: Promise.resolve({ orderId }) }); expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { resolved: true } });
  expect(mockAuth).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
  expect(mockLimit.mock.calls.map(c => c[0])).toEqual([
    expect.objectContaining({ subject: '203.0.113.8', limit: 30, windowSeconds: 600 }), expect.objectContaining({ subject: 'actor', limit: 30, windowSeconds: 600 })]);
  expect(mockRpc).toHaveBeenCalledWith('admin_resolve_discount_attention', { _order_id: orderId, _actor_id: 'actor' });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { orderId, resolved: true } }));
  expect(mockAuth.mock.invocationCallOrder[0]).toBeLessThan(mockCsrf.mock.invocationCallOrder[0]);
  expect(mockCsrf.mock.invocationCallOrder[0]).toBeLessThan(mockLimit.mock.invocationCallOrder[0]);
  expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockAudit.mock.invocationCallOrder[0]);
});
test.each(['auth', 'csrf', 'limit'])('FREQ-549-AC-04: %sで断ればRPCを呼ばず共通応答を保つ', async step => {
  const denied = NextResponse.json({ error: 'denied' }, { status: step === 'limit' ? 429 : 403, headers: { 'Retry-After': '600' } });
  if (step === 'auth') mockAuth.mockResolvedValue({ ok: false, response: denied });
  if (step === 'csrf') mockCsrf.mockResolvedValue(denied);
  if (step === 'limit') mockLimit.mockResolvedValueOnce(denied);
  expect(await POST(req(), { params: Promise.resolve({ orderId }) })).toBe(denied); expect(mockRpc).not.toHaveBeenCalled();
});
test.each([{ note: 'not allowed' }, null])('FREQ-549-AC-04: 空object以外を拒否する (%j)', async body => {
  const res = await POST(req(body), { params: Promise.resolve({ orderId }) }); expect(res.status).toBe(400); expect(mockRpc).not.toHaveBeenCalled();
});
test('FREQ-549-AC-04: DBの未知の文は応答と監査に載せない', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: 'XX000' } });
  const res = await POST(req(), { params: Promise.resolve({ orderId }) }); expect(res.status).toBe(500);
  expect(JSON.stringify(await res.json())+JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
});
test('FREQ-549-AC-04: 全ての応答にno-storeが付き、監査はorderIdと結果だけでipを持たない', async () => {
  const ok = await POST(req(), { params: Promise.resolve({ orderId }) });
  expect(ok.headers.get('Cache-Control')).toBe('no-store');
  expect(mockAudit.mock.calls[0][0]).not.toHaveProperty('ip');
  expect(mockAudit.mock.calls[0][0].metadata).toEqual({ orderId, resolved: true });
  expect((await POST(req({ x: 1 }), { params: Promise.resolve({ orderId }) })).headers.get('Cache-Control')).toBe('no-store');
  expect((await POST(req(), { params: Promise.resolve({ orderId: 'not-a-uuid' }) })).headers.get('Cache-Control')).toBe('no-store');
  mockRpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: 'XX000' } });
  const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try { expect((await POST(req(), { params: Promise.resolve({ orderId }) })).headers.get('Cache-Control')).toBe('no-store'); } finally { silence.mockRestore(); }
  for (const step of ['auth', 'csrf', 'limit'] as const) {
    const denied = NextResponse.json({ error: 'denied' }, { status: step === 'limit' ? 429 : 403 });
    mockAuth.mockResolvedValue(step === 'auth' ? { ok: false, response: denied } : { ok: true, userId: 'actor' });
    mockCsrf.mockResolvedValue(step === 'csrf' ? denied : null);
    mockLimit.mockResolvedValue(step === 'limit' ? denied : null);
    expect((await POST(req(), { params: Promise.resolve({ orderId }) })).headers.get('Cache-Control')).toBe('no-store');
  }
});
test('FREQ-549-AC-04: 監査の書込みが失敗しても確認済みの成功を200のまま返す', async () => {
  mockAudit.mockRejectedValue(new Error('audit down PRIVATE-MARKER'));
  const silence = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const res = await POST(req(), { params: Promise.resolve({ orderId }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { resolved: true } });
    expect(JSON.stringify(silence.mock.calls)).not.toContain('PRIVATE-MARKER');
  } finally { silence.mockRestore(); }
});
