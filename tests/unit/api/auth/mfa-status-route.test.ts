/**
 * DD-AUTH-029 TOTP の状態の窓口（src/app/api/auth/mfa/status/route.ts）の単体テスト。
 * 共有部品（client の作成・認証）は差し替え、窓口の分岐だけを確かめる。
 */

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
  authFailureResponse: jest.fn((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  })),
}));

import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { GET } from '@/app/api/auth/mfa/status/route';

const mockCreateClient = createClient as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;

const getAal = jest.fn();
const listFactors = jest.fn();
let errorSpy: jest.SpyInstance;

function buildRequest() {
  return new Request('http://localhost/api/auth/mfa/status', { method: 'GET' });
}

function authAs(role?: unknown) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: { sub: 'user-1', app_metadata: role === undefined ? undefined : { role } },
  });
}

const verifiedTotp = { id: 'f-1', status: 'verified', factor_type: 'totp', friendly_name: 'Phone' };

async function call() {
  const res = await GET(buildRequest());
  return { status: res.status, body: await res.json() };
}

describe('GET /api/auth/mfa/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCreateClient.mockResolvedValue({
      auth: { mfa: { getAuthenticatorAssuranceLevel: getAal, listFactors } },
    });
    authAs('admin');
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });
    listFactors.mockResolvedValue({ data: { totp: [verifiedTotp], phone: [] }, error: null });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-029 管理者で確かめ済みの TOTP があり aal1 から aal2 へ進める時は needsChallenge が true', async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
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

  it('DD-AUTH-029 一般の会員は isPrivileged と needsChallenge が false', async () => {
    authAs('user');

    const { body } = await call();

    expect(body.data.role).toBe('user');
    expect(body.data.isPrivileged).toBe(false);
    expect(body.data.hasVerifiedFactor).toBe(true);
    expect(body.data.needsChallenge).toBe(false);
  });

  it('DD-AUTH-029 要素が無い時は hasVerifiedFactor が false で factors が空', async () => {
    listFactors.mockResolvedValue({ data: { totp: [], phone: [] }, error: null });

    const { body } = await call();

    expect(body.data.hasVerifiedFactor).toBe(false);
    expect(body.data.needsChallenge).toBe(false);
    expect(body.data.factors).toEqual([]);
  });

  it('DD-AUTH-029 未確認の要素だけなら hasVerifiedFactor が false で factors に載せない', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-2', status: 'unverified', factor_type: 'totp' }], phone: [] },
      error: null,
    });

    const { body } = await call();

    expect(body.data.hasVerifiedFactor).toBe(false);
    expect(body.data.needsChallenge).toBe(false);
    expect(body.data.factors).toEqual([]);
  });

  it('DD-AUTH-029 今が aal2 なら needsChallenge が false', async () => {
    getAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });

    const { body } = await call();

    expect(body.data.currentLevel).toBe('aal2');
    expect(body.data.needsChallenge).toBe(false);
  });

  it('DD-AUTH-029 次が aal1 なら needsChallenge が false', async () => {
    getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });

    const { body } = await call();

    expect(body.data.nextLevel).toBe('aal1');
    expect(body.data.needsChallenge).toBe(false);
  });

  it('DD-AUTH-029 TOTP の一覧が無ければ電話の要素だけを数える', async () => {
    listFactors.mockResolvedValue({
      data: { phone: [{ id: 'p-1', status: 'verified', factor_type: 'phone', friendly_name: null }] },
      error: null,
    });

    const { body } = await call();

    expect(body.data.hasVerifiedFactor).toBe(true);
    expect(body.data.factors).toEqual([{ id: 'p-1', factorType: 'phone', friendlyName: null }]);
  });

  it('DD-AUTH-029 電話の一覧が無ければ TOTP の要素だけを数える', async () => {
    listFactors.mockResolvedValue({ data: { totp: [verifiedTotp] }, error: null });

    const { body } = await call();

    expect(body.data.factors).toEqual([{ id: 'f-1', factorType: 'totp', friendlyName: 'Phone' }]);
  });

  it('DD-AUTH-029 AAL の今・次が無ければ null で返し needsChallenge は false', async () => {
    getAal.mockResolvedValue({ data: {}, error: null });

    const { body } = await call();

    expect(body.data.currentLevel).toBeNull();
    expect(body.data.nextLevel).toBeNull();
    expect(body.data.needsChallenge).toBe(false);
  });

  it('DD-AUTH-029 要素の名前が無ければ null で返す', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f-3', status: 'verified', factor_type: 'totp' }], phone: [] },
      error: null,
    });

    const { body } = await call();

    expect(body.data.factors).toEqual([{ id: 'f-3', factorType: 'totp', friendlyName: null }]);
  });

  it.each(['missing', 'unavailable'])(
    'DD-AUTH-029 確かめが通らない時（%s）は共有部品の失敗の応答を返し AAL を引かない',
    async (reason) => {
      mockAuthenticate.mockResolvedValue({ ok: false, reason });

      const { status } = await call();

      expect(mockFailure).toHaveBeenCalledWith(reason);
      expect(status).toBe(reason === 'unavailable' ? 503 : 401);
      expect(getAal).not.toHaveBeenCalled();
      expect(listFactors).not.toHaveBeenCalled();
    },
  );

  it('DD-AUTH-029 AAL の取得が誤りなら 500', async () => {
    getAal.mockResolvedValue({ data: null, error: { message: 'aal down' } });

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to resolve MFA status' });
  });

  it('DD-AUTH-029 要素の一覧が誤りなら 500', async () => {
    listFactors.mockResolvedValue({ data: null, error: { message: 'list down' } });

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Failed to resolve MFA status' });
  });

  it.each([
    ['admin', true],
    ['supporter', true],
    ['user', false],
  ])('DD-AUTH-029 役割 %s の特権の判定は %s', async (role, privileged) => {
    authAs(role);

    const { body } = await call();

    expect(body.data.role).toBe(role);
    expect(body.data.isPrivileged).toBe(privileged);
  });

  it.each([['owner'], [undefined], [42]])(
    'DD-AUTH-029 許可の3つに無い役割（%p）は user として扱う',
    async (role) => {
      authAs(role);

      const { body } = await call();

      expect(body.data.role).toBe('user');
      expect(body.data.isPrivileged).toBe(false);
      expect(body.data.needsChallenge).toBe(false);
    },
  );

  it('DD-AUTH-029 client の作成が投げたら 500', async () => {
    mockCreateClient.mockRejectedValue(new Error('boom'));

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });
});
