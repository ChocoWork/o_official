const mockResendSend = jest.fn();
const mockResendConstructor = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation((key: string) => {
    mockResendConstructor(key);
    return { emails: { send: (...args: unknown[]) => mockResendSend(...args) } };
  }),
}));

const mockLocalSend = jest.fn();
jest.mock('@/lib/mail/adapters/local', () => ({
  sendMail: (...args: unknown[]) => mockLocalSend(...args),
}));

import {
  checkOrderEmailSendConfig,
  classifyResendError,
  parseRetryAfter,
  ORDER_EMAIL_SEND_TIMEOUT_MS,
  sendOrderEmailMessage,
} from '@/lib/orders/email/order-email-sender';

const MESSAGE = { to: 'hanako@example.com', subject: '件名', text: '本文', idempotencyKey: 'order-email/email-1' };
const RESEND_ENV = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', MAIL_FROM_ADDRESS: 'shop@example.com', RESEND_API_KEY: 're_test_key' };
const LOCAL_ENV = { NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM_ADDRESS: 'no-reply@e2e.test', SUPABASE_URL: 'http://127.0.0.1:54321' };

beforeEach(() => {
  jest.clearAllMocks();
  mockResendSend.mockReset();
  mockLocalSend.mockReset();
});

afterEach(() => jest.useRealTimers());

