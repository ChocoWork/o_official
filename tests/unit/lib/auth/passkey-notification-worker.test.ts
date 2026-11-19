/**
 * DD-AUTH-067 パスキーの知らせの worker（src/lib/auth/passkey-notification-worker.ts）の単体テスト。
 */
// 本物の worker が注文のメールの worker（server 専用の部品を含む）を読み込むため、試験の場では server-only の印を空にする
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/site-url-guard', () => ({ checkSiteUrlForEmail: jest.fn(() => ({ ok: true, origin: 'https://example.com' })) }));

import { createHash } from 'node:crypto';
import { checkSiteUrlForEmail } from '@/lib/site-url-guard';
import {
  passkeyNotificationIdempotencyKey,
  runPasskeyNotificationWorker,
  type PasskeyNotificationWorkerDeps,
} from '@/lib/auth/passkey-notification-worker';
import type { ClaimedPasskeyNotification } from '@/lib/auth/passkey-notification-store';

const sha = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 16);

function row(overrides: Partial<ClaimedPasskeyNotification> = {}): ClaimedPasskeyNotification {
  return {
    id: 'row-1', seq: 1, userId: 'u1', kind: 'passkey_added', passkeyId: null, friendlyName: 'iPhone',
    subjectIsStaff: false, notifySubject: true, subjectEmail: 'a@example.com', actorEmail: null,
    occurredAt: '2026-11-17T15:05:00Z', attempts: 1, leaseToken: 'tok-1', ...overrides,
  };
}

type Mocks = { [K in keyof PasskeyNotificationWorkerDeps]: jest.Mock };

function makeDeps(rows: ClaimedPasskeyNotification[], recipients: Array<{ email: string; audience: 'subject_customer' | 'subject_staff' | 'admin' }>): Mocks {
  const queue = [...rows];
  return {
    claim: jest.fn(async () => ({ ok: true, value: queue.shift() ?? null })),
    recipients: jest.fn(async () => ({ ok: true, value: recipients })),
    complete: jest.fn(async () => ({ ok: true, value: true })),
    fail: jest.fn(async () => ({ ok: true, value: true })),
    skip: jest.fn(async () => ({ ok: true, value: true })),
    send: jest.fn(async () => ({ ok: true, providerMessageId: null })),
    sendPaused: jest.fn(async () => false),
    disabledReason: jest.fn(() => null),
    checkConfig: jest.fn(() => null),
    contactUrl: jest.fn(() => 'https://example.com/contact'),
    now: jest.fn(() => 0),
  };
}

const run = (deps: Mocks, options: { budgetMs?: number; maxRows?: number } = {}) =>
  runPasskeyNotificationWorker({ ...options, deps: deps as unknown as Partial<PasskeyNotificationWorkerDeps> });

const TRANSIENT = { ok: false, failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 120 } };
const PERMANENT = { ok: false, failure: { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null } };

