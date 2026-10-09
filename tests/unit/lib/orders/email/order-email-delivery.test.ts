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

type Call = { name: string; params?: Record<string, unknown> };

function fakeStore(awaiting: Array<{ email_id: string; provider_message_id: string }>, heartbeats: unknown[] = [], failOn?: string) {
  const calls: Call[] = [];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (name === failOn) return { data: null, error: { message: 'db down', code: '08006' } };
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

const ONE = [{ email_id: 'email-1', provider_message_id: 're_1' }];
const THREE = [
  { email_id: 'email-1', provider_message_id: 're_1' },
  { email_id: 'email-2', provider_message_id: 're_2' },
  { email_id: 'email-3', provider_message_id: 're_3' },
];

type CheckDeps = Parameters<typeof checkOrderEmailDeliveries>[0];

/** 時間と待ちは偽物にして、試験が実際には待たないようにする。変えたい物だけ渡す */
function checkDeps(store: CheckDeps['store'], readLastEvent: LastEventReader, overrides: Partial<CheckDeps> = {}): CheckDeps {
  return { store, readLastEvent, now: () => NOW, limit: 50, budgetMs: 8_000, nowMs: () => 0, sleep: async () => undefined, ...overrides };
}

describe('checkOrderEmailDeliveries', () => {
  it('状態の決まっていないメールを Resend で読み、分かった状態を今の時刻で記録する', async () => {
    const { store, calls } = fakeStore([
      { email_id: 'email-1', provider_message_id: 're_1' },
      { email_id: 'email-2', provider_message_id: 're_2' },
    ]);
    const readLastEvent: LastEventReader = jest.fn(async (id: string) =>
      id === 're_1' ? { ok: true as const, status: 'delivered' as const } : { ok: true as const, status: null });

    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent))).resolves.toEqual({
      checked: 2, updated: 1, failed: 0, configError: false, stoppedEarly: false,
    });
    expect(calls.find((call) => call.name === 'list_order_emails_awaiting_delivery')?.params).toEqual({ _limit: 50 });
    expect(calls.find((call) => call.name === 'record_order_email_delivery')?.params).toEqual({
      _svix_id: null, _provider_message_id: 're_1', _delivery_status: 'delivered', _event_at: NOW.toISOString(),
    });
  });

  it('鍵が送信専用などで読めなければ、そこで止めて設定の問題を返す', async () => {
    const { store, calls } = fakeStore([{ email_id: 'email-1', provider_message_id: 're_1' }, { email_id: 'email-2', provider_message_id: 're_2' }]);
    const readLastEvent: LastEventReader = jest.fn(async () => ({ ok: false as const, configError: true, retryable: false }));

    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent))).resolves.toMatchObject({ configError: true, stoppedEarly: true });
    expect(readLastEvent).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.name)).not.toContain('record_order_email_delivery');
  });

  it('2件目から読む前に500ミリ秒待つ。1件目の前は待たない（Resend の回数の制限を使い切らない）', async () => {
    const { store } = fakeStore(THREE);
    const order: string[] = [];
    const readLastEvent: LastEventReader = jest.fn(async (id: string) => {
      order.push(`read:${id}`);
      return { ok: true as const, status: null };
    });
    const sleep = jest.fn(async (ms: number) => {
      order.push(`sleep:${ms}`);
    });

    await checkOrderEmailDeliveries(checkDeps(store, readLastEvent, { sleep }));

    expect(order).toEqual(['read:re_1', 'sleep:500', 'read:re_2', 'sleep:500', 'read:re_3']);
  });

  it('時間の上限（待った時間も数える）に達したら、次を読む前に止まる', async () => {
    const { store } = fakeStore(THREE);
    let clock = 0;
    const readLastEvent: LastEventReader = jest.fn(async () => {
      clock += 4_000;
      return { ok: true as const, status: null };
    });
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });

    // 1件目は 0ms→4000ms。待って 4500ms で2件目を読み 8500ms。3件目の前は待って 9000ms で、上限の 8000ms を過ぎている
    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent, { budgetMs: 8_000, nowMs: () => clock, sleep }))).resolves.toEqual({
      checked: 2, updated: 0, failed: 0, configError: false, stoppedEarly: true,
    });
    expect(readLastEvent).toHaveBeenCalledTimes(2);
  });

  it('上限の時間が尽きていれば、1件も読まない', async () => {
    const { store } = fakeStore(THREE);
    const readLastEvent: LastEventReader = jest.fn(async () => ({ ok: true as const, status: null }));

    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent, { budgetMs: 0 }))).resolves.toEqual({
      checked: 0, updated: 0, failed: 0, configError: false, stoppedEarly: true,
    });
    expect(readLastEvent).not.toHaveBeenCalled();
  });

  it('少し待てば読める見込みの失敗なら、その回をやめて次の1時間に回す', async () => {
    const { store } = fakeStore(THREE);
    const readLastEvent: LastEventReader = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: null })
      .mockResolvedValueOnce({ ok: false, configError: false, retryable: true });

    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent))).resolves.toEqual({
      checked: 1, updated: 0, failed: 1, configError: false, stoppedEarly: true,
    });
    expect(readLastEvent).toHaveBeenCalledTimes(2);
  });

  it('そのメールだけの失敗なら、次のメールへ進む（同じメールで毎回止まって、後ろが読まれなくならない）', async () => {
    const { store } = fakeStore(THREE);
    const readLastEvent: LastEventReader = jest.fn()
      .mockResolvedValueOnce({ ok: false, configError: false, retryable: false })
      .mockResolvedValueOnce({ ok: true, status: 'delivered' })
      .mockResolvedValueOnce({ ok: true, status: null });

    await expect(checkOrderEmailDeliveries(checkDeps(store, readLastEvent))).resolves.toEqual({
      checked: 2, updated: 1, failed: 1, configError: false, stoppedEarly: false,
    });
    expect(readLastEvent).toHaveBeenCalledTimes(3);
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
    // 開封とクリックは届いた後にしか起きない。開封の追跡が有効でも、届いたメールを状態なしのまま読み直し続けない
    ['opened', 'delivered'],
    ['clicked', 'delivered'],
  ])('Resend の最後の状態 %s は %s', async (lastEvent, status) => {
    mockResendGet.mockResolvedValue({ data: { id: 're_1', last_event: lastEvent }, error: null, headers: null });

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: true, status });
    expect(mockResendConstructor).toHaveBeenCalledWith('re_key');
    expect(mockResendGet).toHaveBeenCalledWith('re_1');
  });

  it.each(['sent', 'queued', 'scheduled', 'canceled'])(
    '配達の結果ではない最後の状態 %s は、状態なし（記録しない）',
    async (lastEvent) => {
      mockResendGet.mockResolvedValue({ data: { id: 're_1', last_event: lastEvent }, error: null, headers: null });

      await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: true, status: null });
    },
  );

  it.each(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key'])(
    '鍵の断り %s は設定の問題（待っても読めない）',
    async (name) => {
      mockResendGet.mockResolvedValue({ data: null, error: { name, message: 'denied', statusCode: 401 }, headers: null });

      await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: true, retryable: false });
    },
  );

  it.each([
    ['回数の制限', 'rate_limit_exceeded', 429],
    ['回数の制限（名前が違っても 429）', 'daily_quota_exceeded', 429],
    ['Resend 側の不調', 'internal_server_error', 500],
    ['500 番台', 'service_unavailable', 503],
    ['通信の失敗（statusCode なし）', 'application_error', null],
  ])('%s は、少し待てば読める見込みの失敗', async (_label, name, statusCode) => {
    mockResendGet.mockResolvedValue({ data: null, error: { name, message: 'x', statusCode }, headers: null });

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: false, retryable: true });
  });

  it.each([
    ['見つからない', 'not_found', 404],
    ['番号の形が違う', 'validation_error', 422],
    ['引数が違う', 'invalid_parameter', 400],
  ])('%s（そのメールだけの失敗）は、設定の問題でも、待てば読める見込みの失敗でもない', async (_label, name, statusCode) => {
    mockResendGet.mockResolvedValue({ data: null, error: { name, message: 'x', statusCode }, headers: null });

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: false, retryable: false });
  });

  it('通信の例外は、設定の問題でなく、少し待てば読める見込みの失敗', async () => {
    mockResendGet.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: false, configError: false, retryable: true });
  });
});

