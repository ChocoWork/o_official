/** @jest-environment node */
/**
 * DD-AUTH-041 パスワード変更の確定の窓口（src/app/api/auth/password/change/confirm/route.ts）の単体テスト。
 * 共有部品は差し替え、窓口の順序・失敗の応答・「呼ばれない物」だけを確かめる。
 * SEC-AUTH-034-AC-01（全 session 失効）・AC-02（通知）・AC-03（本人ごとの回数）・AC-04（監査に固定の符号だけ）。
 */

const callLog: string[] = [];
const afterCallbacks: Array<() => Promise<void> | void> = [];

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookies: Array<Record<string, unknown>> = [];
      return {
        status: init?.status ?? 200,
        json: async () => body,
        cookies: { set: (c: Record<string, unknown>) => cookies.push(c), _all: cookies },
      };
    },
  },
  after: (cb: () => Promise<void> | void) => {
    afterCallbacks.push(cb);
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  })),
}));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは漏洩が確認されています。',
}));
jest.mock('@/features/auth/services/password-change', () => ({
  ...jest.requireActual('@/features/auth/services/password-change'),
  verifyCurrentPassword: jest.fn(),
  sendPasswordChangedNotice: jest.fn(),
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { checkPwnedPassword } from '@/lib/pwned-password';
import {
  hashPasswordChangeCode,
  sendPasswordChangedNotice,
  verifyCurrentPassword,
} from '@/features/auth/services/password-change';
import { POST } from '@/app/api/auth/password/change/confirm/route';

const mockRateLimit = enforceRateLimit as jest.Mock;
const mockAuthenticate = authenticateRequest as jest.Mock;
const mockFailure = authFailureResponse as jest.Mock;
const mockCsrf = requireCsrfOrDeny as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;
const mockServiceClient = createServiceRoleClient as jest.Mock;
const mockAuthClient = createServiceRoleAuthClient as jest.Mock;
const mockRevokeAll = revokeAllSessionsForUser as jest.Mock;
const mockPwned = checkPwnedPassword as jest.Mock;
const mockNotice = sendPasswordChangedNotice as jest.Mock;
const mockVerify = verifyCurrentPassword as jest.Mock;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CODE = '04271399';
const NEW_PASSWORD = 'brand-new-Password-QQQ-4321';
const ORIGINAL_SECRET = process.env.JWT_SECRET;
const rpc = jest.fn();
const updateUserById = jest.fn();

type CookieRecord = { name: string; value: string; maxAge?: number };

function authAs(overrides: Record<string, unknown> = {}) {
  mockAuthenticate.mockResolvedValue({
    ok: true,
    claims: {
      sub: USER_ID,
      email: 'member@example.com',
      aal: 'aal1',
      session_id: SESSION_ID,
      app_metadata: { role: 'user' },
      ...overrides,
    },
  });
}

function jsonRequest(payload: unknown) {
  return new Request('http://localhost/api/auth/password/change/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function call(payload: unknown = { code: CODE, new_password: NEW_PASSWORD }) {
  const res = (await POST(jsonRequest(payload))) as unknown as {
    status: number;
    json: () => Promise<unknown>;
    cookies?: { _all: CookieRecord[] };
  };
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookies: res.cookies?._all ?? [] };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockFailure.mockImplementation((reason: string) => ({
    status: reason === 'unavailable' ? 503 : 401,
    json: async () => ({ error: reason }),
  }));
  callLog.length = 0;
  afterCallbacks.length = 0;
  process.env.JWT_SECRET = 'unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockRateLimit.mockResolvedValue(undefined);
  mockCsrf.mockResolvedValue(undefined);
  mockPwned.mockResolvedValue({ status: 'ok' });
  rpc.mockImplementation(async () => {
    callLog.push('consume');
    return { data: 'ok', error: null };
  });
  updateUserById.mockImplementation(async () => {
    callLog.push('update');
    return { data: {}, error: null };
  });
  mockServiceClient.mockResolvedValue({ rpc, auth: { admin: { updateUserById } } });
  mockRevokeAll.mockImplementation(async () => {
    callLog.push('revoke');
    return { authSessionsDeleted: 2 };
  });
  mockNotice.mockImplementation(async () => {
    callLog.push('notice');
  });
  authAs();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('DD-AUTH-041 パスワード変更の確定 正しい手順', () => {
  test('DD-AUTH-041 consume → パスワード更新 → 全 session 失効 → 認証 Cookie 3 つを消す → 通知メールの順で 200', async () => {
    const { status, body, cookies } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(callLog).toEqual(['consume', 'update', 'revoke']);
    expect(updateUserById).toHaveBeenCalledWith(USER_ID, { password: NEW_PASSWORD });
    expect(mockRevokeAll).toHaveBeenCalledWith(USER_ID);

    const cleared = cookies.filter((c) => c.maxAge === 0 || (c as { expires?: unknown }).expires);
    expect(cleared.map((c) => c.name).sort()).toEqual(['sb-access-token', 'sb-csrf-token', 'sb-refresh-token']);
    expect(cleared.every((c) => c.value === '')).toBe(true);

    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(callLog).toEqual(['consume', 'update', 'revoke', 'notice']);
    expect(mockNotice).toHaveBeenCalledWith('member@example.com');

    expect(mockLogAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'password_change_confirm', outcome: 'success', actor_id: USER_ID }),
    );
  });

  test('DD-AUTH-041 consume には利用者・session・鍵つきハッシュ（入力は平文のコードを含めない）を渡す', async () => {
    await call();

    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe('consume_password_change_challenge');
    expect(args).toEqual({
      p_user_id: USER_ID,
      p_auth_session_id: SESSION_ID,
      p_code_hash: hashPasswordChangeCode({ userId: USER_ID, authSessionId: SESSION_ID, code: CODE }),
    });
    expect(JSON.stringify(args)).not.toContain(CODE);
  });

  test('DD-AUTH-041 confirm は GoTrue の signInWithPassword も auth だけのクライアントも一度も呼ばない（現行パスワードの当否を明かさない）', async () => {
    await call();
    await call({ code: '00000000', new_password: NEW_PASSWORD });

    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockAuthClient).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の確定 認証・枠', () => {
  test('DD-AUTH-041 IP の枠が 429 なら認証も consume も呼ばない', async () => {
    mockRateLimit.mockResolvedValueOnce({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const { status } = await call();

    expect(status).toBe(429);
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 IP の枠は 20 回／10 分、本人ごとは subject に利用者の id で 5 回／10 分', async () => {
    await call();

    const first = mockRateLimit.mock.calls[0][0] as Record<string, unknown>;
    const second = mockRateLimit.mock.calls[1][0] as Record<string, unknown>;
    expect(first).toMatchObject({ endpoint: 'auth:password_change_confirm', limit: 20, windowSeconds: 600 });
    expect(first.subject).toBeUndefined();
    expect(second).toMatchObject({
      endpoint: 'auth:password_change_confirm',
      limit: 5,
      windowSeconds: 600,
      subject: USER_ID,
    });
  });

  test('DD-AUTH-041 本人ごとの枠が 429 なら consume を呼ばない（総当たりで消費しない）', async () => {
    mockRateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 429, json: async () => ({ error: 'Too many requests' }) });

    const { status } = await call();

    expect(status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 未ログインは 401。CSRF 拒否は監査せずそのまま返す', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });
    expect((await call()).status).toBe(401);
    expect(mockCsrf).not.toHaveBeenCalled();

    authAs({ aal: 'aal1', app_metadata: { role: 'admin' } });
    mockCsrf.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    mockLogAudit.mockClear();
    const denied = await call();
    expect(denied.status).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each(['admin', 'supporter'])('DD-AUTH-041 aal1 の %s は 403・監査 denied・consume を呼ばない', async (role) => {
    authAs({ aal: 'aal1', app_metadata: { role } });

    const { status } = await call();

    expect(status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_change_confirm', outcome: 'denied', detail: 'aal2_required' }),
    );
  });

  test('DD-AUTH-041 session_id の無い通行証は 401', async () => {
    authAs({ session_id: undefined });
    expect((await call()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の確定 役割の無い通行証・想定外の例外', () => {
  test('DD-AUTH-041 app_metadata の無い通行証は役割なしの会員として扱い、aal1 でも 200', async () => {
    authAs({ app_metadata: undefined });

    const { status } = await call();

    expect(status).toBe(200);
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'aal2_required' }));
    expect(mockLogAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'success', detail: 'password_changed' }),
    );
  });

  test.each([
    ['Error', new TypeError('boom with secret'), 'TypeError'],
    ['Error でない値', 'plain string with secret', 'unknown'],
  ])('DD-AUTH-041 想定外の例外（%s）は 500・ログには名前だけ残し、更新も失効もしない', async (_label, thrown, logged) => {
    rpc.mockRejectedValue(thrown);

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
    expect(console.error).toHaveBeenCalledWith('Password change confirm error:', logged);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(mockRevokeAll).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の確定 入力の検査と漏洩確認はコードの消費より前', () => {
  test.each([
    { code: '1234567', new_password: NEW_PASSWORD },
    { code: 'abcdefgh', new_password: NEW_PASSWORD },
    { code: CODE, new_password: 'a'.repeat(15) },
    { code: CODE },
    {},
  ])('DD-AUTH-041 本文 %j は 400 で consume を呼ばない', async (payload) => {
    const { status } = await call(payload);
    expect(status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 漏洩したパスワードは 400・consume を呼ばない（コードを焼かない）・監査 pwned_password', async () => {
    mockPwned.mockResolvedValue({ status: 'pwned', count: 5 });

    const { status, body } = await call();

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'このパスワードは漏洩が確認されています。' });
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'pwned_password' }),
    );
  });

  test('DD-AUTH-041 漏洩確認が使えない（外部の障害）時は通し、監査に pwned_check_unavailable を残す', async () => {
    mockPwned.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });

    const { status } = await call();

    expect(status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'pwned_check_unavailable:timeout' }),
    );
  });

  test('DD-AUTH-041 新パスワードが現行と同じかの確かめは置かない（confirm が現行パスワードの当否を明かさない）', async () => {
    await call();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockAuthClient).not.toHaveBeenCalled();
  });
});

