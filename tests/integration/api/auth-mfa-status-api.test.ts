/**
 * MFA 状態の窓口（API-AUTH-016）の結合テスト。
 * 認証・Supabase を差し替え、役割・AAL・確かめ済みの要素から答えを組み立てる分岐を確かめる。
 */
export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: (reason: string) =>
    require('next/server').NextResponse.json(
      { error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' },
      { status: reason === 'unavailable' ? 503 : 401 },
    ),
}));

const { createClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');

const makeRequest = () => new Request('http://localhost/api/auth/mfa/status');

function setup(opts: {
  role?: unknown;
  aal?: { data: unknown; error: unknown };
  factors?: { data: unknown; error: unknown };
}) {
  authenticateRequest.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: opts.role === undefined ? {} : { role: opts.role } },
  });
  const mfa = {
    getAuthenticatorAssuranceLevel: jest
      .fn()
      .mockResolvedValue(opts.aal ?? { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }),
    listFactors: jest.fn().mockResolvedValue(opts.factors ?? { data: { totp: [], phone: [] }, error: null }),
  };
  createClient.mockResolvedValue({ auth: { mfa } });
  return mfa;
}

describe('GET /api/auth/mfa/status', () => {
  let GET: (request: Request) => Promise<{ status: number; json: () => Promise<any> }>;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    GET = require('@/app/api/auth/mfa/status/route').GET;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('API-AUTH-016 認証に失敗したら共有の部品の応答（401）をそのまま返し、要素を引かない', async () => {
    const mfa = setup({});
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mfa.listFactors).not.toHaveBeenCalled();
  });

  test('API-AUTH-016 認証の部品が使えない時は 503 を返す', async () => {
    setup({});
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
  });

  test('API-AUTH-016 管理者で確かめ済みの TOTP があり aal1 なら needsChallenge を true で返す', async () => {
    setup({
      role: 'admin',
      aal: { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null },
      factors: {
        data: {
          totp: [{ id: 'f-1', factor_type: 'totp', status: 'verified', friendly_name: 'Phone' }],
          phone: [],
        },
        error: null,
      },
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      role: 'admin',
      isPrivileged: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
      hasVerifiedFactor: true,
      needsChallenge: true,
      factors: [{ id: 'f-1', factorType: 'totp', friendlyName: 'Phone' }],
    });
  });

  test('API-AUTH-016 サポーターも特権として扱い、すでに aal2 なら needsChallenge は false', async () => {
    setup({
      role: 'supporter',
      aal: { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null },
      factors: { data: { totp: [{ id: 'f-1', factor_type: 'totp', status: 'verified' }], phone: [] }, error: null },
    });

    const body = await (await GET(makeRequest())).json();

    expect(body.data.isPrivileged).toBe(true);
    expect(body.data.needsChallenge).toBe(false);
  });

  test('API-AUTH-016 確かめ済みの要素が無ければ hasVerifiedFactor と needsChallenge は false で要素は空', async () => {
    setup({
      role: 'admin',
      aal: { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null },
      factors: {
        data: { totp: [{ id: 'f-u', factor_type: 'totp', status: 'unverified' }], phone: [] },
        error: null,
      },
    });

    const body = await (await GET(makeRequest())).json();

    expect(body.data.hasVerifiedFactor).toBe(false);
    expect(body.data.needsChallenge).toBe(false);
    expect(body.data.factors).toEqual([]);
  });

  test('API-AUTH-016 一般の会員は特権ではなく、要素があっても needsChallenge は false', async () => {
    setup({
      role: 'user',
      aal: { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null },
      factors: { data: { totp: [{ id: 'f-1', factor_type: 'totp', status: 'verified' }], phone: [] }, error: null },
    });

    const body = await (await GET(makeRequest())).json();

    expect(body.data.role).toBe('user');
    expect(body.data.isPrivileged).toBe(false);
    expect(body.data.hasVerifiedFactor).toBe(true);
    expect(body.data.needsChallenge).toBe(false);
  });

  test('API-AUTH-016 役割が未知の値や無い時は user として扱う', async () => {
    setup({ role: 'owner' });
    expect((await (await GET(makeRequest())).json()).data.role).toBe('user');

    setup({});
    expect((await (await GET(makeRequest())).json()).data.role).toBe('user');
  });

  test('API-AUTH-016 TOTP と電話の確かめ済みの要素を並べ、名前が無ければ null にする', async () => {
    setup({
      role: 'admin',
      factors: {
        data: {
          totp: [{ id: 't-1', factor_type: 'totp', status: 'verified' }],
          phone: [
            { id: 'p-1', factor_type: 'phone', status: 'verified', friendly_name: 'Mobile' },
            { id: 'p-2', factor_type: 'phone', status: 'unverified' },
          ],
        },
        error: null,
      },
    });

    const body = await (await GET(makeRequest())).json();

    expect(body.data.factors).toEqual([
      { id: 't-1', factorType: 'totp', friendlyName: null },
      { id: 'p-1', factorType: 'phone', friendlyName: 'Mobile' },
    ]);
  });

  test('API-AUTH-016 一覧に totp・phone の欄が無くても空として扱い、AAL が無ければ null を返す', async () => {
    setup({
      role: 'admin',
      aal: { data: {}, error: null },
      factors: { data: {}, error: null },
    });

    const body = await (await GET(makeRequest())).json();

    expect(body.data.factors).toEqual([]);
    expect(body.data.currentLevel).toBeNull();
    expect(body.data.nextLevel).toBeNull();
  });

  test('API-AUTH-016 AAL の取得に失敗したら 500 を返す', async () => {
    setup({ role: 'admin', aal: { data: null, error: { message: 'aal down' } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to resolve MFA status' });
  });

  test('API-AUTH-016 要素の一覧の取得に失敗したら 500 を返す', async () => {
    setup({ role: 'admin', factors: { data: null, error: { message: 'list down' } } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to resolve MFA status' });
  });

  test('API-AUTH-016 想定外の例外は 500 の汎用エラーに丸める', async () => {
    setup({});
    authenticateRequest.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
