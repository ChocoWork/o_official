jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init: { status: number }) => ({ status: init.status, body })),
  },
}));

import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { checkAuthSessionLiveness, createServiceRoleClient, verifyAccessToken } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
  // admin-rbac は失効確認と ACL 照会を並列に投げるため、authenticateRequest ではなく
  // 内訳の 2 つを直接呼ぶ。ここを戻すと往復が 1 回増える。
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

describe('authorizeAdminPermission', () => {
  const mockRequest = { headers: new Headers() } as unknown as Request;
  const mockQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn(),
  };

  // 認可根拠は DB の ACL と JWT の aal クレーム。app_metadata の MFA フラグは使わない。
  const adminClaims = {
    sub: 'user-1',
    session_id: 'session-1',
    aal: 'aal2',
    email: 'user@example.com',
    app_metadata: { role: 'admin' },
  };

  const grantPermission = (code: string) => {
    mockQuery.or.mockResolvedValue({
      data: [{ roles: { role_permissions: [{ permissions: { code } }] } }],
      error: null,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (createServiceRoleClient as jest.Mock).mockResolvedValue({
      from: jest.fn().mockReturnValue(mockQuery),
    });
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: adminClaims });
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
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

  // トークン自体が通らない場合は 401。失効確認まで進まないので DB も触らない。
  it.each(['missing', 'invalid'] as const)(
    'denies with 401 when the token is rejected with reason=%s',
    async (reason) => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason });

      const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it('denies with 401 when the session has been revoked', async () => {
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('revoked');
    grantPermission('admin.users.manage');

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  // 「失効している」と「失効しているか確認できなかった」を混ぜない。
  // 401 で返すとクライアントがセッション更新を撃ち、DB 障害中に refresh が殺到する。
  it('answers 503 with Retry-After when the session state cannot be determined', async () => {
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('unavailable');
    grantPermission('admin.users.manage');

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
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

  it('does not leak internal error details in the 500 response', async () => {
    (verifyAccessToken as jest.Mock).mockRejectedValue(new Error('connection string leaked'));

    const result = await authorizeAdminPermission('admin.users.manage', mockRequest);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(500);
      expect(JSON.stringify((result.response as unknown as { body: unknown }).body)).not.toContain('leaked');
    }
  });
});
