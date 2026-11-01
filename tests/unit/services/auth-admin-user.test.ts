import { findAuthUserIdByEmail, isAuthUserUnconfirmed } from '@/features/auth/services/auth-admin-user';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * F1 の回帰ガード。
 *
 * かつて findAuthUserIdByEmail は `const fn = client.auth.admin.listUsers` のように
 * メソッドをレシーバから引き剥がして呼んでいた。auth-js の実体はメソッド内で this を
 * 参照するため本番だけ TypeError で落ちるが、当時のテストのモックが `this` を使わない
 * 素のオブジェクトだったため素通りしていた。
 *
 * ここでは this を参照するクラスでモックし、引き剥がして呼ばれたら失敗するようにする。
 */
class FakeSupabaseClient {
  private readonly marker = 'service-role';
  public lastArgs: unknown = null;

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(name: string, params: unknown) {
    // 引き剥がして呼ばれるとここで TypeError になる
    if (this.marker !== 'service-role') {
      throw new Error('unexpected receiver');
    }
    this.lastArgs = { name, params };
    return Promise.resolve(this.result);
  }
}

function asClient(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe('findAuthUserIdByEmail', () => {
  test('レシーバを保ったまま RPC を呼び、正規化したメールを渡す', async () => {
    const fake = new FakeSupabaseClient({ data: 'user-123', error: null });

    const result = await findAuthUserIdByEmail(asClient(fake), '  User@Example.COM ');

    expect(result).toEqual({ status: 'found', userId: 'user-123' });
    expect(fake.lastArgs).toEqual({
      name: 'find_auth_user_id_by_email',
      params: { p_email: 'user@example.com' },
    });
  });

  test('該当なしなら not_found', async () => {
    const fake = new FakeSupabaseClient({ data: null, error: null });
    await expect(findAuthUserIdByEmail(asClient(fake), 'nobody@example.com')).resolves.toEqual({
      status: 'not_found',
    });
  });

  // 「引けなかった」を not_found に丸めると、RPC 障害時に
  // password-reset/request が無言で 200 を返し、register の重複検出も消える。
  test('RPC エラーは throw せず error で返す（not_found と区別する）', async () => {
    const fake = new FakeSupabaseClient({ data: null, error: { message: 'boom' } });
    await expect(findAuthUserIdByEmail(asClient(fake), 'user@example.com')).resolves.toEqual({
      status: 'error',
      message: 'boom',
    });
  });

  test('空文字なら RPC を呼ばない', async () => {
    const fake = new FakeSupabaseClient({ data: 'x', error: null });
    await expect(findAuthUserIdByEmail(asClient(fake), '   ')).resolves.toEqual({ status: 'not_found' });
    expect(fake.lastArgs).toBeNull();
  });
});

/**
 * isAuthUserUnconfirmed（SEC-AUTH-016-AC-04）。確認のリンクが切れた未確認の会員を見分ける。
 * 「未確認と確かめられた」時だけ真。引けない・誤り・投げる時は偽（既存会員として扱う従来の動きに倒す）。
 * 上と同じく this を参照するクラスでモックし、メソッドを引き剥がして呼ぶと失敗させる。
 */
class FakeAdminClient {
  private readonly marker = 'service-role';
  public lastUserId: unknown = null;
  readonly auth: { admin: { getUserById: (id: string) => Promise<{ data: unknown; error: unknown }> } };

  constructor(result: { data: unknown; error: unknown } | Error) {
    this.auth = {
      admin: {
        getUserById: (id: string) => {
          if (this.marker !== 'service-role') throw new Error('unexpected receiver');
          this.lastUserId = id;
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
      },
    };
  }
}

describe('isAuthUserUnconfirmed', () => {
  const asAdminClient = (fake: FakeAdminClient) => fake as unknown as SupabaseClient;

  test('DD-AUTH-018email_confirmed_at が空なら真（引いた id を渡す）', async () => {
    const fake = new FakeAdminClient({ data: { user: { id: 'u-1', email_confirmed_at: null } }, error: null });

    await expect(isAuthUserUnconfirmed(asAdminClient(fake), 'u-1')).resolves.toBe(true);
    expect(fake.lastUserId).toBe('u-1');
  });

  test('DD-AUTH-018email_confirmed_at があれば偽', async () => {
    const fake = new FakeAdminClient({ data: { user: { id: 'u-1', email_confirmed_at: '2026-11-01T00:00:00Z' } }, error: null });

    await expect(isAuthUserUnconfirmed(asAdminClient(fake), 'u-1')).resolves.toBe(false);
  });

  test.each([
    ['管理 API の誤り', { data: { user: null }, error: { message: 'boom' } }],
    ['利用者が返らない', { data: { user: null }, error: null }],
  ])('DD-AUTH-018 %s なら偽（確かめられない時は未確認として扱わない）', async (_label, result) => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeAdminClient(result);

    await expect(isAuthUserUnconfirmed(asAdminClient(fake), 'u-1')).resolves.toBe(false);
    errorSpy.mockRestore();
  });

  test('DD-AUTH-018 管理 API が投げても投げ返さず偽', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeAdminClient(new Error('network'));

    await expect(isAuthUserUnconfirmed(asAdminClient(fake), 'u-1')).resolves.toBe(false);
    errorSpy.mockRestore();
  });

  test('DD-AUTH-018admin を持たない client でも投げず偽', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(isAuthUserUnconfirmed({} as unknown as SupabaseClient, 'u-1')).resolves.toBe(false);
    errorSpy.mockRestore();
  });
});

export {};
