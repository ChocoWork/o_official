jest.mock('@/lib/cache/redis-cache', () => ({
  getRedisJson: jest.fn(),
  setRedisJson: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

import { fetchAddressByPostalCode } from '@/features/checkout/services/postal-code.service';
import { getRedisJson, setRedisJson } from '@/lib/cache/redis-cache';
import { createServiceRoleClient } from '@/lib/supabase/server';

const mockedGetRedisJson = getRedisJson as jest.MockedFunction<typeof getRedisJson>;
const mockedSetRedisJson = setRedisJson as jest.MockedFunction<typeof setRedisJson>;
const mockedCreateServiceRoleClient = createServiceRoleClient as unknown as jest.Mock;

describe('postal-code service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('DBに住所がある場合は外部APIを呼ばない', async () => {
    mockedGetRedisJson.mockResolvedValueOnce(null);

    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        postal_code: '9813351',
        prefecture: '宮城県',
        city: '富谷市',
        address: '鷹乃杜',
      },
      error: null,
    });

    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select, upsert: jest.fn() });
    mockedCreateServiceRoleClient.mockResolvedValue({ from });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchAddressByPostalCode('980-0000');

      expect(result).toEqual({ prefecture: '宮城県', city: '富谷市', address: '鷹乃杜' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockedSetRedisJson).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('DBにない場合は外部API取得後にDB/Redisへ保存する', async () => {
    mockedGetRedisJson.mockResolvedValueOnce(null);

    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const upsert = jest.fn().mockResolvedValue({ error: null });
    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select, upsert });
    mockedCreateServiceRoleClient.mockResolvedValue({ from });

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
      expect(upsert).toHaveBeenCalled();
      expect(mockedSetRedisJson).toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
