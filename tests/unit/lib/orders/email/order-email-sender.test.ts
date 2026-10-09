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
  sendOrderEmailMessage,
} from '@/lib/orders/email/order-email-sender';

const MESSAGE = { to: 'hanako@example.com', subject: '件名', text: '本文', idempotencyKey: 'order-email/email-1' };
const RESEND_ENV = { NODE_ENV: 'production', MAIL_PROVIDER: 'resend', MAIL_FROM_ADDRESS: 'shop@example.com', RESEND_API_KEY: 're_test_key' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkOrderEmailSendConfig', () => {
  it.each([
    [{ ...RESEND_ENV }, null],
    [{ NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM_ADDRESS: 'shop@example.com' }, null],
    [{ NODE_ENV: 'development', MAIL_FROM_ADDRESS: 'shop@example.com' }, null],
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
    const env = { NODE_ENV: 'production', MAIL_PROVIDER: 'local', MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };

    await expect(sendOrderEmailMessage(MESSAGE, env)).resolves.toEqual({ ok: true, providerMessageId: null });
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
});
