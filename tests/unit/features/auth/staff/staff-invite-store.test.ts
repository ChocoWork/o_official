/**
 * DD-AUTH-075 店員の招待の DB を呼ぶ部品（src/features/auth/staff/staff-invite-store.ts）の単体テスト。
 */

jest.mock('server-only', () => ({}), { virtual: true });

import {
  activateStaffRole,
  bindStaffInviteWindow,
  cancelStaffInvite,
  consumeStaffInvite,
  demoteStaff,
  hasOpenStaffInvite,
  issueStaffInvite,
} from '@/features/auth/staff/staff-invite-store';
import { hashInviteToken } from '@/features/auth/staff/invite-token';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = '0123456789abcdef0123456789abcdef0123456789a';
const FIXED_HASH_HEX = '263b9741bfc84598b8f5688c5481887c8493d40b0b557de2f2f9b0329139c5db';
const SECRET_MESSAGE = 'duplicate key value violates unique constraint "secret_internal_detail"';

const rpc = jest.fn();
const deps = { rpc };

const fail = (message: string, code = 'P0001') => ({ data: null, error: { message, code } });
const ok = (data: unknown) => ({ data, error: null });
const hashArgToHex = (arg: string) => arg.replace(/^\\x/, '');

const issueInput = { userId: USER_ID, roleCode: 'admin' as const, kind: 'invite' as const, issuedBy: ACTOR_ID, reason: null };

