/**
 * Supabase の captcha を免除される「auth だけ」のクライアントと、captcha の拒否の見分け（src/lib/auth/service-role-auth-client.ts）。
 *
 * @packageDocumentation
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 呼び手が使う 4 つの関数だけを持つ。`.from()`・`.rpc()`・`.storage` と、`auth.admin`・`auth.mfa` などの
 * 残りの `auth` の機能（サービスの鍵の見出しで動く利用者の削除・更新・generateLink を含む）を型にも実体にも持たない。
 */
export type ServiceRoleAuthClient = {
  auth: Pick<SupabaseClient['auth'], 'signInWithPassword' | 'signInWithOtp' | 'signUp' | 'resend'>;
};

/**
 * 毎回新しく作る（使い回さない）。
 * SUPABASE_URL（無ければ NEXT_PUBLIC_SUPABASE_URL）と SUPABASE_SERVICE_ROLE_KEY が無ければ throw する。文に鍵の値を載せない。
 *
 * @impl IMPL-AUTH-228
 * @design DD-AUTH-040
 * @remarks captcha が掛かる窓口（/signup・/token（password）・/otp）をアプリのサーバーが呼ぶ時は、GoTrue の管理者免除で通すためサービスの鍵で呼ぶ。
 * アプリの Turnstile の検証は窓口の手前で済んでいて、トークンは 1 回しか使えないので GoTrue へは転送しない。
 * signInWithPassword の後、クライアントは利用者の session をメモリに保持する。そのクライアントで DB や RPC を呼ぶと
 * 利用者の権限で動くか、サービスの権限が混ざる。だから返すのは auth の 4 つの関数（signInWithPassword・signInWithOtp・signUp・resend）だけで、
 * 毎回作り直し、.from()・.rpc()・auth.admin・auth.mfa を持たせない（サービスの鍵の見出しで動く管理 API が、利用者の入力を扱う呼び手から届かないように）。
 * DB・RPC・管理 API は従来の createServiceRoleClient を使い、両者を 1 つの変数に混ぜない。
 */
export async function createServiceRoleAuthClient(): Promise<ServiceRoleAuthClient> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set for service role client');
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  // from・rpc・storage・auth.admin・auth.mfa を渡さない。client や auth の全体を返すと、呼び手が DB や管理 API へ使い回せてしまう。
  // 4 つの関数は GoTrueClient の中の this を使うので、auth に束ねて取り出す。
  const { auth } = client;
  return {
    auth: {
      signInWithPassword: auth.signInWithPassword.bind(auth),
      signInWithOtp: auth.signInWithOtp.bind(auth),
      signUp: auth.signUp.bind(auth),
      resend: auth.resend.bind(auth),
    },
  };
}

/**
 * Supabase の captcha が断った誤りか。
 * `code === 'captcha_failed'`、または status が 400 で message に captcha を含む。
 * 資格情報の誤り（Invalid login credentials）はこれに当たらない。
 *
 * @impl IMPL-AUTH-233
 * @design DD-AUTH-040
 * @remarks 管理者免除が効かない時（鍵の種類の違いなど）、GoTrue は 400 の captcha_failed を返す。これを資格情報の誤り（401）に丸めると、
 * 全員が入れないのに監視に上がらない。呼び手は 5xx と監査 supabase_captcha_rejected で気付けるようにする。
 */
export function isCaptchaRejection(
  error: { code?: string; status?: number; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === 'captcha_failed') return true;
  return error.status === 400 && /captcha/i.test(String(error.message ?? ''));
}
