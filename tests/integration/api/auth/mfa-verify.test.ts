export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map(),
      cookies: {
        _cookies: [] as any[],
        set(c: any) { this._cookies.push(c); },
        get(name: string) { return this._cookies.find((c: any) => c.name === name); },
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
  resolveRequestUser: jest.fn(),
}));

jest.mock('@/features/auth/services/mfa-metadata', () => ({
  markPrivilegedMfaVerified: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

// persistNewSession は本物を使い、aal2 セッションが実際に Cookie へ書き戻ることを検証する。
jest.mock('@/features/auth/services/session', () => ({
  ...jest.requireActual('@/features/auth/services/session'),
  findSessionByRefreshHash: jest.fn(),
}));

const { cookies } = require('next/headers');
const sessionService = require('@/features/auth/services/session');
const FACTOR_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest() {
  return new Request('http://localhost/api/auth/mfa/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ factorId: FACTOR_ID, code: '123456' }),
  });
}

describe('POST /api/auth/mfa/verify', () => {
  let verifyHandler: any;
  let insertMock: jest.Mock;

  beforeAll(() => {
    verifyHandler = require('@/app/api/auth/mfa/verify/route').POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    sessionService.findSessionByRefreshHash.mockResolvedValue({ id: 'sess-1', user_id: 'user-1' });

    const { createClient, createServiceRoleClient, resolveRequestUser } = require('@/lib/supabase/server');

    resolveRequestUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'admin@example.com', app_metadata: { role: 'admin' } } },
      error: null,
    });

    createClient.mockResolvedValue({
      auth: {
        mfa: {
          challenge: jest.fn().mockResolvedValue({ data: { id: 'challenge-1' }, error: null }),
          verify: jest.fn().mockResolvedValue({
            data: { access_token: 'aal2-access', refresh_token: 'aal2-refresh', expires_in: 3600 },
            error: null,
          }),
          getAuthenticatorAssuranceLevel: jest
            .fn()
            .mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
        },
      },
    });

    insertMock = jest.fn().mockResolvedValue({});
    const fromMock = jest.fn(() => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({}) })),
      insert: insertMock,
    }));
    createServiceRoleClient.mockResolvedValue({ from: fromMock });
  });

  test('昇格したセッションを Cookie に書き戻す', async () => {
    const res: any = await verifyHandler(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.currentLevel).toBe('aal2');

    expect(res.cookies.get('sb-access-token').value).toBe('aal2-access');
    expect(res.cookies.get('sb-refresh-token').value).toBe('aal2-refresh');
    // CSRF も回転させる（トークン対が変わるため）
    expect(res.cookies.get('sb-csrf-token').value).toEqual(expect.any(String));
    expect(res.cookies.get('sb-csrf-token').value).not.toBe('');

    // sessions テーブルにも新しい行を残す
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'user-1' }),
    ]);
  });

  test('セッション永続化に失敗したら 500 を返す', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockResolvedValue({
      from: jest.fn(() => {
        throw new Error('db down');
      }),
    });

    const res: any = await verifyHandler(makeRequest());

    expect(res.status).toBe(500);
  });
});
