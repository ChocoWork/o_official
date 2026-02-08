import { maskAuditEvent } from '@/lib/audit';

describe('maskAuditEvent', () => {
  it('masks sensitive keys in metadata', () => {
    const event = {
      action: 'auth.login.failure',
      outcome: 'failure' as const,
      metadata: {
        password: 'hunter2',
        token: 'abcdefg1234567890',
        safe: 'keepme',
      },
    };

    const masked = maskAuditEvent(event as any);

    expect(masked.metadata?.password).toBe('[REDACTED]');
    expect(masked.metadata?.token).toBe('[REDACTED]');
    expect(masked.metadata?.safe).toBe('keepme');
  });

  it('masks JWTs and long tokens in detail', () => {
    const event = {
      action: 'auth.refresh.failure',
      outcome: 'failure' as const,
      detail: `User attempted refresh with token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef.verylongsignature and with password=pw12345 and longtoken=abcdefghijklmnopqrstuvwxyz0123456789`,
    };

    const masked = maskAuditEvent(event as any);

    expect(masked.detail).toContain('[REDACTED_JWT]');
    expect(masked.detail).toContain('password=[REDACTED]');
    expect(masked.detail).toContain('[REDACTED_TOKEN]');
  });
});