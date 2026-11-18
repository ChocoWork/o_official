/**
 * DD-AUTH-083 Google のログインの戻りの窓口で、店員がフックに断られた時に、ログイン画面へ固定の符号で戻す。
 * Cookie もセッションも作らない。
 */
const enforceRateLimitMock = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));
const logAuditMock = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => logAuditMock(...args) }));
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  resolveReturnDestination: jest.fn(),
  applyReturnIntentCookie: jest.fn(),
}));
const persistSessionAndCookiesMock = jest.fn();
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => persistSessionAndCookiesMock(...args),
}));
const exchangeCodeForSessionMock = jest.fn();
jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { exchangeCodeForSession: exchangeCodeForSessionMock } }),
}));
const cookieSetMock = jest.fn();
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
    redirect: (url: URL, init?: { status?: number }) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: cookieSetMock },
    }),
  },
}));

const MARKER_MESSAGE = '[staff-passkey-required] staff must sign in with a passkey';
const OAUTH_ENV_KEYS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

async function callGet(query: string) {
  const { GET } = await import('@/app/api/auth/oauth/callback/route');
  return (await GET(new Request(`http://localhost:3000/api/auth/oauth/callback${query}`))) as unknown as {
    status: number;
    headers: Map<string, string>;
  };
}

describe('DD-AUTH-083 Google の戻りで店員が断られた時', () => {
  const saved: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string | undefined>> = {};
  beforeAll(() => {
    for (const key of OAUTH_ENV_KEYS) saved[key] = process.env[key];
  });
  afterAll(() => {
    for (const key of OAUTH_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    enforceRateLimitMock.mockResolvedValue(undefined);
    logAuditMock.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('DD-AUTH-083 交換がフックの印つき 403 で失敗したら、/login?error=staff_passkey_required へ 303 で戻り、保存も Cookie もしない', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, message: MARKER_MESSAGE } });

    const res = await callGet('?code=staff');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=staff_passkey_required');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: 'staff_passkey_required', metadata: { error: null } }));
  });

  it('DD-AUTH-083 GoTrue が戻りの URL に誤りを付けて来た時（code が無く error_description が印で始まる）も同じ行き先へ戻る', async () => {
    const res = await callGet(`?error=access_denied&error_description=${encodeURIComponent(MARKER_MESSAGE)}`);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=staff_passkey_required');
    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
    expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
    expect(cookieSetMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ detail: 'staff_passkey_required' }));
  });

  it('DD-AUTH-083 印の無い誤りは今までどおり（code が無ければ 400、交換の失敗は 502）', async () => {
    expect((await callGet('?error=access_denied&error_description=other')).status).toBe(400);
    exchangeCodeForSessionMock.mockResolvedValue({ data: { session: null, user: null }, error: { status: 400, message: 'bad' } });
    expect((await callGet('?code=x')).status).toBe(502);
  });
});
export {};
