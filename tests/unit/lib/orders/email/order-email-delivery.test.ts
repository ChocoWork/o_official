const mockResendGet = jest.fn();
const mockResendConstructor = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation((key: string) => {
    mockResendConstructor(key);
    return { emails: { get: (...args: unknown[]) => mockResendGet(...args) } };
  }),
}));

import {
  checkOrderEmailDeliveries,
  createResendLastEventReader,
  parseDeliveryEvent,
  runOrderEmailDeliveryCheckIfDue,
  type LastEventReader,
} from '@/lib/orders/email/order-email-delivery';

const NOW = new Date('2026-10-09T12:00:00Z');

describe('parseDeliveryEvent（設計書 6-3）', () => {
  it.each([
    ['email.delivered', 'delivered'],
    ['email.delivery_delayed', 'delayed'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.suppressed', 'suppressed'],
    ['email.failed', 'failed'],
  ])('%s は %s', (type, status) => {
    expect(parseDeliveryEvent({ type, created_at: '2026-10-09T01:00:00.000Z', data: { email_id: 're_1' } })).toEqual({
      kind: 'delivery', status, providerMessageId: 're_1', eventAt: new Date('2026-10-09T01:00:00.000Z'),
    });
  });

  it('受けない種類は無視する（Object の名前も知らない種類として扱う）', () => {
    expect(parseDeliveryEvent({ type: 'email.opened', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } })).toEqual({ kind: 'ignored' });
    expect(parseDeliveryEvent({ type: 'constructor', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } })).toEqual({ kind: 'ignored' });
  });

  it('形の違う知らせは invalid', () => {
    expect(parseDeliveryEvent(null)).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: {} })).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: 'yesterday', data: { email_id: 're_1' } })).toEqual({ kind: 'invalid' });
    expect(parseDeliveryEvent({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: { email_id: 'x'.repeat(201) } })).toEqual({ kind: 'invalid' });
  });
});

function fakeStore(awaiting: Array<{ email_id: string; provider_message_id: string }>, heartbeats: unknown[] = []) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    switch (name) {
      case 'list_order_emails_awaiting_delivery':
        return { data: awaiting, error: null };
      case 'record_order_email_delivery':
        return { data: 'updated', error: null };
      case 'get_ops_heartbeats':
        return { data: heartbeats, error: null };
      default:
        return { data: null, error: null };
    }
  });
  return { store: { rpc } as never, calls };
}

describe('checkOrderEmailDeliveries', () => {
  it('状態の決まっていないメールを Resend で読み、分かった状態を今の時刻で記録する', async () => {
    const { store, calls } = fakeStore([
      { email_id: 'email-1', provider_message_id: 're_1' },
      { email_id: 'email-2', provider_message_id: 're_2' },
    ]);
    const readLastEvent: LastEventReader = jest.fn(async (id: string) =>
      id === 're_1' ? { ok: true as const, status: 'delivered' as const } : { ok: true as const, status: null });

    await expect(checkOrderEmailDeliveries({ store, readLastEvent, now: () => NOW, limit: 50 })).resolves.toEqual({
      checked: 2, updated: 1, failed: 0, configError: false,
    });
    expect(calls.find((call) => call.name === 'list_order_emails_awaiting_delivery')?.params).toEqual({ _limit: 50 });
    expect(calls.find((call) => call.name === 'record_order_email_delivery')?.params).toEqual({
      _svix_id: null, _provider_message_id: 're_1', _delivery_status: 'delivered', _event_at: NOW.toISOString(),
    });
  });

  it('鍵が送信専用などで読めなければ、そこで止めて設定の問題を返す', async () => {
    const { store, calls } = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }, { email_id: 'email-2', provider_message_id: 're_2' }]);
    const readLastEvent: LastEventReader = jest.fn(async () => ({ ok: false as const, configError: true }));

    await expect(checkOrderEmailDeliveries({ store, readLastEvent, now: () => NOW, limit: 50 })).resolves.toMatchObject({ configError: true });
    expect(readLastEvent).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.name)).not.toContain('record_order_email_delivery');
  });
});