describe('DD-AUTH-041 パスワード変更の確定 コードの確かめ', () => {
  test.each(['invalid', 'locked', 'none'])(
    'DD-AUTH-041 consume が %s なら 401・同じ文・更新も失効もしない',
    async (result) => {
      rpc.mockResolvedValue({ data: result, error: null });

      const { status, body } = await call();

      expect(status).toBe(401);
      expect(body).toEqual({ error: '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。' });
      expect(updateUserById).not.toHaveBeenCalled();
      expect(mockRevokeAll).not.toHaveBeenCalled();
      expect(afterCallbacks).toHaveLength(0);
    },
  );

  test('DD-AUTH-041 監査の符号: invalid は code_invalid、locked は code_locked、none は code_unusable', async () => {
    rpc.mockResolvedValueOnce({ data: 'invalid', error: null });
    await call();
    rpc.mockResolvedValueOnce({ data: 'locked', error: null });
    await call();
    rpc.mockResolvedValueOnce({ data: 'none', error: null });
    await call();

    const details = mockLogAudit.mock.calls.map((c) => (c[0] as { detail?: string }).detail);
    expect(details).toEqual(['code_invalid', 'code_locked', 'code_unusable']);
  });

  test('DD-AUTH-041 consume の RPC が失敗したら 500・更新しない・監査 consume_failed', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'rpc failed' } });

    const { status } = await call();

    expect(status).toBe(500);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'consume_failed' }),
    );
  });
});

