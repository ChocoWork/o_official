/**
 * 通行証の amr（認証方法の記録）から、2 段目を通った方法があるかを読む。
 *
 * パスワードだけで得た通行証は数えない。初めての TOTP の登録を、メールの受け箱などを持つ人に限るために使う。
 * magiclink を数えるのは、確認済みの利用者のメール OTP を GoTrue が otp と magiclink のどちらで記録するかが未実測で、
 * 外すと管理者が最初の TOTP を登録できなくなる恐れがあるため。どちらも受け箱を持つ証明で、守りの強さは同じ。
 */

export const SECOND_FACTOR_AMR_METHODS: readonly string[] = [
  'otp',
  'magiclink',
  'totp',
  'oauth',
  'sso/saml',
  'email/signup',
];

function readMethod(entry: unknown): string | null {
  if (typeof entry === 'string') {
    return entry;
  }
  if (entry && typeof entry === 'object' && 'method' in entry) {
    const method = (entry as { method?: unknown }).method;
    return typeof method === 'string' ? method : null;
  }
  return null;
}

/** amr の中に 2 段目を通った方法が 1 つでもあれば真。配列でない・空・未定義は偽。 */
export function hasSecondFactorAmr(claims: { amr?: unknown } | null | undefined): boolean {
  const amr = claims?.amr;
  if (!Array.isArray(amr)) {
    return false;
  }
  return amr.some((entry) => {
    const method = readMethod(entry);
    return method !== null && SECOND_FACTOR_AMR_METHODS.includes(method);
  });
}
