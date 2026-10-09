import { ORDER_EMAIL_OPS_LIMITS, runOrderEmailOpsChecks } from '@/lib/orders/email/order-email-ops';
import type { OpsAlertMail } from '@/lib/ops/ops-alert-mail';

const NOW = new Date('2026-10-09T12:00:00Z');

type State = {
  sendState: unknown[];
  backlog: unknown[];
  dead: unknown[];
  delivery: unknown[];
  heartbeats: unknown[];
  sentAt: Record<string, string | null>;
  failOn?: string;
};

function emptyState(): State {
  return {
    sendState: [{ paused: false, reason: null, paused_at: null, next_probe_at: null }],
    backlog: [], dead: [], delivery: [], heartbeats: [], sentAt: {},
  };
}

/** DB の関数を、送る権利の時刻まで含めてまねる（グループ B の ops-checks の試験と同じ作り） */
function fakeStore(state: State) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (state.failOn === name) return { data: null, error: { message: 'db down' } };
    switch (name) {
      case 'get_order_email_send_state':
        return { data: state.sendState, error: null };
      case 'get_order_email_backlog':
        return { data: state.backlog, error: null };
      case 'list_unnotified_dead_order_emails':
        return { data: state.dead, error: null };
      case 'mark_order_emails_dead_notified':
        return { data: (params?._email_ids as string[]).length, error: null };
      case 'list_unnotified_order_email_delivery_problems':
        return { data: state.delivery, error: null };
      case 'mark_order_email_delivery_problems_notified':
        return { data: (params?._email_ids as string[]).length, error: null };
      case 'get_ops_heartbeats':
        return { data: state.heartbeats, error: null };
      case 'claim_ops_alert': {
        const key = String(params?._alert_key);
        const previous = state.sentAt[key] ?? null;
        if (previous && NOW.getTime() - new Date(previous).getTime() < Number(params?._cooldown_seconds) * 1000) {
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
  return { store: { rpc } as never, calls };
}

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

describe('runOrderEmailOpsChecks', () => {
  // process.env を差し替えた試験の後に、元へ戻す
  afterEach(() => jest.restoreAllMocks());

  it('何も無ければ知らせない', async () => {
    const send = jest.fn();
    const { store } = fakeStore(emptyState());

    await expect(runOrderEmailOpsChecks({ store, send, now: () => NOW })).resolves.toEqual({
      pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('送信を止めていれば知らせ、1時間以内はもう知らせない', async () => {
    const state = emptyState();
    state.sendState = [{ paused: true, reason: 'config_api_key', paused_at: '2026-10-09T11:50:00Z', next_probe_at: '2026-10-09T12:05:00Z' }];
    const { store } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).pausedAlerted).toBe(true);
    expect(send.mock.calls[0][0].kind).toBe('order_email_paused');
    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).pausedAlerted).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('15分以上送れていないメールがあれば知らせる', async () => {
    const state = emptyState();
    state.backlog = [{ status: 'retry_wait', email_count: 2, oldest_created_at: '2026-10-09T11:30:00Z', last_errors: ['provider_unavailable'] }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).backlogAlerted).toBe(true);
    expect(calls.find((call) => call.name === 'get_order_email_backlog')?.params).toEqual({
      _older_than_seconds: ORDER_EMAIL_OPS_LIMITS.backlogAgeSeconds,
    });
  });

  it('送れなかったメールをまとめて1通知らせ、送れた時だけ印を付ける', async () => {
    const state = emptyState();
    state.dead = [{ email_id: 'email-1', order_id: ORDER_ID, kind: 'paid', last_error_code: 'invalid_message', attempts: 1, finished_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    const unsent = fakeStore({ ...state, sentAt: {} });
    const failingSend = jest.fn().mockResolvedValue(false);

    expect((await runOrderEmailOpsChecks({ store: unsent.store, send: failingSend, now: () => NOW })).deadNotified).toBe(0);
    expect(unsent.calls.map((call) => call.name)).not.toContain('mark_order_emails_dead_notified');

    const sent = fakeStore({ ...state, sentAt: {} });
    const send = jest.fn().mockResolvedValue(true);
    expect((await runOrderEmailOpsChecks({ store: sent.store, send, now: () => NOW })).deadNotified).toBe(1);
    expect(sent.calls.find((call) => call.name === 'mark_order_emails_dead_notified')?.params).toEqual({ _email_ids: ['email-1'] });
  });

  it('届かなかったメールをまとめて1通知らせ、印を付ける', async () => {
    const state = emptyState();
    state.delivery = [{ email_id: 'email-2', order_id: ORDER_ID, kind: 'shipped', delivery_status: 'bounced', delivery_event_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store, send, now: () => NOW })).deliveryNotified).toBe(1);
    expect(send.mock.calls[0][0].kind).toBe('order_email_delivery_problem');
    expect(calls.find((call) => call.name === 'mark_order_email_delivery_problems_notified')?.params).toEqual({ _email_ids: ['email-2'] });
  });

  it('注文のメールの worker が15分以上成功していなければ知らせる。一度も成功していなければ知らせない', async () => {
    const stale = emptyState();
    stale.heartbeats = [{ job: 'order_email_worker', last_succeeded_at: '2026-10-09T11:44:00Z', last_failed_at: null, last_error_code: null }];
    const send = jest.fn<Promise<boolean>, [OpsAlertMail]>().mockResolvedValue(true);

    expect((await runOrderEmailOpsChecks({ store: fakeStore(stale).store, send, now: () => NOW })).staleAlerted).toBe(true);
    expect(send.mock.calls[0][0].subject).toBe('【要確認】定期処理が止まっています（注文のメールの送信）');

    const never = emptyState();
    expect((await runOrderEmailOpsChecks({ store: fakeStore(never).store, send: jest.fn(), now: () => NOW })).staleAlerted).toBe(false);
  });

  it('点検の1つが失敗しても残りは続ける', async () => {
    const state = emptyState();
    state.failOn = 'get_order_email_backlog';
    state.dead = [{ email_id: 'email-1', order_id: ORDER_ID, kind: 'paid', last_error_code: null, attempts: 9, finished_at: null, total_count: 1 }];
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await runOrderEmailOpsChecks({ store: fakeStore(state).store, send: jest.fn().mockResolvedValue(true), now: () => NOW });

      expect(result.failedChecks).toEqual(['backlog']);
      expect(result.deadNotified).toBe(1);
      expect(error).toHaveBeenCalledWith('[order-email-ops] backlog check failed', 'OrderEmailStoreError');
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('止める環境では、DB を読まず、知らせず、印も付けない（本番の知らせを、開発や preview が知らせ済みにしない）', async () => {
    // 知らせる理由が全部そろった状態にして、門が無ければ読み書きと送信が起きることを確かめられるようにする
    const state = emptyState();
    state.sendState = [{ paused: true, reason: 'config_api_key', paused_at: '2026-10-09T11:50:00Z', next_probe_at: '2026-10-09T12:05:00Z' }];
    state.backlog = [{ status: 'retry_wait', email_count: 2, oldest_created_at: '2026-10-09T11:30:00Z', last_errors: ['provider_unavailable'] }];
    state.dead = [{ email_id: 'email-1', order_id: ORDER_ID, kind: 'paid', last_error_code: 'invalid_message', attempts: 1, finished_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    state.delivery = [{ email_id: 'email-2', order_id: ORDER_ID, kind: 'shipped', delivery_status: 'bounced', delivery_event_at: '2026-10-09T11:00:00Z', total_count: 1 }];
    state.heartbeats = [{ job: 'order_email_worker', last_succeeded_at: '2026-10-09T11:44:00Z', last_failed_at: null, last_error_code: null }];
    const { store, calls } = fakeStore(state);
    const send = jest.fn().mockResolvedValue(true);
    // 本番の DB につないだ next dev（VERCEL_ENV は無い）
    jest.replaceProperty(process, 'env', {
      ...process.env, NODE_ENV: 'development', VERCEL_ENV: undefined, SUPABASE_URL: 'https://example.supabase.co',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(runOrderEmailOpsChecks({ store, send, now: () => NOW })).resolves.toEqual({
        pausedAlerted: false, backlogAlerted: false, deadNotified: 0, deliveryNotified: 0, staleAlerted: false, failedChecks: [],
      });
      expect(calls).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[order-email-ops] skipped', 'development_shared_database');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