describe('DD-AUTH-041 パスワード変更の確定 更新・失効の失敗', () => {
  test('DD-AUTH-041 パスワードの更新が失敗したら 500・失効も通知もしない・コードは焼けたまま・監査 update_failed', async () => {
    updateUserById.mockResolvedValue({ data: null, error: { code: 'weak_password', message: 'detail text' } });

    const { status, body, cookies } = await call();

    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('detail text');
    expect(mockRevokeAll).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(cookies).toHaveLength(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'update_failed' }),
    );
  });

  test('DD-AUTH-041 全 session 失効が throw しても 200 のまま・この端末の Cookie は消す・通知も送る・監査 revoke_failed', async () => {
    mockRevokeAll.mockRejectedValue(new Error('auth_session_revocation_failed'));

    const { status, cookies } = await call();

    expect(status).toBe(200);
    expect(cookies.filter((c) => c.value === '').map((c) => c.name).sort()).toEqual([
      'sb-access-token',
      'sb-csrf-token',
      'sb-refresh-token',
    ]);
    expect(afterCallbacks).toHaveLength(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'revoke_failed' }),
    );
  });

  test('DD-AUTH-041 通知メールの失敗は応答を変えない（after の中で握る）', async () => {
    mockNotice.mockRejectedValue(new Error('smtp down'));

    const { status } = await call();
    expect(status).toBe(200);
    await expect(Promise.resolve(afterCallbacks[0]())).resolves.toBeUndefined();
  });
});

describe('DD-AUTH-041 パスワード変更の確定 監査と応答に秘密を残さない', () => {
  test('DD-AUTH-041 監査の引数・応答・console にパスワード・コード・session_id が現れない', async () => {
    const outcomes = [
      await call(),
      await (async () => {
        rpc.mockResolvedValueOnce({ data: 'invalid', error: null });
        return call();
      })(),
      await (async () => {
        mockPwned.mockResolvedValueOnce({ status: 'pwned', count: 1 });
        return call();
      })(),
      await (async () => {
        updateUserById.mockResolvedValueOnce({ data: null, error: { message: `leak ${NEW_PASSWORD}` } });
        return call();
      })(),
    ];

    const dump = JSON.stringify([mockLogAudit.mock.calls, outcomes.map((o) => o.body)]);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain(SESSION_ID);
  });
});
