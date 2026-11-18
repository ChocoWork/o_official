import { createServiceRoleClient } from '@/lib/supabase/server';
import { passkeyDeleteFloorFailureReason, type PasskeyDeleteFloorReason } from '@/lib/auth/staff-passkey-invite-errors';

/** 削除の結果。下限を割る削除は `min_keys`、他人の鍵・存在しない鍵は `not_found`、DB の誤り・例外は `failed`（呼び手が閉じる側に倒す）。 */
export type StaffPasskeyDeleteResult = { ok: true } | { ok: false; reason: PasskeyDeleteFloorReason };

/**
 * 店員の鍵を、下限（認めた鍵が `min_approved_passkeys` 未満にならないこと）を DB の中で守って消す（`passkey_delete_with_floor`）。
 *
 * @impl IMPL-AUTH-387
 * @design DD-AUTH-082
 * @remarks 数えと削除が同じ取引で、同時の2つの削除でも下限を割らない。利用者は検証済みのセッションの人（リクエストの値ではない）を呼び手が渡す。
 * 認めていない鍵は、認めた鍵が下限未満でも消せる（疑わしい鍵を外せる）。DB が止める時は SQLSTATE と固定の文だけを見て、ログには文を残さない。
 */
export async function deleteStaffPasskey(userId: string, passkeyId: string): Promise<StaffPasskeyDeleteResult> {
  try {
    const service = await createServiceRoleClient();
    const { error } = (await service.rpc('passkey_delete_with_floor', { p_user_id: userId, p_passkey_id: passkeyId })) as {
      error: { code?: string; message?: string } | null;
    };
    if (!error) return { ok: true };
    const reason = passkeyDeleteFloorFailureReason(error.message);
    if (reason === 'failed') console.error('staff-passkey-delete: rpc returned an error', { code: error.code });
    return { ok: false, reason };
  } catch {
    console.error('staff-passkey-delete: rpc call failed');
    return { ok: false, reason: 'failed' };
  }
}