describe('runPasskeyNotificationWorker', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('DD-AUTH-067 全宛先に送れたら complete し、sent に数える', async () => {
    const deps = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    const result = await run(deps);
    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, dead: 0, skipped: 0, stopped: 'idle' });
    expect(deps.complete).toHaveBeenCalledWith('row-1', 'tok-1');
    expect(deps.fail).not.toHaveBeenCalled();
    const message = deps.send.mock.calls[0][0];
    expect(message.to).toBe('a@example.com');
    expect(message.subject).toBe('パスキーが追加されました');
    expect(message.text).toContain('https://example.com/contact');
  });

  it('DD-AUTH-067 宛先ごとの重複防止の鍵は、行ごと・宛先ごとに固定で、再試行でも同じ', async () => {
    const recipients = [
      { email: 'staff@example.com', audience: 'subject_staff' as const },
      { email: 'Admin@Example.com', audience: 'admin' as const },
    ];
    const keys: string[][] = [];
    for (let i = 0; i < 2; i += 1) {
      const deps = makeDeps([row({ id: 'row-9', subjectIsStaff: true, attempts: i + 1 })], recipients);
      await run(deps);
      keys.push(deps.send.mock.calls.map((call) => call[0].idempotencyKey));
    }
    expect(keys[0]).toEqual([
      `passkey-notification/row-9/${sha('staff@example.com')}`,
      `passkey-notification/row-9/${sha('admin@example.com')}`,
    ]);
    expect(keys[1]).toEqual(keys[0]);
    expect(passkeyNotificationIdempotencyKey('row-1', 'a@example.com')).not.toBe(passkeyNotificationIdempotencyKey('row-2', 'a@example.com'));
  });

  it('DD-AUTH-067 宛先ごとに文面が分かれ、本人のアドレスは店長の文面にだけ入る', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true, subjectEmail: 'staff@example.com' })],
      [{ email: 'staff@example.com', audience: 'subject_staff' }, { email: 'boss@example.com', audience: 'admin' }],
    );
    await run(deps);
    const [staffMessage, adminMessage] = deps.send.mock.calls.map((call) => call[0]);
    expect(staffMessage.subject).toBe('パスキーが追加されました');
    expect(staffMessage.text).not.toContain('staff@example.com');
    expect(adminMessage.subject).toBe('店員のパスキーが追加されました');
    expect(adminMessage.text).toContain('staff@example.com');
  });

  it('DD-AUTH-067 設定が無ければ claim を呼ばず config で止まる', async () => {
    const deps = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.checkConfig.mockReturnValue('config_provider');
    expect((await run(deps)).stopped).toBe('config');
    expect(deps.claim).not.toHaveBeenCalled();

    const noUrl = makeDeps([row()], []);
    noUrl.contactUrl.mockReturnValue(null);
    expect((await run(noUrl)).stopped).toBe('config');
    expect(noUrl.claim).not.toHaveBeenCalled();
  });

  it('DD-AUTH-067 共有の送信の一時停止の間でも、注文のメールの試しの時刻に関わらず、1回に1行だけ claim して試す', async () => {
    const deps = makeDeps([row({ id: 'r1' }), row({ id: 'r2' })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.sendPaused.mockResolvedValue(true);
    const result = await run(deps);
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(deps.complete).toHaveBeenCalledWith('r1', 'tok-1');
  });

  it('DD-AUTH-067 一時停止の間の試しが設定の失敗なら、その1行だけで止まり、追加の claim は0回', async () => {
    const deps = makeDeps([row({ id: 'r1' }), row({ id: 'r2' })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.sendPaused.mockResolvedValue(true);
    deps.send.mockResolvedValue({ ok: false, failure: { category: 'config', code: 'quota_daily', retryAfterSeconds: null } });
    const result = await run(deps);
    expect(result.stopped).toBe('config');
    expect(deps.claim).toHaveBeenCalledTimes(1);
    expect(deps.fail).toHaveBeenCalledWith('r1', 'tok-1', 'quota_daily', 900, false);
  });

  it('DD-AUTH-067 停止の決め（disabled）の時は claim を呼ばない', async () => {
    const deps = makeDeps([row()], []);
    deps.disabledReason.mockReturnValue('non_production_deployment');
    expect(await run(deps)).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0, stopped: 'disabled' });
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('DD-AUTH-067 1通も送れず全部が恒久の失敗なら、complete でなく skip（all_recipients_permanent）にする', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true })],
      [{ email: 'a@example.com', audience: 'subject_staff' }, { email: 'b@example.com', audience: 'admin' }],
    );
    deps.send.mockResolvedValue(PERMANENT);
    const result = await run(deps);
    expect(deps.skip).toHaveBeenCalledWith('row-1', 'tok-1', 'all_recipients_permanent');
    expect(deps.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('DD-AUTH-067 恒久の失敗の宛先だけ飛ばし、一時的な失敗が無ければ complete する', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true })],
      [{ email: 'bad@example.com', audience: 'admin' }, { email: 'good@example.com', audience: 'admin' }],
    );
    deps.send.mockResolvedValueOnce(PERMANENT);
    const result = await run(deps);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(deps.fail).not.toHaveBeenCalled();
    expect(result.sent).toBe(1);
  });

  it('DD-AUTH-067 一時的な失敗があっても残りの宛先を試し、最初の失敗の符号と最大の待ち秒数で fail する', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true })],
      [
        { email: 'a@example.com', audience: 'subject_staff' },
        { email: 'b@example.com', audience: 'admin' },
        { email: 'c@example.com', audience: 'admin' },
      ],
    );
    deps.send
      .mockResolvedValueOnce(TRANSIENT)
      .mockResolvedValueOnce({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: 900 } })
      .mockResolvedValueOnce({ ok: true, providerMessageId: null });
    const result = await run(deps);
    expect(deps.send).toHaveBeenCalledTimes(3);
    expect(deps.fail).toHaveBeenCalledWith('row-1', 'tok-1', 'rate_limited', 900);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retried: 1, dead: 0, sent: 0 });
  });

  it('DD-AUTH-067 宛先が0なら skip する', async () => {
    const deps = makeDeps([row()], []);
    const result = await run(deps);
    expect(deps.skip).toHaveBeenCalledWith('row-1', 'tok-1', 'no_recipient');
    expect(deps.send).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('DD-AUTH-067 9回目の失敗は dead に数える', async () => {
    const deps = makeDeps([row({ attempts: 9 })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.send.mockResolvedValue(TRANSIENT);
    const result = await run(deps);
    expect(deps.fail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ dead: 1, retried: 0 });
  });

  it('DD-AUTH-067 1行の宛先を送る間に予算を越えたら、残りを送らず fail して次へ回す', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true })],
      [{ email: 'a@example.com', audience: 'subject_staff' }, { email: 'b@example.com', audience: 'admin' }],
    );
    // 開始 0 → claim の確かめ 0 → 最初の宛先の前 0 → 最初の送りの後に 5000
    let t = 0;
    deps.now.mockImplementation(() => t);
    deps.send.mockImplementation(async () => {
      t = 5000;
      return { ok: true, providerMessageId: null };
    });
    const result = await run(deps, { budgetMs: 3000 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.fail).toHaveBeenCalledWith('row-1', 'tok-1', 'budget_exceeded', 0);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retried: 1, stopped: 'budget' });
  });

  it('DD-AUTH-067 予算を使い切ったら次の行を取らず budget で止まる', async () => {
    const deps = makeDeps([row({ id: 'r1' }), row({ id: 'r2' })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    let t = 0;
    deps.now.mockImplementation(() => t);
    deps.send.mockImplementation(async () => {
      t += 4000;
      return { ok: true, providerMessageId: null };
    });
    const result = await run(deps, { budgetMs: 3000 });
    expect(result).toMatchObject({ claimed: 1, sent: 1, stopped: 'budget' });
    expect(deps.claim).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-067 最大行数で止まる', async () => {
    const deps = makeDeps(
      [row({ id: 'r1' }), row({ id: 'r2' }), row({ id: 'r3' })],
      [{ email: 'a@example.com', audience: 'subject_customer' }],
    );
    const result = await run(deps, { maxRows: 2 });
    expect(result).toMatchObject({ claimed: 2, sent: 2, stopped: 'budget' });
  });

  it('DD-AUTH-067 claim の失敗（戻り・例外）は claim_error', async () => {
    const failed = makeDeps([], []);
    failed.claim.mockResolvedValue({ ok: false });
    expect((await run(failed)).stopped).toBe('claim_error');
    const thrown = makeDeps([], []);
    thrown.claim.mockRejectedValue(new Error('boom'));
    expect((await run(thrown)).stopped).toBe('claim_error');
  });

  it('DD-AUTH-067 送り手の config の失敗はその場で止め、行は fail に回す', async () => {
    const deps = makeDeps([row({ id: 'r1' }), row({ id: 'r2' })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.send.mockResolvedValue({ ok: false, failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null } });
    const result = await run(deps);
    expect(result.stopped).toBe('config');
    expect(deps.claim).toHaveBeenCalledTimes(1);
    // 設定の失敗はこの行の失敗として数えない（countAttempt が偽。共有の一時停止は DB の関数が同じ取引で書く）
    expect(deps.fail).toHaveBeenCalledWith('r1', 'tok-1', 'config_api_key', 900, false);
    expect(deps.fail).toHaveBeenCalledTimes(1);
  });

  it('DD-AUTH-067 宛先の取得に失敗した行は fail し、例外は握って次の行へ進む', async () => {
    const deps = makeDeps([row({ id: 'r1' }), row({ id: 'r2' })], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.recipients.mockResolvedValueOnce({ ok: false });
    deps.recipients.mockRejectedValueOnce(new Error('boom'));
    const first = await run(deps);
    expect(deps.fail).toHaveBeenCalledWith('r1', 'tok-1', 'db_unavailable', 0);
    expect(first.retried).toBe(1);
    expect(first.claimed).toBe(2);
  });

  it('DD-AUTH-067 ログに宛先のアドレス・本文・鍵の名前を出さない', async () => {
    const deps = makeDeps([row({ friendlyName: 'SecretName' })], [{ email: 'leak@example.com', audience: 'subject_customer' }]);
    deps.send.mockResolvedValue(TRANSIENT);
    deps.fail.mockRejectedValue(new Error('leak@example.com SecretName'));
    await run(deps);
    deps.checkConfig.mockReturnValue('config_provider');
    await run(deps);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain('leak@example.com');
    expect(logged).not.toContain('SecretName');
    expect(logged).not.toContain('Le Fil des Heures');
  });
  it('DD-AUTH-067 送り手の失敗の符号が決まりの形でなければ send_failed にして fail する', async () => {
    const deps = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.send.mockResolvedValue({ ok: false, failure: { category: 'transient', code: 'Bad-Code', retryAfterSeconds: null } });
    await run(deps);
    expect(deps.fail).toHaveBeenCalledWith('row-1', 'tok-1', 'send_failed', 0);
  });

  it('DD-AUTH-067 config の失敗に待ち秒数があればそれを fail に渡す', async () => {
    const deps = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.send.mockResolvedValue({ ok: false, failure: { category: 'config', code: 'quota_daily', retryAfterSeconds: 600 } });
    await run(deps);
    expect(deps.fail).toHaveBeenCalledWith('row-1', 'tok-1', 'quota_daily', 600, false);
  });

  it('DD-AUTH-067 一時的な失敗の後に予算を越えたら、最初の失敗の符号で fail する', async () => {
    const deps = makeDeps(
      [row({ subjectIsStaff: true })],
      [{ email: 'a@example.com', audience: 'subject_staff' }, { email: 'b@example.com', audience: 'admin' }],
    );
    let t = 0;
    deps.now.mockImplementation(() => t);
    deps.send.mockImplementation(async () => {
      t = 5000;
      return TRANSIENT;
    });
    await run(deps, { budgetMs: 3000 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.fail).toHaveBeenCalledWith('row-1', 'tok-1', 'rate_limited', 120);
  });

  it('DD-AUTH-067 complete が失敗（担当を失った）でも行は sent に数え、ログに印を出さない', async () => {
    const deps = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    deps.complete.mockResolvedValue({ ok: false });
    const result = await run(deps);
    expect(result.sent).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-1');
  });

  it('DD-AUTH-067 引数なしの呼び出しは、本物の設定の確かめを通る（設定が無ければ何も取らない）', async () => {
    const result = await runPasskeyNotificationWorker();
    expect(result.claimed).toBe(0);
    expect(['config', 'claim_error', 'disabled']).toContain(result.stopped);
  });

  it('DD-AUTH-067 お問い合わせの住所は、サイトの住所の確かめを通った /contact。使えなければ config で止まる', async () => {
    const { contactUrl: _omit, ...others } = makeDeps([row()], [{ email: 'a@example.com', audience: 'subject_customer' }]);
    const real = others as unknown as Partial<PasskeyNotificationWorkerDeps>;
    const check = checkSiteUrlForEmail as jest.Mock;
    check.mockReturnValueOnce({ ok: true, origin: 'https://shop.example.com/' });
    await runPasskeyNotificationWorker({ deps: real });
    expect((others.send.mock.calls[0][0] as { text: string }).text).toContain('https://shop.example.com/contact');

    check.mockReturnValueOnce({ ok: false, code: 'config_site_url' });
    const stopped = await runPasskeyNotificationWorker({ deps: real });
    expect(stopped.stopped).toBe('config');
  });
  it('DD-AUTH-067 本物の一時停止の確かめ: 止まっていれば1行だけ、止まっていなければ通常どおり、読めなければ通常どおり', async () => {
    const { createServiceRoleClient } = jest.requireMock('@/lib/supabase/server') as { createServiceRoleClient: jest.Mock };
    const state = (paused: boolean) => ({
      rpc: jest.fn(async () => ({
        data: [{ paused, reason: paused ? 'quota_daily' : null, paused_at: null, next_probe_at: new Date(Date.now() + 600_000).toISOString() }],
        error: null,
      })),
    });
    const rows = () => [row({ id: 'r1' }), row({ id: 'r2' })];
    const recipients = [{ email: 'a@example.com', audience: 'subject_customer' as const }];
    for (const [setup, expected] of [
      [() => createServiceRoleClient.mockResolvedValueOnce(state(true)), 1],
      [() => createServiceRoleClient.mockResolvedValueOnce(state(false)), 2],
      [() => createServiceRoleClient.mockRejectedValueOnce(new Error('db down')), 2],
    ] as const) {
      const { sendPaused: _omit, ...rest } = makeDeps(rows(), recipients);
      setup();
      const result = await runPasskeyNotificationWorker({ deps: rest as unknown as Partial<PasskeyNotificationWorkerDeps> });
      expect(result.claimed).toBe(expected);
    }
  });
});
