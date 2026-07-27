import { fetchAddressByPostalCode } from '@/features/checkout/services/postal-code.service';

// no external dependencies, only global.fetch is used

describe('postal-code service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('valid postal code calls ZipCloud and returns address', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        results: [
          {
            address1: '宮城県',
            address2: '富谷市',
            address3: '鷹乃杜',
          },
        ],
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchAddressByPostalCode('981-3351');
      expect(result).toEqual({ prefecture: '宮城県', city: '富谷市', address: '鷹乃杜' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('caches result in memory to avoid duplicate fetches', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        results: [
          {
            address1: '北海道',
            address2: '札幌市',
            address3: '中央区',
          },
        ],
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const first = await fetchAddressByPostalCode('060-0000');
      const second = await fetchAddressByPostalCode('0600000');
      expect(first).toEqual(second);
      expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('invalid postal code returns null without fetching', async () => {
    // 前のテストの後始末で global.fetch が undefined に戻ることがあるため、
    // spyOn ではなく差し替えで検証する。
    const fetchMock = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchAddressByPostalCode('123');
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
