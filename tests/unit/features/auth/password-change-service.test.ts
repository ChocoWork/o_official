/** @jest-environment node */
/**
 * DD-AUTH-041 パスワード変更の部品（src/features/auth/services/password-change.ts）。
 * 外部（Supabase・メール）は差し替え、コードの作り方・鍵つきのハッシュ・現行パスワードの確かめ・メールの本文を確かめる。
 */
import crypto from 'crypto';

jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import { createServiceRoleAuthClient } from '@/lib/auth/service-role-auth-client';
import { createServiceRoleClient } from '@/lib/supabase/server';
import sendMail from '@/lib/mail';
import {
  PASSWORD_CHANGE_CODE_TTL_SECONDS,
  PASSWORD_CHANGE_MAX_ATTEMPTS,
  generatePasswordChangeCode,
  hashPasswordChangeCode,
  sendPasswordChangeCodeMail,
  sendPasswordChangedNotice,
  verifyCurrentPassword,
  voidPasswordChangeChallenge,
} from '@/features/auth/services/password-change';

const mockAuthClient = createServiceRoleAuthClient as jest.Mock;
const mockServiceClient = createServiceRoleClient as jest.Mock;
const mockSendMail = sendMail as unknown as jest.Mock;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ORIGINAL_SECRET = process.env.JWT_SECRET;

function fakeAccessToken(sessionId: string) {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url');
  return `header.${payload}.signature`;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('DD-AUTH-041 定数', () => {
  test('DD-AUTH-041 コードの寿命は 10 分、間違いは 5 回まで', () => {
    expect(PASSWORD_CHANGE_CODE_TTL_SECONDS).toBe(600);
    expect(PASSWORD_CHANGE_MAX_ATTEMPTS).toBe(5);
  });
});

describe('DD-AUTH-041 generatePasswordChangeCode', () => {
  test('DD-AUTH-041 1000 回作って全部 8 桁の数字（先頭 0 を保つ）', () => {
    for (let i = 0; i < 1000; i += 1) {
      expect(generatePasswordChangeCode()).toMatch(/^\d{8}$/);
    }
  });

  test('DD-AUTH-041 乱数が小さい値でも左を 0 で埋める', () => {
    const spy = jest.spyOn(crypto, 'randomInt').mockReturnValue(42 as never);
    expect(generatePasswordChangeCode()).toBe('00000042');
    spy.mockRestore();
  });
});

describe('DD-AUTH-041 hashPasswordChangeCode', () => {
  const input = { userId: USER_ID, authSessionId: SESSION_ID, code: '12345678' };

  test('DD-AUTH-041 hex 64 桁で、同じ入力なら同じ値', () => {
    const hash = hashPasswordChangeCode(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPasswordChangeCode(input)).toBe(hash);
  });

  test('DD-AUTH-041 別の session・別の利用者・別のコードで別の値（用途に結ぶ）', () => {
    const base = hashPasswordChangeCode(input);
    expect(hashPasswordChangeCode({ ...input, authSessionId: '33333333-3333-4333-8333-333333333333' })).not.toBe(base);
    expect(hashPasswordChangeCode({ ...input, userId: '44444444-4444-4444-8444-444444444444' })).not.toBe(base);
    expect(hashPasswordChangeCode({ ...input, code: '12345679' })).not.toBe(base);
  });

  test('DD-AUTH-041 鍵つき: JWT_SECRET を替えると別の値、同じ入力の素の sha256 とも一致しない', () => {
    const base = hashPasswordChangeCode(input);
    const plainSha = crypto
      .createHash('sha256')
      .update(`password_change:${USER_ID}:${SESSION_ID}:12345678`)
      .digest('hex');
    expect(base).not.toBe(plainSha);

    process.env.JWT_SECRET = 'another-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(hashPasswordChangeCode(input)).not.toBe(base);
  });

  test('DD-AUTH-041 入力は HMAC-SHA256(JWT_SECRET, password_change:user:session:code) の hex', () => {
    const expected = crypto
      .createHmac('sha256', process.env.JWT_SECRET as string)
      .update(`password_change:${USER_ID}:${SESSION_ID}:12345678`)
      .digest('hex');
    expect(hashPasswordChangeCode(input)).toBe(expected);
  });

  test('DD-AUTH-041 JWT_SECRET が無ければ throw する', () => {
    delete process.env.JWT_SECRET;
    expect(() => hashPasswordChangeCode(input)).toThrow();
  });
});

describe('DD-AUTH-041 voidPasswordChangeChallenge', () => {
  function updateChain(result: { error: unknown } | Error) {
    const isNull = jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const eq = jest.fn(() => ({ is: isNull }));
    const update = jest.fn(() => ({ eq }));
    const from = jest.fn(() => ({ update }));
    mockServiceClient.mockResolvedValue({ from });
    return { from, update, eq, isNull };
  }

  test('DD-AUTH-041 used_at を立てる更新を .is(used_at, null) つきで 1 回呼ぶ', async () => {
    const chain = updateChain({ error: null });
    await expect(voidPasswordChangeChallenge('challenge-1')).resolves.toBe(true);
    expect(chain.from).toHaveBeenCalledWith('password_change_challenges');
    expect(chain.update).toHaveBeenCalledTimes(1);
    const patch = (chain.update.mock.calls[0] as unknown as [{ used_at: string }])[0];
    expect(Number.isNaN(Date.parse(patch.used_at))).toBe(false);
    expect(chain.eq).toHaveBeenCalledWith('id', 'challenge-1');
    expect(chain.isNull).toHaveBeenCalledWith('used_at', null);
  });

  test('DD-AUTH-041 更新の失敗でも throw せず false を返す', async () => {
    updateChain({ error: { code: 'XX000', message: 'db down' } });
    await expect(voidPasswordChangeChallenge('challenge-1')).resolves.toBe(false);
  });

  test('DD-AUTH-041 クライアントの作成が throw しても throw せず false を返す', async () => {
    mockServiceClient.mockRejectedValue(new Error('no env'));
    await expect(voidPasswordChangeChallenge('challenge-1')).resolves.toBe(false);
  });
});

describe('DD-AUTH-041 verifyCurrentPassword', () => {
  const rpc = jest.fn();
  const signInWithPassword = jest.fn();

  beforeEach(() => {
    rpc.mockReset();
    signInWithPassword.mockReset();
    rpc.mockResolvedValue({ data: null, error: null });
    mockAuthClient.mockResolvedValue({ auth: { signInWithPassword } });
    mockServiceClient.mockResolvedValue({ rpc });
  });

  test('DD-AUTH-041 成功したら作られた GoTrue の session を revoke_auth_session で消す', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: fakeAccessToken(SESSION_ID) }, user: { id: USER_ID } },
      error: null,
    });

    await expect(verifyCurrentPassword('user@example.com', 'current-password-123')).resolves.toEqual({ ok: true });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'user@example.com', password: 'current-password-123' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: SESSION_ID });
  });

  test('DD-AUTH-041 session の id が読めなくても成功は成功のまま（消せないことを console に残す）', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'not-a-jwt' }, user: { id: USER_ID } },
      error: null,
    });

    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 消す RPC が失敗しても成功は成功のまま', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: { access_token: fakeAccessToken(SESSION_ID) }, user: { id: USER_ID } },
      error: null,
    });
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'rpc failed' } });

    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: true });
  });

  test('DD-AUTH-041 invalid_credentials は invalid（session が無いので消さない）', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    });

    await expect(verifyCurrentPassword('user@example.com', 'wrong')).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([400, 401])('DD-AUTH-041 符号が無くても status %i の誤りは invalid（session が無いので消さない）', async (status) => {
    signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { status, message: 'Invalid login credentials' },
    });

    await expect(verifyCurrentPassword('user@example.com', 'wrong')).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('DD-AUTH-041 符号も 400・401 でもない誤り（429）は invalid にせず unavailable', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 429, message: 'rate limited' },
    });

    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['data が null', null],
    ['session が null', { session: null, user: null }],
  ])('DD-AUTH-041 誤りが無くても %s なら成功のまま、消せないことを console に残して消す RPC は呼ばない', async (_label, data) => {
    signInWithPassword.mockResolvedValue({ data, error: null });

    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('verifyCurrentPassword: auth session id unreadable; session not revoked');
  });

  test('DD-AUTH-041 captcha_failed は captcha_rejected', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'captcha_failed', status: 400, message: 'captcha protection: request disallowed' },
    });

    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({
      ok: false,
      reason: 'captcha_rejected',
    });
  });

  test('DD-AUTH-041 ネットワークの失敗（投げる・取得の誤り・5xx）は unavailable', async () => {
    signInWithPassword.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: false, reason: 'unavailable' });

    signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
    });
    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: false, reason: 'unavailable' });

    signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { status: 503, message: 'upstream' },
    });
    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  test('DD-AUTH-041 クライアントの作成が throw しても unavailable', async () => {
    mockAuthClient.mockRejectedValue(new Error('no env'));
    await expect(verifyCurrentPassword('user@example.com', 'pw')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  test('DD-AUTH-041 誤りの本文・パスワードを返り値と console に載せない', async () => {
    signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials secret-detail' },
    });
    const errorSpy = console.error as jest.Mock;

    const result = await verifyCurrentPassword('user@example.com', 'super-secret-current');
    expect(JSON.stringify(result)).not.toContain('secret-detail');
    expect(JSON.stringify(result)).not.toContain('super-secret-current');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('super-secret-current');
  });
});

