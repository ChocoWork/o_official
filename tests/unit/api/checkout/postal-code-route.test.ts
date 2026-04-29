import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status || 200,
      })),
    },
  };
});

jest.mock('@/features/checkout/services/postal-code.service', () => ({
  fetchAddressByPostalCode: jest.fn(),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

import { GET } from '@/app/api/checkout/postal-code/route';
import { fetchAddressByPostalCode } from '@/features/checkout/services/postal-code.service';

const mockedFetchAddressByPostalCode = fetchAddressByPostalCode as jest.MockedFunction<typeof fetchAddressByPostalCode>;

describe('GET /api/checkout/postal-code', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  test('郵便番号不正時は400を返す', async () => {
    const req = new NextRequest('http://localhost/api/checkout/postal-code');
    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid postalCode' });
  });

  test('住所取得成功時はaddressを返す', async () => {
    mockedFetchAddressByPostalCode.mockResolvedValueOnce({
      prefecture: '宮城県',
      city: '富谷市',
      address: '鷹乃杜',
    });

    const req = new NextRequest('http://localhost/api/checkout/postal-code?postalCode=981-3351');
    const res = await GET(req);

    expect(mockedFetchAddressByPostalCode).toHaveBeenCalledWith('981-3351');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: {
        prefecture: '宮城県',
        city: '富谷市',
        address: '鷹乃杜',
      },
    });
  });

  test('外部APIエラー時は502を返す', async () => {
    mockedFetchAddressByPostalCode.mockRejectedValueOnce(new Error('boom'));

    const req = new NextRequest('http://localhost/api/checkout/postal-code?postalCode=9813351');
    const res = await GET(req);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Postal code lookup failed' });
  });

  test('レート制限時は429を返す', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({
      body: { error: 'Too many requests' },
      status: 429,
    });

    const req = new NextRequest('http://localhost/api/checkout/postal-code?postalCode=9813351');
    const res = await GET(req);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    expect(mockedFetchAddressByPostalCode).not.toHaveBeenCalled();
  });
});
