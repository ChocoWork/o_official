import { staffIdleCheck, staffIdlePeek, type StaffIdleResult } from '@/lib/auth/staff-passkey-idle-rpc';

/** 無操作の確かめが使う DB の呼び（テストで差し替える）。 */
export type StaffIdleDeps = {
  check: (sessionId: string, userId: string) => Promise<StaffIdleResult>;
  peek: (sessionId: string) => Promise<StaffIdleResult>;
};

/**
 * 本番の呼び（`staff-passkey-idle-rpc` の2本）。
 *
 * @impl IMPL-AUTH-380
 * @design DD-AUTH-081
 */
export const staffIdleDeps: StaffIdleDeps = { check: staffIdleCheck, peek: staffIdlePeek };

/**
 * 店員の無操作が1時間以内かを確かめる。`touch`（既定）は通れば時刻を進め（`staff_idle_check`）、
 * `peek` は時刻を進めない（`staff_idle_peek`。画面の `/api/auth/me` 用で、開き直すだけでは無操作が延びない）。
 *
 * @impl IMPL-AUTH-379
 * @design DD-AUTH-081
 * @remarks RPC が失敗したら `error`。呼び手は 503 の閉じる側に倒し、ログアウトも 401 もしない（`/api/auth/me` も 503・`unavailable`）。
 */
export async function checkStaffIdle(
  deps: StaffIdleDeps,
  sessionId: string,
  userId: string,
  mode: 'touch' | 'peek' = 'touch',
): Promise<'ok' | 'idle' | 'error'> {
  const result = mode === 'peek' ? await deps.peek(sessionId) : await deps.check(sessionId, userId);
  if (!result.ok) return 'error';
  return result.value ? 'ok' : 'idle';
}
