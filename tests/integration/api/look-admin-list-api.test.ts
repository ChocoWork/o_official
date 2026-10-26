export {};

// 窓口・認可（admin-rbac）・署名（look-images）は本物を通し、外との境目（Supabase の client・token の検証・応答の型）だけを差し替える。
// LOOK の管理の窓口は DB も置き場も service role の client 1つで触るので、差し替える client もその1つだけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { GET } = require('@/app/api/admin/looks/route');

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type TableOp = { table: string; calls: Call[] };

function createFakeClient(tables: Record<string, Result>, sign?: (path: string, expiresIn: number) => Result) {
  const ops: TableOp[] = [];
  const signCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  const rpcCalls: string[] = [];
  const client = {
    ops,
    signCalls,
    rpcCalls,
    rpc: jest.fn(async (name: string) => {
      rpcCalls.push(name);
      return { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const op: TableOp = { table, calls: [] };
      ops.push(op);
      const result = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          op.calls.push([m, args]);
          return builder;
        };
      }
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
    storage: {
      from: jest.fn((bucket: string) => ({
        createSignedUrl: jest.fn(async (path: string, expiresIn: number) => {
          signCalls.push({ bucket, path, expiresIn });
          return sign
            ? sign(path, expiresIn)
            : { data: { signedUrl: `https://signed.example/${path}?e=${expiresIn}` }, error: null };
        }),
      })),
    },
  };
  return client;
}

function aclRows(codes: string[]) {
  return [{ roles: { role_permissions: codes.map((code) => ({ permissions: { code } })) } }];
}

function makeRequest() {
  return { headers: { get: () => null } } as unknown as Request;
}

const ROWS = [
  {
    id: 2,
    season_year: 2026,
    season_type: 'AW',
    theme: 'Newer',
    theme_description: '',
    image_urls: ['looks/2026-10-20/b.jpg', 'looks/2026-10-20/c.png'],
    status: 'private',
    created_at: '2026-10-20T00:00:00Z',
    look_items: [{ item_id: 5 }],
  },
  {
    id: 1,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Older',
    theme_description: 'desc',
    image_urls: [],
    status: 'published',
    created_at: '2026-04-01T00:00:00Z',
    look_items: [],
  },
];

let serviceClient: ReturnType<typeof createFakeClient>;

function setup(
  options: {
    looksResult?: Result;
    codes?: string[];
    aal?: string;
    verified?: unknown;
    liveness?: string;
    sign?: (path: string, expiresIn: number) => Result;
  } = {},
) {
  serviceClient = createFakeClient(
    {
      looks: options.looksResult ?? { data: ROWS, error: null },
      user_roles: { data: aclRows(options.codes ?? ['admin.looks.read']), error: null },
      audit_logs: { data: null, error: null },
    },
    options.sign,
  );
  createServiceRoleClient.mockResolvedValue(serviceClient);
  verifyAccessToken.mockResolvedValue(
    options.verified ?? {
      ok: true,
      claims: { sub: 'admin-1', session_id: 'sess-1', aal: options.aal ?? 'aal2', app_metadata: { role: 'admin' } },
    },
  );
  checkAuthSessionLiveness.mockResolvedValue(options.liveness ?? 'active');
}

function looksOp() {
  return serviceClient.ops.find((o) => o.table === 'looks');
}

describe('GET /api/admin/looks（管理の LOOK の一覧）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API-LOOK-001 非公開を含む全部の列を作った日時の新しい順に取り、200 で data を返す', async () => {
    setup();

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([2, 1]);
    expect(body.data[0].status).toBe('private');
    expect(looksOp()?.calls.map(([m]) => m)).toEqual(['select', 'order']);
    expect(looksOp()?.calls[1]).toEqual(['order', ['created_at', { ascending: false }]]);
    // status で絞らない・件数の上限もページ分けも付けない
    expect(looksOp()?.calls.some(([m]) => ['eq', 'in', 'limit'].includes(m))).toBe(false);
  });

  it('API-LOOK-001 関連の look_items(item_id) を同じ取り出しで付け、行の他の列はそのまま返す', async () => {
    setup();

    const body = await (await GET(makeRequest())).json();

    const selectArg = looksOp()?.calls[0][1][0] as string;
    expect(selectArg).toContain('look_items(item_id)');
    expect(selectArg).toContain('image_urls');
    expect(body.data[0]).toMatchObject({
      season_year: 2026,
      season_type: 'AW',
      theme: 'Newer',
      look_items: [{ item_id: 5 }],
    });
  });

  it('API-LOOK-001 image_urls を期限 3600 秒の署名つき URL に置き換え、画像の無い LOOK は空の配列で返す', async () => {
    setup();

    const body = await (await GET(makeRequest())).json();

    expect(body.data[0].image_urls).toEqual([
      'https://signed.example/looks/2026-10-20/b.jpg?e=3600',
      'https://signed.example/looks/2026-10-20/c.png?e=3600',
    ]);
    expect(body.data[1].image_urls).toEqual([]);
    expect(serviceClient.signCalls).toEqual([
      { bucket: 'look-images', path: 'looks/2026-10-20/b.jpg', expiresIn: 3600 },
      { bucket: 'look-images', path: 'looks/2026-10-20/c.png', expiresIn: 3600 },
    ]);
  });

  it('API-LOOK-001 image_urls が null の行は署名せず空の配列で返す', async () => {
    setup({ looksResult: { data: [{ ...ROWS[0], image_urls: null }], error: null } });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].image_urls).toEqual([]);
    expect(serviceClient.signCalls).toHaveLength(0);
  });

  it('API-LOOK-001 署名に失敗した画像は元の値のまま返し、一覧自体は 200 にする', async () => {
    setup({ sign: () => ({ data: null, error: { message: 'not found' } }) });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].image_urls).toEqual(['looks/2026-10-20/b.jpg', 'looks/2026-10-20/c.png']);
  });

  it('API-LOOK-001 表が null を返した時は空の一覧を 200 で返す', async () => {
    setup({ looksResult: { data: null, error: null } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], meta: { canManage: false } });
  });

  it('API-LOOK-001 admin.looks.manage を持つ人には meta.canManage を true で返し、data は変えない', async () => {
    setup({ codes: ['admin.looks.read', 'admin.looks.manage'] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta).toEqual({ canManage: true });
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([2, 1]);
  });

  it('API-LOOK-001 読み出しだけの人にも一覧は返し、meta.canManage は false にする（権限が無いための 403 だけを false にする）', async () => {
    setup({ codes: ['admin.looks.read'] });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta).toEqual({ canManage: false });
    expect(body.data).toHaveLength(2);
  });

  it('API-LOOK-001 meta.canManage を決める確かめ（manage）が 503 になる時はその 503 をそのまま返し、表を読まない', async () => {
    setup({ codes: ['admin.looks.read', 'admin.looks.manage'] });
    // 1回目（read）は active、2回目（manage）は確認できない
    checkAuthSessionLiveness.mockResolvedValueOnce('active').mockResolvedValueOnce('unavailable');

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 表は service role の client で読み、利用者の JWT の client は使わない', async () => {
    setup();

    await GET(makeRequest());

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(looksOp()).toBeDefined();
  });

  it('API-LOOK-001 一覧の読みは監査に残さず、回数の制限も数えない', async () => {
    setup();

    await GET(makeRequest());

    expect(serviceClient.ops.some((o) => o.table === 'audit_logs')).toBe(false);
    expect(serviceClient.rpcCalls).toEqual([]);
  });

  it('API-LOOK-001 admin.looks.read の権限を確かめ、manage だけでは 403 で表を読まない', async () => {
    setup({ codes: ['admin.looks.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Forbidden', permission: 'admin.looks.read' });
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 ほかの領域の権限（news）だけでは 403 で断る', async () => {
    setup({ codes: ['admin.news.read', 'admin.news.manage'] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 aal2 でない session は 403 MFA required で断る', async () => {
    setup({ aal: 'aal1' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'MFA required', permission: 'admin.looks.read' });
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 token が無効なら 401 で断る', async () => {
    setup({ verified: { ok: false, reason: 'invalid' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 session が失効していれば 401 で断る', async () => {
    setup({ liveness: 'revoked' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(looksOp()).toBeUndefined();
  });

  it('API-LOOK-001 session の確認ができない時は 503 と Retry-After で断る', async () => {
    setup({ liveness: 'unavailable' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
  });

  it('API-LOOK-001 表の読みが失敗したら 500 Failed to fetch looks を返し、署名しない', async () => {
    setup({ looksResult: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch looks' });
    expect(serviceClient.signCalls).toHaveLength(0);
  });

  it('API-LOOK-001 認可の後の client の用意で例外が出たら 500 Internal server error を返す', async () => {
    setup();
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可（read）の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => serviceClient); // 認可（manage）の ACL の照会
    createServiceRoleClient.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
