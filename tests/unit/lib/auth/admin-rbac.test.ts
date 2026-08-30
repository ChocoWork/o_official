jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init: { status: number }) => ({ status: init.status, body })),
  },
}));

import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient, verifyAccessToken } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
  verifyAccessToken: jest.fn(),
}));

describe('authorizeAdminPermission', () => {
  const mockRequest = { headers: new Headers() } as unknown as Request;
  const mockRpc = jest.fn();
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn(),
  };

  // The verified access token carries role + MFA flags in app_metadata.
  // app_metadata の MFA フラグはユーザー単位で永続するため認可根拠にしない（判定は aal クレーム）。
  const adminAppMetadata = { role: 'admin', admin_mfa_verified: true };

  const adminClaims = {
    sub: 'user-1',
    session_id: 'session-1',
    aal: 'aal2',
    email: 'user@example.com',
    app_metadata: adminAppMetadata,
  };

  const grantPermission = (code: string) => {
    mockQuery.or.mockResolvedValue({
      data: [{ roles: { role_permissions: [{ permissions: { code } }] } }],
      error: null,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockRpc.mockResolvedValue({ data: true, error: null });
    (createServiceRoleClient as jest.Mock).mockResolvedValue({
      from: jest.fn().mockReturnValue(mockQuery),
      rpc: mockRpc,
    });
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: adminClaims });
  });

  it('grants when ACL permission exists and token role is admin', async () => {
    grantPermission('admin.users.manage');

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe('user-1');
      expect(result.role).toBe('admin');
      expect(result.actorEmail).toBe('user@example.com');
    }
  });

  it('denies when ACL permission is missing even if token role is admin', async () => {
    mockQuery.or.mockResolvedValue({ data: [], error: null });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((result.response as unknown as { body: { error: string } }).body.error).toBe('Forbidden');
    }
  });

  it('denies with 401 when the access token is missing', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason: 'missing' });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('denies with 401 when the access token fails verification', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason: 'invalid' });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('denies with MFA required while the session is still aal1', async () => {
    (verifyAccessToken as jest.Mock).mockResolvedValue({
      ok: true,
      claims: { ...adminClaims, aal: 'aal1' },
    });
    grantPermission('admin.users.manage');

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((result.response as unknown as { body: { reason: string } }).body.reason).toBe('MFA required');
    }
  });

  it('denies with 401 when the auth session has been revoked', async () => {
    grantPermission('admin.users.manage');
    mockRpc.mockResolvedValue({ data: false, error: null });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(mockRpc).toHaveBeenCalledWith('is_auth_session_active', { p_session_id: 'session-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('fails closed when the session revocation check errors', async () => {
    grantPermission('admin.users.manage');
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });
});
