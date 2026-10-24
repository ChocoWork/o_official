/** @jest-environment node */
export {};

// 守りの部品（admin-security）の CSRF の確かめを、本物の NextResponse（本番と同じ Response の道）で確かめる。
// stockist-admin-guards.test.ts は next/server を差し替えるので、本番の「Response のまま返す」道をここで通す。
// 差し替えるのは外との境目（Supabase の client・Cookie と見出し・token の hash）だけ
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

// tests/setupRequestPolyfill.js が Response を node-fetch の物に替えていて、静的な json が無い。NextResponse.json が使うので足す
const polyfilledResponse = Response as unknown as { json?: (body: unknown, init?: ResponseInit) => Response };
if (typeof polyfilledResponse.json !== 'function') {
  polyfilledResponse.json = (body, init) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
    });
}

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { cookies, headers } = require('next/headers');
const security = require('@/features/stockist/services/admin-security');

function setBrowser(options: { refreshToken?: string; csrfHeader?: string | null }) {
  cookies.mockResolvedValue({
    get: (name: string) => (name === 'sb-refresh-token' && options.refreshToken ? { value: options.refreshToken } : undefined),
  });
  headers.mockResolvedValue({
    get: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? options.csrfHeader ?? null : null),
  });
}

function setSessions(options: { storedHash?: string | null; throws?: boolean }) {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) builder[m] = () => builder;
  builder.maybeSingle = async () => {
    if (options.throws) throw new Error('sessions down');
    return { data: options.storedHash === undefined ? null : { csrf_token_hash: options.storedHash }, error: null };
  };
  createServiceRoleClient.mockResolvedValue({ from: jest.fn(() => builder) });
}

describe('取扱店の CSRF の確かめと本物の Response（ARC-STOCKIST-003）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ARC-STOCKIST-003 token が違う時、共有の確かめの 403 の Response をそのまま窓口の応答にする', async () => {
    setSessions({ storedHash: 'hash(other)' });
    setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

    const result = await security.requireAdminStockistCsrf();
    const deny = security.toCsrfDenyResponse(result);

    expect(result).toBeInstanceOf(Response);
    expect(deny).toBe(result);
    expect(deny.status).toBe(403);
    expect(await deny.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
  });

  it('ARC-STOCKIST-003 x-csrf-token の見出しが無い時も 403 の Response をそのまま返す', async () => {
    setSessions({ storedHash: 'hash(csrf-ok)' });
    setBrowser({ refreshToken: 'refresh-1' });

    const result = await security.requireAdminStockistCsrf();

    expect(security.toCsrfDenyResponse(result)).toBe(result);
    expect(result.status).toBe(403);
  });

  it('ARC-STOCKIST-003 照合の DB が失敗した時は 500 の Response をそのまま返す', async () => {
    setSessions({ throws: true });
    setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

    const result = await security.requireAdminStockistCsrf();
    const deny = security.toCsrfDenyResponse(result);

    expect(deny).toBe(result);
    expect(deny.status).toBe(500);
    expect(await deny.json()).toEqual({ error: 'Internal server error' });
  });

  it('ARC-STOCKIST-003 token が合えば何も返さず、通す（null）', async () => {
    setSessions({ storedHash: 'hash(csrf-ok)' });
    setBrowser({ refreshToken: 'refresh-1', csrfHeader: 'csrf-ok' });

    const result = await security.requireAdminStockistCsrf();

    expect(result).toBeUndefined();
    expect(security.toCsrfDenyResponse(result)).toBeNull();
  });
});
