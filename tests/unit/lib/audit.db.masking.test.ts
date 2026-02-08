jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');

describe('logAudit masking and DB insert', () => {
  it('inserts masked metadata and detail into audit_logs', async () => {
    const insertMock = jest.fn().mockResolvedValue({});
    const fromMock = jest.fn().mockReturnValue({ insert: insertMock });
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const event = {
      action: 'auth.password_reset.request',
      outcome: 'success',
      metadata: { password: 'secret', card_number: '4111111111111111' },
      detail: 'user provided password=pw123 and token abcdefghijklmnopqrstuvwxyz0123456789',
    };

    await logAudit(event as any);

    expect(fromMock).toHaveBeenCalledWith('audit_logs');
    // inspect what was inserted
    const inserted = insertMock.mock.calls[0][0][0];
    expect(inserted.metadata.password).toBe('[REDACTED]');
    expect(inserted.metadata.card_number).toBe('[REDACTED]');
    expect(inserted.detail).toContain('[REDACTED_TOKEN]');
  });
});