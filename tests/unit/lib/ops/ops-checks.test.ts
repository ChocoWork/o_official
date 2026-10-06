import { OPS_CHECK_LIMITS, runOpsChecks } from '@/lib/ops/ops-checks';
import type { OpsStore } from '@/lib/ops/ops-store';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const NOW = new Date('2026-10-05T12:00:00Z');

type FakeState = {
  backlog: unknown[];
  dead: unknown[];
  heartbeats: unknown[];
  sentAt: Record<string, string | null>;
  failOn?: string;
  failClaimKey?: string;
};

/** DB の関数を、送る権利の時刻まで含めてまねる */
function fakeStore(state: FakeState) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (state.failOn === name || (name === 'claim_ops_alert' && state.failClaimKey === params?._alert_key)) {
      return { data: null, error: { message: 'db down' } };
    }
    switch (name) {
      case 'get_stripe_webhook_backlog':
        return { data: state.backlog, error: null };
      case 'list_unnotified_dead_stripe_webhook_events':
        return { data: state.dead.slice(0, Number(params?._limit)), error: null };
      case 'mark_stripe_webhook_dead_notified':
        return { data: (params?._event_ids as string[]).length, error: null };
      case 'get_ops_heartbeats':
        return { data: state.heartbeats, error: null };
      case 'claim_ops_alert': {
        const key = String(params?._alert_key);
        const previous = state.sentAt[key] ?? null;
        const cooldownMs = Number(params?._cooldown_seconds) * 1000;
        if (previous && NOW.getTime() - new Date(previous).getTime() < cooldownMs) {
          return { data: [{ claimed: false, claimed_at: null, previous_sent_at: previous }], error: null };
        }
        state.sentAt[key] = NOW.toISOString();
        return { data: [{ claimed: true, claimed_at: NOW.toISOString(), previous_sent_at: previous }], error: null };
      }
      case 'release_ops_alert': {
        const key = String(params?._alert_key);
        if (state.sentAt[key] === params?._claimed_at) state.sentAt[key] = (params?._previous_sent_at as string | null) ?? null;
        return { data: true, error: null };
      }
      default:
        return { data: null, error: null };
    }
  });
  return { store: { rpc } as unknown as OpsStore, calls };
}

function emptyState(): FakeState {
  return { backlog: [], dead: [], heartbeats: [], sentAt: {} };
}

function deadRow(n: number, total: number) {
  return {
    event_id: `evt_${n}`, event_type: 'refund.updated', last_error: 'unexpected_error',
    received_at: '2026-10-05T00:00:00Z', attempt_count: 9, dead_at: '2026-10-05T04:15:00Z', total_count: total,
  };
}

function heartbeat(job: string, lastSucceededAt: string | null) {
  return { job, last_succeeded_at: lastSucceededAt, last_failed_at: null, last_error_code: null };
}