describe('staff-invite-store', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    rpc.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('issueStaffInvite', () => {
    it('DD-AUTH-075 staff_invite_issue を引数どおりに呼び、招待の id と合言葉を返す（ハッシュは合言葉から作る）', async () => {
      rpc.mockResolvedValue(ok(INVITE_ID));
      const result = await issueStaffInvite(deps, { ...issueInput, kind: 'redo', reason: '端末の紛失' });
      expect(result).toEqual({ ok: true, value: { inviteId: INVITE_ID, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } });
      expect(rpc).toHaveBeenCalledTimes(1);
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe('staff_invite_issue');
      expect(args).toMatchObject({
        p_user_id: USER_ID,
        p_role_code: 'admin',
        p_kind: 'redo',
        p_issued_by: ACTOR_ID,
        p_reason: '端末の紛失',
      });
      const token = (result as { value: { token: string } }).value.token;
      expect(hashArgToHex(args.p_token_hash)).toBe(Buffer.from(hashInviteToken(token)).toString('hex'));
    });

    it('DD-AUTH-075 例外の文を理由に写す', async () => {
      const cases: Array<[string, string]> = [
        ['LAST_ADMIN_REQUIRED', 'last_admin'],
        ['SELF_ROLE_CHANGE_FORBIDDEN', 'self'],
        ['STAFF_ALREADY_STAFF', 'already_staff'],
        ['ROLE_PERMISSION_FORBIDDEN', 'forbidden'],
        ['USER_NOT_FOUND', 'not_found'],
      ];
      for (const [message, reason] of cases) {
        rpc.mockResolvedValue(fail(message));
        await expect(issueStaffInvite(deps, issueInput)).resolves.toEqual({ ok: false, reason });
      }
    });

    it('DD-AUTH-075 未知のエラー・種類の拒否・例外・形の違う戻りは failed で、本文を返さない', async () => {
      for (const outcome of [fail(SECRET_MESSAGE, '23505'), fail('STAFF_INVITE_KIND_FORBIDDEN', '42501'), ok(null), ok(5)]) {
        rpc.mockResolvedValue(outcome);
        const result = await issueStaffInvite(deps, issueInput);
        expect(result).toEqual({ ok: false, reason: 'failed' });
      }
      rpc.mockRejectedValue(new Error(SECRET_MESSAGE));
      await expect(issueStaffInvite(deps, issueInput)).resolves.toEqual({ ok: false, reason: 'failed' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET_MESSAGE);
    });

    it('DD-AUTH-075 合言葉を console に出さない', async () => {
      rpc.mockResolvedValue(ok(INVITE_ID));
      const result = await issueStaffInvite(deps, issueInput);
      rpc.mockResolvedValue(fail('LAST_ADMIN_REQUIRED'));
      await issueStaffInvite(deps, issueInput);
      rpc.mockResolvedValue(fail(SECRET_MESSAGE, '23505'));
      await issueStaffInvite(deps, issueInput);
      const token = (result as { value: { token: string } }).value.token;
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(token);
    });
  });

  describe('consumeStaffInvite', () => {
    it('DD-AUTH-075 合言葉のハッシュで staff_invite_consume を呼び、行を返す', async () => {
      rpc.mockResolvedValue(ok([{ invite_id: INVITE_ID, user_id: USER_ID, role_code: 'supporter' }]));
      await expect(consumeStaffInvite(deps, TOKEN)).resolves.toEqual({
        ok: true,
        value: { inviteId: INVITE_ID, userId: USER_ID, roleCode: 'supporter' },
      });
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe('staff_invite_consume');
      expect(hashArgToHex(args.p_token_hash)).toBe(FIXED_HASH_HEX);
      expect(JSON.stringify(args)).not.toContain(TOKEN);
    });

    it('DD-AUTH-075 行が無い・誤り・形の違う戻りは invalid', async () => {
      for (const outcome of [ok([]), ok(null), fail(SECRET_MESSAGE, '23505'), ok([{ invite_id: 1 }])]) {
        rpc.mockResolvedValue(outcome);
        await expect(consumeStaffInvite(deps, TOKEN)).resolves.toEqual({ ok: false, reason: 'invalid' });
      }
      rpc.mockRejectedValue(new Error('x'));
      await expect(consumeStaffInvite(deps, TOKEN)).resolves.toEqual({ ok: false, reason: 'invalid' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
    });
  });

  describe('bindStaffInviteWindow', () => {
    it('DD-AUTH-075 staff_invite_bind_window を招待とセッションで呼ぶ', async () => {
      rpc.mockResolvedValue(ok(null));
      await expect(bindStaffInviteWindow(deps, INVITE_ID, SESSION_ID)).resolves.toEqual({ ok: true, value: undefined });
      expect(rpc).toHaveBeenCalledWith('staff_invite_bind_window', { p_invite_id: INVITE_ID, p_session_id: SESSION_ID });
    });

    it('DD-AUTH-075 結び済みは already_bound、それ以外は failed', async () => {
      rpc.mockResolvedValue(fail('STAFF_INVITE_ALREADY_BOUND'));
      await expect(bindStaffInviteWindow(deps, INVITE_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason: 'already_bound' });
      for (const message of ['STAFF_INVITE_INVALID', SECRET_MESSAGE]) {
        rpc.mockResolvedValue(fail(message));
        await expect(bindStaffInviteWindow(deps, INVITE_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
      }
      rpc.mockRejectedValue(new Error('x'));
      await expect(bindStaffInviteWindow(deps, INVITE_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
    });
  });

  describe('activateStaffRole', () => {
    it('DD-AUTH-075 staff_role_activate を利用者とセッションで呼び、役割を返す', async () => {
      rpc.mockResolvedValue(ok({ role: 'admin' }));
      await expect(activateStaffRole(deps, USER_ID, SESSION_ID)).resolves.toEqual({ ok: true, value: { role: 'admin' } });
      expect(rpc).toHaveBeenCalledWith('staff_role_activate', { p_user_id: USER_ID, p_session_id: SESSION_ID });
    });

    it('DD-AUTH-075 4つの例外名を写し、それ以外は failed', async () => {
      const cases: Array<[string, string]> = [
        ['STAFF_ACTIVATE_INVITE_INVALID', 'invite_invalid'],
        ['STAFF_ACTIVATE_NO_WINDOW', 'no_window'],
        ['STAFF_ACTIVATE_KEYS_SHORT', 'keys_short'],
        ['STAFF_ACTIVATE_KEYS_NOT_WINDOW', 'keys_not_window'],
        ['STAFF_INVITE_ALREADY_BOUND', 'failed'],
        [SECRET_MESSAGE, 'failed'],
      ];
      for (const [message, reason] of cases) {
        rpc.mockResolvedValue(fail(message));
        await expect(activateStaffRole(deps, USER_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason });
      }
      rpc.mockResolvedValue(ok({ nope: 1 }));
      await expect(activateStaffRole(deps, USER_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
      rpc.mockRejectedValue(new Error('x'));
      await expect(activateStaffRole(deps, USER_ID, SESSION_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
    });
  });

  describe('cancelStaffInvite', () => {
    it('DD-AUTH-075 staff_invite_cancel を操作者と利用者で呼ぶ', async () => {
      rpc.mockResolvedValue(ok(null));
      await expect(cancelStaffInvite(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: true, value: undefined });
      expect(rpc).toHaveBeenCalledWith('staff_invite_cancel', { p_actor_id: ACTOR_ID, p_user_id: USER_ID });
    });

    it('DD-AUTH-075 店長でない操作者は forbidden、それ以外は failed', async () => {
      rpc.mockResolvedValue(fail('ROLE_PERMISSION_FORBIDDEN', '42501'));
      await expect(cancelStaffInvite(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: false, reason: 'forbidden' });
      rpc.mockResolvedValue(fail(SECRET_MESSAGE));
      await expect(cancelStaffInvite(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
      rpc.mockRejectedValue(new Error('x'));
      await expect(cancelStaffInvite(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
    });
  });

  describe('demoteStaff', () => {
    it('DD-AUTH-075 staff_demote を操作者と利用者で呼ぶ', async () => {
      rpc.mockResolvedValue(ok(null));
      await expect(demoteStaff(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: true, value: undefined });
      expect(rpc).toHaveBeenCalledWith('staff_demote', { p_actor_id: ACTOR_ID, p_user_id: USER_ID });
    });

    it('DD-AUTH-075 例外の文を理由に写す', async () => {
      const cases: Array<[string, string]> = [
        ['LAST_ADMIN_REQUIRED', 'last_admin'],
        ['SELF_ROLE_CHANGE_FORBIDDEN', 'self'],
        ['ROLE_PERMISSION_FORBIDDEN', 'forbidden'],
        ['USER_NOT_FOUND', 'not_found'],
        [SECRET_MESSAGE, 'failed'],
      ];
      for (const [message, reason] of cases) {
        rpc.mockResolvedValue(fail(message));
        await expect(demoteStaff(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: false, reason });
      }
      rpc.mockRejectedValue(new Error('x'));
      await expect(demoteStaff(deps, ACTOR_ID, USER_ID)).resolves.toEqual({ ok: false, reason: 'failed' });
    });
  });

  describe('hasOpenStaffInvite', () => {
    it('DD-AUTH-075 staff_invite_open の真偽を返し、誤り・形の違う戻り・例外は偽', async () => {
      rpc.mockResolvedValue(ok(true));
      await expect(hasOpenStaffInvite(deps, USER_ID)).resolves.toBe(true);
      expect(rpc).toHaveBeenCalledWith('staff_invite_open', { p_user_id: USER_ID });
      rpc.mockResolvedValue(ok(false));
      await expect(hasOpenStaffInvite(deps, USER_ID)).resolves.toBe(false);
      for (const outcome of [fail(SECRET_MESSAGE), ok('true'), ok(null)]) {
        rpc.mockResolvedValue(outcome);
        await expect(hasOpenStaffInvite(deps, USER_ID)).resolves.toBe(false);
      }
      rpc.mockRejectedValue(new Error('x'));
      await expect(hasOpenStaffInvite(deps, USER_ID)).resolves.toBe(false);
    });
  });
});