describe('DD-AUTH-041 メール', () => {
  test('DD-AUTH-041 コードのメール: 宛先・コード・有効期限 10 分・心当たりが無い時の案内。パスワードを含まない', async () => {
    await sendPasswordChangeCodeMail('user@example.com', '01234567');

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const payload = mockSendMail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
    expect(payload.to).toBe('user@example.com');
    expect(payload.text).toContain('01234567');
    expect(payload.html).toContain('01234567');
    expect(payload.text).toContain('10 分');
    expect(payload.text).toContain('心当たり');
    expect(payload.subject).not.toContain('01234567');
    expect(payload.text.toLowerCase()).not.toContain('new_password');
  });

  test('DD-AUTH-041 コードのメールの送信が失敗したら呼び手に伝える（throw する）', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(sendPasswordChangeCodeMail('user@example.com', '01234567')).rejects.toThrow();
  });

  test('DD-AUTH-041 変更の通知: 件名「パスワードを変更しました」、パスワードやコードを含まない', async () => {
    await sendPasswordChangedNotice('user@example.com');

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const payload = mockSendMail.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
    expect(payload.to).toBe('user@example.com');
    expect(payload.subject).toBe('パスワードを変更しました');
    expect(payload.text).toContain('心当たり');
    expect(payload.html).not.toMatch(/\d{8}/);
  });
});