describe('checkOrderEmailSendConfig', () => {
  it.each([
    [{ ...RESEND_ENV }, null],
    [LOCAL_ENV, null],
    [{ NODE_ENV: 'development', MAIL_FROM_ADDRESS: 'shop@example.com', SUPABASE_URL: 'http://127.0.0.1:54321' }, null],
    [{ ...LOCAL_ENV, SUPABASE_URL: 'https://project.supabase.co' }, 'config_provider'],
    [{ ...LOCAL_ENV, SUPABASE_URL: undefined }, 'config_provider'],
    [{ ...LOCAL_ENV, SUPABASE_URL: 'broken-url' }, 'config_provider'],
    [{ ...LOCAL_ENV, SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, null],
    [{ ...LOCAL_ENV, SUPABASE_URL: 'http://[::1]:54321' }, null],
    [{ ...LOCAL_ENV, SUPABASE_URL: 'https://project.supabase.co', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }, 'config_provider'],
    [{ ...LOCAL_ENV, SUPABASE_URL: 'http://localhost:54321', NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' }, null],
    [{ NODE_ENV: 'production', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'ses', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'smtp', MAIL_FROM_ADDRESS: 'shop@example.com' }, 'config_provider'],
    [{ ...RESEND_ENV, MAIL_FROM_ADDRESS: '' }, 'config_provider'],
    [{ ...RESEND_ENV, RESEND_API_KEY: '' }, 'config_api_key'],
  ] as const)('%o は %s', (env, expected) => {
    expect(checkOrderEmailSendConfig(env)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  it('秒数を読み、大文字小文字を問わず、1日で打ち切る。読めなければ null', () => {
    expect(parseRetryAfter({ 'retry-after': '30' })).toBe(30);
    expect(parseRetryAfter({ 'Retry-After': '5' })).toBe(5);
    expect(parseRetryAfter({ 'retry-after': '999999' })).toBe(86_400);
    expect(parseRetryAfter({ 'retry-after': 'soon' })).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('classifyResendError（設計書 4-4）', () => {
  it.each([
    [{ name: 'rate_limit_exceeded', statusCode: 429 }, { category: 'transient', code: 'rate_limited', retryAfterSeconds: 2 }],
    [{ name: 'application_error', statusCode: 500 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'internal_server_error', statusCode: 500 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'application_error', statusCode: null }, { category: 'transient', code: 'network_error', retryAfterSeconds: null }],
    [{ name: 'concurrent_idempotent_requests', statusCode: 409 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'some_new_error', statusCode: 503 }, { category: 'transient', code: 'provider_unavailable', retryAfterSeconds: 2 }],
    [{ name: 'some_new_error', statusCode: 418 }, { category: 'transient', code: 'unexpected_error', retryAfterSeconds: 2 }],
    [{ name: 'missing_api_key', statusCode: 401 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'restricted_api_key', statusCode: 401 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'invalid_api_key', statusCode: 403 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'suspended_api_key', statusCode: 403 }, { category: 'config', code: 'config_api_key', retryAfterSeconds: null }],
    [{ name: 'validation_error', statusCode: 403 }, { category: 'config', code: 'config_sender_domain', retryAfterSeconds: null }],
    [{ name: 'invalid_from_address', statusCode: 422 }, { category: 'config', code: 'config_sender_domain', retryAfterSeconds: null }],
    [{ name: 'daily_quota_exceeded', statusCode: 429 }, { category: 'config', code: 'quota_daily', retryAfterSeconds: null }],
    [{ name: 'monthly_quota_exceeded', statusCode: 429 }, { category: 'config', code: 'quota_monthly', retryAfterSeconds: null }],
    [{ name: 'validation_error', statusCode: 400 }, { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null }],
    [{ name: 'missing_required_field', statusCode: 422 }, { category: 'permanent', code: 'invalid_message', retryAfterSeconds: null }],
    [{ name: 'invalid_idempotent_request', statusCode: 409 }, { category: 'permanent', code: 'idempotency_conflict', retryAfterSeconds: null }],
  ])('%o を %o に分ける', (error, expected) => {
    expect(classifyResendError(error, { 'retry-after': '2' })).toEqual(expected);
  });
});

describe('sendOrderEmailMessage', () => {
  it('Resend へ重複防止キーを付けて送り、メールの番号を返す', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 're_123' }, error: null, headers: {} });

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({ ok: true, providerMessageId: 're_123' });

    expect(mockResendConstructor).toHaveBeenCalledWith('re_test_key');
    expect(mockResendSend).toHaveBeenCalledWith(
      { from: 'shop@example.com', to: 'hanako@example.com', subject: '件名', text: '本文' },
      { idempotencyKey: 'order-email/email-1' },
    );
  });

  it('Resend の断りを分けて返す（待つ時間の指示を読む）', async () => {
    mockResendSend.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' },
      headers: { 'retry-after': '3' },
    });

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({
      ok: false,
      failure: { category: 'transient', code: 'rate_limited', retryAfterSeconds: 3 },
    });
  });

  it('送る途中で投げられたら通信の失敗としてやり直す', async () => {
    mockResendSend.mockRejectedValue(new Error('socket hang up'));

    await expect(sendOrderEmailMessage(MESSAGE, RESEND_ENV)).resolves.toEqual({
      ok: false,
      failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null },
    });
  });

  it('手元のメール受けは Mailpit へ送る（メールの番号は持たない）', async () => {
    mockLocalSend.mockResolvedValue({ ID: 'mailpit-1' });
    await expect(sendOrderEmailMessage(MESSAGE, LOCAL_ENV)).resolves.toEqual({ ok: true, providerMessageId: null });
    expect(mockLocalSend).toHaveBeenCalledWith({ to: 'hanako@example.com', subject: '件名', text: '本文', from: 'no-reply@e2e.test' });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('SES と設定が無いときは送らずに設定の問題を返す', async () => {
    await expect(sendOrderEmailMessage(MESSAGE, { NODE_ENV: 'production', MAIL_FROM_ADDRESS: 'shop@example.com' })).resolves.toEqual({
      ok: false,
      failure: { category: 'config', code: 'config_provider', retryAfterSeconds: null },
    });
    await expect(sendOrderEmailMessage(MESSAGE, { ...RESEND_ENV, RESEND_API_KEY: '' })).resolves.toEqual({
      ok: false,
      failure: { category: 'config', code: 'config_api_key', retryAfterSeconds: null },
    });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(mockLocalSend).not.toHaveBeenCalled();
  });

  it('local と共有の DB の組み合わせは送信前に設定の問題を返す', async () => {
    await expect(sendOrderEmailMessage(MESSAGE, { ...LOCAL_ENV, SUPABASE_URL: 'https://project.supabase.co' })).resolves.toEqual({
      ok: false, failure: { category: 'config', code: 'config_provider', retryAfterSeconds: null },
    });
    expect(mockLocalSend).not.toHaveBeenCalled();
    expect(mockResendSend).not.toHaveBeenCalled();
  });
});

describe('sendOrderEmailMessage の時間上限', () => {
  beforeEach(() => jest.useFakeTimers());

  it.each([
    ['Resend', RESEND_ENV, mockResendSend],
    ['手元のメール受け', LOCAL_ENV, mockLocalSend],
  ] as const)('%s の返事がなければ8秒で通信の一時的な失敗になる', async (_name, env, send) => {
    send.mockReturnValue(new Promise(() => {}));
    const result = jest.fn();
    void sendOrderEmailMessage(MESSAGE, env).then(result);

    await jest.advanceTimersByTimeAsync(7_999);
    expect(result).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(result).toHaveBeenCalledWith({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } });
    expect(result).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('8秒より前に Resend の返事が来れば送信結果を返し、タイマーを止める', async () => {
    mockResendSend.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ data: { id: 're_fast' }, error: null, headers: {} }), 7_999);
    }));
    const result = sendOrderEmailMessage(MESSAGE, RESEND_ENV);

    await jest.advanceTimersByTimeAsync(7_999);

    await expect(result).resolves.toEqual({ ok: true, providerMessageId: 're_fast' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['Resend', RESEND_ENV, mockResendSend],
    ['手元のメール受け', LOCAL_ENV, mockLocalSend],
  ] as const)('%s が打ち切り後に失敗しても未処理の Promise の失敗にならない', async (_name, env, send) => {
    let rejectSend!: (reason: Error) => void;
    send.mockReturnValue(new Promise((_resolve, reject) => { rejectSend = reject; }));
    const result = jest.fn();
    void sendOrderEmailMessage(MESSAGE, env).then(result);

    await jest.advanceTimersByTimeAsync(ORDER_EMAIL_SEND_TIMEOUT_MS);
    expect(result).toHaveBeenCalledWith({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } });
    rejectSend(new Error('late network error'));
    await jest.advanceTimersByTimeAsync(0);

    expect(result).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('打ち切り後に Resend が受け付けても、返した一時的な失敗を変えない', async () => {
    let resolveSend!: (response: { data: { id: string }; error: null; headers: object }) => void;
    mockResendSend.mockReturnValue(new Promise((resolve) => { resolveSend = resolve; }));
    const result = jest.fn();
    void sendOrderEmailMessage(MESSAGE, RESEND_ENV).then(result);

    await jest.advanceTimersByTimeAsync(ORDER_EMAIL_SEND_TIMEOUT_MS);
    expect(result).toHaveBeenCalledWith({ ok: false, failure: { category: 'transient', code: 'network_error', retryAfterSeconds: null } });
    resolveSend({ data: { id: 're_late' }, error: null, headers: {} });
    await jest.advanceTimersByTimeAsync(0);

    expect(result).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
