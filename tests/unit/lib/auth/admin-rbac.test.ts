jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init: { status: number }) => ({ status: init.status, body })),
  },
}));

import { authorizeAdminPermission, authorizeAdminPermissions, legacyPermissionMap } from '@/lib/auth/admin-rbac';
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

  // 在庫の入荷・棚卸は admin.stock.manage と admin.stock.read の両方が要る（グループ G-2）。
  // 複数の権限を要る操作は、全部を持つ時だけ通す。持つ権限は有効な全ての役割の和集合で数える
  describe('authorizeAdminPermissions（FREQ-540-AC-06）', () => {
    const REQUIRED = ['admin.stock.manage', 'admin.stock.read'] as const;
    const grantRoles = (...roles: string[][]) => {
      mockQuery.or.mockResolvedValue({
        data: roles.map((codes) => ({ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } })),
        error: null,
      });
    };
    const bodyOf = (result: Awaited<ReturnType<typeof authorizeAdminPermissions>>) =>
      (result as unknown as { response: { body: unknown } }).response.body;

    it('FREQ-540-AC-06: 要るコードを全部持てば通り、1つの役割にそろっていなくても有効な役割の和集合で数える', async () => {
      grantRoles(['admin.stock.manage', 'admin.stock.read']);
      const together = await authorizeAdminPermissions(REQUIRED, mockRequest);
      expect(together).toEqual({
        ok: true,
        userId: 'user-1',
        role: 'admin',
        actorEmail: 'user@example.com',
        permissions: new Set(['admin.stock.manage', 'admin.stock.read']),
      });

      grantRoles(['admin.stock.manage'], ['admin.stock.read', 'admin.orders.read']);
      const split = await authorizeAdminPermissions(REQUIRED, mockRequest);
      expect(split.ok).toBe(true);
      // 成功の結果の permissions は、有効な全ての役割の和集合（要るコード以外も含む。窓口が画面の出し分けに使う）
      expect(split.ok && split.permissions).toEqual(new Set(['admin.stock.manage', 'admin.stock.read', 'admin.orders.read']));
    });

    it.each([
      ['どちらも持たない', [['admin.items.read', 'admin.items.manage']], 'admin.stock.manage'],
      ['admin.stock.read だけ', [['admin.stock.read']], 'admin.stock.manage'],
      ['admin.stock.manage だけ', [['admin.stock.manage']], 'admin.stock.read'],
      ['役割が無い', [], 'admin.stock.manage'],
    ] as const)('FREQ-540-AC-06: %s なら 403 で、足りない最初のコードを permission に入れる', async (_name, roles, missing) => {
      grantRoles(...roles.map((codes) => [...codes]));

      const result = await authorizeAdminPermissions(REQUIRED, mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
      expect(bodyOf(result)).toEqual({ error: 'Forbidden', permission: missing, role: 'admin' });
    });

    it('要るコードの並びが足りない最初のコードを決める（持っていないコードのうち、先に渡した方）', async () => {
      grantRoles([]);

      const result = await authorizeAdminPermissions(['admin.stock.read', 'admin.stock.manage'], mockRequest);

      expect(bodyOf(result)).toEqual({ error: 'Forbidden', permission: 'admin.stock.read', role: 'admin' });
    });

    it('全部持っていても MFA（aal2）でなければ、既存と同じ本文で 403。permission は先頭の必要コード', async () => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: { ...adminClaims, aal: 'aal1' } });
      grantRoles(['admin.stock.manage', 'admin.stock.read']);

      const result = await authorizeAdminPermissions(REQUIRED, mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
      expect(bodyOf(result)).toEqual({ error: 'Forbidden', reason: 'MFA required', permission: 'admin.stock.manage', role: 'admin' });
    });

    it('足りないコードがあれば、MFA でなくても先に権限の 403 を返す（既存の単独版と同じ順）', async () => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: { ...adminClaims, aal: 'aal1' } });
      grantRoles(['admin.stock.read']);

      const result = await authorizeAdminPermissions(REQUIRED, mockRequest);

      expect(bodyOf(result)).toEqual({ error: 'Forbidden', permission: 'admin.stock.manage', role: 'admin' });
    });

    it.each(['missing', 'invalid'] as const)('トークンが通らない（%s）なら 401 で、DB は触らない', async (reason) => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason });

      const result = await authorizeAdminPermissions(REQUIRED, mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    it.each([['revoked', 401], ['unavailable', 503]] as const)('セッションが %s なら %i', async (liveness, status) => {
      (checkAuthSessionLiveness as jest.Mock).mockResolvedValue(liveness);
      grantRoles(['admin.stock.manage', 'admin.stock.read']);

      const result = await authorizeAdminPermissions(REQUIRED, mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(status);
    });

    it('要るコードの一覧が空なら、誰にも通さず 500（権限の確認なしで通る道を作らない）', async () => {
      grantRoles(['admin.stock.manage', 'admin.stock.read']);

      const result = await authorizeAdminPermissions([], mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(500);
    });

    it('authorizeAdminPermission(code) は authorizeAdminPermissions([code]) と同じ結果を返す', async () => {
      grantRoles(['admin.orders.read']);
      expect(await authorizeAdminPermission('admin.orders.read', mockRequest))
        .toEqual(await authorizeAdminPermissions(['admin.orders.read'], mockRequest));
      expect(bodyOf(await authorizeAdminPermission('admin.orders.manage', mockRequest)))
        .toEqual(bodyOf(await authorizeAdminPermissions(['admin.orders.manage'], mockRequest)));
    });
  });

  // 認可で断った要求を窓口が監査に残すための denial（波 4 Task 7）。actor が分かる拒否にだけ付ける
  describe('DD-STOCKIST-039: 断った要求に付く denial', () => {
    const grantCodes = (...codes: string[]) => {
      mockQuery.or.mockResolvedValue({
        data: [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }],
        error: null,
      });
    };
    const bodyOf = (result: Awaited<ReturnType<typeof authorizeAdminPermissions>>) =>
      (result as unknown as { response: { body: unknown } }).response.body;
    const denialOf = (result: Awaited<ReturnType<typeof authorizeAdminPermissions>>) =>
      result.ok ? undefined : result.denial;

    it('失効した session の 401 は、reason=session と最初に要ったコードを持つ', async () => {
      (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('revoked');
      grantCodes('admin.stockists.manage');

      const result = await authorizeAdminPermissions(['admin.stockists.manage', 'admin.stockists.read'], mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(denialOf(result)).toEqual({
        userId: 'user-1',
        email: 'user@example.com',
        role: 'admin',
        permission: 'admin.stockists.manage',
        reason: 'session',
      });
    });

    // 結び付き込みの生存の確かめは checkAuthSessionLiveness の中で切り替わる。admin-rbac は名前・引数を
    // 変えずに呼ぶだけで、結び付いていない session（liveness が revoked）は ACL が有っても 401 になる。
    it('DD-AUTH-039 結び付いていない session は ACL を持っていても 401 で、session_id を渡して確かめる', async () => {
      (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('revoked');
      grantCodes('admin.stockists.manage');

      const result = await authorizeAdminPermission('admin.stockists.manage', mockRequest);

      expect(checkAuthSessionLiveness).toHaveBeenCalledWith('session-1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    });

    it('足りない権限の 403 は、reason=permission と足りない最初のコードを持つ', async () => {
      grantCodes('admin.stockists.read');

      const result = await authorizeAdminPermissions(['admin.stockists.read', 'admin.stockists.manage'], mockRequest);

      if (!result.ok) expect(result.response.status).toBe(403);
      expect(denialOf(result)).toEqual({
        userId: 'user-1',
        email: 'user@example.com',
        role: 'admin',
        permission: 'admin.stockists.manage',
        reason: 'permission',
      });
    });

    it('aal1 の 403 は、reason=mfa と先頭の要るコードを持つ', async () => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: true, claims: { ...adminClaims, aal: 'aal1' } });
      grantCodes('admin.stockists.manage');

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      if (!result.ok) expect(result.response.status).toBe(403);
      expect(denialOf(result)).toEqual({
        userId: 'user-1',
        email: 'user@example.com',
        role: 'admin',
        permission: 'admin.stockists.manage',
        reason: 'mfa',
      });
    });

    it('メールの無い token は email=null、app_metadata の役割が無ければ role=user', async () => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({
        ok: true,
        claims: { sub: 'user-2', session_id: 's-2', aal: 'aal2' },
      });
      mockQuery.or.mockResolvedValue({ data: [], error: null });

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      expect(denialOf(result)).toEqual({
        userId: 'user-2',
        email: null,
        role: 'user',
        permission: 'admin.stockists.manage',
        reason: 'permission',
      });
    });

    it.each(['missing', 'invalid'] as const)('token の無い・通らない 401（%s）には denial が無い', async (reason) => {
      (verifyAccessToken as jest.Mock).mockResolvedValue({ ok: false, reason });

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect('denial' in result).toBe(false);
    });

    it('失効を確認できない 503 には denial が無い', async () => {
      (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('unavailable');
      grantCodes('admin.stockists.manage');

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      if (!result.ok) expect(result.response.status).toBe(503);
      expect('denial' in result).toBe(false);
    });

    it('内部の誤りの 500 には denial が無い', async () => {
      (verifyAccessToken as jest.Mock).mockRejectedValue(new Error('boom'));

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      if (!result.ok) expect(result.response.status).toBe(500);
      expect('denial' in result).toBe(false);
    });

    it('denial を足しても、断った応答の本文は変わらない', async () => {
      grantCodes('admin.stockists.read');

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      expect(bodyOf(result)).toEqual({ error: 'Forbidden', permission: 'admin.stockists.manage', role: 'admin' });
    });

    it('成功の結果の形は変わらず、denial を持たない', async () => {
      grantCodes('admin.stockists.manage');

      const result = await authorizeAdminPermissions(['admin.stockists.manage'], mockRequest);

      expect(result).toEqual({
        ok: true,
        userId: 'user-1',
        role: 'admin',
        actorEmail: 'user@example.com',
        permissions: new Set(['admin.stockists.manage']),
      });
      expect('denial' in result).toBe(false);
    });
  });
});

describe('legacyPermissionMap', () => {
  it('FREQ-543-AC-01: 初期値は店長32・サポーター指定8・一般0だけ', () => {
    expect(legacyPermissionMap.admin.size).toBe(32);
    expect(legacyPermissionMap.admin.has('admin.discounts.read')).toBe(true);
    expect(legacyPermissionMap.admin.has('admin.discounts.manage')).toBe(true);
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