describe('読み取りの打ち切り（偽のタイマー）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockResendGet.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('返事の来ない読み取りは5秒で打ち切り、少し待てば読める見込みの失敗にする', async () => {
    mockResendGet.mockReturnValue(new Promise(() => {}));
    let settled = false;
    const pending = createResendLastEventReader('re_key')('re_1').then((result) => {
      settled = true;
      return result;
    });

    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: false, configError: false, retryable: true });
    // 打ち切りのタイマーが残らない
    expect(jest.getTimerCount()).toBe(0);
  });

  it('読み取りが先に終われば、打ち切りのタイマーを止める', async () => {
    mockResendGet.mockResolvedValue({ data: { id: 're_1', last_event: 'delivered' }, error: null, headers: null });

    await expect(createResendLastEventReader('re_key')('re_1')).resolves.toEqual({ ok: true, status: 'delivered' });

    expect(jest.getTimerCount()).toBe(0);
  });

  it('打ち切った後に読み取りが失敗しても、unhandled rejection にならない', async () => {
    let failRead: (reason: Error) => void = () => undefined;
    mockResendGet.mockReturnValue(new Promise((_resolve, reject) => {
      failRead = reject;
    }));
    const pending = createResendLastEventReader('re_key')('re_1');
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ ok: false, configError: false, retryable: true });

    failRead(new Error('late failure'));
    // 実際のイベントループを1周させる。受け取る人のいない失敗があれば、jest が今の試験の失敗にする
    await jest.advanceTimersByTimeAsync(0);
  });
});

