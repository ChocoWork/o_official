jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockClientRpc = jest.fn();
const mockClient = { rpc: (...args: unknown[]) => mockClientRpc(...args), from: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(async () => mockClient) }));
jest.mock('@/lib/orders/email/order-email-sender', () => ({
  ...jest.requireActual('@/lib/orders/email/order-email-sender'),
  checkOrderEmailSendConfig: () => null,
}));

import {
  orderEmailWorkerDisabledReason,
  processOrderEmails,
  runOrderEmailWorker,
  skipReasonFor,
  type OrderEmailWorkerDeps,
} from '@/lib/orders/email/order-email-worker';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { OrderEmailMaterialError, type OrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import type { OrderEmailStore } from '@/lib/orders/email/order-email-store';
import type { OrderEmailSendOutcome } from '@/lib/orders/email/order-email-sender';

type QueueRow = {
  email_id: string; order_id: string; kind: string; variant: string | null; origin: string; attempts: number;
  lease_token: string; subject: string | null; body_text: string | null; payment_expired_sent: boolean;
};

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
    lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, ...overrides,
  };
}

function material(overrides: Partial<OrderEmailMaterial['order']> = {}): OrderEmailMaterial {
  return {
    order: {
      id: 'order-1', status: 'paid', shipping_email: 'hanako@example.com', shipping_full_name: '山田 花子',
      subtotal_amount: 5000, shipping_amount: 0, discount_amount: 0, total_amount: 5000, currency: 'jpy',
      shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-1-1',
      shipping_building: null, shipping_phone: '0311112222', review_reason: null, shipping_carrier: null, tracking_number: null,
      ...overrides,
    },
    items: [{ item_name: 'コート', color: null, size: null, quantity: 1, line_total: 5000, fulfillment_type: 'stock' }],
  };
}

/** DB の関数をまねる。取り出しは queue から1行ずつ返す */
function harness(queue: QueueRow[], options: {
  material?: OrderEmailMaterial | null | Error;
  send?: OrderEmailSendOutcome[];
  saveResult?: boolean;
  completeResult?: boolean;
  failOn?: string;
  config?: OrderEmailWorkerDeps['checkConfig'];
  clock?: number[];
} = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const pending = [...queue];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    calls.push({ name, params });
    if (options.failOn === name) return { data: null, error: { message: 'db down', code: '08006' } };
    switch (name) {
      case 'claim_order_email':
        return { data: pending.length > 0 ? [pending.shift()] : [], error: null };
      case 'save_order_email_content':
        return { data: options.saveResult ?? true, error: null };
      case 'complete_order_email':
        return { data: options.completeResult ?? true, error: null };
      case 'skip_order_email':
        return { data: true, error: null };
      case 'fail_order_email':
        return { data: params?._category === 'permanent' ? 'dead' : 'retry_wait', error: null };
      case 'pause_order_email_sending':
        return { data: true, error: null };
      default:
        return { data: null, error: null };
    }
  });
  const outcomes = [...(options.send ?? [{ ok: true, providerMessageId: 're_1' } as const])];
  const send = jest.fn(async () => outcomes.shift() ?? ({ ok: true, providerMessageId: 're_next' } as const));
  const loadMaterial = jest.fn(async () => {
    const value = options.material === undefined ? material() : options.material;
    if (value instanceof Error) throw value;
    return value;
  });
  const times = [...(options.clock ?? [])];
  const deps: OrderEmailWorkerDeps = {
    store: { rpc } as unknown as OrderEmailStore,
    loadMaterial,
    send,
    checkConfig: options.config ?? (() => null),
    now: () => (times.length > 0 ? (times.shift() as number) : 0),
    budgetMs: 10_000,
  };
  return { deps, calls, send, loadMaterial };
}

const names = (calls: Array<{ name: string }>) => calls.map((call) => call.name);

