/**
 * 管理者・サポーターの TOTP の流れ（ARC-AUTH-003）の結合テスト。
 * 状態（API-AUTH-016）→ 登録（API-AUTH-017）→ 確認（API-AUTH-018）の3つの窓口を本物のまま順に通し、
 * 状態を持つ偽の Supabase の MFA で、aal1 から aal2 のトークンに替わるまでを確かめる。
 */
export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: {
        _cookies: [] as { name: string; value: string }[],
        set(cookie: { name: string; value: string }) {
          this._cookies.push(cookie);
        },
        get(name: string) {
          return this._cookies.find((cookie) => cookie.name === name);
        },
      },
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: (reason: string) =>
    require('next/server').NextResponse.json(
      { error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' },
      { status: reason === 'unavailable' ? 503 : 401 },
    ),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// 書き戻しは本物の persistNewSession で通し、Cookie が実際に aal2 のトークンへ替わることを見る。
jest.mock('@/features/auth/services/session', () => ({
  ...jest.requireActual('@/features/auth/services/session'),
  findSessionByRefreshHash: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');
const { cookies } = require('next/headers');
const { findSessionByRefreshHash } = require('@/features/auth/services/session');

const FACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CODE = '654321';

type FakeFactor = { id: string; factor_type: 'totp'; status: 'verified' | 'unverified'; friendly_name: string | null };

/** 登録で未確認の要素が増え、確認で verified と aal2 になる、最小の Supabase の MFA。 */
function createFakeMfa(initialFactors: FakeFactor[] = []) {
  const state = { factors: [...initialFactors], level: 'aal1' as 'aal1' | 'aal2' };
  const mfa = {
    getAuthenticatorAssuranceLevel: jest.fn(async () => ({
      data: {
        currentLevel: state.level,
        nextLevel: state.factors.some((f) => f.status === 'verified') ? 'aal2' : 'aal1',
      },
      error: null,
    })),
    listFactors: jest.fn(async () => ({ data: { totp: [...state.factors], phone: [] }, error: null })),
    unenroll: jest.fn(async ({ factorId }: { factorId: string }) => {
      state.factors = state.factors.filter((f) => f.id !== factorId);
      return { error: null };
    }),
    enroll: jest.fn(async () => {
      state.factors.push({ id: FACTOR_ID, factor_type: 'totp', status: 'unverified', friendly_name: null });
      return {
        data: {
          id: FACTOR_ID,
          friendly_name: null,
          totp: { qr_code: '<svg></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' },
        },
        error: null,
      };
    }),
    challenge: jest.fn(async ({ factorId }: { factorId: string }) =>
      state.factors.some((f) => f.id === factorId)
        ? { data: { id: 'challenge-1' }, error: null }
        : { data: null, error: { message: 'Factor not found' } },
    ),
    verify: jest.fn(async ({ factorId, code }: { factorId: string; code: string }) => {
      if (code !== CODE) {
        return { data: null, error: { message: 'Invalid TOTP code entered' } };
      }
      state.factors = state.factors.map((f) => (f.id === factorId ? { ...f, status: 'verified' as const } : f));
      state.level = 'aal2';
      return { data: { access_token: 'aal2-access', refresh_token: 'aal2-refresh' }, error: null };
    }),
  };
  return { state, mfa };
}

/** amr は既定でメール OTP を通った通行証（初めての TOTP の登録は 2 段目を通った通行証だけが許される） */
function setup(role: string, initialFactors: FakeFactor[] = [], amr: unknown = [{ method: 'otp', timestamp: 0 }]) {
  const fake = createFakeMfa(initialFactors);
  createClient.mockResolvedValue({ auth: { mfa: fake.mfa } });
  authenticateRequest.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: { role }, amr },
  });
  return fake;
}

const get = (url: string) => new Request(`http://localhost${url}`);
const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('管理者とサポーターの TOTP の流れ', () => {
  let statusGET: (request: Request) => Promise<any>;
  let enrollPOST: (request: Request) => Promise<any>;
  let verifyPOST: (request: Request) => Promise<any>;
  let insertMock: jest.Mock;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    statusGET = require('@/app/api/auth/mfa/status/route').GET;
    enrollPOST = require('@/app/api/auth/mfa/enroll-totp/route').POST;
    verifyPOST = require('@/app/api/auth/mfa/verify/route').POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    cookies.mockResolvedValue({ get: jest.fn().mockReturnValue({ value: 'aal1-refresh' }) });
    findSessionByRefreshHash.mockResolvedValue({ id: 'sess-aal1', user_id: 'user-1' });
    insertMock = jest.fn().mockResolvedValue({ error: null });
    createServiceRoleClient.mockResolvedValue({
      from: jest.fn(() => ({
        insert: insertMock,
        update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({ error: null }) })),
      })),
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('ARC-AUTH-003 初めての管理者は 状態 → 登録 → 確認 の順で aal1 から aal2 のトークンに替わる', async () => {
    const { state } = setup('admin');

    const before = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(before.data).toMatchObject({ isPrivileged: true, hasVerifiedFactor: false, needsChallenge: false });

    const enrolled = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));
    const enrolledBody = await enrolled.json();
    expect(enrolled.status).toBe(200);
    expect(enrolledBody.data.factorId).toBe(FACTOR_ID);
    expect(enrolledBody.data.secret).toBeTruthy();
    expect(enrolledBody.data.qrCode).toMatch(/^data:image\/svg\+xml/);
    expect(state.factors).toEqual([expect.objectContaining({ status: 'unverified' })]);

    // 確認の前は、要素があっても確かめ済みではないので状態は変わらない
    const mid = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(mid.data.hasVerifiedFactor).toBe(false);

    const verified = await verifyPOST(post('/api/auth/mfa/verify', { factorId: enrolledBody.data.factorId, code: CODE }));
    expect(verified.status).toBe(200);
    expect((await verified.json()).data).toMatchObject({ currentLevel: 'aal2', verified: true });
    expect(verified.cookies.get('sb-access-token').value).toBe('aal2-access');
    expect(verified.cookies.get('sb-refresh-token').value).toBe('aal2-refresh');
    expect(insertMock).toHaveBeenCalledWith([expect.objectContaining({ user_id: 'user-1' })]);

    const after = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(after.data).toMatchObject({
      currentLevel: 'aal2',
      hasVerifiedFactor: true,
      needsChallenge: false,
      factors: [{ id: FACTOR_ID, factorType: 'totp', friendlyName: null }],
    });
  });

  test('ARC-AUTH-003 登録済みのサポーターは状態で確認を求められ、登録は 409 で断られ、確認だけで aal2 になる', async () => {
    const { state } = setup('supporter', [
      { id: FACTOR_ID, factor_type: 'totp', status: 'verified', friendly_name: 'Phone' },
    ]);

    const status = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(status.data).toMatchObject({
      role: 'supporter',
      hasVerifiedFactor: true,
      nextLevel: 'aal2',
      needsChallenge: true,
    });

    const enroll = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));
    expect(enroll.status).toBe(409);
    expect(state.factors).toHaveLength(1);

    const verified = await verifyPOST(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: CODE }));
    expect(verified.status).toBe(200);
    expect(verified.cookies.get('sb-access-token').value).toBe('aal2-access');

    const after = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(after.data.needsChallenge).toBe(false);
  });

  test('ARC-AUTH-003 誤ったコードでは aal1 のままで、Cookie も sessions の行も書き換わらない', async () => {
    const { state } = setup('admin', [
      { id: FACTOR_ID, factor_type: 'totp', status: 'verified', friendly_name: null },
    ]);

    const res = await verifyPOST(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: '000000' }));

    expect(res.status).toBe(400);
    expect(res.cookies.get('sb-access-token')).toBeUndefined();
    expect(insertMock).not.toHaveBeenCalled();
    expect(state.level).toBe('aal1');
    const status = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(status.data).toMatchObject({ currentLevel: 'aal1', needsChallenge: true });
  });

  test('ARC-AUTH-003 前の登録の途中で残った未確認の要素は、登録し直す時に外されて1つだけになる', async () => {
    const { state } = setup('admin', [
      { id: 'stale-factor', factor_type: 'totp', status: 'unverified', friendly_name: null },
    ]);

    const res = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));

    expect(res.status).toBe(200);
    expect(state.factors.map((f) => f.id)).toEqual([FACTOR_ID]);
  });

  test('ARC-AUTH-003 password だけの通行証の管理者は登録を 403 で断られ、未確認の要素も作られない', async () => {
    const { state } = setup('admin', [], [{ method: 'password', timestamp: 0 }]);

    const enroll = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));

    expect(enroll.status).toBe(403);
    expect(state.factors).toEqual([]);
  });

  test('ARC-AUTH-003 一般の会員は登録も確認も 403 で、要素も Cookie も作られない', async () => {
    const { state } = setup('user');

    const enroll = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));
    const verify = await verifyPOST(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: CODE }));

    expect(enroll.status).toBe(403);
    expect(verify.status).toBe(403);
    expect(state.factors).toEqual([]);
    expect(state.level).toBe('aal1');
    expect(insertMock).not.toHaveBeenCalled();

    // 状態は一般の会員にも答えるが、特権ではなく確認も求めない
    const status = await (await statusGET(get('/api/auth/mfa/status'))).json();
    expect(status.data).toMatchObject({ role: 'user', isPrivileged: false, needsChallenge: false });
  });

  test('ARC-AUTH-003 未ログインでは3つの窓口とも 401 で、MFA の操作に進まない', async () => {
    const { mfa } = setup('admin');
    authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });

    const status = await statusGET(get('/api/auth/mfa/status'));
    const enroll = await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));
    const verify = await verifyPOST(post('/api/auth/mfa/verify', { factorId: FACTOR_ID, code: CODE }));

    expect([status.status, enroll.status, verify.status]).toEqual([401, 401, 401]);
    expect(mfa.enroll).not.toHaveBeenCalled();
    expect(mfa.challenge).not.toHaveBeenCalled();
    expect(mfa.verify).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-003 役割は JWT のクレームから読み、DB の表を引いて確かめない', async () => {
    const { createServiceRoleClient: serviceRole } = require('@/lib/supabase/server');
    setup('admin');

    await enrollPOST(post('/api/auth/mfa/enroll-totp', {}));

    // 窓口が役割の判断のために service role で表を引くことは無い
    expect(serviceRole).not.toHaveBeenCalled();
  });
});
