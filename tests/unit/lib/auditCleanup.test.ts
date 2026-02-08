jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { cleanupAuditLogs } = require('@/lib/auditCleanup');

describe('cleanupAuditLogs', () => {
  it('deletes rows older than retention cutoff', async () => {
    const deleteMock = jest.fn().mockReturnThis();
    const ltMock = jest.fn().mockResolvedValue({ data: [{ id: '1' }, { id: '2' }], error: null });

    // chain: from('audit_logs').delete().lt('created_at', cutoff)
    const fromMock = jest.fn().mockReturnValue({ delete: deleteMock });
    deleteMock.mockReturnValue({ lt: ltMock });

    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const result = await cleanupAuditLogs({ retentionDays: 1 });

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith('audit_logs');
    expect(deleteMock).toHaveBeenCalled();
    expect(ltMock).toHaveBeenCalledWith('created_at', expect.any(String));
    expect(result.deleted).toBe(2);
  });

  it('throws if supabase returns error', async () => {
    const deleteMock = jest.fn().mockReturnThis();
    const ltMock = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });

    const fromMock = jest.fn().mockReturnValue({ delete: deleteMock });
    deleteMock.mockReturnValue({ lt: ltMock });

    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await expect(cleanupAuditLogs({ retentionDays: 1 })).rejects.toHaveProperty('message', 'boom');
  });
});