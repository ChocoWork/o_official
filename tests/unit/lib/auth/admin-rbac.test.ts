jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init: { status: number }) => ({ status: init.status, body })),
  },
}));

import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient, extractBearerToken } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
  extractBearerToken: jest.fn(),
}));

describe('authorizeAdminPermission', () => {
  const mockRequest = { headers: new Headers() } as unknown as Request;
  const mockGetUser = jest.fn();
  const mockGetUserById = jest.fn();
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (createClient as jest.Mock).mockResolvedValue({ auth: { getUser: mockGetUser } });
    (createServiceRoleClient as jest.Mock).mockResolvedValue({
      auth: { admin: { getUserById: mockGetUserById } },
      from: jest.fn().mockReturnValue(mockQuery),
    });
    (extractBearerToken as jest.Mock).mockReturnValue(null);
  });

  it('grants when ACL permission exists and token role is admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'user@example.com' } }, error: null });
    mockGetUserById.mockResolvedValue({ data: { user: { app_metadata: { role: 'admin' } } }, error: null });
    mockQuery.or.mockResolvedValue({
      data: [
        {
          roles: {
            role_permissions: [
              { permissions: { code: 'admin.users.manage' } },
            ],
          },
        },
      ],
      error: null,
    });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe('user-1');
      expect(result.role).toBe('admin');
    }
  });

  it('denies when ACL permission is missing even if token role is admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'user@example.com' } }, error: null });
    mockGetUserById.mockResolvedValue({ data: { user: { app_metadata: { role: 'admin' } } }, error: null });
    mockQuery.or.mockResolvedValue({ data: [], error: null });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((result.response as unknown as { body: { error: string } }).body.error).toBe('Forbidden');
    }
  });
});
