/**
 * パスキーのログインの「始め」の部品（src/features/auth/passkey/browser-start.ts）。画面は持たない（段2のログインの画面が呼ぶ）。
 * 設定が `server` ならアプリの窓口 (a)、`browser` なら GoTrue を直に呼ぶ (b)。ブラウザの WebAuthn の呼び出しと終わりの窓口への送信は段2。
 *
 * @packageDocumentation
 * @remarks import してよいのは `@/lib/auth/passkey-start-mode` だけ（`node:`・`server-only`・鍵の関数をブラウザの束に入れない）。
 * Cookie・トークン・`challenge_id` はログに出さない。
 */
import { resolvePasskeyStartMode, type PasskeyStartMode } from '@/lib/auth/passkey-start-mode';

export type PasskeyAuthenticationStart = {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  expires_at: number;
};

type GoTrueError = { status?: number; code?: string; message?: string };

export type PasskeyStartDeps = {
  mode: PasskeyStartMode;
  fetchApp?: typeof fetch;
  supabase?: {
    auth: {
      passkey: {
        startAuthentication(params?: {
          options?: { captchaToken?: string };
        }): Promise<{ data: PasskeyAuthenticationStart | null; error: GoTrueError | null }>;
      };
    };
  };
};

export type PasskeyStartResult =
  | { ok: true; start: PasskeyAuthenticationStart }
  | {
      ok: false;
      reason: 'rate_limited' | 'unavailable' | 'captcha_required' | 'failed';
      retryAfterSeconds?: number;
    };

const START_ENDPOINT = '/api/auth/passkey/login/start';

/**
 * 設定 `NEXT_PUBLIC_PASSKEY_START_MODE` をブラウザで読む。
 * Next.js はブラウザの束で `process.env.NEXT_PUBLIC_X` と**そのまま書いた形**だけを埋め込む。`process.env` 全体を渡すと空になり、いつも `server` になるので、値だけを取り出して渡す。
 *
 * @impl IMPL-AUTH-280
 * @design DD-AUTH-053
 */
export function resolveBrowserStartMode(): PasskeyStartMode {
  return resolvePasskeyStartMode({
    NEXT_PUBLIC_PASSKEY_START_MODE: process.env.NEXT_PUBLIC_PASSKEY_START_MODE,
  });
}

/** GoTrue・窓口の成功の応答は形を確かめる（使う項目だけ。違えば閉じる）。`userVerification` は必ず `required` にして返す。 */
function toStart(data: unknown): PasskeyAuthenticationStart | null {
  if (!data || typeof data !== 'object') return null;
  const { challenge_id, options, expires_at } = data as Record<string, unknown>;
  if (typeof challenge_id !== 'string' || challenge_id.length === 0) return null;
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const { challenge } = options as Record<string, unknown>;
  if (typeof challenge !== 'string' || challenge.length === 0) return null;
  return {
    challenge_id,
    options: { ...(options as PublicKeyCredentialRequestOptionsJSON), userVerification: 'required' },
    expires_at,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return seconds > 0 ? seconds : undefined;
}

function isCaptchaError(error: GoTrueError): boolean {
  return /captcha/i.test(`${error.code ?? ''} ${error.message ?? ''}`);
}

async function startAsServer(fetchApp: typeof fetch): Promise<PasskeyStartResult> {
  let response: Response;
  try {
    response = await fetchApp(START_ENDPOINT, { method: 'POST', credentials: 'same-origin' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
    return retryAfterSeconds === undefined
      ? { ok: false, reason: 'rate_limited' }
      : { ok: false, reason: 'rate_limited', retryAfterSeconds };
  }
  if (response.status === 503 || response.status === 409 || response.status === 502) {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) return { ok: false, reason: 'failed' };
  try {
    const start = toStart(await response.json());
    return start ? { ok: true, start } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

async function startAsBrowser(
  supabase: NonNullable<PasskeyStartDeps['supabase']>,
  captchaToken: string | undefined,
): Promise<PasskeyStartResult> {
  if (!captchaToken) return { ok: false, reason: 'captcha_required' };
  try {
    const { data, error } = await supabase.auth.passkey.startAuthentication({ options: { captchaToken } });
    if (error) {
      if (error.status === 429) return { ok: false, reason: 'rate_limited' };
      if (isCaptchaError(error)) return { ok: false, reason: 'captcha_required' };
      return { ok: false, reason: 'failed' };
    }
    const start = toStart(data);
    return start ? { ok: true, start } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * ログインの始めを行う関数を作る。`mode` が `server` ならアプリの窓口、`browser` なら GoTrue を直に呼ぶ。
 *
 * @impl IMPL-AUTH-272
 * @design DD-AUTH-053
 */
export function createPasskeyAuthenticationStarter(
  deps: PasskeyStartDeps,
): (input?: { captchaToken?: string }) => Promise<PasskeyStartResult> {
  return async (input) => {
    if (deps.mode === 'browser') {
      if (!deps.supabase) return { ok: false, reason: 'failed' };
      return startAsBrowser(deps.supabase, input?.captchaToken);
    }
    return startAsServer(deps.fetchApp ?? fetch);
  };
}