describe('orderEmailWorkerDisabledReason', () => {
  it.each([
    ['Vercel preview', { NODE_ENV: 'production', VERCEL_ENV: 'preview' }, 'non_production_deployment'],
    ['Vercel development', { NODE_ENV: 'development', VERCEL_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, 'non_production_deployment'],
    ['Vercel production', { NODE_ENV: 'production', VERCEL_ENV: 'production' }, null],
    ['Vercel でない本番ビルド', { NODE_ENV: 'production' }, null],
    ['next dev と本番の DB', { NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co' }, 'development_shared_database'],
    ['next dev と手元の IPv4', { NODE_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, null],
    ['next dev と localhost', { NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, null],
    ['next dev と手元の IPv6', { NODE_ENV: 'development', SUPABASE_URL: 'http://[::1]:54321' }, null],
    ['next dev と住所なし', { NODE_ENV: 'development' }, 'development_shared_database'],
    ['next dev と壊れた住所', { NODE_ENV: 'development', SUPABASE_URL: 'broken-url' }, 'development_shared_database'],
    ['非公開の住所を優先', { NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, 'development_shared_database'],
    ['空の非公開の住所は公開の住所へ', { NODE_ENV: 'development', SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, null],
    ['localhost に似た外部の host', { NODE_ENV: 'development', SUPABASE_URL: 'https://localhost.example.com' }, 'development_shared_database'],
  ] as const)('%s の環境判定', (_name, env, expected) => {
    expect(orderEmailWorkerDisabledReason(env)).toBe(expected);
  });
});

describe('runOrderEmailWorker の環境の守り', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [{ NODE_ENV: 'production', VERCEL_ENV: 'preview' }, 'non_production_deployment'],
    [{ NODE_ENV: 'development', VERCEL_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' }, 'non_production_deployment'],
    [{ NODE_ENV: 'development', SUPABASE_URL: 'https://project.supabase.co' }, 'development_shared_database'],
    [{ NODE_ENV: 'development' }, 'development_shared_database'],
    [{ NODE_ENV: 'development', SUPABASE_URL: 'broken-url' }, 'development_shared_database'],
  ] as const)('%o では DB に触れず disabled を返す', async (env, reason) => {
    jest.replaceProperty(process, 'env', env);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runOrderEmailWorker()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' });

    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[order-email-worker] skipped', reason);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('runOrderEmailWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordHeartbeat.mockReset().mockResolvedValue(undefined);
    mockClientRpc.mockReset();
    // 実際の環境変数（VERCEL_ENV など）に左右されず、環境の門を通る環境で試す
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('送るものが無くても、最後の成功を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: [], error: null });

    await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'empty' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', true, null);
  });

  it('取り出しに失敗したら、失敗と原因の記号を記録する', async () => {
    mockClientRpc.mockResolvedValue({ data: null, error: { message: 'down', code: '08006' } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(runOrderEmailWorker()).resolves.toMatchObject({ stoppedBy: 'claim_error' });
      expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockClient, 'order_email_worker', false, 'db_unavailable');
      expect(error).toHaveBeenCalledWith('[order-email-worker] claim failed', 'OrderEmailStoreError', '08006');
    } finally {
      error.mockRestore();
    }
  });

  it('止める環境では DB に触れず、最後の成功も記録しない（本番の記録を、開発や preview が上書きしない）', async () => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'production', VERCEL_ENV: 'preview' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(runOrderEmailWorker()).resolves.toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(mockRecordHeartbeat).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[order-email-worker] skipped', 'non_production_deployment');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('processOrderEmails', () => {
  afterEach(() => jest.restoreAllMocks());

  it('中身を作って送る前に控え、行の番号の重複防止キーで送り、送信済みにする', async () => {
    const h = harness([row()]);

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'empty' });
    expect(names(h.calls)).toEqual(['claim_order_email', 'save_order_email_content', 'complete_order_email', 'claim_order_email']);
    const saved = h.calls[1].params as { _subject: string; _body_text: string };
    expect(saved._subject).toBe('【Le Fil des Heures】ご注文ありがとうございます（ORD-ORDER-1）');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: saved._subject, text: saved._body_text, idempotencyKey: 'order-email/email-1',
    });
    expect(h.calls[2].params).toEqual({ _email_id: 'email-1', _lease_token: 'lease-1', _provider_message_id: 're_1' });
  });

  it('控えがあれば作り直さず、控えた中身を同じ鍵で送る（送れた直後に落ちた後のやり直し）', async () => {
    const h = harness([row({ attempts: 2, subject: '控えた件名', body_text: '控えた本文' })]);

    await processOrderEmails(h.deps);

    expect(names(h.calls)).not.toContain('save_order_email_content');
    expect(h.send).toHaveBeenCalledWith({
      to: 'hanako@example.com', subject: '控えた件名', text: '控えた本文', idempotencyKey: 'order-email/email-1',
    });
  });

  it('入金待ちは、注文がもう入金待ちでなければ取りやめにし、送らない', async () => {
    const h = harness([row({ kind: 'awaiting_payment', variant: null })], { material: material({ status: 'paid' }) });

    const result = await processOrderEmails(h.deps);

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _reason: 'superseded',
    });
  });

  it('宛先が無ければ取りやめにする', async () => {
    const h = harness([row()], { material: material({ shipping_email: '  ' }) });

    await processOrderEmails(h.deps);

    expect(h.calls.find((call) => call.name === 'skip_order_email')?.params).toMatchObject({ _reason: 'no_recipient' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('注文や明細が無い・発送の伝票番号が無いときは、すぐ送れなかったにする', async () => {
    const missing = harness([row()], { material: null });
    await processOrderEmails(missing.deps);
    expect(missing.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });

    const shipped = harness([row({ kind: 'shipped', variant: null })], { material: material({ status: 'shipped' }) });
    await processOrderEmails(shipped.deps);
    expect(shipped.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'source_missing', _category: 'permanent',
    });
    expect(shipped.send).not.toHaveBeenCalled();
  });

  it('材料を読めないときと、中身を控えられないときは、送らずにやり直す', async () => {
    const unreadable = harness([row()], { material: new OrderEmailMaterialError('orders') });
    await processOrderEmails(unreadable.deps);
    expect(unreadable.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });

    const unsaved = harness([row()], { failOn: 'save_order_email_content' });
    await processOrderEmails(unsaved.deps);
    expect(unsaved.send).not.toHaveBeenCalled();
    expect(unsaved.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({
      _error_code: 'db_unavailable', _category: 'transient',
    });
  });

  it('担当を失っていて控えられなければ、送らず何も書かない', async () => {
    const h = harness([row()], { saveResult: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await processOrderEmails(h.deps);

    expect(h.send).not.toHaveBeenCalled();
    expect(names(h.calls)).not.toContain('fail_order_email');
    expect(result.failed).toBe(1);
    expect(warn).toHaveBeenCalledWith('[order-email-worker] lease lost', 'email-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('一時的な失敗は待つ時間の指示を渡してやり直し、次の行へ進む', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [
        { ok: false, failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 2 } },
        { ok: true, providerMessageId: 're_2' },
      ],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, stoppedBy: 'empty' });
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toEqual({
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'rate_limited', _category: 'transient', _retry_after_seconds: 2,
    });
  });

  it('設定の問題では止めて、残りを取り出さない', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      send: [{ ok: false, failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null } }],
    });

    const result = await processOrderEmails(h.deps);

    expect(result.stoppedBy).toBe('paused');
    expect(names(h.calls).filter((name) => name === 'claim_order_email')).toHaveLength(1);
    expect(h.calls.find((call) => call.name === 'fail_order_email')?.params).toMatchObject({ _category: 'config', _error_code: 'config_api_key' });
  });

  it('送る前に設定が足りなければ、止めて取り出さない', async () => {
    const h = harness([row()], { config: () => 'config_provider' });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0, stoppedBy: 'paused' });
    expect(names(h.calls)).toEqual(['pause_order_email_sending']);
    expect(h.calls[0].params).toEqual({ _reason: 'config_provider' });
  });

  it('取り出しに失敗したら止める', async () => {
    const h = harness([row()], { failOn: 'claim_order_email' });
    // 想定した失敗のログを検証し、試験の出力には流さない。
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ stoppedBy: 'claim_error' });
    expect(error).toHaveBeenCalledWith('[order-email-worker] claim failed', 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('時間の予算を使い切ったら止める', async () => {
    const h = harness([row(), row({ email_id: 'email-2', order_id: 'order-2', lease_token: 'lease-2' })], {
      clock: [0, 0, 10_001],
    });

    const result = await processOrderEmails(h.deps);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0, stoppedBy: 'budget' });
  });

  it('送信済みの記録に失敗しても止めない（担当の期限の後に、同じ鍵で送り直す）', async () => {
    const h = harness([row()], { failOn: 'complete_order_email' });
    // 送信後の DB 失敗でも、宛先や本文をログに残していないことを確かめる。
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });
    expect(error).toHaveBeenCalledWith('[order-email-worker] failed to record sent', 'email-1', 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('送信済みの記録で担当を失ったときは、行の ID だけを警告する', async () => {
    const h = harness([row()], { completeResult: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(processOrderEmails(h.deps)).resolves.toMatchObject({ sent: 1, stoppedBy: 'empty' });

    expect(warn).toHaveBeenCalledWith('[order-email-worker] lease lost', 'email-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fail_order_email', { send: [{ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } }] }, ['email-1', 'network_error']],
    ['skip_order_email', { material: material({ shipping_email: null }) }, ['email-1', 'no_recipient']],
    ['pause_order_email_sending', { config: () => 'config_provider' }, ['config_provider']],
  ] satisfies Array<[string, Parameters<typeof harness>[1], string[]]>)('%s の DB 失敗は原因と SQLSTATE だけを記録する', async (failOn, options, context) => {
    const h = harness([row()], { ...options, failOn });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await processOrderEmails(h.deps);

    const messages: Record<string, string> = {
      fail_order_email: '[order-email-worker] failed to record failure',
      skip_order_email: '[order-email-worker] failed to record skip',
      pause_order_email_sending: '[order-email-worker] failed to pause sending',
    };
    expect(error).toHaveBeenCalledWith(messages[failOn], ...context, 'OrderEmailStoreError', '08006');
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('skipReasonFor（設計書 4-1）', () => {
  const claim = (kind: string) => ({ kind } as never);

  it.each([
    ['awaiting_payment', 'pending', null],
    ['awaiting_payment', 'paid', 'superseded'],
    ['awaiting_payment', 'failed', 'superseded'],
    ['payment_expired', 'failed', null],
    ['payment_expired', 'cancelled', null],
    ['payment_expired', 'paid', 'superseded'],
    ['payment_expired', 'shipped', 'superseded'],
    ['paid', 'shipped', null],
    ['canceled', 'cancelled', null],
    ['shipped', 'shipped', null],
  ])('%s のメールは、注文が %s なら %s', (kind, status, expected) => {
    expect(skipReasonFor(claim(kind), material({ status: status as never }))).toBe(expected);
  });
});
