jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

import { incrementCounter } from '@/features/auth/ratelimit';
import { createServiceRoleClient } from '@/lib/supabase/server';

describe('incrementCounter', () => {
  const mockRpc = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc: mockRpc });
  });

  test('calls the atomic rate limit RPC function with ip when subject is absent', async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });

    const count = await incrementCounter({
      ip: '1.2.3.4',
      endpoint: 'auth:login',
      bucket: '2026-04-19T00:00:00Z',
    });

    expect(count).toBe(1);
    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('increment_rate_limit_counter', {
      _ip: '1.2.3.4',
      _endpoint: 'auth:login',
      _bucket: '2026-04-19T00:00:00Z',
    });
  });

  test('calls the atomic rate limit RPC function with null ip for subject-based counting', async () => {
    mockRpc.mockResolvedValue({ data: 2, error: null });

    const count = await incrementCounter({
      ip: '1.2.3.4',
      endpoint: 'auth:identify',
      bucket: '2026-04-19T00:00:00Z',
      subject: 'user@example.com',
    });

    expect(count).toBe(2);
    expect(mockRpc).toHaveBeenCalledWith('increment_rate_limit_counter', {
      _ip: null,
      _endpoint: 'auth:identify|acct:user@example.com',
      _bucket: '2026-04-19T00:00:00Z',
    });
  });

  test('throws when RPC returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc failure' } });

    await expect(
      incrementCounter({
        endpoint: 'auth:login',
        bucket: '2026-04-19T00:00:00Z',
      }),
    ).rejects.toThrow('rpc failure');
  });

  test('incrementCounterBy passes the weighted increment to the RPC function', async () => {
    const { incrementCounterBy } = await import('@/features/auth/ratelimit');
    mockRpc.mockResolvedValue({ data: 10485760, error: null });

    const count = await incrementCounterBy({
      endpoint: 'admin:looks:create:upload-bytes',
      bucket: '2026-04-26T12:00:00Z',
      increment: 5242880,
      subject: 'admin-user-id',
    });

    expect(count).toBe(10485760);
    expect(mockRpc).toHaveBeenCalledWith('increment_rate_limit_counter', {
      _ip: null,
      _endpoint: 'admin:looks:create:upload-bytes|acct:admin-user-id',
      _bucket: '2026-04-26T12:00:00Z',
      _increment: 5242880,
    });
  });
});
