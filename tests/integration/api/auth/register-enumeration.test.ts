export {};
jest.mock('server-only', () => ({}), { virtual: true });

// ARC-AUTH-006: 会員登録とパスワードの再設定は、アカウントの有無で応答を変えない（アカウント列挙対策）。
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

const logAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => logAudit(...args) }));

const sendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({ __esModule: true, default: (...args: unknown[]) => sendMail(...args) }));

// Confirm email が OFF の設定の確かめだけが使う。保存の中身は services/register のテストが担当する。
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: jest.fn().mockResolvedValue({ ok: true }),
}));

const signUp = jest.fn();
const rpc = jest.fn();
const from = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: (...a: unknown[]) => signUp(...a) } }),
  createServiceRoleClient: async () => ({ rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) }),
}));

function registerRequest(email: string) {
  return new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Passw0rd!23456789', turnstileToken: 't' }),
    headers: { 'content-type': 'application/json' },
  });
}

function resetRequest(email: string) {
  return new Request('http://localhost:3000/api/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email, turnstileToken: 't' }),
    headers: { 'content-type': 'application/json' },
  });
}

describe('ARC-AUTH-006 会員登録は登録済みかどうかで応答を変えない', () => {
  let handler: any;
  const errorSpy = jest.spyOn(console, 'error');

  beforeAll(async () => {
    handler = (await import('@/app/api/auth/register/route')).POST;
  });

  beforeEach(() => {
    afterCallbacks.length = 0;
    sendMail.mockClear();
    logAudit.mockClear();
    signUp.mockReset();
    rpc.mockReset();
    errorSpy.mockImplementation(() => undefined);
  });

  afterAll(() => errorSpy.mockRestore());

  test('ARC-AUTH-006 登録済み・未登録で HTTP ステータスとレスポンス本文が完全に一致する', async () => {
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

  test('ARC-AUTH-006 登録済みのときは signUp を呼ばず、本人にだけメールで知らせる', async () => {
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

  test('ARC-AUTH-006 SSO / banned などで RPC が取りこぼしても、signUp の重複エラーを 409 にしない', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'User already registered' } });

    const res: any = await handler(registerRequest('banned@example.com'));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
  });

  test('ARC-AUTH-006 ユーザー照会が失敗したら 503。重複チェックを無言で飛ばさない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res: any = await handler(registerRequest('whoever@example.com'));

    expect(res.status).toBe(503);
    expect(signUp).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-006 登録済みの通知のメールにはログインの導線だけを載せ、監査に conflict を残す', async () => {
    rpc.mockResolvedValue({ data: 'existing-1', error: null });

    const res: any = await handler(registerRequest('taken@example.com'));

    expect(res.status).toBe(202);
    await afterCallbacks[0]();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).toContain('http://localhost:3000/login');
    expect(mail.text).toContain('http://localhost:3000/login');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'conflict', detail: 'already_registered_notified' }),
    );
  });

  test('ARC-AUTH-006 通知のメールが送れなくても応答は同じ 202 で、例外を外へ出さない', async () => {
    rpc.mockResolvedValue({ data: 'existing-1', error: null });
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res: any = await handler(registerRequest('taken@example.com'));
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();

    expect(res.status).toBe(202);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('ARC-AUTH-006 signUp の重複エラーでも本人へ通知のメールを送る', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'duplicate key value' } });

    await handler(registerRequest('sso@example.com'));

    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'sso@example.com' });
  });

  test('ARC-AUTH-006 新規には通知のメールを送らない', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({ data: { session: null, user: { id: 'new-1' } }, error: null });

    await handler(registerRequest('new@example.com'));

    expect(afterCallbacks).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-006 Confirm email が OFF の設定だと新規は 201 で登録済みは 202 になり、応答で判別できる（ON が前提）', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    signUp.mockResolvedValue({
      data: { session: { access_token: 'a', refresh_token: 'r' }, user: { id: 'new-1', email: 'new@example.com' } },
      error: null,
    });
    const fresh: any = await handler(registerRequest('new@example.com'));

    rpc.mockResolvedValue({ data: 'existing-1', error: null });
    const existing: any = await handler(registerRequest('taken@example.com'));

    expect(fresh.status).toBe(201);
    expect(existing.status).toBe(202);
  });
});

describe('ARC-AUTH-006 パスワードの再設定の申請はアカウントの有無で応答を変えない', () => {
  let handler: any;
  const insert = jest.fn();
  const errorSpy = jest.spyOn(console, 'error');

  beforeAll(async () => {
    handler = (await import('@/app/api/auth/password-reset/request/route')).POST;
  });

  beforeEach(() => {
    afterCallbacks.length = 0;
    sendMail.mockClear();
    logAudit.mockClear();
    rpc.mockReset();
    from.mockReset();
    errorSpy.mockImplementation(() => undefined);
    insert.mockReset().mockResolvedValue({ error: null });
    // update().eq().eq() を await しても落ちない、同じ形の連鎖
    const chain: { update: jest.Mock; eq: jest.Mock; insert: jest.Mock } = {
      update: jest.fn(),
      eq: jest.fn(),
      insert,
    };
    chain.update.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    from.mockReturnValue(chain);
  });

  afterAll(() => errorSpy.mockRestore());

  test('ARC-AUTH-006 アカウントが有る時と無い時で、HTTP ステータスと本文が一致する', async () => {
    rpc.mockResolvedValue({ data: 'existing-1', error: null });
    const existing: any = await handler(resetRequest('taken@example.com'));
    const existingBody = await existing.json();

    rpc.mockResolvedValue({ data: null, error: null });
    const missing: any = await handler(resetRequest('nobody@example.com'));
    const missingBody = await missing.json();

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(existing.status);
    expect(missingBody).toEqual(existingBody);
    expect(missingBody).toEqual({ ok: true });
  });

  test('ARC-AUTH-006 アカウントが無ければ印もメールも作らない（店のドメインを踏み台にさせない）', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await handler(resetRequest('nobody@example.com'));

    expect(from).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset_request', outcome: 'success', detail: 'no_account' }),
    );
  });

  test('ARC-AUTH-006 アカウントが有れば印を保存し、メールは応答の外で送る', async () => {
    rpc.mockResolvedValue({ data: 'existing-1', error: null });

    await handler(resetRequest('taken@example.com'));

    expect(from).toHaveBeenCalledWith('password_reset_tokens');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0][0]).toMatchObject({ user_id: 'existing-1', email: 'taken@example.com', used: false });
    expect(sendMail).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: 'taken@example.com' });
  });

  test('ARC-AUTH-006 照会が失敗したら「アカウント無し」の 200 に丸めず 500 を返す', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res: any = await handler(resetRequest('whoever@example.com'));

    expect(res.status).toBe(500);
    expect(from).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset_request', outcome: 'error', detail: 'user_lookup_failed' }),
    );
  });
});
