jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn(), getCsrfTokenFromCookie: jest.fn() }));
import { clientFetch, getCsrfTokenFromCookie } from '@/lib/client-fetch';
import { fetchOrderStatusPrivate, submitOrderStatusLastFour } from '@/features/order-status/status-client';

const token = 't'.repeat(43);
const mockFetch = jest.fn();
beforeEach(() => { jest.clearAllMocks(); global.fetch = mockFetch; });

test('GETはclientFetchでno-storeとAbortSignalを渡す', async () => {
  const signal = new AbortController().signal;
  jest.mocked(clientFetch).mockResolvedValue({ status: 200 } as Response);
  await fetchOrderStatusPrivate(token, signal);
  const [url, init] = jest.mocked(clientFetch).mock.calls[0];
  expect(url === `/api/order-status/${token}/private`).toBe(true);
  expect(init).toEqual(expect.objectContaining({ method: 'GET', cache: 'no-store', signal }));
});

test('確認POSTはCSRFを付けるがrefreshも自動再送もしない', async () => {
  jest.mocked(getCsrfTokenFromCookie).mockReturnValue('synthetic-csrf');
  mockFetch.mockResolvedValue({ status: 401 });
  await submitOrderStatusLastFour(token, '1234');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(clientFetch).not.toHaveBeenCalled();
  const [url, init] = mockFetch.mock.calls[0];
  expect(url === `/api/order-status/${token}/verify`).toBe(true);
  expect(init.method).toBe('POST');
  expect(init.cache).toBe('no-store');
  expect(init.credentials).toBe('same-origin');
  expect(new Headers(init.headers).get('x-csrf-token') === 'synthetic-csrf').toBe(true);
  expect(JSON.parse(init.body).lastFour === '1234').toBe(true);
});

test.each([500, 503, 'network'])('CSRF無しと失敗%sも一回で止める', async (status) => {
  jest.mocked(getCsrfTokenFromCookie).mockReturnValue(undefined);
  if (status === 'network') mockFetch.mockRejectedValueOnce(new TypeError('opaque'));
  else mockFetch.mockResolvedValueOnce({ status });
  await submitOrderStatusLastFour(token, '1234').catch(() => undefined);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(new Headers(mockFetch.mock.calls[0][1].headers).has('x-csrf-token')).toBe(false);
  expect(clientFetch).not.toHaveBeenCalled();
});
