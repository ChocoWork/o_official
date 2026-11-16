/**
 * フックの拒否（店員はパスキーでだけ入れる）を、アプリが言い回しに頼らず見分けるための印。
 * DB の関数 `public.passkey_access_token_hook`（移行 20261116230000）が拒否の文の頭に付ける物と同じ文字列にする。
 */
export const STAFF_PASSKEY_REQUIRED_MARKER = '[staff-passkey-required]';

/**
 * GoTrue が返した誤りが、フックの「店員はパスキーでだけ入れる」拒否かを調べる。
 *
 * @impl IMPL-AUTH-241
 * @design DD-AUTH-044
 * @remarks GoTrue はフックの拒否を HTTP 403・`code: unknown`・`message` にフックの文のまま返す（手元の試し T2）。
 * 状態が 403 で、文が印で始まる時だけ真にする。
 */
export function isStaffPasskeyRequiredError(
  error: { status?: number; message?: string } | null | undefined,
): boolean {
  return (
    error?.status === 403 &&
    typeof error.message === 'string' &&
    error.message.startsWith(STAFF_PASSKEY_REQUIRED_MARKER)
  );
}
