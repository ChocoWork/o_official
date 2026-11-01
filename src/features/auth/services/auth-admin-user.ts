import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * メールアドレスの解決結果。
 *
 * 「該当なし」と「引けなかった」を必ず区別する。両方を null に潰すと、
 * RPC が落ちた瞬間に呼び出し側が「アカウントが無い」と解釈してしまう:
 *   - password-reset/request は無言で 200 を返し、再設定が全滅しても誰も気づけない
 *   - register は重複検出が消え、409 ガードが無言で無効化される
 * どちらも障害が成功として記録されるため、監視でも検出できない。
 */
export type AuthUserLookup =
  | { status: 'found'; userId: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/**
 * メールアドレスから auth.users の id を引く。
 *
 * 引数は必ず実物の SupabaseClient を受ける。以前はモックを通しやすくするために
 * `{ auth?: { admin?: { listUsers?: ... } } }` という構造的な型にしていたが、
 * その形だとメソッドをレシーバから引き剥がして呼べてしまう。auth-js の
 * GoTrueAdminApi は本体で this.fetch / this.url / this.headers を参照するため、
 * 剥がして呼ぶと本番だけ TypeError で落ちる（素のオブジェクトのモックは通る）。
 * 同じ穴を開けないよう、ここを緩めないこと。
 *
 * 解決は SECURITY DEFINER 関数（093）に寄せている。auth.admin.listUsers は
 * メール絞り込みに対応しておらず（PageParams は page / perPage のみ）、
 * 全件取得して線形探索するしかないため。
 *
 * 注意: 093 の関数は SSO / banned / 論理削除済みユーザーを除外する。
 * 「パスワードを再設定できるユーザー」を返す関数であり、
 * 「そのメールが登録済みか」とは意味が違う。
 */
export async function findAuthUserIdByEmail(
  supabase: SupabaseClient,
  email: string
): Promise<AuthUserLookup> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return { status: 'not_found' };

  const { data, error } = await supabase.rpc('find_auth_user_id_by_email', {
    p_email: normalizedEmail,
  });

  if (error) {
    console.error('[auth.findAuthUserIdByEmail] RPC error:', error);
    return { status: 'error', message: error.message ?? 'rpc_failed' };
  }

  if (typeof data === 'string' && data) {
    return { status: 'found', userId: data };
  }

  return { status: 'not_found' };
}

/**
 * 利用者がメールを確認していないか（email_confirmed_at が空か）を管理 API で確かめる。
 *
 * 確認のリンクの有効期限（5 分）を過ぎた未確認の会員が、同じメールで登録し直した時に、
 * 「すでに登録されています」のメールではなく確認メールを送り直すために使う（SEC-AUTH-016-AC-04）。
 * 真を返すのは「未確認と確かめられた」時だけ。引けない・誤り・例外は偽に倒し、従来の既存会員の扱いに戻す
 * （確かめられないのに確認メールを送り直さない）。投げ返さない。
 * find_auth_user_id_by_email（093）は id しか返さず、変えると移行になるので、確認の有無は別に引く。
 */
export async function isAuthUserUnconfirmed(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      console.error('[auth.isAuthUserUnconfirmed] getUserById failed:', error?.message ?? 'no_user');
      return false;
    }
    return !data.user.email_confirmed_at;
  } catch (e) {
    console.error('[auth.isAuthUserUnconfirmed] getUserById threw:', e instanceof Error ? e.name : 'unknown');
    return false;
  }
}