describe('createResendLastEventReader', () => {
  beforeEach(() => {
    mockResendGet.mockReset();
    mockResendConstructor.mockReset();
  });

  it.each([
    ['delivered', 'delivered'],
    ['delivery_delayed', 'delayed'],
    ['bounced', 'bounced'],
    ['complained', 'complained'],
    ['suppressed', 'suppressed'],
    ['failed', 'failed'],
  ])('Resend の最後の状態 %s は %s', async (lastEvent, status) => {
    mockResendGet.mockResolvedValue({ data: { id: 're_1', last_event: lastEvent }, error: null, headers: null });

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: true, status });
    expect(mockResendConstructor).toHaveBeenCalledWith('re_key');
    expect(mockResendGet).toHaveBeenCalledWith('re_1');
  });

  it.each(['sent', 'queued', 'scheduled', 'canceled', 'opened', 'clicked'])(
    '配達の結果ではない最後の状態 %s は、状態なし（記録しない）',
    async (lastEvent) => {
      mockResendGet.mockResolvedValue({ data: { id: 're_1', last_event: lastEvent }, error: null, headers: null });

      await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: true, status: null });
    },
  );

  it.each(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key'])(
    '鍵の断り %s は設定の問題',
    async (name) => {
      mockResendGet.mockResolvedValue({ data: null, error: { name, message: 'denied', statusCode: 401 }, headers: null });

      await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: true });
    },
  );

  it('回数の制限など鍵以外の断りも、通信の例外も、設定の問題にしない', async () => {
    mockResendGet.mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 }, headers: null });
    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: false });

    mockResendGet.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: false });
  });
});

describe('runOrderEmailDeliveryCheckIfDue', () => {
  const RESEND ={ NODE_ENV: 'production', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM_ADDRESS: 'shop@example.com' };

  // process.env を差し替えた試験の後に、元へ戻す
  afterEach(() => jest.restoreAllMocks());

  it('送り手が Resend でなければ何もしない', async () => {
    const { store, calls } = fakeStore([]);
    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: { NODE_ENV: 'production', MAIL_PROVIDER: 'local' }, now: () => NOW })).resolves.toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('最後に動いてから1時間たっていなければ動かない', async () => {
    const { store, calls } = fakeStore([], [
      { job: 'order_email_delivery_check', last_succeeded_at: null, last_failed_at: '2026-10-09T11:30:00Z', last_error_code: 'config_api_key' },
    ]);
    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: RESEND, now: () => NOW })).resolves.toBe('not_due');
    expect(calls.map((call) => call.name)).toEqual(['get_ops_heartbeats']);
  });

  it('動いたら最後の成功を記録する。鍵の問題なら失敗と原因の記号を記録する', async () => {
    const ok = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);
    await expect(runOrderEmailDeliveryCheckIfDue(ok.store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: true, status: 'delivered' }),
    })).resolves.toBe('done');
    expect(ok.calls.find((call) => call.name === 'record_ops_heartbeat')?.params).toEqual({
      _job: 'order_email_delivery_check', _succeeded: true, _error_code: null,
    });

    const denied = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);
    await expect(runOrderEmailDeliveryCheckIfDue(denied.store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: false, configError: true }),
    })).resolves.toBe('failed');
    expect(denied.calls.find((call) => call.name === 'record_ops_heartbeat')?.params).toEqual({
      _job: 'order_email_delivery_check', _succeeded: false, _error_code: 'config_api_key',
    });
  });

  it('本番の DB につないだ next dev では、DB にも Resend にも触れず、最後の成功も記録しない（注文のメールの worker と同じ環境の門）', async () => {
    // 実際の環境変数（VERCEL_ENV など）に左右されず、手元の開発で共有の DB につないだ環境にする
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', VERCEL_ENV: undefined, SUPABASE_URL: 'https://example.supabase.co' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const readLastEvent = jest.fn();
    const { store, calls } = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);

    await expect(runOrderEmailDeliveryCheckIfDue(store, { readLastEvent, now: () => NOW })).resolves.toBe('skipped');

    expect(calls).toEqual([]);
    expect(readLastEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-delivery] skipped', 'development_shared_database');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('Vercel の preview では、Resend の設定があっても DB にも Resend にも触れず、最後の成功も記録しない', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const readLastEvent = jest.fn();
    const { store, calls } = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }]);

    await expect(runOrderEmailDeliveryCheckIfDue(store, {
      env: { ...RESEND, VERCEL_ENV: 'preview' }, readLastEvent, now: () => NOW,
    })).resolves.toBe('skipped');

    expect(calls).toEqual([]);
    expect(readLastEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-delivery] skipped', 'non_production_deployment');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
