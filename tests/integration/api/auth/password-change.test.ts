/** @jest-environment node */
export {};

// パスワード変更の開始と確定の窓口（API-AUTH-020・021）。
// 窓口・コードの作成とハッシュ・メールの文面・入力の形は本物を通し、外へ出る物だけを差し替える:
// 認証の確かめ、CSRF、回数の制限、監査、メールの送信、漏洩確認、全 session の失効、GoTrue（現行パスワードの確かめと更新）、
// DB の関数（issue/consume は移行 M3 の動きを JS で写した物。SQL そのものは DB 結合テストが確かめる）。
// 開始で作ったコードと確定で作るハッシュが本物の部品で一致するか、別の session のコードが使えないか、
// 5 回の誤りで使えなくなるか、弱いパスワードがコードを焼かないかを、2 つの窓口をつないで確かめる。

const cookieLog: Array<{ name: string; value: string; maxAge?: number }> = [];
const afterCallbacks: Array<() => Promise<void> | void> = [];

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: {
        set: (c: { name: string; value: string; maxAge?: number }) => {
          cookieLog.push(c);
        },
      },
    }),
  },
  after: (cb: () => Promise<void> | void) => {
    afterCallbacks.push(cb);
  },
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockLogAudit(...args),
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn(async () => undefined) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn(async () => undefined) }));

const mockAuthenticateRequest = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  authFailureResponse: (reason: string) => {
    const { NextResponse } = jest.requireMock('next/server');
    return NextResponse.json({ error: reason === 'unavailable' ? 'Service temporarily unavailable' : 'Unauthorized' }, {
      status: reason === 'unavailable' ? 503 : 401,
    });
  },
}));

const mockSendMail = jest.fn();
jest.mock('@/lib/mail', () => ({ __esModule: true, default: (...args: unknown[]) => mockSendMail(...args) }));

const mockCheckPwned = jest.fn();
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: (...args: unknown[]) => mockCheckPwned(...args),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは漏洩が確認されています。',
}));

const mockRevokeAll = jest.fn();
jest.mock('@/lib/auth/revoke-user-sessions', () => ({
  revokeAllSessionsForUser: (...args: unknown[]) => mockRevokeAll(...args),
}));

// --- DB の関数の写し（移行 M3 の動き）---
type Row = {
  id: string;
  userId: string;
  sessionId: string;
  hash: string;
  attempts: number;
  expiresAt: number;
  used: boolean;
};
let rows: Row[] = [];
let nextId = 1;

function fakeIssue(args: { p_user_id: string; p_auth_session_id: string; p_code_hash: string; p_ttl_seconds: number }) {
  for (const row of rows) if (row.userId === args.p_user_id && !row.used) row.used = true;
  const row: Row = {
    id: `challenge-${nextId++}`,
    userId: args.p_user_id,
    sessionId: args.p_auth_session_id,
    hash: args.p_code_hash,
    attempts: 0,
    expiresAt: Date.now() + args.p_ttl_seconds * 1000,
    used: false,
  };
  rows.push(row);
  return row.id;
}

function fakeConsume(args: { p_user_id: string; p_auth_session_id: string; p_code_hash: string }) {
  const open = rows
    .filter((r) => r.userId === args.p_user_id && r.sessionId === args.p_auth_session_id && !r.used && r.expiresAt > Date.now())
    .pop();
  if (!open) return 'none';
  if (open.attempts >= 5) return 'locked';
  if (open.hash === args.p_code_hash) {
    open.used = true;
    return 'ok';
  }
  open.attempts += 1;
  return 'invalid';
}

const mockUpdateUserById = jest.fn();
let mailShouldFail = false;
const serviceClient = {
  rpc: async (name: string, args: Record<string, never>) => {
    if (name === 'issue_password_change_challenge') return { data: fakeIssue(args as never), error: null };
    if (name === 'consume_password_change_challenge') return { data: fakeConsume(args as never), error: null };
    if (name === 'revoke_auth_session') return { data: null, error: null };
    throw new Error(`unexpected rpc ${name}`);
  },
  from: (table: string) => {
    if (table !== 'password_change_challenges') throw new Error(`unexpected table ${table}`);
    return {
      update: () => ({
        eq: (_col: string, id: string) => ({
          is: async () => {
            const row = rows.find((r) => r.id === id);
            if (row && !row.used) row.used = true;
            return { error: null };
          },
        }),
      }),
    };
  },
  auth: { admin: { updateUserById: (...args: unknown[]) => mockUpdateUserById(...args) } },
};
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => serviceClient }));

