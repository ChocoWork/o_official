import crypto from 'crypto';

/**
 * 漏洩済みパスワードの検査。HaveIBeenPwned の Pwned Passwords Range API を使う。
 *
 * Supabase の leaked password protection は Pro プラン以上でしか有効にできないため
 * （公式: "Leaked password protection is available on the Pro Plan and above."）、
 * 同等の制御をアプリ側に置く。Supabase が内部で使っているのと同じ仕組み。
 *
 * k-匿名性方式なので、**パスワードも完全なハッシュも送らない**。
 * SHA-1 の先頭 5 文字だけを送り、返ってきたサフィックス一覧をローカルで照合する。
 * 相手に渡るのは 5 文字のプレフィックスだけで、そこには数百件が該当する。
 *
 * SHA-1 を使うのは HIBP の API がそう定めているため。ここでの用途は
 * 「照合キー」であってパスワードの保存ではない（保存は Supabase の bcrypt）。
 *
 * NIST SP 800-63B と OWASP ASVS 2.1.7 が求めるのはこの「漏洩リストとの照合」であり、
 * 文字種の構成規則ではない（ASVS 2.1.9 は構成規則を明確に非推奨としている）。
 */

const RANGE_API = 'https://api.pwnedpasswords.com/range';
const TIMEOUT_MS = 3000;

export type PwnedCheckResult =
  | { status: 'pwned'; count: number }
  | { status: 'ok' }
  /** 外部 API に到達できなかった。呼び出し側は登録を止めないこと（下記参照）。 */
  | { status: 'unavailable'; reason: string };

/**
 * @returns 漏洩リストに載っていれば `pwned`、載っていなければ `ok`、
 *   HIBP に到達できなければ `unavailable`。
 *
 * `unavailable` のとき呼び出し側は **fail-open**（登録や再設定を通す）にする。
 * 外部サービスの障害で自社の認証を止めるのは割に合わない。
 * 代わりに監査ログへ残し、検査が効いていない期間を後から追えるようにする。
 */
export async function checkPwnedPassword(password: string): Promise<PwnedCheckResult> {
  if (!password) {
    return { status: 'ok' };
  }

  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const response = await fetch(`${RANGE_API}/${prefix}`, {
      method: 'GET',
      headers: {
        // 応答にダミーを混ぜてもらい、返却サイズからプレフィックスを推測されにくくする。
        'Add-Padding': 'true',
        'User-Agent': 'o-official-password-check',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 同じプレフィックスの結果は使い回して良い。
      cache: 'force-cache',
    });

    if (!response.ok) {
      return { status: 'unavailable', reason: `hibp_status_${response.status}` };
    }

    const body = await response.text();

    // 1 行 = "<SHA1 のサフィックス 35 文字>:<出現回数>"
    for (const line of body.split('\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;

      if (line.slice(0, separator).trim().toUpperCase() === suffix) {
        const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
        // padding で混ぜられたダミーは count が 0 で返る。
        if (Number.isFinite(count) && count > 0) {
          return { status: 'pwned', count };
        }
        return { status: 'ok' };
      }
    }

    return { status: 'ok' };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.name : String(error) };
  }
}

/** 画面に出す文言。件数は出さない（攻撃者に情報を与えるだけで利用者の役に立たない）。 */
export const PWNED_PASSWORD_MESSAGE =
  'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。';
