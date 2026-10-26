/**
 * 戻り先の控えの保存（src/features/auth/return-intent/return-intent-store.ts）。
 *
 * @packageDocumentation
 * @remarks 表は private スキーマで PostgREST から見えないため、service_role だけが呼べる公開の関数 2 本（rpc）で触る。
 * 番号の平文は DB に渡さず sha256 のハッシュだけを渡す。失敗は例外にせず null で返し、ログインそのものを止めない。
 * ログには符号だけを残し、道筋・番号・ハッシュは出さない。
 */
import { createHash, randomBytes } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

export type ReturnIntentPurpose = 'login' | 'signup';

/** 32 バイトの乱数を base64url にした 43 文字。 */
export const RETURN_INTENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * 戻り先の控えの番号を作る。
 *
 * @impl IMPL-AUTH-214
 * @design DD-AUTH-033
 * @remarks 推測できないことが唯一の守りなので、128 ビットを超える 256 ビットの暗号用の乱数を使う。
 */
export function generateReturnIntentToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 番号を DB に渡す形（sha256 の 16 進 64 桁）にする。
 *
 * @impl IMPL-AUTH-215
 * @design DD-AUTH-033
 * @remarks 表が漏れても番号そのものは分からないようにする。bindTo（登録したメール）を渡すと番号とメールを
 * 一緒にハッシュし、別のメールの印では行に当たらないようにする（登録の確認リンクの結び付け。SEC-AUTH-007、ADR-0413）。
 * 渡さない時（ログイン）は番号だけのハッシュで、今までと同じ。
 */
export function hashReturnIntentToken(token: string, bindTo?: string): string {
  const material = bindTo === undefined ? token : `${token}\n${normalizeBindEmail(bindTo)}`;
  return createHash('sha256').update(material).digest('hex');
}

/**
 * 結び付けのメールを正規化する（前後の空白を除いて小文字にする）。
 *
 * @impl IMPL-AUTH-222
 * @design DD-AUTH-033
 * @remarks 大文字小文字や空白の違いで、同じ人の結び付けが外れないようにする。
 */
export function normalizeBindEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 戻り先を控え、Cookie に置く番号と Max-Age（秒）を返す。失敗は null。
 *
 * @impl IMPL-AUTH-207
 * @design DD-AUTH-033
 * @remarks 期限は DB の関数が用途で決め、Cookie の Max-Age は戻り値の秒数をそのまま使う（期限とずらさない）。
 */
export async function createReturnIntent(input: {
  returnPath: string;
  purpose: ReturnIntentPurpose;
  bindTo?: string;
}): Promise<{ token: string; maxAgeSeconds: number } | null> {
  try {
    const token = generateReturnIntentToken();
    const client = await createServiceRoleClient();
    const { data, error } = await client.rpc('create_auth_return_intent', {
      _token_hash: hashReturnIntentToken(token, input.bindTo),
      _return_path: input.returnPath,
      _purpose: input.purpose,
    });
    if (error) {
      console.error('return-intent create failed', { code: error.code });
      return null;
    }
    if (typeof data !== 'number' || !Number.isInteger(data) || data <= 0) {
      console.error('return-intent create returned unexpected value');
      return null;
    }
    return { token, maxAgeSeconds: data };
  } catch {
    console.error('return-intent create threw');
    return null;
  }
}

/**
 * 番号の控えを 1 回で使い切り、戻り先の道筋を返す。使えない・失敗は null。
 *
 * @impl IMPL-AUTH-213
 * @design DD-AUTH-033
 * @remarks 使い切りは DB の関数の 1 文（UPDATE … RETURNING）で行い、2 回呼ばれても 2 回目は必ず null になる。
 * 期限切れ・使用済み・別の用途・存在しないは区別せず null にする（理由を端末へ漏らさない）。
 */
export async function consumeReturnIntent(input: {
  token: string;
  purpose: ReturnIntentPurpose;
  userId: string;
  bindTo?: string;
}): Promise<string | null> {
  try {
    const client = await createServiceRoleClient();
    const { data, error } = await client.rpc('consume_auth_return_intent', {
      _token_hash: hashReturnIntentToken(input.token, input.bindTo),
      _purpose: input.purpose,
      _user_id: input.userId,
    });
    if (error) {
      console.error('return-intent consume failed', { code: error.code });
      return null;
    }
    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch {
    console.error('return-intent consume threw');
    return null;
  }
}