const CURRENT_PASSWORD = 'current-password-Aaaa-1111';
const NEW_PASSWORD = 'brand-new-password-Bbbb-2222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_A = '22222222-2222-4222-8222-222222222222';
const SESSION_B = '33333333-3333-4333-8333-333333333333';

function fakeAccessToken(sessionId: string) {
  return `h.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.s`;
}

const mockSignInWithPassword = jest.fn();
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: async () => ({ auth: { signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args) } }),
}));

function signInAs(sessionId: string) {
  mockAuthenticateRequest.mockResolvedValue({
    ok: true,
    claims: {
      sub: USER_ID,
      email: 'member@example.com',
      aal: 'aal1',
      session_id: sessionId,
      app_metadata: { role: 'user' },
    },
  });
}

function postJson(path: string, payload: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function start(currentPassword = CURRENT_PASSWORD): Promise<{ status: number; body: any }> {
  const route = await import('@/app/api/auth/password/change/start/route');
  const res = await route.POST(postJson('/api/auth/password/change/start', { current_password: currentPassword }));
  return { status: res.status, body: await res.json() };
}

async function confirm(code: string, newPassword = NEW_PASSWORD): Promise<{ status: number; body: any }> {
  const route = await import('@/app/api/auth/password/change/confirm/route');
  const res = await route.POST(postJson('/api/auth/password/change/confirm', { code, new_password: newPassword }));
  return { status: res.status, body: await res.json() };
}

/** 直近のコードのメールから 8 桁のコードを取り出す。 */
function lastMailedCode(): string {
  const calls = mockSendMail.mock.calls.filter((c) => (c[0] as { subject: string }).subject === 'パスワード変更の確認コード');
  const payload = calls[calls.length - 1][0] as { text: string };
  const match = /\d{8}/.exec(payload.text);
  if (!match) throw new Error('code not found in mail');
  return match[0];
}

function wrongCode(code: string) {
  return code === '00000000' ? '11111111' : '00000000';
}

beforeEach(() => {
  rows = [];
  nextId = 1;
  cookieLog.length = 0;
  afterCallbacks.length = 0;
  mailShouldFail = false;
  process.env.JWT_SECRET = 'integration-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  mockLogAudit.mockReset();
  mockSendMail.mockReset();
  mockSendMail.mockImplementation(async () => {
    if (mailShouldFail) throw new Error('smtp down');
  });
  mockCheckPwned.mockReset();
  mockCheckPwned.mockResolvedValue({ status: 'ok' });
  mockRevokeAll.mockReset();
  mockRevokeAll.mockResolvedValue({ authSessionsDeleted: 1 });
  mockUpdateUserById.mockReset();
  mockUpdateUserById.mockResolvedValue({ data: {}, error: null });
  mockSignInWithPassword.mockReset();
  mockSignInWithPassword.mockImplementation(async (credentials: { password: string }) =>
    credentials.password === CURRENT_PASSWORD
      ? { data: { session: { access_token: fakeAccessToken(SESSION_B) }, user: { id: USER_ID } }, error: null }
      : { data: { session: null, user: null }, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } },
  );
  signInAs(SESSION_A);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('API-AUTH-020 POST /api/auth/password/change/start', () => {
  test('API-AUTH-020 現行パスワードが合えば、本人のメールへ 8 桁のコードが届き、DB にはハッシュだけが残る', async () => {
    const res = await start();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const code = lastMailedCode();
    expect(code).toMatch(/^\d{8}$/);
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'member@example.com' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code);
    // 確かめに作られた GoTrue の session を消す呼び出しは、確定とは別の経路（revoke_auth_session）で行う
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-020 現行パスワードが違えば 401 で、メールは届かず、コードも作られない', async () => {
    const res = await start('wrong-current-password-0000');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: '現行のパスワードが正しくありません。' });
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('API-AUTH-020 未ログインは 401 で、現行パスワードを試さない', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: false, reason: 'missing' });

    const res = await start();

    expect(res.status).toBe(401);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('API-AUTH-020 メールが送れなければ 500 で、発行したコードは使えなくなる', async () => {
    mailShouldFail = true;

    const res = await start();

    expect(res.status).toBe(500);
    expect(rows).toHaveLength(1);
    expect(rows[0].used).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'mail_failed' }));
  });

  test('API-AUTH-020 もう一度送ると前のコードは使えなくなる', async () => {
    await start();
    const first = lastMailedCode();
    await start();
    const second = lastMailedCode();

    const staleResult = await confirm(first);
    const freshResult = second === first ? { status: 200 } : await confirm(second);

    // 前のコードと新しいコードが偶然同じ値のときは、同じ値が有効なので確かめを飛ばす
    if (second !== first) {
      expect(staleResult.status).toBe(401);
    }
    expect(freshResult.status).toBe(200);
  });
});

