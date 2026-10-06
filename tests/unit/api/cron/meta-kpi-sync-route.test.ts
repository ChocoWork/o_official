jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

const mockMaybeSingle = jest.fn();
const mockServiceClient = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => mockMaybeSingle() }) }),
  }),
};
const mockCreateServiceRoleClient = jest.fn(async () => mockServiceClient);
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));
jest.mock('@/lib/meta/sync-kpi', () => ({ syncMetaKpis: jest.fn() }));
jest.mock('@/lib/kpi/monthly-metrics', () => ({ currentSeasonKey: () => '2026-AW' }));

import { POST } from '@/app/api/cron/meta-kpi-sync/route';

const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/meta-kpi-sync', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

describe('POST /api/cron/meta-kpi-sync の合言葉', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CRON_SECRET = CRON_SECRET;
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  afterEach(() => {
    // restoreAllMocks は jest.fn の実装まで消すので使わない（Jest 29）
    warn.mockRestore();
    delete process.env.CRON_SECRET;
  });

  it('一致しなければ 401 で、DB を触らない', async () => {
    const response = (await POST(request(`Bearer ${CRON_SECRET.slice(0, -1)}X`))) as unknown as { status: number };
    expect(response.status).toBe(401);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が32文字未満なら、一致していても 401', async () => {
    process.env.CRON_SECRET = 'short-secret';
    const response = (await POST(request('Bearer short-secret'))) as unknown as { status: number };
    expect(response.status).toBe(401);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('一致すれば処理に進む（つながりが無ければ skipped）', async () => {
    const response = (await POST(request(`Bearer ${CRON_SECRET}`))) as unknown as { status: number; body: unknown };
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { skipped: true } });
  });
});
