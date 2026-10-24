import { cleanupAuditLogs } from '@/lib/auditCleanup';
import { createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

const mockCreateServiceRoleClient = createServiceRoleClient as unknown as jest.Mock;

type AuditRow = { id: string; created_at: string };

/** audit_logs を行ごと持つ作り物。delete().lt() は境より前の行を本当に取り除き、数を返す。 */
function installAuditLogsTable(rows: AuditRow[], failWith?: unknown) {
  const table = { rows: [...rows] };
  const from = jest.fn((name: string) => {
    if (name !== 'audit_logs') throw new Error(`unexpected table ${name}`);
    return {
      delete: () => ({
        lt: async (column: 'created_at', cutoff: string) => {
          if (failWith) return { data: null, count: null, error: failWith };
          const removed = table.rows.filter((row) => row[column] < cutoff);
          table.rows = table.rows.filter((row) => row[column] >= cutoff);
          return { data: removed, count: removed.length, error: null };
        },
      }),
    };
  });
  mockCreateServiceRoleClient.mockResolvedValue({ from });
  return table;
}

describe('監査ログの古い行を消す部品（ARC-ADMIN-005）', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  it('ARC-ADMIN-005 既定の 365 日より古い行だけが表から消え、新しい行は残る', async () => {
    const table = installAuditLogsTable([
      { id: 'old', created_at: '2025-10-23T23:59:59.000Z' },
      { id: 'edge', created_at: '2025-10-24T00:00:00.000Z' },
      { id: 'new', created_at: '2026-10-23T00:00:00.000Z' },
    ]);

    const result = await cleanupAuditLogs();

    expect(result.deleted).toBe(1);
    expect(result.data).toEqual([{ id: 'old', created_at: '2025-10-23T23:59:59.000Z' }]);
    expect(table.rows.map((row) => row.id)).toEqual(['edge', 'new']);
  });

  it('ARC-ADMIN-005 日数を渡すとその日数より古い行まで消える', async () => {
    const table = installAuditLogsTable([
      { id: 'a', created_at: '2026-08-01T00:00:00.000Z' },
      { id: 'b', created_at: '2026-10-01T00:00:00.000Z' },
    ]);

    const result = await cleanupAuditLogs({ retentionDays: 30 });

    expect(result.deleted).toBe(1);
    expect(table.rows.map((row) => row.id)).toEqual(['b']);
  });

  it('ARC-ADMIN-005 消す行が無ければ消した数は 0', async () => {
    installAuditLogsTable([{ id: 'new', created_at: '2026-10-23T00:00:00.000Z' }]);

    await expect(cleanupAuditLogs()).resolves.toEqual({ deleted: 0, data: [] });
  });

  it('ARC-ADMIN-005 DB が断れば誤りをそのまま投げる', async () => {
    const dbError = { message: 'permission denied' };
    installAuditLogsTable([{ id: 'old', created_at: '2020-01-01T00:00:00.000Z' }], dbError);

    await expect(cleanupAuditLogs()).rejects.toBe(dbError);
  });
});
