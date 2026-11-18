/**
 * DD-AUTH-050 パスキーの窓口が使う DB の関数を呼ぶ薄い部品（src/lib/auth/passkey-approval-rpc.ts）の単体テスト。
 */

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import {
  approve,
  approvedCount,
  approvedIds,
  approveFailureReason,
  isCredentialApproved,
  isStaff,
  windowIsOpen,
} from '@/lib/auth/passkey-approval-rpc';

const { createServiceRoleClient } = require('@/lib/supabase/server');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const PASSKEY_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

const rpc = jest.fn();

describe('passkey-approval-rpc', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    createServiceRoleClient.mockReset().mockResolvedValue({ rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-050 isStaff は passkey_is_staff を1回呼び、真偽を返す', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(isStaff(USER_ID)).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_is_staff', { p_user_id: USER_ID });
  });

  it('DD-AUTH-050 isCredentialApproved は base64url を \\x 16進に直して passkey_credential_is_approved を1回呼ぶ', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    // 'AQID_-A' は base64url で 01 02 03 ff e0
    await expect(isCredentialApproved(USER_ID, 'AQID_-A')).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_credential_is_approved', {
      p_user_id: USER_ID,
      p_credential_id: '\\x010203ffe0',
    });
  });

  it.each(['', 'a!b', 'abc d', 'AQID_-A=', 'abc+/', 'a', ' ', 'あいう'])(
    'DD-AUTH-050 isCredentialApproved は base64url でない文字列 %j では RPC を呼ばず偽を返す',
    async (raw) => {
      await expect(isCredentialApproved(USER_ID, raw)).resolves.toEqual({ ok: true, value: false });
      expect(rpc).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it('DD-AUTH-050 approvedIds は passkey_approved_ids を呼び、一覧を返す', async () => {
    rpc.mockResolvedValue({ data: [PASSKEY_ID], error: null });

    await expect(approvedIds(USER_ID)).resolves.toEqual({ ok: true, value: [PASSKEY_ID] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_approved_ids', { p_user_id: USER_ID });
  });

  it('DD-AUTH-050 approvedCount は passkey_approved_count を呼び、本数を返す', async () => {
    rpc.mockResolvedValue({ data: 2, error: null });

    await expect(approvedCount(USER_ID)).resolves.toEqual({ ok: true, value: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_approved_count', { p_user_id: USER_ID });
  });

  it('DD-AUTH-050 windowIsOpen は passkey_window_is_open を利用者とセッションで呼ぶ', async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(windowIsOpen(USER_ID, SESSION_ID)).resolves.toEqual({ ok: true, value: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_window_is_open', { p_user_id: USER_ID, p_session_id: SESSION_ID });
  });

  it('DD-AUTH-050 approve は passkey_approve を呼び、成功なら ok を返す', async () => {
    await expect(approve(USER_ID, PASSKEY_ID, 'window')).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('passkey_approve', { p_user_id: USER_ID, p_passkey_id: PASSKEY_ID, p_via: 'window' });
  });

  it.each([
    ['23505', 'stale'],
    ['55000', 'window_full'],
    ['42501', 'other'],
    [undefined, 'other'],
  ])('DD-AUTH-050 approve の失敗 %s は reason %s で返す', async (code, reason) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'x' } });

    await expect(approve(USER_ID, PASSKEY_ID, 'window')).resolves.toEqual({ ok: false, reason });
  });

  it.each([
    ['42501', 'PASSKEY_REAUTH_NOT_ALLOWED', 'reauth_not_allowed'],
    ['42501', 'passkey_not_owned', 'other'],
    ['23505', 'PASSKEY_REAUTH_NOT_ALLOWED', 'stale'],
    ['55000', undefined, 'window_full'],
    [undefined, undefined, 'other'],
  ])('DD-AUTH-069 approveFailureReason(%s, %s) は %s', (code, message, reason) => {
    expect(approveFailureReason(code, message)).toBe(reason);
  });

  it('DD-AUTH-069 approve は認めた鍵が0本の店員の reauth の断りを reauth_not_allowed で返す', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'PASSKEY_REAUTH_NOT_ALLOWED' } });

    await expect(approve(USER_ID, PASSKEY_ID, 'reauth')).resolves.toEqual({ ok: false, reason: 'reauth_not_allowed' });
  });

  it('DD-AUTH-050 approve は例外でも reason other で返す', async () => {
    rpc.mockRejectedValue(new Error('network'));

    await expect(approve(USER_ID, PASSKEY_ID, 'reauth')).resolves.toEqual({ ok: false, reason: 'other' });
  });

  it('DD-AUTH-050 approve はクライアントを作れなくても reason other で返す', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no key'));

    await expect(approve(USER_ID, PASSKEY_ID, 'script')).resolves.toEqual({ ok: false, reason: 'other' });
  });

  it.each([
    ['isStaff', () => isStaff(USER_ID)],
    ['isCredentialApproved', () => isCredentialApproved(USER_ID, 'AQID')],
    ['approvedIds', () => approvedIds(USER_ID)],
    ['approvedCount', () => approvedCount(USER_ID)],
    ['windowIsOpen', () => windowIsOpen(USER_ID, SESSION_ID)],
  ])('DD-AUTH-050 %s は RPC の誤り・例外・クライアントの失敗で ok: false を返し、値を漏らさない', async (_name, call) => {
    rpc.mockResolvedValueOnce({ data: true, error: { code: 'XX000', message: 'secret detail' } });
    await expect(call()).resolves.toEqual({ ok: false });

    rpc.mockRejectedValueOnce(new Error('network'));
    await expect(call()).resolves.toEqual({ ok: false });

    createServiceRoleClient.mockRejectedValueOnce(new Error('no key'));
    await expect(call()).resolves.toEqual({ ok: false });

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret detail');
  });

  it.each([
    ['isStaff', () => isStaff(USER_ID), 'yes'],
    ['isStaff', () => isStaff(USER_ID), null],
    ['isCredentialApproved', () => isCredentialApproved(USER_ID, 'AQID'), 1],
    ['windowIsOpen', () => windowIsOpen(USER_ID, SESSION_ID), 'true'],
    ['approvedIds', () => approvedIds(USER_ID), 'x'],
    ['approvedIds', () => approvedIds(USER_ID), [1]],
    ['approvedCount', () => approvedCount(USER_ID), '2'],
    ['approvedCount', () => approvedCount(USER_ID), -1],
    ['approvedCount', () => approvedCount(USER_ID), 1.5],
    ['approvedCount', () => approvedCount(USER_ID), null],
  ])('DD-AUTH-050 %s は想定外の型の戻りを ok: false に倒す（閉じる側）', async (_name, call, data) => {
    rpc.mockResolvedValue({ data, error: null });

    await expect(call()).resolves.toEqual({ ok: false });
  });
});
