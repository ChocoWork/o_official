/**
 * パスキーのログインの「始め」を、サーバーの窓口 (a) とブラウザの直の呼び出し (b) のどちらで行うかの設定。
 * ブラウザの部品も読むので、import は1つも持たない（鍵の関数を含むファイルと分ける）。
 *
 * @packageDocumentation
 */

export type PasskeyStartMode = 'server' | 'browser';

/**
 * `NEXT_PUBLIC_PASSKEY_START_MODE` を前後の空白・大小を無視して読む。`browser` の時だけ `browser`。未設定・空・知らない値は `server`。
 *
 * @impl IMPL-AUTH-250
 * @design DD-AUTH-051
 */
export function resolvePasskeyStartMode(
  env: Record<string, string | undefined> = process.env,
): PasskeyStartMode {
  return env.NEXT_PUBLIC_PASSKEY_START_MODE?.trim().toLowerCase() === 'browser' ? 'browser' : 'server';
}