describe('見回りと Resend の読み取りの組み合わせ', () => {
  beforeEach(() => mockResendGet.mockReset());
  afterEach(() => jest.useRealTimers());

  it.each([
    ['回数の制限', { name: 'rate_limit_exceeded', message: 'x', statusCode: 429 }],
    ['500 番台', { name: 'internal_server_error', message: 'x', statusCode: 500 }],
    ['通信の失敗', { name: 'application_error', message: 'x', statusCode: null }],
  ])('%s では、その回をやめて次のメールを読まない', async (_label, error) => {
    mockResendGet.mockResolvedValue({ data: null, error, headers: null });
    const { store } = fakeStore(THREE);

    await expect(checkOrderEmailDeliveries(checkDeps(store, createResendLastEventReader('re_key')))).resolves.toEqual({
      checked: 0, updated: 0, failed: 1, configError: false, stoppedEarly: true,
    });
    expect(mockResendGet).toHaveBeenCalledTimes(1);
  });

  it('時間切れでも、その回をやめて次のメールを読まない', async () => {
    jest.useFakeTimers();
    mockResendGet.mockReturnValue(new Promise(() => {}));
    const { store } = fakeStore(THREE);

    const run = checkOrderEmailDeliveries(checkDeps(store, createResendLastEventReader('re_key')));
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(run).resolves.toEqual({ checked: 0, updated: 0, failed: 1, configError: false, stoppedEarly: true });
    expect(mockResendGet).toHaveBeenCalledTimes(1);
  });

  it('そのメールだけの失敗（not_found）では、次のメールを読む', async () => {
    mockResendGet
      .mockResolvedValueOnce({ data: null, error: { name: 'not_found', message: 'x', statusCode: 404 }, headers: null })
      .mockResolvedValue({ data: { id: 're_x', last_event: 'delivered' }, error: null, headers: null });
    const { store } = fakeStore(THREE);

    await expect(checkOrderEmailDeliveries(checkDeps(store, createResendLastEventReader('re_key')))).resolves.toEqual({
      checked: 2, updated: 2, failed: 1, configError: false, stoppedEarly: false,
    });
    expect(mockResendGet).toHaveBeenCalledTimes(3);
  });
});

