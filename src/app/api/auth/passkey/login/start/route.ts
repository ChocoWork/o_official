/**
 * パスキーのログインの始め (a)（src/app/api/auth/passkey/login/start/route.ts）。
 * アプリのサーバーが `sb_secret_` の鍵で GoTrue の `/passkeys/authentication/options` を呼び、お客さんの IP を `Sb-Forwarded-For` に添える。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-271
 * @design DD-AUTH-052
 * @remarks 順番: 設定が `browser` なら 409 → IP が取れなければ 503（GoTrue も回数の枠も使わない）→ IP ごとの回数 → 鍵の確かめ → GoTrue。
 * IP は `getClientIp`（`x-forwarded-for` は読まない）だけから取る。無い時だけ手元の開発の IP を使う。
 * GoTrue の応答の使う項目を確かめ、形が違えば 502 で閉じる。`userVerification` は `required` に書き換える。
 */
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { withNoStore } from '@/lib/http/no-store';
import { getClientIp } from '@/lib/request-ip';
import { resolvePasskeyStartMode } from '@/lib/auth/passkey-start-mode';
import { resolvePasskeyStartDevIp, resolveStartSecretKey } from '@/lib/auth/passkey-start-config';
import { requestAuthenticationOptionsAsServer } from '@/lib/auth/passkey-gotrue';

const AUDIT_ACTION = 'auth.passkey.login.start';
const RATE_LIMIT = { endpoint: 'auth:passkey:login:start', limit: 20, windowSeconds: 300 } as const;

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return withNoStore(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }),
  );
}

async function deny(detail: string, body: unknown, status: number): Promise<Response> {
  await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail });
  return json(body, status);
}

type StartData = { challenge_id: string; options: Record<string, unknown>; expires_at: number };

function isStartData(data: unknown): data is StartData {
  if (!data || typeof data !== 'object') return false;
  const { challenge_id, options, expires_at } = data as Record<string, unknown>;
  if (typeof challenge_id !== 'string' || challenge_id.length === 0) return false;
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return false;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const { challenge } = options as Record<string, unknown>;
  return typeof challenge === 'string' && challenge.length > 0;
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (resolvePasskeyStartMode() === 'browser') {
      return json({ error: 'passkey_start_mode_browser' }, 409);
    }

    const clientIp = getClientIp(request) ?? resolvePasskeyStartDevIp();
    if (clientIp === null) {
      return await deny('client_ip_unavailable', { error: 'client_ip_unavailable' }, 503);
    }

    const limited = await enforceRateLimit({ request, ...RATE_LIMIT });
    if (limited) return limited;

    const secret = resolveStartSecretKey();
    if (!secret.ok) {
      return await deny(
        secret.reason === 'missing' ? 'secret_key_missing' : 'secret_key_bad_shape',
        { error: 'passkey_start_unavailable' },
        503,
      );
    }

    const result = await requestAuthenticationOptionsAsServer({ clientIp, secretKey: secret.key });
    if (!result.ok) {
      if (result.status === 429) {
        await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail: 'gotrue_rate_limited' });
        return json({ error: 'Too many requests' }, 429, { 'Retry-After': '300' });
      }
      return await deny('gotrue_failed', { error: 'passkey_start_failed' }, 502);
    }
    if (!isStartData(result.data)) {
      return await deny('gotrue_bad_response', { error: 'passkey_start_failed' }, 502);
    }

    const { challenge_id, options, expires_at } = result.data;
    return json({ challenge_id, options: { ...options, userVerification: 'required' }, expires_at }, 200);
  } catch {
    return await deny('unexpected_error', { error: 'passkey_start_failed' }, 502);
  }
}