describe('runOpsChecks', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('何も無ければ知らせない', async () => {
    const send = jest.fn();
    const { store } = fakeStore(emptyState());
    await expect(runOpsChecks({ store, send, now: () => NOW })).resolves.toEqual({
      backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('溜まりがあれば知らせ、1時間以内はもう知らせない', async () => {
    const state = emptyState();
    state.backlog = [{ processing_status: 'queued', event_count: 3, oldest_received_at: '2026-10-05T11:30:00Z', last_errors: [] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const first = await runOpsChecks({ store, send, now: () => NOW });
    expect(first.backlogAlerted).toBe(true);
    expect(send.mock.calls[0][0].kind).toBe('webhook_backlog');
    expect(calls.find((call) => call.name === 'get_stripe_webhook_backlog')?.params).toEqual({ _older_than_seconds: 900 });
    expect(calls.find((call) => call.name === 'claim_ops_alert')?.params).toEqual({
      _alert_key: 'webhook_backlog', _cooldown_seconds: 3600,
    });

    const second = await runOpsChecks({ store, send, now: () => NOW });
    expect(second.backlogAlerted).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('溜まりのメールが送れなければ、送る権利を返し、次の点検でまた送れる', async () => {
    const state = emptyState();
    state.backlog = [{ processing_status: 'failed', event_count: 1, oldest_received_at: '2026-10-05T11:00:00Z', last_errors: ['db_unavailable'] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect((await runOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(false);
    expect(calls.some((call) => call.name === 'release_ops_alert')).toBe(true);
    expect((await runOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(true);
  });

  it('溜まりの送信が例外を投げても権利を返し、1時間以内の次の点検で送れる', async () => {
    const state = emptyState();
    state.backlog = [{ processing_status: 'queued', event_count: 1, oldest_received_at: '2026-10-05T11:00:00Z', last_errors: [] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>()
      .mockRejectedValueOnce(new TypeError('mail provider details'))
      .mockResolvedValueOnce(true);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runOpsChecks({ store, send, now: () => NOW });
    expect(first.backlogAlerted).toBe(false);
    expect(first.failedChecks).toEqual(['backlog']);
    expect(state.sentAt.webhook_backlog).toBeNull();
    expect(calls.find((call) => call.name === 'release_ops_alert')?.params).toEqual({
      _alert_key: 'webhook_backlog', _claimed_at: NOW.toISOString(), _previous_sent_at: null,
    });
    expect(log).toHaveBeenCalledWith('[ops-checks] backlog check failed', 'TypeError');

    const second = await runOpsChecks({ store, send, now: () => NOW });
    expect(second.backlogAlerted).toBe(true);
    expect(second.failedChecks).toEqual([]);
    expect(state.sentAt.webhook_backlog).toBe(NOW.toISOString());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('退避が60件でも1通、載せるのは50件まで。送れた50件に印を付ける', async () => {
    const state = emptyState();
    state.dead = Array.from({ length: 60 }, (_, i) => deadRow(i + 1, 60));
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.kind).toBe('webhook_dead');
    expect(mail.lines.filter((line) => line.startsWith('- evt_'))).toHaveLength(OPS_CHECK_LIMITS.deadDigestLimit);
    expect(mail.lines.join('\n')).toContain('ほかに 10 件');
    const mark = calls.find((call) => call.name === 'mark_stripe_webhook_dead_notified');
    expect((mark?.params?._event_ids as string[])).toHaveLength(50);
    expect(result.deadNotified).toBe(50);
  });

  it('退避のメールが送れなければ印を付けず、権利を返す', async () => {
    const state = emptyState();
    state.dead = [deadRow(1, 1)];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(false);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.deadNotified).toBe(0);
    expect(calls.some((call) => call.name === 'mark_stripe_webhook_dead_notified')).toBe(false);
    expect(calls.some((call) => call.name === 'release_ops_alert')).toBe(true);
  });

  it('退避の送信が例外を投げたら前の送信時刻に戻し、次の点検で送って印を付ける', async () => {
    const state = emptyState();
    state.dead = [deadRow(1, 1)];
    state.sentAt.webhook_dead = '2026-10-05T10:00:00Z';
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>()
      .mockRejectedValueOnce(new Error('mail provider details'))
      .mockResolvedValueOnce(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const first = await runOpsChecks({ store, send, now: () => NOW });
    expect(first.deadNotified).toBe(0);
    expect(first.failedChecks).toEqual(['dead']);
    expect(state.sentAt.webhook_dead).toBe('2026-10-05T10:00:00Z');
    expect(calls.some((call) => call.name === 'mark_stripe_webhook_dead_notified')).toBe(false);
    expect(calls.find((call) => call.name === 'release_ops_alert')?.params).toEqual({
      _alert_key: 'webhook_dead', _claimed_at: NOW.toISOString(), _previous_sent_at: '2026-10-05T10:00:00Z',
    });

    const second = await runOpsChecks({ store, send, now: () => NOW });
    expect(second.deadNotified).toBe(1);
    expect(second.failedChecks).toEqual([]);
    expect(state.sentAt.webhook_dead).toBe(NOW.toISOString());
    expect(calls.find((call) => call.name === 'mark_stripe_webhook_dead_notified')?.params).toEqual({ _event_ids: ['evt_1'] });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['list_unnotified_dead_stripe_webhook_events', 0],
    ['mark_stripe_webhook_dead_notified', 1],
  ])('退避の %s が失敗したログは固定のRPC名を含み、DBの中身を含まない', async (operation, sentCount) => {
    const state = emptyState();
    state.dead = [deadRow(1, 1)];
    state.failOn = operation;
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.failedChecks).toEqual(['dead']);
    expect(result.deadNotified).toBe(0);
    expect(send).toHaveBeenCalledTimes(sentCount);
    expect(log).toHaveBeenCalledWith('[ops-checks] dead check failed', `ops store failed: ${operation}`);
    expect(calls.some((call) => call.name === 'release_ops_alert')).toBe(false);
  });

  it.each([
    ['order_sweep', '2026-10-05T10:00:00Z', true],
    ['order_sweep', '2026-10-05T10:00:01Z', false],
    ['stripe_reconcile', '2026-10-04T11:00:00Z', true],
    ['stripe_reconcile', '2026-10-04T11:00:01Z', false],
  ])('%s の最後の成功が %s なら、遅れの知らせは %s', async (job, lastSucceededAt, expected) => {
    const state = emptyState();
    state.heartbeats = [heartbeat(job, lastSucceededAt)];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.staleAlerted.includes(job as 'order_sweep' | 'stripe_reconcile')).toBe(expected);
  });

  it('見回りの権利取得が失敗しても、同じ点検で照合の遅れを知らせる', async () => {
    const state = emptyState();
    state.heartbeats = [heartbeat('order_sweep', '2026-10-05T09:00:00Z'), heartbeat('stripe_reconcile', '2026-10-04T10:00:00Z')];
    state.failClaimKey = 'job_stale_order_sweep';
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.failedChecks).toEqual(['stale']);
    expect(result.staleAlerted).toEqual(['stripe_reconcile']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toContain('毎晩の照合');
    expect(calls.filter((call) => call.name === 'claim_ops_alert').map((call) => call.params?._alert_key)).toEqual([
      'job_stale_order_sweep', 'job_stale_stripe_reconcile',
    ]);
  });

  it('両方の定期処理が遅れたら、それぞれのキーと1時間の制限で知らせる', async () => {
    const state = emptyState();
    state.heartbeats = [heartbeat('order_sweep', '2026-10-05T09:00:00Z'), heartbeat('stripe_reconcile', '2026-10-04T10:00:00Z')];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.staleAlerted).toEqual(['order_sweep', 'stripe_reconcile']);
    expect(result.failedChecks).toEqual([]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.name === 'claim_ops_alert').map((call) => call.params)).toEqual([
      { _alert_key: 'job_stale_order_sweep', _cooldown_seconds: 3600 },
      { _alert_key: 'job_stale_stripe_reconcile', _cooldown_seconds: 3600 },
    ]);
  });

  it('両方の遅れの点検が失敗しても、失敗一覧のstaleは1つだけにする', async () => {
    const state = emptyState();
    state.heartbeats = [heartbeat('order_sweep', '2026-10-05T09:00:00Z'), heartbeat('stripe_reconcile', '2026-10-04T10:00:00Z')];
    state.failOn = 'claim_ops_alert';
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.failedChecks).toEqual(['stale']);
    expect(result.staleAlerted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.name === 'claim_ops_alert').map((call) => call.params?._alert_key)).toEqual([
      'job_stale_order_sweep', 'job_stale_stripe_reconcile',
    ]);
  });

  it('一度も成功していない定期処理は、遅れの対象にしない（開店前）', async () => {
    const state = emptyState();
    state.heartbeats = [heartbeat('order_sweep', null), heartbeat('webhook_worker', '2026-10-05T11:59:00Z')];
    const { store } = fakeStore(state);
    const send = jest.fn();

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.staleAlerted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('溜まりの読み出しが失敗しても、退避と遅れの点検は続ける', async () => {
    const state = emptyState();
    state.failOn = 'get_stripe_webhook_backlog';
    state.dead = [deadRow(1, 1)];
    state.heartbeats = [heartbeat('order_sweep', '2026-10-05T09:00:00Z')];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    const result = await runOpsChecks({ store, send, now: () => NOW });
    expect(result.failedChecks).toEqual(['backlog']);
    expect(result.deadNotified).toBe(1);
    expect(result.staleAlerted).toEqual(['order_sweep']);
  });
});
