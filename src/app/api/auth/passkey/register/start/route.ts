/**
 * パスキーの登録の始め（src/app/api/auth/passkey/register/start/route.ts）。
 * 登録の条件（店員は登録の窓か5分以内の入り直し、お客さんは10分以内のパスキーかメールのコード）を確かめてから、GoTrue の選択肢を取る。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-276
 * @design DD-AUTH-056
 * @remarks 順番と確かめは `guardPasskeyRegistration`（終わりと同じ）。外れたら GoTrue を呼ばない。
 * 選択肢は `authenticatorSelection.userVerification` を `required` に書き換えて返す（応答に `authenticatorSelection` が無ければ作る）。GoTrue の失敗・形の違いは 502。
 */
import { logAudit } from '@/lib/audit';
import { registrationOptions } from '@/lib/auth/passkey-gotrue';
import { guardPasskeyRegistration, registrationJson } from '@/lib/auth/passkey-registration-guard';

const AUDIT_ACTION = 'auth.passkey.register.start';

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
    const guard = await guardPasskeyRegistration(request, {
      auditAction: AUDIT_ACTION,
      endpoint: 'auth:passkey:register:start',
    });
    if (!guard.ok) return guard.response;

    const result = await registrationOptions(guard.accessToken);
    if (!result.ok) {
      await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail: 'gotrue_failed', actor_id: guard.userId });
      return registrationJson({ error: 'passkey_register_failed' }, 502);
    }
    if (!isStartData(result.data)) {
      await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail: 'gotrue_bad_response', actor_id: guard.userId });
      return registrationJson({ error: 'passkey_register_failed' }, 502);
    }

    const { challenge_id, options, expires_at } = result.data;
    const existing = options.authenticatorSelection;
    const selection =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
    const body = {
      challenge_id,
      options: { ...options, authenticatorSelection: { ...selection, userVerification: 'required' } },
      expires_at,
      mode: guard.mode,
    };

    await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: `register_start:${guard.mode}`, actor_id: guard.userId });
    return registrationJson(body, 200);
  } catch {
    console.error('passkey register start handler error');
    await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'unexpected_error' });
    return registrationJson({ error: 'Internal server error' }, 500);
  }
}
