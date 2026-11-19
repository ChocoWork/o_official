import { PASSKEY_NOTIFICATION_OPS_LIMITS, runPasskeyNotificationOpsChecks } from '@/lib/auth/passkey-notification-ops';
import type { OpsStore } from '@/lib/ops/ops-store';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const NOW = new Date('2026-11-20T12:00:00Z');

type State = {
  dead: Array<Record<string, unknown>>;
  heartbeats: unknown[];
  failOn?: string;
  claimed?: boolean;
  listData?: unknown;
  markData?: unknown;
};

function fakeStore(state: State) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (state.failOn === name) return { data: null, error: { message: 'db down' } };
    switch (name) {
      case 'list_unnotified_dead_passkey_notifications':
        return { data: 'listData' in state ? state.listData : state.dead.slice(0, Number(params?._limit)), error: null };
      case 'mark_passkey_notification_dead_notified':
        return { data: 'markData' in state ? state.markData : (params?._ids as string[]).length, error: null };
      case 'get_ops_heartbeats':
        return { data: state.heartbeats, error: null };
      case 'claim_ops_alert':
        return { data: [{ claimed: state.claimed !== false, claimed_at: NOW.toISOString(), previous_sent_at: null }], error: null };
      default:
        return { data: true, error: null };
    }
  });
  return { store: { rpc } as unknown as OpsStore, calls };
}

const deadRow = (n: number, total: number) => ({
  id: `id-${n}`, kind: 'staff_demoted', attempts: 9, last_error_code: 'resend_rejected', finished_at: '2026-11-20T01:00:00Z', total,
});
const heartbeat = (at: string | null) => [
  { job: 'passkey_notification_worker', last_succeeded_at: at, last_failed_at: null, last_error_code: null },
];
const fresh = (): State => ({ dead: [], heartbeats: [] });

