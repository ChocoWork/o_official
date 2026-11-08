/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/meta/config', () => ({ getMetaConfig: jest.fn() }));
jest.mock('@/lib/meta/graph-client', () => ({ metaGraphGetAll: jest.fn() }));
jest.mock('@/lib/meta/token-crypto', () => ({ decryptMetaToken: jest.fn() }));
import { syncMetaKpis, type MetaConnection } from '@/lib/meta/sync-kpi';
import { getMetaConfig } from '@/lib/meta/config';
import { metaGraphGetAll } from '@/lib/meta/graph-client';
import { decryptMetaToken } from '@/lib/meta/token-crypto';

// Accounting plan 2 Task 8 (FREQ-573-AC-02): the Meta sync writes the monthly records through system_upsert_kpi_monthly_records, not the table.
const connection: MetaConnection = { id: 'c1', instagram_user_id: 'ig1', ad_account_id: null, access_token_encrypted: 'x' };
const fromCalls: string[] = [];
const rpc = jest.fn();
const supabase = { from: (table: string) => { fromCalls.push(table); throw new Error('the table must not be touched'); }, rpc: (...args: unknown[]) => rpc(...args) };

beforeEach(() => {
  jest.resetAllMocks();
  fromCalls.length = 0;
  (getMetaConfig as jest.Mock).mockReturnValue({ graphVersion: 'v25.0', encryptionKey: Buffer.alloc(32) });
  (decryptMetaToken as jest.Mock).mockReturnValue('token');
  (metaGraphGetAll as jest.Mock).mockImplementation(async (_host: string, _version: string, path: string) =>
    path.endsWith('/insights') && path.startsWith('ig1')
      ? [{ name: 'reach', values: [{ value: 100, end_time: '2026-07-05T07:00:00+0000' }, { value: 20, end_time: '2026-07-06T07:00:00+0000' }] },
        { name: 'profile_views', values: [{ value: 3, end_time: '2026-08-01T07:00:00+0000' }] }]
      : []);
  rpc.mockResolvedValue({ data: 2, error: null });
});

describe('syncMetaKpis', () => {
  test('FREQ-573-AC-02: Metaの同期は集めた月の値をsystem_upsert_kpi_monthly_recordsで保存し、表を直接書かない', async () => {
    const result = await syncMetaKpis(supabase as never, connection, '2026SS');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('system_upsert_kpi_monthly_records', {
      _rows: [
        { month_key: '2026-07', metric_key: 'src:reach', value: 120 },
        { month_key: '2026-08', metric_key: 'src:profile_visits', value: 3 },
      ],
    });
    expect(fromCalls).toEqual([]);
    expect(result).toEqual({ status: 'success', metricsWritten: 2, message: null });
  });

  test('FREQ-573-AC-02: Metaの同期は保存の失敗を投げ直し、集めた値が無ければ書き口を呼ばない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'ACCOUNTING_ARGUMENT_INVALID', code: '22023' } });
    await expect(syncMetaKpis(supabase as never, connection, '2026SS')).rejects.toThrow('ACCOUNTING_ARGUMENT_INVALID');
    rpc.mockClear();
    (metaGraphGetAll as jest.Mock).mockResolvedValue([]);
    expect((await syncMetaKpis(supabase as never, connection, '2026SS')).metricsWritten).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});
