export {};

// 取扱店の守りの部品（admin-security）を、共有の回数の数え（rateLimit と ratelimit）と CSRF の照合（csrfMiddleware）を
// 本物のまま通して確かめる。差し替えるのは外との境目（Supabase の client・Cookie と見出し・token の hash・応答の型）だけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      _body: body,
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

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn(async (value: string) => `hash(${value})`),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { cookies, headers } = require('next/headers');
const security = require('@/features/stockist/services/admin-security');
const listRoute = require('@/app/api/admin/stockists/route');
const itemRoute = require('@/app/api/admin/stockists/[id]/route');

type Result = { data: unknown; error: unknown };
type RpcArgs = Record<string, unknown>;

const NOW = Date.parse('2026-10-24T12:34:56Z');
const WINDOW_START = '2026-10-24T12:30:00.000Z';

function createServiceClient(options: { count?: (args: RpcArgs) => Result; storedHash?: string | null; sessionsThrows?: boolean } = {}) {
  const rpcCalls: RpcArgs[] = [];
  const sessionQueries: unknown[][] = [];
  const stockistsWrites: string[] = [];
  return {
    rpcCalls,
    sessionQueries,
    stockistsWrites,
    rpc: jest.fn(async (_name: string, args: RpcArgs) => {
      rpcCalls.push(args);
      return options.count ? options.count(args) : { data: 1, error: null };
    }),
    from: jest.fn((table: string) => {
      const builder: Record<string, unknown> = {};
      // 取扱店の書き込みは認可の後に service role の client で行う（ADR-0267）。更新・削除は .select() で返る 1 行を返す（0 行は 404 になる）
      let written: string | null = null;
      const result = (): Result => {
        if (table === 'stockists') {
          const data =
            written === 'update'
              ? [{ id: 7 }]
              : written === 'delete'
                ? [{ id: 7, name: 'A Shop', address: 'Tokyo', status: 'published' }]
                : { id: 1 };
          return { data, error: null };
        }
        if (table === 'user_roles') {
          return {
            data: [{ roles: { role_permissions: ['admin.stockists.read', 'admin.stockists.manage'].map((code) => ({ permissions: { code } })) } }],
            error: null,
          };
        }
        return { data: null, error: null };
      };
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order']) {
        builder[m] = (...args: unknown[]) => {
          if (table === 'sessions') sessionQueries.push([m, ...args]);
          if (table === 'stockists' && written === null && (m === 'insert' || m === 'update' || m === 'delete')) {
            written = m;
            stockistsWrites.push(m);
          }
          return builder;
        };
      }
      builder.maybeSingle = async () => {
        if (options.sessionsThrows) throw new Error('sessions down');
        return { data: options.storedHash === undefined ? null : { csrf_token_hash: options.storedHash }, error: null };
      };
      builder.single = () => Promise.resolve(result());
      builder.then = (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR);
      return builder;
    }),
  };
}

function makeRequest(forwarded: string | null = '203.0.113.9') {
  return {
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'x-forwarded-for') return forwarded;
        if (key === 'user-agent') return 'jest-agent';
        return null;
      },
    },
    json: jest.fn(async () => ({
      name: 'A Shop',
      address: 'Tokyo',
      phone: '03',
      time: '11-19',
      holiday: 'Mon',
      status: 'published',
    })),
  } as unknown as Request & { json: jest.Mock };
}

function setBrowser(options: { refreshToken?: string; csrfHeader?: string | null }) {
  cookies.mockResolvedValue({
    get: (name: string) => (name === 'sb-refresh-token' && options.refreshToken ? { value: options.refreshToken } : undefined),
  });
  headers.mockResolvedValue({
    get: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? options.csrfHeader ?? null : null),
  });
}

let service: ReturnType<typeof createServiceClient>;

