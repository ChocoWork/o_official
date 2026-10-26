/** @jest-environment node */
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
import { clientFetch } from '@/lib/client-fetch';
import { postAllocationSwap, fetchSwapCandidates } from '@/lib/inventory/allocation-swap-client';

const id = '11111111-1111-4111-8111-111111111111'; const donor = '22222222-2222-4222-8222-222222222222';
const item = '33333333-3333-4333-8333-333333333333'; const donorItem = '44444444-4444-4444-8444-444444444444';
const input = { takerOrderItemId: item, donorOrderItemId: donorItem, quantity: 1, reason: '調整', requestKey: donor };
const saved = { id, operationId: donor, takerOrderId: id, takerOrderItemId: item, donorOrderId: donor, donorOrderItemId: donorItem, quantity: 1, reason: input.reason, replayed: true };
const fetcher = clientFetch as jest.Mock;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => jest.resetAllMocks());
test('FREQ-523-AC-04: 同じ本文とrequestKeyを再送しreplayedの結果を返す', async () => {
  fetcher.mockRejectedValueOnce(new Error('PRIVATE')).mockResolvedValueOnce(answer(saved));
  expect(await postAllocationSwap(id, input)).toEqual({ kind: 'unknown' });
  expect(await postAllocationSwap(id, input)).toEqual({ kind: 'ok', data: saved });
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  expect(fetcher).toHaveBeenCalledWith(`/api/admin/orders/${id}/allocations/swap`, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
});
test.each([500, 502, 503])('FREQ-523-AC-04: HTTP%sは記録済みか不明でunknown', async (status) => {
  fetcher.mockResolvedValue(answer({ error: 'PRIVATE' }, status)); expect(await postAllocationSwap(id, input)).toEqual({ kind: 'unknown' });
});
test.each([null, {}, { ...saved, id: donor }, { ...saved, donorOrderItemId: item }, { ...saved, quantity: 2 }, { ...saved, reason: 'different' }])('FREQ-523-AC-04: 読めない・別操作の成功%jはunknown', async (data) => {
  fetcher.mockResolvedValue(answer(data)); expect(await postAllocationSwap(id, input)).toEqual({ kind: 'unknown' });
});
test.each([
  [401, {}, { kind: 'blocked', message: 'ログインし直してください。' }],
  [403, { permission: 'admin.orders.allocate' }, { kind: 'blocked', message: '割り当てを入れ替える権限がありません。', forbidden: true }],
  [403, { code: 'GROUP_G_FORBIDDEN' }, { kind: 'blocked', message: '割り当てを入れ替える権限がありません。', forbidden: true }],
  [403, { reason: 'CSRF validation failed' }, { kind: 'blocked', message: '操作の確認ができませんでした。ページを読み込み直してから、もう一度お試しください。', forbidden: false }],
  [403, { reason: 'MFA required', permission: 'admin.orders.allocate' }, { kind: 'blocked', message: '2要素認証が必要です', forbidden: false }],
  [409, { code: 'GROUP_G_SWAP_ORDER_NOT_PAID', error: 'PRIVATE' }, { kind: 'refused', message: '入金が確認できていない注文は入れ替えられません。' }],
  [400, { code: 'toString', error: 'PRIVATE' }, { kind: 'refused', message: '入力を確かめてください。' }],
])('FREQ-540-AC-13: HTTP%sの断りを固定文で分ける', async (status, body, expected) => {
  fetcher.mockResolvedValue(answer(body, status)); expect(await postAllocationSwap(id, input)).toEqual(expected);
});
test('FREQ-523-AC-05: 候補はno-store、公開型を検査して返す', async () => {
  const data = [{ donorOrderId: donor, donorOrderItemId: donorItem, orderCreatedAt: '2026-10-26T00:00:00Z', swappableQuantity: 2, takerQuantity: 1 }];
  fetcher.mockResolvedValue(answer({ data })); expect(await fetchSwapCandidates(id, item)).toEqual({ kind: 'ok', data });
  expect(fetcher).toHaveBeenCalledWith(`/api/admin/orders/${id}/allocations/swap-candidates?orderItemId=${item}`, { cache: 'no-store' });
});
test('FREQ-523-AC-05: 候補の業務拒否は表の文、未知の応答と通信切れは固定文', async () => {
  fetcher.mockResolvedValueOnce(answer({ code: 'GROUP_G_SWAP_ORDER_NOT_PAID' }, 409)).mockResolvedValueOnce(answer({ data: null })).mockRejectedValueOnce(new Error('PRIVATE'));
  expect(await fetchSwapCandidates(id, item)).toEqual({ kind: 'error', message: '入金が確認できていない注文は入れ替えられません。', denied: false });
  for (let i = 0; i < 2; i++) expect(await fetchSwapCandidates(id, item)).toEqual({ kind: 'error', message: '候補を読み込めませんでした。', denied: false });
});
test('FREQ-523-AC-05: 不正なpathを送らない', async () => {
  expect((await postAllocationSwap('../bad', input)).kind).toBe('refused');
  expect((await fetchSwapCandidates(id, 'bad')).kind).toBe('error'); expect(fetcher).not.toHaveBeenCalled();
});
