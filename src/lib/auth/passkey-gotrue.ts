import type {
  PasskeyAuthenticationOptionsResponse,
  PasskeyListItem,
  PasskeyMetadata,
  PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationVerifyParams,
} from '@supabase/supabase-js';

/**
 * GoTrue のパスキーの REST を `fetch` で直に呼ぶ薄い層（src/lib/auth/passkey-gotrue.ts）。
 * supabase-js のパスキーの関数は更新トークンつきの session が要るが、窓口は要求の Cookie のアクセストークンしか持たないので使わない。
 * すべて例外を投げず、10秒で打ち切り、トークン・鍵を `message` に入れない。
 *
 * @packageDocumentation
 */

export type GoTrueResult<T> = { ok: true; data: T } | { ok: false; status: number; message?: string };
export type PublicKeyCredentialRequestOptionsJSON = PasskeyAuthenticationOptionsResponse['options'];
export type PasskeyRegistrationCredential = PasskeyRegistrationVerifyParams['credential'];

const TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 200;
/** supabase-js（auth-js の `lib/fetch.js`）と同じ版。誤りの本文の形（`msg`・`message`・`error_code`）がそろう。 */
const API_VERSION = '2024-01-01';

function authBaseUrl(): string {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  return `${url.replace(/\/+$/, '')}/auth/v1`;
}

function errorMessage(body: unknown, secrets: string[]): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { msg, message } = body as { msg?: unknown; message?: unknown };
  let text = typeof msg === 'string' ? msg : typeof message === 'string' ? message : undefined;
  if (!text) return undefined;
  for (const secret of secrets) if (secret) text = text.split(secret).join('');
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

type CallOptions = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  expectBody?: boolean;
};

async function call<T>(options: CallOptions, secrets: string[]): Promise<GoTrueResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${authBaseUrl()}${options.path}`, {
      method: options.method,
      headers: { 'X-Supabase-Api-Version': API_VERSION, 'Content-Type': 'application/json', ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsedOk = false;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: parsedOk ? errorMessage(parsed, secrets) : undefined };
    }
    if (options.expectBody === false) return { ok: true, data: null as T };
    if (!parsedOk || parsed === undefined) return { ok: false, status: res.status };
    return { ok: true, data: parsed as T };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function userHeaders(accessToken: string): Record<string, string> {
  return { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${accessToken}` };
}

/**
 * ログインの始め (a)。`sb_secret_` の鍵を `apikey` だけで渡し、お客さんの IP を `Sb-Forwarded-For` に添える。`Authorization` は付けない。本文は `{}`。
 *
 * @impl IMPL-AUTH-257
 * @design DD-AUTH-051
 */
export function requestAuthenticationOptionsAsServer(input: {
  clientIp: string;
  secretKey: string;
}): Promise<GoTrueResult<{ challenge_id: string; options: PublicKeyCredentialRequestOptionsJSON; expires_at: number }>> {
  return call(
    {
      method: 'POST',
      path: '/passkeys/authentication/options',
      headers: { apikey: input.secretKey, 'Sb-Forwarded-For': input.clientIp },
      body: {},
    },
    [input.secretKey],
  );
}

/**
 * 登録の始め。
 *
 * @impl IMPL-AUTH-258
 * @design DD-AUTH-051
 */
export function registrationOptions(accessToken: string): Promise<GoTrueResult<PasskeyRegistrationOptionsResponse>> {
  return call(
    { method: 'POST', path: '/passkeys/registration/options', headers: userHeaders(accessToken), body: {} },
    [accessToken],
  );
}

/**
 * 登録の終わり。
 *
 * @impl IMPL-AUTH-259
 * @design DD-AUTH-051
 */
export function registrationVerify(
  accessToken: string,
  input: { challengeId: string; credential: PasskeyRegistrationCredential },
): Promise<GoTrueResult<PasskeyMetadata>> {
  return call(
    {
      method: 'POST',
      path: '/passkeys/registration/verify',
      headers: userHeaders(accessToken),
      body: { challenge_id: input.challengeId, credential: input.credential },
    },
    [accessToken],
  );
}

/**
 * 鍵の一覧。
 *
 * @impl IMPL-AUTH-260
 * @design DD-AUTH-051
 */
export function listPasskeys(accessToken: string): Promise<GoTrueResult<PasskeyListItem[]>> {
  return call({ method: 'GET', path: '/passkeys', headers: userHeaders(accessToken) }, [accessToken]);
}

/**
 * 鍵の名前の変更。
 *
 * @impl IMPL-AUTH-261
 * @design DD-AUTH-051
 */
export function updatePasskey(
  accessToken: string,
  input: { passkeyId: string; friendlyName: string },
): Promise<GoTrueResult<PasskeyListItem>> {
  return call(
    {
      method: 'PATCH',
      path: `/passkeys/${encodeURIComponent(input.passkeyId)}`,
      headers: userHeaders(accessToken),
      body: { friendly_name: input.friendlyName },
    },
    [accessToken],
  );
}

/**
 * 鍵の削除。
 *
 * @impl IMPL-AUTH-262
 * @design DD-AUTH-051
 */
export function deletePasskey(accessToken: string, passkeyId: string): Promise<GoTrueResult<null>> {
  return call(
    {
      method: 'DELETE',
      path: `/passkeys/${encodeURIComponent(passkeyId)}`,
      headers: userHeaders(accessToken),
      expectBody: false,
    },
    [accessToken],
  );
}