function setupRoute(serviceOptions: Parameters<typeof createServiceClient>[0] = {}) {
  service = createServiceClient(serviceOptions);
  const userClient = {
    from: jest.fn(() => {
      const builder: Record<string, unknown> = {};
      let written: string | null = null;
      for (const m of ['insert', 'update', 'delete', 'select', 'eq', 'order']) {
        builder[m] = () => {
          if (written === null && (m === 'insert' || m === 'update' || m === 'delete')) written = m;
          return builder;
        };
      }
      builder.single = () => Promise.resolve({ data: { id: 1 }, error: null });
      // 更新・削除は .select() で返る 1 行を返す（0 行は 404 になる）
      builder.then = (onF: (v: Result) => unknown) => {
        const data =
          written === 'update'
            ? [{ id: 7 }]
            : written === 'delete'
              ? [{ id: 7, name: 'A Shop', address: 'Tokyo', status: 'published' }]
              : null;
        return Promise.resolve({ data, error: null }).then(onF);
      };
      return builder;
    }),
  };
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(service);
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: 'admin-1', session_id: 'sess-1', aal: 'aal2', app_metadata: { role: 'admin' } },
  });
  checkAuthSessionLiveness.mockResolvedValue('active');
  return userClient;
}

describe('取扱店の守りの部品（ARC-STOCKIST-003）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowser({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('回数の制限', () => {
    it('ARC-STOCKIST-003 読みの枠は名前 admin:stockists:read で、600 秒ごとの窓に送り元と操作者の2本を数える', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);

      const res = await security.enforceAdminStockistReadRateLimit(makeRequest('203.0.113.9, 10.0.0.1'), 'admin-1');

      expect(res).toBeUndefined();
      expect(service.rpcCalls).toHaveLength(2);
      expect(service.rpcCalls[0]).toEqual({ _ip: '203.0.113.9', _endpoint: 'admin:stockists:read', _bucket: WINDOW_START });
      expect(service.rpcCalls[1]._ip).toBeNull();
      expect(service.rpcCalls[1]._bucket).toBe(WINDOW_START);
      expect(String(service.rpcCalls[1]._endpoint)).toMatch(/^admin:stockists:read\|acct:[0-9a-f]{128}$/);
    });

    it('ARC-STOCKIST-003 変更の枠は名前 admin:stockists:mutation で、読みの枠とは別に数える', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);

      const res = await security.enforceAdminStockistMutationRateLimit(makeRequest(), 'admin-1');

      expect(res).toBeUndefined();
      expect(service.rpcCalls.map((c) => String(c._endpoint).split('|')[0])).toEqual([
        'admin:stockists:mutation',
        'admin:stockists:mutation',
      ]);
    });

    it('ARC-STOCKIST-003 操作者の枠は操作者ごとに別で、同じ ID なら同じ枠、違う ID なら違う枠に数える', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);

      await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-1');
      await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-1');
      await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-2');

      const actorEndpoints = service.rpcCalls.filter((c) => c._ip === null).map((c) => c._endpoint);
      expect(actorEndpoints[0]).toBe(actorEndpoints[1]);
      expect(actorEndpoints[2]).not.toBe(actorEndpoints[0]);
      expect(actorEndpoints.join(' ')).not.toContain('admin-1');
    });

    it('ARC-STOCKIST-003 窓が 600 秒を越えると新しい窓の数えに移る', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);

      await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-1');
      (Date.now as jest.Mock).mockReturnValue(NOW + 600_000);
      await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-1');

      expect(service.rpcCalls[0]._bucket).toBe(WINDOW_START);
      expect(service.rpcCalls[2]._bucket).toBe('2026-10-24T12:40:00.000Z');
    });

    it.each([
      { label: '読み', fn: 'enforceAdminStockistReadRateLimit', limit: 120 },
      { label: '変更', fn: 'enforceAdminStockistMutationRateLimit', limit: 20 },
    ])('ARC-STOCKIST-003 $labelの回数が $limit 回ちょうどなら通し、1 回超えたら 429 と Retry-After 600 で断る', async ({ fn, limit }) => {
      service = createServiceClient({ count: () => ({ data: limit, error: null }) });
      createServiceRoleClient.mockResolvedValue(service);
      expect(await security[fn](makeRequest(), 'admin-1')).toBeUndefined();

      service = createServiceClient({ count: () => ({ data: limit + 1, error: null }) });
      createServiceRoleClient.mockResolvedValue(service);
      const res = await security[fn](makeRequest(), 'admin-1');

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(await res.json()).toEqual({ error: 'Too many requests' });
    });

    it('ARC-STOCKIST-003 送り元の枠を先に見て、超えていれば操作者の枠は数えない', async () => {
      service = createServiceClient({ count: () => ({ data: 1000, error: null }) });
      createServiceRoleClient.mockResolvedValue(service);

      const res = await security.enforceAdminStockistMutationRateLimit(makeRequest(), 'admin-1');

      expect(res.status).toBe(429);
      expect(service.rpcCalls).toHaveLength(1);
      expect(service.rpcCalls[0]._ip).toBe('203.0.113.9');
    });

    it('ARC-STOCKIST-003 送り元の見出しを偽って変えても、操作者の枠を超えていれば 429 で断る', async () => {
      service = createServiceClient({ count: (args) => ({ data: args._ip === null ? 21 : 1, error: null }) });
      createServiceRoleClient.mockResolvedValue(service);

      const res = await security.enforceAdminStockistMutationRateLimit(makeRequest('198.51.100.77'), 'admin-1');

      expect(res.status).toBe(429);
      expect(service.rpcCalls).toHaveLength(2);
    });

    it('ARC-STOCKIST-003 数えの DB が使えない時は 503 と Retry-After 600 で断る', async () => {
      service = createServiceClient({ count: () => ({ data: null, error: { message: 'rpc down' } }) });
      createServiceRoleClient.mockResolvedValue(service);

      const res = await security.enforceAdminStockistReadRateLimit(makeRequest(), 'admin-1');

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    });

    it('ARC-STOCKIST-003 送り元の見出しが無ければ 127.0.0.1 の枠に数える', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);

      await security.enforceAdminStockistReadRateLimit(makeRequest(null), 'admin-1');

      expect(service.rpcCalls[0]._ip).toBe('127.0.0.1');
    });
  });

  describe('CSRF の token', () => {
    it('ARC-STOCKIST-003 refresh の Cookie が無ければ確かめず通す', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);
      setBrowser({});

      const result = await security.requireAdminStockistCsrf();

      expect(result).toBeUndefined();
      expect(security.toCsrfDenyResponse(result)).toBeNull();
      expect(service.sessionQueries).toEqual([]);
    });

    it('ARC-STOCKIST-003 Cookie があるのに x-csrf-token の見出しが無ければ 403 の拒否にする', async () => {
      service = createServiceClient();
      createServiceRoleClient.mockResolvedValue(service);
      setBrowser({ refreshToken: 'refresh-1' });

      const deny = security.toCsrfDenyResponse(await security.requireAdminStockistCsrf());

      expect(deny.status).toBe(403);
      expect(await deny.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
      expect(service.sessionQueries).toEqual([]);
    });

    it('ARC-STOCKIST-003 session の token の hash と見出しの hash が合えば通す', async () => {
      service = createServiceClient({ storedHash: 'hash(csrf-ok)' });
      createServiceRoleClient.mockResolvedValue(service);
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

      const result = await security.requireAdminStockistCsrf();

      expect(security.toCsrfDenyResponse(result)).toBeNull();
      expect(service.sessionQueries).toContainEqual(['eq', 'refresh_token_hash', 'hash(refresh-1)']);
    });

    it('ARC-STOCKIST-003 URL の符号化をされた見出しの token も元に戻して照合する', async () => {
      service = createServiceClient({ storedHash: 'hash(a b)' });
      createServiceRoleClient.mockResolvedValue(service);
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'a%20b' });

      expect(security.toCsrfDenyResponse(await security.requireAdminStockistCsrf())).toBeNull();
    });

    it('ARC-STOCKIST-003 token が session のものと違う時も、session に token が無い時も 403 で拒む', async () => {
      for (const storedHash of ['hash(other)', null, undefined]) {
        service = createServiceClient({ storedHash });
        createServiceRoleClient.mockResolvedValue(service);
        setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

        const deny = security.toCsrfDenyResponse(await security.requireAdminStockistCsrf());

        expect(deny.status).toBe(403);
        expect(await deny.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
      }
    });

    it('ARC-STOCKIST-003 照合の DB が失敗したら 500 で拒む', async () => {
      service = createServiceClient({ sessionsThrows: true });
      createServiceRoleClient.mockResolvedValue(service);
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

      const deny = security.toCsrfDenyResponse(await security.requireAdminStockistCsrf());

      expect(deny.status).toBe(500);
      expect(await deny.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('窓口に差し込んだ守り', () => {
    it('ARC-STOCKIST-003 refresh の Cookie があって token が違えば、変更の窓口は 403 で断って入力も表も読まない', async () => {
      const userClient = setupRoute({ storedHash: 'hash(other)' });
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });
      const request = makeRequest();

      const res = await listRoute.POST(request);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
      expect(request.json).not.toHaveBeenCalled();
      expect(userClient.from).not.toHaveBeenCalled();
      expect(service.stockistsWrites).toEqual([]);
    });

    it('ARC-STOCKIST-003 token が合えば変更の窓口は進み、6つの窓口のうち変更の4つが同じ守りを通る', async () => {
      setupRoute({ storedHash: 'hash(csrf-ok)' });
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });
      const params = { params: Promise.resolve({ id: '7' }) };

      expect((await listRoute.POST(makeRequest())).status).toBe(201);
      expect((await itemRoute.PUT(makeRequest(), params)).status).toBe(200);
      expect((await itemRoute.PATCH(makeRequest(), params)).status).toBe(200);
      expect((await itemRoute.DELETE(makeRequest(), params)).status).toBe(200);
      const mutationRpcs = service.rpcCalls.filter((c) => String(c._endpoint).startsWith('admin:stockists:mutation'));
      expect(mutationRpcs).toHaveLength(8);
      expect(service.stockistsWrites).toEqual(['insert', 'update', 'update', 'delete']);
      expect(createClient).not.toHaveBeenCalled();
    });

    it('ARC-STOCKIST-003 読みの窓口は CSRF の token を求めず、読みの枠で数える', async () => {
      setupRoute({ storedHash: 'hash(other)' });
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'wrong' });

      const res = await listRoute.GET(makeRequest());

      expect(res.status).toBe(200);
      expect(service.sessionQueries).toEqual([]);
      expect(service.rpcCalls.every((c) => String(c._endpoint).startsWith('admin:stockists:read'))).toBe(true);
    });

    it('ARC-STOCKIST-003 回数の制限は CSRF の token の確かめより前で、枠を超えた要求は照合の DB を引かない', async () => {
      setupRoute({ count: () => ({ data: 21, error: null }), storedHash: 'hash(csrf-ok)' });
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

      const res = await listRoute.POST(makeRequest());

      expect(res.status).toBe(429);
      expect(service.sessionQueries).toEqual([]);
    });

    // 現状の動きの記録。認可で断った要求を回数の枠に数えないのは SEC-STOCKIST-020 を満たさない欠け。直したらこの件を直す。
    it('ARC-STOCKIST-003 現状の記録 認可で断られた要求は回数の枠にも CSRF の照合にも数えない', async () => {
      setupRoute({ storedHash: 'hash(csrf-ok)' });
      setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });

      const res = await listRoute.POST(makeRequest());

      expect(res.status).toBe(401);
      expect(service.rpcCalls).toEqual([]);
      expect(service.sessionQueries).toEqual([]);
    });
  });
});
