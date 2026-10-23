jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init: { status: number }) => ({ status: init.status, body })),
  },
}));

import { authorizeAdminPermission, legacyPermissionMap } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

// admin-rbac は失効確認と ACL 照会を並列に投げるため、authenticateRequest ではなく
// 内訳の 2 つを直接呼ぶ。ここを戻すと往復が 1 回増える。
jest.mock('@/lib/auth/authenticate', () => ({
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
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    (createServiceRoleClient as jest.Mock).mockResolvedValue({
      from: jest.fn().mockReturnValue(mockQuery),
    });
    (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: adminClaims });
    (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
  });

  afterEach(() => jest.restoreAllMocks());

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

  it('権限管理のACLが空ならtoken adminでも拒否し、次の要求でACLを再取得する', async () => {
    mockQuery.or.mockResolvedValueOnce({ data: [], error: null });
    const denied = await authorizeAdminPermission('admin.permissions.manage', mockRequest);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    grantPermission('admin.permissions.manage');
    expect((await authorizeAdminPermission('admin.permissions.manage', mockRequest)).ok).toBe(true);
    expect(mockQuery.or).toHaveBeenCalledTimes(2);
    expect(mockQuery.eq).toHaveBeenCalledWith('active', true);
    expect(mockQuery.or).toHaveBeenCalledWith(expect.stringMatching(/^expires_at.is.null,expires_at.gt\./));
  });

  describe('監査ログの権限 admin.audit.read', () => {
    it.each([
      ['admin', 'admin.audit.read', true],
      ['supporter', 'admin.orders.read', false],
      ['user', null, false],
    ] as const)('%s の ACL（%s）では監査ログの許可=%s', async (role, permission, allowed) => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({
        ok: true,
        claims: { ...adminClaims, app_metadata: { role } },
      });
      if (permission) {
        grantPermission(permission);
      } else {
        mockQuery.or.mockResolvedValue({ data: [], error: null });
      }

      const result = await authorizeAdminPermission('admin.audit.read', mockRequest);

      expect(result.ok).toBe(allowed);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((result.response as unknown as { body: unknown }).body).toEqual({
          error: 'Forbidden', permission: 'admin.audit.read', role,
        });
      }
      expect(mockQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(mockQuery.eq).toHaveBeenCalledWith('active', true);
    });

    it('店長でも DB の ACL に監査ログの権限がなければ拒否する', async () => {
      mockQuery.or.mockResolvedValue({ data: [], error: null });

      const result = await authorizeAdminPermission('admin.audit.read', mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((result.response as unknown as { body: unknown }).body).toEqual({
          error: 'Forbidden', permission: 'admin.audit.read', role: 'admin',
        });
      }
    });
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

  // 返金とショップの設定の権限は、店長（admin）の役割だけに付ける（グループ E-2 設計書 11-3）。
  // 認可は DB の ACL で決まる。ここでは、新しい権限の記号が通ること、ほかの権限では通らないことを確かめる
  describe.each(['admin.orders.refund', 'admin.settings.manage'] as const)('新しい権限 %s', (code) => {
    it('DB の ACL にその権限があれば通る', async () => {
      grantPermission(code);

      const result = await authorizeAdminPermission(code, mockRequest);

      expect(result.ok).toBe(true);
    });

    it('注文の管理の権限（admin.orders.manage）だけでは通らない', async () => {
      grantPermission('admin.orders.manage');

      const result = await authorizeAdminPermission(code, mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((result.response as unknown as { body: { permission: string } }).body.permission).toBe(code);
      }
    });
  });

  // 返品の権限は、店長（admin）とサポート（supporter）の両方の役割に付ける（グループ E-3 設計書 10-2）。
  // 認可は DB の ACL で決まる。ここでは、返品の権限が通ること、注文の管理の権限や返金の権限だけでは通らないこと
  // （返品と返金は別の権限）を確かめる
  describe('新しい権限 admin.orders.return', () => {
    it('DB の ACL にその権限があれば通る', async () => {
      grantPermission('admin.orders.return');

      const result = await authorizeAdminPermission('admin.orders.return', mockRequest);

      expect(result.ok).toBe(true);
    });

    it.each(['admin.orders.manage', 'admin.orders.refund'] as const)('%s だけでは通らない', async (granted) => {
      grantPermission(granted);

      const result = await authorizeAdminPermission('admin.orders.return', mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        expect((result.response as unknown as { body: { permission: string } }).body.permission).toBe('admin.orders.return');
      }
    });

    it('返品の権限だけでは、返金の権限が要る操作は通らない', async () => {
      grantPermission('admin.orders.return');

      const result = await authorizeAdminPermission('admin.orders.refund', mockRequest);

      expect(result.ok).toBe(false);
    });
  });
});

describe('legacyPermissionMap', () => {
  it('初期値は店長30・サポーター指定8・一般0だけ', () => {
    expect(legacyPermissionMap.admin.size).toBe(30);
    expect([...legacyPermissionMap.supporter].sort()).toEqual([
      'admin.contact.manage', 'admin.contact.read', 'admin.orders.manage', 'admin.orders.read',
      'admin.orders.return', 'admin.shipping.manage', 'admin.shipping.read', 'admin.users.read',
    ]);
    expect(legacyPermissionMap.user.size).toBe(0);
    expect(legacyPermissionMap.admin.has('admin.permissions.manage')).toBe(true);
  });
  it.each([
    ['admin', true],
    ['supporter', false],
    ['user', false],
  ] as const)('監査ログの権限は %s の組で %s', (role, allowed) => {
    expect(legacyPermissionMap[role].has('admin.audit.read')).toBe(allowed);
  });

  it('店長の組には返金とショップの設定の権限が入り、サポートの人の組には入らない', () => {
    expect(legacyPermissionMap.admin.has('admin.orders.refund')).toBe(true);
    expect(legacyPermissionMap.admin.has('admin.settings.manage')).toBe(true);
    expect(legacyPermissionMap.supporter.has('admin.orders.refund')).toBe(false);
    expect(legacyPermissionMap.supporter.has('admin.settings.manage')).toBe(false);
    expect(legacyPermissionMap.user.size).toBe(0);
  });

  it('返品の権限は店長の組にもサポートの人の組にも入る（額を決める返金とは別の権限）', () => {
    expect(legacyPermissionMap.admin.has('admin.orders.return')).toBe(true);
    expect(legacyPermissionMap.supporter.has('admin.orders.return')).toBe(true);
    expect(legacyPermissionMap.user.has('admin.orders.return')).toBe(false);
  });
});
