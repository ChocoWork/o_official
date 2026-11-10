import { act, renderHook } from '@testing-library/react';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { ESTIMATE_DEBOUNCE_MS, useUnitPricingEstimate } from '@/hooks/useUnitPricingEstimate';

const URL_A = '/api/admin/returns/r1/receive-estimate';
const FALLBACK = '見込みを読み込めませんでした。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClientFetch.mockReset();
});
afterEach(() => jest.useRealTimers());

const flush = async (ms = 0) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

describe('useUnitPricingEstimate', () => {
  test('DD-ADMIN-022: url が null の間は何も呼ばず idle', async () => {
    const { result } = renderHook(() => useUnitPricingEstimate(null, null, FALLBACK));
    await flush(ESTIMATE_DEBOUNCE_MS * 2);
    expect(result.current).toEqual({ status: 'idle' });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test('DD-ADMIN-022: 選びが変わった直後から loading で、300ms 待ってから1回だけ呼ぶ', async () => {
    mockClientFetch.mockResolvedValue(json({ data: { refundAmount: 17000 } }));
    const { result } = renderHook(() => useUnitPricingEstimate<{ refundAmount: number }>(URL_A, { n: 1 }, FALLBACK));
    expect(result.current).toEqual({ status: 'loading' });
    await flush(ESTIMATE_DEBOUNCE_MS - 1);
    expect(mockClientFetch).not.toHaveBeenCalled();
    await flush(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: 'ready', estimate: { refundAmount: 17000 } });
  });

  test('DD-ADMIN-022: 300ms 以内に続けて選びを変えても呼ぶのは最後の1回だけ', async () => {
    mockClientFetch.mockResolvedValue(json({ data: { refundAmount: 1 } }));
    const { rerender } = renderHook(({ n }) => useUnitPricingEstimate(URL_A, { n }, FALLBACK), { initialProps: { n: 1 } });
    await flush(200);
    rerender({ n: 2 });
    await flush(200);
    rerender({ n: 3 });
    await flush(ESTIMATE_DEBOUNCE_MS);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((mockClientFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({ n: 3 });
  });

  test('DD-ADMIN-022: 選びを変えた後に届いた古い答えは捨てる', async () => {
    const first = deferred();
    const second = deferred();
    mockClientFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ n }) => useUnitPricingEstimate<{ v: number }>(URL_A, { n }, FALLBACK), { initialProps: { n: 1 } });
    await flush(ESTIMATE_DEBOUNCE_MS);
    rerender({ n: 2 });
    await flush(ESTIMATE_DEBOUNCE_MS);
    await act(async () => { second.resolve(json({ data: { v: 2 } })); });
    expect(result.current).toEqual({ status: 'ready', estimate: { v: 2 } });
    await act(async () => { first.resolve(json({ data: { v: 1 } })); });
    expect(result.current).toEqual({ status: 'ready', estimate: { v: 2 } });
  });

  test('DD-ADMIN-022: 窓口の断りは文つきの error（額は出さない）', async () => {
    mockClientFetch.mockResolvedValue(json({ error: '返金の額の計算を確かめられませんでした。画面を開き直してください。', code: 'UNIT_PRICING_INVALID' }, 409));
    const { result } = renderHook(() => useUnitPricingEstimate(URL_A, { n: 1 }, FALLBACK));
    await flush(ESTIMATE_DEBOUNCE_MS);
    expect(result.current).toEqual({ status: 'error', message: '返金の額の計算を確かめられませんでした。画面を開き直してください。' });
  });

  test('DD-ADMIN-022: 通信が切れた時は代わりの文の error', async () => {
    mockClientFetch.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useUnitPricingEstimate(URL_A, { n: 1 }, FALLBACK));
    await flush(ESTIMATE_DEBOUNCE_MS);
    expect(result.current).toEqual({ status: 'error', message: FALLBACK });
  });
});
