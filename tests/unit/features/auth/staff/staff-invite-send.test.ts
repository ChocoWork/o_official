/**
 * DD-AUTH-076 招待を出して、ログインを終わらせ、メールを送る共通の流れ（src/features/auth/staff/staff-invite-send.ts）の単体テスト。
 */

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  checkOrderEmailSendConfig: jest.fn(() => null),
  sendOrderEmailMessage: jest.fn(),
}));
jest.mock('@/lib/site-url-guard', () => ({ checkSiteUrlForEmail: jest.fn() }));

import { createHash } from 'node:crypto';
import { issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { checkOrderEmailSendConfig, sendOrderEmailMessage } from '@/lib/orders/email/order-email-sender';
import { checkSiteUrlForEmail } from '@/lib/site-url-guard';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://configured.example';

const rpc = jest.fn();
const store = { rpc };
const send = sendOrderEmailMessage as jest.Mock;
const revoke = revokeAllSessionsForUser as jest.Mock;
const input = {
  userId: USER_ID,
  email: 'new-staff@example.com',
  role: 'admin' as const,
  kind: 'invite' as const,
  issuedBy: ACTOR_ID,
  reason: null,
  hadPasskeys: false,
};

describe('issueAndSendStaffInvite', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    rpc.mockResolvedValue({ data: INVITE_ID, error: null });
    revoke.mockResolvedValue({ authSessionsDeleted: 0 });
    send.mockResolvedValue({ ok: true, providerMessageId: null });
    (checkSiteUrlForEmail as jest.Mock).mockReturnValue({ ok: true, origin: ORIGIN });
    (checkOrderEmailSendConfig as jest.Mock).mockReturnValue(null);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('DD-AUTH-076 発行 → ログインの終了 → メールの順で行い、リンクはサイトの設定の住所の /staff/invite#合言葉になる', async () => {
    const result = await issueAndSendStaffInvite(store, input);

    expect(result).toEqual({ ok: true });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0]);
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(revoke).toHaveBeenCalledWith(USER_ID);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe('new-staff@example.com');
    const link = /https:\/\/configured\.example\/staff\/invite#([A-Za-z0-9_-]{43})/.exec(message.text);
    expect(link).not.toBeNull();
    // DB へ渡すハッシュは、メールの合言葉の UTF-8 の SHA-256（bytea の \x 形）
    const hash = createHash('sha256').update(link![1], 'utf8').digest('hex');
    expect(rpc.mock.calls[0][1].p_token_hash).toBe(`\\x${hash}`);
    expect(message.idempotencyKey).toBe(`staff-invite/${INVITE_ID}`);
  });

  it('DD-AUTH-076 期限は発行の時刻の24時間後を「YYYY年M月D日 H:mm（日本時間）」にして本文に入れる', async () => {
    const now = new Date('2026-11-18T03:04:05Z');

    await issueAndSendStaffInvite(store, input, { now: () => now });

    expect(send.mock.calls[0][0].text).toContain('リンクの有効期限は 2026年11月19日 12:04（日本時間） までです。');
  });

  it('DD-AUTH-076 日本時間の日付が変わる時刻と、月・日の0埋めなしも書式どおりになる', async () => {
    // 2026-01-01T14:30Z の24時間後は 2026-01-02T14:30Z = 日本時間 2026-01-02 23:30
    await issueAndSendStaffInvite(store, input, { now: () => new Date('2026-01-01T14:30:00Z') });
    expect(send.mock.calls[0][0].text).toContain('2026年1月2日 23:30（日本時間）');

    // 2026-01-01T15:00Z の24時間後は 2026-01-02T15:00Z = 日本時間 2026-01-03 0:00
    send.mockClear();
    await issueAndSendStaffInvite(store, input, { now: () => new Date('2026-01-01T15:00:00Z') });
    expect(send.mock.calls[0][0].text).toContain('2026年1月3日 0:00（日本時間）');
  });

  it.each([
    ['invite', false, false],
    ['invite', true, true],
    ['redo', false, true],
    ['promote', false, true],
  ] as const)('DD-AUTH-076 %s・既存の鍵 %s の時、削除の知らせは %s', async (kind, hadPasskeys, expected) => {
    await issueAndSendStaffInvite(store, { ...input, kind, hadPasskeys });

    expect(send.mock.calls[0][0].text.includes('これまでのパスキーはすべて削除されました。')).toBe(expected);
  });

  it('DD-AUTH-076 役割の呼び名を店長・サポーターで書き分け、DB には役割と種類と理由をそのまま渡す', async () => {
    await issueAndSendStaffInvite(store, { ...input, role: 'supporter', kind: 'redo', reason: '端末を紛失したため' });

    expect(send.mock.calls[0][0].text).toContain('のサポーターとして');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_user_id: USER_ID, p_role_code: 'supporter', p_kind: 'redo', p_issued_by: ACTOR_ID, p_reason: '端末を紛失したため',
    });
  });

  it.each([
    ['サイトの住所が使えない', () => (checkSiteUrlForEmail as jest.Mock).mockReturnValue({ ok: false, code: 'config_site_url' })],
    ['メールの設定が足りない', () => (checkOrderEmailSendConfig as jest.Mock).mockReturnValue('config_provider')],
  ])('DD-AUTH-076 %s時は、鍵を消す発行の前に config で断る', async (_label, arrange) => {
    arrange();

    const result = await issueAndSendStaffInvite(store, input);

    expect(result).toEqual({ ok: false, reason: 'config' });
    expect(rpc).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 発行が already_staff で断られたら、ログインも終わらせず、メールも送らない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'STAFF_ALREADY_STAFF', code: 'P0001' } });

    const result = await issueAndSendStaffInvite(store, input);

    expect(result).toEqual({ ok: false, reason: 'already_staff' });
    expect(revoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('DD-AUTH-076 ログインの終了に失敗したら revoke_failed で、メールは送らない', async () => {
    revoke.mockRejectedValue(new Error('app_session_revocation_failed'));

    const result = await issueAndSendStaffInvite(store, input);

    expect(result).toEqual({ ok: false, reason: 'revoke_failed' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['送り手が失敗を返す', () => send.mockResolvedValue({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } })],
    ['送り手が例外を投げる', () => send.mockRejectedValue(new Error('boom'))],
  ])('DD-AUTH-076 %sと mail_failed になり、ログに合言葉もアドレスも出ない', async (_label, arrange) => {
    arrange();

    const result = await issueAndSendStaffInvite(store, input);

    expect(result).toEqual({ ok: false, reason: 'mail_failed' });
    const logged = JSON.stringify(errorSpy.mock.calls);
    const token = /#([A-Za-z0-9_-]{43})/.exec(send.mock.calls[0][0].text)![1];
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('new-staff@example.com');
  });
});
