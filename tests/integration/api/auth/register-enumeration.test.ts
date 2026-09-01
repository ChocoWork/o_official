export {};

// FREQ-320: 登録済みかどうかを応答で判別できないこと（アカウント列挙対策）
//
// 本番ビルドの E2E では Turnstile が fail-closed で 403 を返すため、
// 応答の同一性はここで検証する（FR-PWRESET-002 と同じ切り分け）。

process.env.ADMIN_API_KEY = 'test-admin-key';

const afterCallbacks: Array<() => unknown> = [];

// 漏洩パスワード検査は外部 API（HaveIBeenPwned）を叩く。テストからネットワークへ出さない。
// 検査そのものの挙動は tests/unit/lib/pwned-password.test.ts が担当する。
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      cookies: { set: jest.fn() },
    }),
  },
  // after() はリクエストコンテキスト外だと投げるので、呼び出しを溜めるだけのスタブにする
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

const sendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({ __esModule: true, default: (...args: unknown[]) => sendMail(...args) }));

const signUp = jest.fn();
const rpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: (...a: unknown[]) => signUp(...a) } }),
  createServiceRoleClient: async () => ({ rpc: (...a: unknown[]) => rpc(...a) }),
}));

function registerRequest(email: string) {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Passw0rd!23456789', turnstileToken: 't' }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/auth/register — アカウント列挙対策', () => {
  let handler: any;

  beforeAll(async () => {
    handler = (await import('@/app/api/auth/register/route')).POST;
  });

  beforeEach(() => {
    afterCallbacks.length = 0;
    sendMail.mockClear();
    signUp.mockReset();
    rpc.mockReset();
  });

  test('登録済み・未登録で HTTP ステータスとレスポンス本文が完全に一致する', async () => {
    // 未登録: RPC は該当なし、signUp は確認メール待ち（セッション無し）を返す
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({ data: { session: null, user: { id: 'new-1' } }, error: null });
    const fresh: any = await handler(registerRequest('new@example.com'));
    const freshBody = await fresh.json();

    // 登録済み: RPC が id を返す
    rpc.mockResolvedValue({ data: 'existing-1', error: null });
    const existing: any = await handler(registerRequest('taken@example.com'));
    const existingBody = await existing.json();

    expect(existing.status).toBe(fresh.status);
    expect(existingBody).toEqual(freshBody);
    // 「既に登録済み」を応答本文に出さない
    expect(JSON.stringify(existingBody)).not.toMatch(/already|登録済み/i);
  });

  test('登録済みのときは signUp を呼ばず、本人にだけメールで知らせる', async () => {
    rpc.mockResolvedValue({ data: 'existing-1', error: null });

    await handler(registerRequest('taken@example.com'));

    expect(signUp).not.toHaveBeenCalled();

    // 送信は after() の中。応答経路には乗せない
    expect(sendMail).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'taken@example.com' });
    // 通知にパスワードそのものを載せない
    expect(JSON.stringify(sendMail.mock.calls[0][0])).not.toContain('Passw0rd!23456789');
  });

  test('SSO / banned などで RPC が取りこぼしても、signUp の重複エラーを 409 にしない', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'User already registered' } });

    const res: any = await handler(registerRequest('banned@example.com'));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
  });

  test('ユーザー照会が失敗したら 503。重複チェックを無言で飛ばさない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res: any = await handler(registerRequest('whoever@example.com'));

    expect(res.status).toBe(503);
    expect(signUp).not.toHaveBeenCalled();
  });
});
