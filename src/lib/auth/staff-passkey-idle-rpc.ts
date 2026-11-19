import { createServiceRoleClient } from '@/lib/supabase/server';

/** 呼び出しの結果。誤り・例外・真偽でない値は `{ ok: false }` で、呼び手は 503 か「しばらくしてから」を返す（ログアウトさせない）。 */
export type StaffIdleResult = { ok: true; value: boolean } | { ok: false };

async function callIdleRpc(name: string, args: Record<string, unknown>): Promise<StaffIdleResult> {
  try {
    const service = await createServiceRoleClient();
    const { data, error } = (await service.rpc(name, args)) as { data: unknown; error: { code?: string } | null };
    if (error) {
      console.error('staff-passkey-idle-rpc: rpc returned an error', { name, code: error.code });
      return { ok: false };
    }
    return typeof data === 'boolean' ? { ok: true, value: data } : { ok: false };
  } catch {
    console.error('staff-passkey-idle-rpc: rpc call failed', { name });
    return { ok: false };
  }
}

/**
 * 店員の無操作が1時間以内かを確かめ、通れば時刻を進める（DB の `staff_idle_check`。確かめと書き込みを1回の呼びで）。
 *
 * @remarks 時刻の書き込みが失敗すると DB は例外を投げる（真を返さない）。その時は `{ ok: false }` になり、呼び手（窓口・ページ）は 503 の閉じる側に倒す。
 *
 * @impl IMPL-AUTH-350
 * @design DD-AUTH-074
 */
export function staffIdleCheck(sessionId: string, userId: string): Promise<StaffIdleResult> {
  return callIdleRpc('staff_idle_check', { p_session_id: sessionId, p_user_id: userId });
}

/**
 * 店員の無操作が1時間以内かを見るだけで、時刻を進めない（DB の `staff_idle_peek`。`/api/auth/me` 用）。
 *
 * @impl IMPL-AUTH-351
 * @design DD-AUTH-074
 */
export function staffIdlePeek(sessionId: string): Promise<StaffIdleResult> {
  return callIdleRpc('staff_idle_peek', { p_session_id: sessionId });
}

/**
 * 店員の最後の操作の時刻を進める（DB の `staff_session_touch`。60秒の間引き。書いたら真、間引かれたら偽）。
 *
 * @impl IMPL-AUTH-352
 * @design DD-AUTH-074
 */
export function staffSessionTouch(sessionId: string, userId: string): Promise<StaffIdleResult> {
  return callIdleRpc('staff_session_touch', { p_session_id: sessionId, p_user_id: userId });
}
