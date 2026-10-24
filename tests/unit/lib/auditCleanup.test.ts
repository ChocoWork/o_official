export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const auditCleanupModule = require('@/lib/auditCleanup');
const { cleanupAuditLogs } = auditCleanupModule;

function buildClient(result: Record<string, unknown>) {
  const ltMock = jest.fn().mockResolvedValue(result);
  const deleteMock = jest.fn().mockReturnValue({ lt: ltMock });
  const fromMock = jest.fn().mockReturnValue({ delete: deleteMock });
  createServiceRoleClient.mockReturnValue({ from: fromMock });
  return { ltMock, deleteMock, fromMock };
}

describe('cleanupAuditLogs', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('DD-ADMIN-015 deletes rows older than retention cutoff', async () => {
    const deleteMock = jest.fn().mockReturnThis();
    // 実装は delete({ count: 'exact' }) の count を件数として返す。
    const ltMock = jest.fn().mockResolvedValue({ data: [{ id: '1' }, { id: '2' }], count: 2, error: null });

    // chain: from('audit_logs').delete().lt('created_at', cutoff)
    const fromMock = jest.fn().mockReturnValue({ delete: deleteMock });
    deleteMock.mockReturnValue({ lt: ltMock });

    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const result = await cleanupAuditLogs({ retentionDays: 1 });

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith('audit_logs');
    expect(deleteMock).toHaveBeenCalledWith({ count: 'exact' });
    expect(ltMock).toHaveBeenCalledWith('created_at', expect.any(String));
    expect(result.deleted).toBe(2);
  });

  it('DD-ADMIN-015 throws if supabase returns error', async () => {
    const deleteMock = jest.fn().mockReturnThis();
    const ltMock = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });

    const fromMock = jest.fn().mockReturnValue({ delete: deleteMock });
    deleteMock.mockReturnValue({ lt: ltMock });

    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await expect(cleanupAuditLogs({ retentionDays: 1 })).rejects.toHaveProperty('message', 'boom');
  });

  it('DD-ADMIN-015 引数を渡さない時は固定した現在時刻の365日前を境にする', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
    const { ltMock } = buildClient({ data: [], count: 0, error: null });

    await cleanupAuditLogs();

    expect(ltMock).toHaveBeenCalledWith('created_at', '2025-10-24T00:00:00.000Z');
  });

  it('DD-ADMIN-015 retentionDays を渡した時はその日数前を境にする', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
    const { ltMock } = buildClient({ data: [], count: 0, error: null });

    await cleanupAuditLogs({ retentionDays: 30 });

    expect(ltMock).toHaveBeenCalledWith('created_at', '2026-09-24T00:00:00.000Z');
  });

  it('DD-ADMIN-015 件数が返らない時は deleted を 0 にして data をそのまま返す', async () => {
    const data = [{ id: '1' }];
    buildClient({ data, error: null });

    const result = await cleanupAuditLogs({ retentionDays: 1 });

    expect(result).toEqual({ deleted: 0, data });
  });

  it('DD-ADMIN-015 日数が数でない時は境の時刻を作る所で例外になり、そのまま投げる', async () => {
    buildClient({ data: [], count: 0, error: null });

    await expect(cleanupAuditLogs({ retentionDays: Number.NaN })).rejects.toThrow(RangeError);
  });

  it('DD-ADMIN-015 default export は cleanupAuditLogs と同じ関数', () => {
    expect(auditCleanupModule.default).toBe(cleanupAuditLogs);
  });
});