describe('passkey notification ops checks (DD-AUTH-089)', () => {
  const send = jest.fn<Promise<boolean>, [OpsAlertMail]>();
  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  const run = async (state: State) => {
    const { store, calls } = fakeStore(state);
    const result = await runPasskeyNotificationOpsChecks({ store, send, now: () => NOW });
    return { result, calls };
  };

  test('DD-AUTH-089 dead が0件なら送らず、mark も呼ばない', async () => {
    const { result, calls } = await run(fresh());
    expect(send).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).not.toContain('mark_passkey_notification_dead_notified');
    expect(result).toEqual({ deadNotified: 0, staleAlerted: false, failedChecks: [] });
  });

  test('DD-AUTH-089 dead が1件以上ならまとめて1通送り、送れたら mark を呼ぶ', async () => {
    const state = fresh();
    state.dead = [deadRow(1, 2), deadRow(2, 2)];
    const { result, calls } = await run(state);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.kind).toBe('passkey_notification_dead');
    expect(mail.subject).toBe('パスキーの知らせが届きませんでした');
    expect(mail.lines[0]).toBe('2件の知らせが、再試行の上限を越えて届きませんでした。種類・失敗の理由・時刻は次のとおりです。');
    expect(mail.lines[1]).toMatch(/^staff_demoted／resend_rejected／/);
    expect(calls.find((c) => c.name === 'list_unnotified_dead_passkey_notifications')?.params)
      .toEqual({ _limit: PASSKEY_NOTIFICATION_OPS_LIMITS.digestLimit });
    expect(calls.find((c) => c.name === 'mark_passkey_notification_dead_notified')?.params).toEqual({ _ids: ['id-1', 'id-2'] });
    expect(result.deadNotified).toBe(2);
  });

  test('DD-AUTH-089 送れなかった時（送信失敗・冷却中）は mark を呼ばない', async () => {
    const failing = fresh();
    failing.dead = [deadRow(1, 1)];
    send.mockResolvedValue(false);
    expect((await run(failing)).calls.map((c) => c.name)).not.toContain('mark_passkey_notification_dead_notified');
    const cooling = fresh();
    cooling.dead = [deadRow(1, 1)];
    cooling.claimed = false;
    send.mockClear();
    send.mockResolvedValue(true);
    const { calls } = await run(cooling);
    expect(send).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).not.toContain('mark_passkey_notification_dead_notified');
  });

  test('DD-AUTH-089 mark が失敗しても例外を出さず failedChecks に dead を入れ、stale の点検は続ける', async () => {
    const state = fresh();
    state.dead = [deadRow(1, 1)];
    state.failOn = 'mark_passkey_notification_dead_notified';
    state.heartbeats = heartbeat('2026-11-20T11:00:00Z');
    const { result } = await run(state);
    expect(result.failedChecks).toEqual(['dead']);
    expect(result.staleAlerted).toBe(true);
  });

  test.each([
    ['29分前', '2026-11-20T11:31:00Z', 0],
    ['31分前', '2026-11-20T11:29:00Z', 1],
  ])('DD-AUTH-089 心拍の最後の成功が%sなら stale の知らせは%i通', async (_label, at, count) => {
    const state = fresh();
    state.heartbeats = heartbeat(at);
    const { result } = await run(state);
    expect(send).toHaveBeenCalledTimes(count);
    expect(result.staleAlerted).toBe(count === 1);
    if (count === 1) {
      const mail = send.mock.calls[0][0];
      expect(mail.subject).toBe('パスキーの知らせの送りが止まっています');
      expect(mail.lines).toEqual([expect.stringMatching(/^最後に成功したのは .+ です。送りの設定とログを確認してください。$/)]);
    }
  });

  test('DD-AUTH-089 一度も成功が無ければ stale の対象にしない', async () => {
    const state = fresh();
    state.heartbeats = heartbeat(null);
    await run(state);
    expect(send).not.toHaveBeenCalled();
  });

  test('DD-AUTH-089 claimAlert の鍵は passkey_notification_dead と job_stale_passkey_notification_worker で、冷却は3600秒', async () => {
    const state = fresh();
    state.dead = [deadRow(1, 1)];
    state.heartbeats = heartbeat('2026-11-20T10:00:00Z');
    const { calls } = await run(state);
    expect(calls.filter((c) => c.name === 'claim_ops_alert').map((c) => c.params)).toEqual([
      { _alert_key: 'passkey_notification_dead', _cooldown_seconds: 3600 },
      { _alert_key: 'job_stale_passkey_notification_worker', _cooldown_seconds: 3600 },
    ]);
  });

  test('DD-AUTH-089 一覧の読み込みが失敗しても stale の点検は続ける', async () => {
    const state = fresh();
    state.failOn = 'list_unnotified_dead_passkey_notifications';
    state.heartbeats = heartbeat('2026-11-20T10:00:00Z');
    const { result } = await run(state);
    expect(result.failedChecks).toEqual(['dead']);
    expect(result.staleAlerted).toBe(true);
  });

  test('DD-AUTH-089 メールにアドレス（@）を入れない。DB の行にアドレスがあっても写さない', async () => {
    const state = fresh();
    state.dead = [{ ...deadRow(1, 1), subject_email: 'a@example.com', actor_email: 'b@example.com' }];
    state.heartbeats = heartbeat('2026-11-20T10:00:00Z');
    await run(state);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [mail] of send.mock.calls) expect(`${mail.subject}\n${mail.lines.join('\n')}`).not.toContain('@');
  });

  test('DD-AUTH-089 一覧が配列でない時は0件として扱い、送らない', async () => {
    const state = fresh();
    state.listData = null;
    const { result } = await run(state);
    expect(send).not.toHaveBeenCalled();
    expect(result.failedChecks).toEqual([]);
  });

  test('DD-AUTH-089 失敗コードと時刻が無い行は「不明」で書き、mark が数を返さなければ0', async () => {
    const state = fresh();
    state.dead = [{ ...deadRow(1, 1), last_error_code: null, finished_at: null }];
    state.markData = null;
    const { result } = await run(state);
    expect(send.mock.calls[0][0].lines[1]).toBe('staff_demoted／不明／不明');
    expect(result.deadNotified).toBe(0);
  });

  test('DD-AUTH-089 送信が投げた時は例外名だけをログに出し、点検は続ける。名前の無い例外は UnknownError', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const state = fresh();
    state.dead = [deadRow(1, 1)];
    send.mockRejectedValueOnce(new TypeError('a@example.com'));
    expect((await run(state)).result.failedChecks).toEqual(['dead']);
    send.mockRejectedValueOnce('a@example.com');
    expect((await run(state)).result.failedChecks).toEqual(['dead']);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).toContain('UnknownError');
    expect(logged).not.toContain('a@example');
  });
});
