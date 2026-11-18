/**
 * DD-AUTH-081 店員の無操作の確かめ（src/lib/auth/staff-passkey-idle.ts）の単体テスト。
 */
import { checkStaffIdle, type StaffIdleDeps } from '@/lib/auth/staff-passkey-idle';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function makeDeps(result: { ok: true; value: boolean } | { ok: false }): StaffIdleDeps & { check: jest.Mock; peek: jest.Mock } {
  return { check: jest.fn().mockResolvedValue(result), peek: jest.fn().mockResolvedValue(result) };
}

describe('checkStaffIdle', () => {
  it('DD-AUTH-081 既定の touch は staff_idle_check を呼び、真なら ok（最後に使った時刻が1時間以内）', async () => {
    const deps = makeDeps({ ok: true, value: true });
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID)).resolves.toBe('ok');
    expect(deps.check).toHaveBeenCalledWith(SESSION_ID, USER_ID);
    expect(deps.peek).not.toHaveBeenCalled();
  });

  it('DD-AUTH-081 偽（1時間を過ぎた・行も auth.sessions にも無い）は idle', async () => {
    const deps = makeDeps({ ok: true, value: false });
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID, 'touch')).resolves.toBe('idle');
  });

  it('DD-AUTH-081 peek は staff_idle_peek だけを呼び（時刻を進めない）、利用者は渡さない', async () => {
    const deps = makeDeps({ ok: true, value: true });
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID, 'peek')).resolves.toBe('ok');
    expect(deps.peek).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.check).not.toHaveBeenCalled();
    deps.peek.mockResolvedValue({ ok: true, value: false });
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID, 'peek')).resolves.toBe('idle');
  });

  it('DD-AUTH-081 RPC の失敗は error（touch も peek も。idle にも ok にもしない）', async () => {
    const deps = makeDeps({ ok: false });
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID, 'touch')).resolves.toBe('error');
    await expect(checkStaffIdle(deps, SESSION_ID, USER_ID, 'peek')).resolves.toBe('error');
  });
});
