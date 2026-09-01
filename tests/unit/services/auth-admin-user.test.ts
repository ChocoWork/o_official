import { findAuthUserIdByEmail } from '@/features/auth/services/auth-admin-user';
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

export {};