describe('runOrderEmailDeliveryCheckIfDue', () => {
  const RESEND = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM_ADDRESS: 'shop@example.com' };
  const START = { _job: 'order_email_delivery_check', _succeeded: true, _error_code: null };
  const failure = (code: string) => ({ _job: 'order_email_delivery_check', _succeeded: false, _error_code: code });
  const heartbeatsOf = (calls: Call[]) => calls.filter((call) => call.name === 'record_ops_heartbeat').map((call) => call.params);

  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  // process.env を差し替えた試験の後に、元へ戻す
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

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

  it('動き始めに最後の記録を書く（読む前）。読み終えた後は、追加の記録をしない', async () => {
    const { store, calls } = fakeStore(ONE);
    await expect(runOrderEmailDeliveryCheckIfDue(store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: true, status: 'delivered' }),
    })).resolves.toBe('done');

    expect(heartbeatsOf(calls)).toEqual([START]);
    // 読む途中で打ち切られても、次の分にやり直さないよう、記録が一覧を読むより先
    const names = calls.map((call) => call.name);
    expect(names.indexOf('record_ops_heartbeat')).toBeGreaterThan(names.indexOf('get_ops_heartbeats'));
    expect(names.indexOf('record_ops_heartbeat')).toBeLessThan(names.indexOf('list_order_emails_awaiting_delivery'));
  });

  it('始めの記録が書けなければ、読まずに失敗を返す', async () => {
    const { store, calls } = fakeStore(ONE, [], 'record_ops_heartbeat');
    const readLastEvent = jest.fn();

    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: RESEND, now: () => NOW, readLastEvent })).resolves.toBe('failed');

    expect(readLastEvent).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).not.toContain('list_order_emails_awaiting_delivery');
    // 書けない DB に、失敗の記録を重ねない
    expect(heartbeatsOf(calls)).toEqual([START]);
  });

  it('鍵の問題なら、始めの記録の後に、失敗と原因の記号を記録する', async () => {
    const { store, calls } = fakeStore(ONE);

    await expect(runOrderEmailDeliveryCheckIfDue(store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: false, configError: true, retryable: false }),
    })).resolves.toBe('failed');

    expect(heartbeatsOf(calls)).toEqual([START, failure('config_api_key')]);
  });

  it('1件も読めず、失敗だけだった時は、provider_unavailable を記録する', async () => {
    const { store, calls } = fakeStore(ONE);

    await expect(runOrderEmailDeliveryCheckIfDue(store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: false, configError: false, retryable: true }),
    })).resolves.toBe('failed');

    expect(heartbeatsOf(calls)).toEqual([START, failure('provider_unavailable')]);
  });

  it('一部でも読めていれば、失敗があっても追加の記録はしない', async () => {
    jest.useFakeTimers();
    const { store, calls } = fakeStore(THREE.slice(0, 2));
    const readLastEvent: LastEventReader = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: null })
      .mockResolvedValueOnce({ ok: false, configError: false, retryable: false });

    const run = runOrderEmailDeliveryCheckIfDue(store, { env: RESEND, now: () => NOW, readLastEvent });
    // 2件目の前の500ミリ秒の待ちを進める
    await jest.advanceTimersByTimeAsync(500);

    await expect(run).resolves.toBe('done');
    expect(heartbeatsOf(calls)).toEqual([START]);
  });

  it('DB の失敗は、db_unavailable を記録して失敗を返す', async () => {
    const { store, calls } = fakeStore(ONE, [], 'list_order_emails_awaiting_delivery');
    const readLastEvent = jest.fn();

    await expect(runOrderEmailDeliveryCheckIfDue(store, { env: RESEND, now: () => NOW, readLastEvent })).resolves.toBe('failed');

    expect(readLastEvent).not.toHaveBeenCalled();
    expect(heartbeatsOf(calls)).toEqual([START, failure('db_unavailable')]);
  });

  it('結果の件数と印だけを1行のログに出す（メールの番号・宛先は出さない）', async () => {
    const { store } = fakeStore(ONE);
    await runOrderEmailDeliveryCheckIfDue(store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: true, status: 'delivered' }),
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[order-email-delivery] checked', 1, 1, 0, 'complete');

    info.mockClear();
    const stopped = fakeStore(ONE);
    await runOrderEmailDeliveryCheckIfDue(stopped.store, {
      env: RESEND, now: () => NOW, readLastEvent: async () => ({ ok: false, configError: false, retryable: true }),
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[order-email-delivery] checked', 0, 0, 1, 'stopped_early');
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/re_1|email-1/);
  });

  it('本番の DB につないだ next dev では、DB にも Resend にも触れず、最後の成功も記録しない（注文のメールの worker と同じ環境の門）', async () => {
    // 実際の環境変数（VERCEL_ENV など）に左右されず、手元の開発で共有の DB につないだ環境にする
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development', VERCEL_ENV: undefined, SUPABASE_URL: 'https://example.supabase.co' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const readLastEvent = jest.fn();
    const { store, calls } = fakeStore(ONE);

    await expect(runOrderEmailDeliveryCheckIfDue(store, { readLastEvent, now: () => NOW })).resolves.toBe('skipped');

    expect(calls).toEqual([]);
    expect(readLastEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-delivery] skipped', 'development_shared_database');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('Vercel の preview では、Resend の設定があっても DB にも Resend にも触れず、最後の成功も記録しない', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const readLastEvent = jest.fn();
    const { store, calls } = fakeStore(ONE);

    await expect(runOrderEmailDeliveryCheckIfDue(store, {
      env: { ...RESEND, VERCEL_ENV: 'preview' }, readLastEvent, now: () => NOW,
    })).resolves.toBe('skipped');

    expect(calls).toEqual([]);
    expect(readLastEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-delivery] skipped', 'non_production_deployment');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
