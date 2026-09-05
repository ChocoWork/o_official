export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('../../../src/lib/audit');

describe('audit DB integration', () => {
  beforeEach(() => jest.resetAllMocks());

  test('logAudit inserts into audit_logs table', async () => {
    const insertMock = jest.fn().mockResolvedValue({});
    const fromMock = jest.fn(() => ({ insert: insertMock }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await logAudit({ action: 'test_action', actor_email: 'a@example.com', outcome: 'success', detail: 'ok' });

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith('audit_logs');
    expect(insertMock).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ action: 'test_action', actor_email: 'a@example.com', outcome: 'success' })]));
  });

  test('logAudit failures are caught and do not throw', async () => {
    const insertMock = jest.fn().mockRejectedValue(new Error('db down'));
    const fromMock = jest.fn(() => ({ insert: insertMock }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    await expect(logAudit({ action: 'x', outcome: 'failure' })).resolves.not.toThrow();
  });

  test.each(['returned', 'thrown'])('audit %s errors do not leak details or reject authentication', async mode => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = { message: 'secret-token-and-personal-data', code: '42501' };
    const insert = mode === 'returned'
      ? jest.fn().mockResolvedValue({ error: failure })
      : jest.fn().mockRejectedValue(failure);
    createServiceRoleClient.mockReturnValue({ from: () => ({ insert }) });
    await expect(logAudit({ action: 'auth.otp.verify', outcome: 'success',
      actor_email: 'private@example.invalid', detail: 'private detail' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Failed to write audit log');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-token|private@example|private detail/);
    warn.mockRestore();
  });
});