/**
 * DD-AUTH-066 パスキーの知らせを取り出して送るための DB の関数を呼ぶ薄い部品（src/lib/auth/passkey-notification-store.ts）の単体テスト。
 */

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import {
  claimPasskeyNotification,
  completePasskeyNotification,
  failPasskeyNotification,
  passkeyNotificationRecipients,
  skipPasskeyNotification,
} from '@/lib/auth/passkey-notification-store';

const { createServiceRoleClient } = require('@/lib/supabase/server');

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const rpc = jest.fn();

const claimedRow = {
  id: ID, seq: 7, user_id: USER_ID, kind: 'passkey_added', passkey_id: null, friendly_name: 'iPhone',
  subject_is_staff: false, notify_subject: true, subject_email: 'a@example.com',
  occurred_at: '2026-11-18T00:00:00+00:00', attempts: 1, lease_token: TOKEN,
};

describe('passkey-notification-store', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
    createServiceRoleClient.mockReset().mockResolvedValue({ rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-066 claimPasskeyNotification は claim_passkey_notification を担当の秒数つきで1回呼び、行を写す', async () => {
    rpc.mockResolvedValue({ data: [claimedRow], error: null });

    await expect(claimPasskeyNotification(120)).resolves.toEqual({
      ok: true,
      value: {
        id: ID, seq: 7, userId: USER_ID, kind: 'passkey_added', passkeyId: null, friendlyName: 'iPhone',
        subjectIsStaff: false, notifySubject: true, subjectEmail: 'a@example.com',
        occurredAt: '2026-11-18T00:00:00+00:00', attempts: 1, leaseToken: TOKEN,
      },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('claim_passkey_notification', { _lease_seconds: 120 });
  });

  it('DD-AUTH-066 claimPasskeyNotification は bigint の seq が文字列で来ても数に直し、取り出す行が無ければ null', async () => {
    rpc.mockResolvedValueOnce({ data: [{ ...claimedRow, seq: '9' }], error: null });
    await expect(claimPasskeyNotification(60)).resolves.toMatchObject({ ok: true, value: { seq: 9 } });

    rpc.mockResolvedValueOnce({ data: [], error: null });
    await expect(claimPasskeyNotification(60)).resolves.toEqual({ ok: true, value: null });
  });

  it.each([
    ['配列でない', { id: ID }],
    ['行が2つ', [claimedRow, claimedRow]],
    ['kind が知らない値', [{ ...claimedRow, kind: 'other' }]],
    ['lease_token が無い', [{ ...claimedRow, lease_token: undefined }]],
    ['subject_is_staff が真偽でない', [{ ...claimedRow, subject_is_staff: 'yes' }]],
    ['行が object でない', ['x']],
  ])('DD-AUTH-066 claimPasskeyNotification は戻りが想定外（%s）なら { ok: false }', async (_label, data) => {
    rpc.mockResolvedValue({ data, error: null });

    await expect(claimPasskeyNotification(60)).resolves.toEqual({ ok: false });
  });

  it('DD-AUTH-066 completePasskeyNotification は complete_passkey_notification を正しい引数で呼び、真偽を返す', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(completePasskeyNotification(ID, TOKEN)).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledWith('complete_passkey_notification', { _id: ID, _lease_token: TOKEN });

    rpc.mockResolvedValue({ data: false, error: null });
    await expect(completePasskeyNotification(ID, TOKEN)).resolves.toEqual({ ok: true, value: false });
  });

  it('DD-AUTH-066 failPasskeyNotification は fail_passkey_notification を正しい引数で呼ぶ', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(failPasskeyNotification(ID, TOKEN, 'smtp_error', 90)).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledWith('fail_passkey_notification', {
      _id: ID, _lease_token: TOKEN, _error_code: 'smtp_error', _retry_after_seconds: 90,
    });
  });

  it('DD-AUTH-066 skipPasskeyNotification は skip_passkey_notification を正しい引数で呼ぶ', async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    await expect(skipPasskeyNotification(ID, TOKEN, 'no_recipient')).resolves.toEqual({ ok: true, value: true });
    expect(rpc).toHaveBeenCalledWith('skip_passkey_notification', { _id: ID, _lease_token: TOKEN, _reason: 'no_recipient' });
  });

  it('DD-AUTH-066 passkeyNotificationRecipients は passkey_notification_recipients を呼び、宛先の一覧を返す', async () => {
    rpc.mockResolvedValue({
      data: [{ email: 'a@example.com', audience: 'subject_staff' }, { email: 'b@example.com', audience: 'admin' }],
      error: null,
    });

    await expect(passkeyNotificationRecipients(ID)).resolves.toEqual({
      ok: true,
      value: [{ email: 'a@example.com', audience: 'subject_staff' }, { email: 'b@example.com', audience: 'admin' }],
    });
    expect(rpc).toHaveBeenCalledWith('passkey_notification_recipients', { _id: ID });

    rpc.mockResolvedValue({ data: [], error: null });
    await expect(passkeyNotificationRecipients(ID)).resolves.toEqual({ ok: true, value: [] });
  });

  it.each([
    ['配列でない', null],
    ['知らない audience', [{ email: 'a@example.com', audience: 'everyone' }]],
    ['email が文字列でない', [{ email: null, audience: 'admin' }]],
  ])('DD-AUTH-066 passkeyNotificationRecipients は戻りが想定外（%s）なら { ok: false }', async (_label, data) => {
    rpc.mockResolvedValue({ data, error: null });

    await expect(passkeyNotificationRecipients(ID)).resolves.toEqual({ ok: false });
  });

  it('DD-AUTH-066 complete・fail・skip は、真偽でない戻りを { ok: false } にする', async () => {
    rpc.mockResolvedValue({ data: 'true', error: null });

    await expect(completePasskeyNotification(ID, TOKEN)).resolves.toEqual({ ok: false });
    await expect(failPasskeyNotification(ID, TOKEN, 'x', 0)).resolves.toEqual({ ok: false });
    await expect(skipPasskeyNotification(ID, TOKEN, 'x')).resolves.toEqual({ ok: false });
  });

  it('DD-AUTH-066 DB の誤りは { ok: false }。ログに残すのは関数の名前とコードだけ', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'secret detail a@example.com' } });

    await expect(claimPasskeyNotification(10)).resolves.toEqual({ ok: false });
    await expect(failPasskeyNotification(ID, TOKEN, 'Bad', 0)).resolves.toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalledWith('passkey-notification-store: rpc returned an error', {
      name: 'claim_passkey_notification', code: '22023',
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('a@example.com');
  });

  it('DD-AUTH-066 例外（クライアントを作れない・呼べない）も { ok: false } にする', async () => {
    createServiceRoleClient.mockRejectedValueOnce(new Error('no key'));
    await expect(claimPasskeyNotification(60)).resolves.toEqual({ ok: false });

    rpc.mockRejectedValueOnce(new Error('network'));
    await expect(passkeyNotificationRecipients(ID)).resolves.toEqual({ ok: false });
    expect(errorSpy).toHaveBeenCalledWith('passkey-notification-store: rpc call failed', { name: 'passkey_notification_recipients' });
  });
});
