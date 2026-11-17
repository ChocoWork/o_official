/**
 * 端末の名前の初期値（src/features/auth/passkey/device-name.ts）。
 *
 * @packageDocumentation
 */

const MAX_LENGTH = 64;
const FALLBACK = 'この端末';
const KEYWORDS = ['iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux'] as const;

/**
 * User-Agent から端末の名前を作る。`iPhone`・`iPad`・`Android`・`Mac`・`Windows`・`Linux` を含む順に見て、無ければ `この端末`。最大64字。
 *
 * @impl IMPL-AUTH-304
 * @design DD-AUTH-060
 */
export function deviceNameFromUserAgent(ua: string): string {
  const found = KEYWORDS.find((keyword) => ua.includes(keyword));
  return [...(found ?? FALLBACK)].slice(0, MAX_LENGTH).join('');
}