describe('API-AUTH-021 POST /api/auth/password/change/confirm', () => {
  test('API-AUTH-021 開始で届いたコードと新しいパスワードで変わり、全 session を失効して認証 Cookie を消し、通知する', async () => {
    await start();
    const code = lastMailedCode();

    const res = await confirm(code);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateUserById).toHaveBeenCalledWith(USER_ID, { password: NEW_PASSWORD });
    expect(mockRevokeAll).toHaveBeenCalledWith(USER_ID);
    expect(cookieLog.filter((c) => c.value === '' && c.maxAge === 0).map((c) => c.name).sort()).toEqual([
      'sb-access-token',
      'sb-csrf-token',
      'sb-refresh-token',
    ]);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockSendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: 'member@example.com', subject: 'パスワードを変更しました' }),
    );
  });

  test('API-AUTH-021 使い終わったコードは 2 回目に使えない', async () => {
    await start();
    const code = lastMailedCode();
    expect((await confirm(code)).status).toBe(200);
    mockUpdateUserById.mockClear();

    const second = await confirm(code);

    expect(second.status).toBe(401);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  test('API-AUTH-021 別の session から送ったコードは使えない（コードは要求した session に結ぶ）', async () => {
    await start();
    const code = lastMailedCode();
    signInAs(SESSION_B);

    const res = await confirm(code);

    expect(res.status).toBe(401);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockRevokeAll).not.toHaveBeenCalled();
  });

  test('API-AUTH-021 誤りは同じ文で答え、5 回間違えると正しいコードでも使えなくなる', async () => {
    await start();
    const code = lastMailedCode();
    const bad = wrongCode(code);

    const bodies: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await confirm(bad);
      expect(res.status).toBe(401);
      bodies.push(res.body);
    }
    const locked = await confirm(code);

    expect(locked.status).toBe(401);
    bodies.push(locked.body);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  test('API-AUTH-021 弱い（漏洩した）パスワードは 400 で、コードを使い切らない', async () => {
    await start();
    const code = lastMailedCode();
    mockCheckPwned.mockResolvedValueOnce({ status: 'pwned', count: 9 });

    const weak = await confirm(code, 'password-that-leaked-0000');
    expect(weak.status).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();

    const retry = await confirm(code);
    expect(retry.status).toBe(200);
  });

  test('API-AUTH-021 16 文字未満の新パスワードは 400 で、コードを使い切らない', async () => {
    await start();
    const code = lastMailedCode();

    const short = await confirm(code, 'a'.repeat(15));
    expect(short.status).toBe(400);

    const retry = await confirm(code);
    expect(retry.status).toBe(200);
  });

  test('API-AUTH-021 パスワードの更新が失敗すれば 500 で、失効も通知も Cookie の削除もしない', async () => {
    await start();
    const code = lastMailedCode();
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: 'x' } });

    const res = await confirm(code);

    expect(res.status).toBe(500);
    expect(mockRevokeAll).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(cookieLog).toHaveLength(0);
  });

  test('API-AUTH-021 開始の前に確定を呼んでも（コードが無い）401 で、パスワードは変わらない', async () => {
    const res = await confirm('12345678');

    expect(res.status).toBe(401);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  test('API-AUTH-021 確定は GoTrue の現行パスワードの確かめを呼ばない（現行パスワードの当否を明かさない）', async () => {
    await start();
    mockSignInWithPassword.mockClear();

    await confirm(wrongCode(lastMailedCode()));
    await confirm(lastMailedCode());

    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('API-AUTH-021 監査にもメールの文面以外の応答にも、パスワード・コード・session_id の値が現れない', async () => {
    await start();
    const code = lastMailedCode();
    const responses = [await confirm(wrongCode(code)), await confirm(code)];

    const dump = JSON.stringify([mockLogAudit.mock.calls, responses.map((r) => r.body)]);
    expect(dump).not.toContain(CURRENT_PASSWORD);
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(SESSION_A);
  });
});
