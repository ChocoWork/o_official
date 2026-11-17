/**
 * パスキーの登録の終わり（src/app/api/auth/passkey/register/finish/route.ts）。
 * 始めと同じ確かめをやり直し → UV の印 → GoTrue の検証 → 店員なら認める（失敗したら GoTrue に作られた鍵を消す）、の順に進める。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-277
 * @design DD-AUTH-056
 * @remarks 順番: `guardPasskeyRegistration`（始めと同じ。窓が閉じていたら GoTrue を呼ばない）→ 本文の形（`id` と `rawId` の一致を含む）→
 * 登録の `attestationObject` の UV の印（無ければ 400 `uv_required`）→ GoTrue の検証 → 店員は `passkey_approve`（窓は `window`、入り直しは `reauth`）。
 * 認めが落ちたら（古い行・窓の上限の競り負けを含む）、管理 API で今作られた鍵を消して 500 `passkey_approve_failed`。消すのも失敗したら
 * 監査に `passkey_approve_failed:compensation_failed`。お客さんは認めの表を使わない。窓は閉じない・セッションは終わらせない（段3）。
 */
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { PasskeyRegisterFinishSchema } from '@/features/auth/schemas/passkey';
import { readAttestationUserVerified } from '@/lib/auth/passkey-uv';
import { registrationVerify } from '@/lib/auth/passkey-gotrue';
import { approve, approvedCount } from '@/lib/auth/passkey-approval-rpc';
import { guardPasskeyRegistration, registrationJson } from '@/lib/auth/passkey-registration-guard';

const AUDIT_ACTION = 'auth.passkey.register.finish';

type CreatedPasskey = { id: string; friendly_name: string | null; created_at: string };

function readCreatedPasskey(data: unknown): CreatedPasskey | null {
  if (!data || typeof data !== 'object') return null;
  const { id, friendly_name, created_at } = data as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || typeof created_at !== 'string') return null;
  return { id, friendly_name: typeof friendly_name === 'string' ? friendly_name : null, created_at };
}

/** 今作られた鍵を管理 API で消す（補償）。失敗しても例外にせず、結果だけ返す。 */
async function deleteCreatedPasskey(userId: string, passkeyId: string): Promise<boolean> {
  try {
    const service = await createServiceRoleClient();
    const { error } = await service.auth.admin.passkey.deletePasskey({ userId, passkeyId });
    return !error;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const guard = await guardPasskeyRegistration(request, {
      auditAction: AUDIT_ACTION,
      endpoint: 'auth:passkey:register:finish',
    });
    if (!guard.ok) return guard.response;
    const actorId = guard.userId;

    const deny = async (detail: string, body: unknown, status: number) => {
      await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail, actor_id: actorId });
      return registrationJson(body, status);
    };

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return await deny('invalid_request', { error: 'invalid_request' }, 400);
    }
    const parsed = PasskeyRegisterFinishSchema.safeParse(raw);
    if (!parsed.success) return await deny('invalid_request', { error: 'invalid_request' }, 400);
    const { challenge_id: challengeId, credential } = parsed.data;

    // 使えない鍵を数に入れないための確かめ。ここまで GoTrue の検証を呼ばない。
    if (readAttestationUserVerified(credential.response.attestationObject) !== true) {
      return await deny('uv_required', { error: 'uv_required' }, 400);
    }

    const verified = await registrationVerify(guard.accessToken, { challengeId, credential: credential as never });
    if (!verified.ok) {
      return await deny('gotrue_failed', { error: 'passkey_register_failed' }, 502);
    }
    const passkey = readCreatedPasskey(verified.data);
    if (!passkey) return await deny('gotrue_bad_response', { error: 'passkey_register_failed' }, 502);

    let count: number | undefined;
    if (guard.isStaff) {
      const approved = await approve(actorId, passkey.id, guard.mode === 'window' ? 'window' : 'reauth');
      if (!approved.ok) {
        const removed = await deleteCreatedPasskey(actorId, passkey.id);
        return await deny(
          removed ? 'passkey_approve_failed' : 'passkey_approve_failed:compensation_failed',
          { error: 'passkey_approve_failed' },
          500,
        );
      }
      const counted = await approvedCount(actorId);
      if (counted.ok) count = counted.value;
    }

    await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: `register_finish:${guard.mode}`, actor_id: actorId });
    return registrationJson(
      {
        passkey: { id: passkey.id, friendly_name: passkey.friendly_name, created_at: passkey.created_at },
        ...(count !== undefined ? { approvedCount: count } : {}),
      },
      200,
    );
  } catch {
    console.error('passkey register finish handler error');
    await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'unexpected_error' });
    return registrationJson({ error: 'Internal server error' }, 500);
  }
}
