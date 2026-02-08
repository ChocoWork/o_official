jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('../../../src/lib/audit');

describe('audit DB integration', () => {
  beforeEach(() => jest.resetAllMocks());

  test('logAudit inserts into audit_logs table', async () => {
    const insertMock = jest.fn().mockResolvedValue({});
    const fromMock = jest.fn((table: string) => ({ insert: insertMock }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await logAudit({ action: 'test_action', actor_email: 'a@example.com', outcome: 'success', detail: 'ok' });

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith('audit_logs');
    expect(insertMock).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ action: 'test_action', actor_email: 'a@example.com', outcome: 'success' })]));
  });

  test('logAudit failures are caught and do not throw', async () => {
    const insertMock = jest.fn().mockRejectedValue(new Error('db down'));
    const fromMock = jest.fn((table: string) => ({ insert: insertMock }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await expect(logAudit({ action: 'x', outcome: 'failure' })).resolves.not.toThrow();
  });
});