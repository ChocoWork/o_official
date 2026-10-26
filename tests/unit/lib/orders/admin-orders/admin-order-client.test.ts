import { fetchAdminOrderDetail, readSafeOrderActionError } from '@/lib/orders/admin-orders/admin-order-client';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
const id = 'a1b2c3d4-1111-4222-8333-444455556666';
const response = (body: unknown, status = 200): Response => ({ ok: status < 300, status, json: async () => body }) as Response;
beforeEach(() => mockFetch.mockReset());

it('FREQ-539-AC-01: 詳細をno-storeで読みdataを返す', async () => {
  const data = { order: { id } };
  mockFetch.mockResolvedValue(response({ data }));
  expect(await fetchAdminOrderDetail(id)).toEqual({ kind: 'ready', data });
  expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${id}`, { cache: 'no-store' });
});
it.each([[403, 'forbidden'], [404, 'notFound'], [500, 'error']])('FREQ-539-AC-01: HTTP %sを%sへ分ける', async (status, kind) => {
  mockFetch.mockResolvedValue(response({ error: 'PRIVATE' }, Number(status)));
  expect(await fetchAdminOrderDetail(id)).toEqual({ kind });
});
it('FREQ-539-AC-01: 通信とJSONの失敗は固定のerror', async () => {
  mockFetch.mockRejectedValueOnce(new Error('PRIVATE')).mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('PRIVATE'); } });
  expect(await fetchAdminOrderDetail(id)).toEqual({ kind: 'error' });
  expect(await fetchAdminOrderDetail(id)).toEqual({ kind: 'error' });
});
it.each([400, 409])('FREQ-539-AC-03: %sの短い日本語だけを通す', async (status) => {
  expect(await readSafeOrderActionError(response({ error: '入力を確かめてください。' }, status), '既定')).toBe('入力を確かめてください。');
});
it.each([['PRIVATE', 400], ['長'.repeat(201), 409], ['', 400], ['入力\nPRIVATE', 400], ['入力を確かめてください。', 500]])('FREQ-539-AC-03: 安全でない本文は既定にする %#', async (error, status) => {
  expect(await readSafeOrderActionError(response({ error }, Number(status)), '既定')).toBe('既定');
});
