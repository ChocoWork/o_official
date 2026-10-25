/**
 * ログインの2段目（確認コードの検証・再送・離脱）の窓口を、保留の 2FA Cookie（sb-login-2fa-session）を
 * 偽造して HTTP で直に叩いて確かめる。
 *
 * 対象の AC: FR-LOGIN-001-AC-02 / FREQ-335-AC-01 / FREQ-336-AC-01〜04 / SEC-AUTH-002-AC-01・02 /
 *            SEC-AUTH-003-AC-01・02 / SEC-AUTH-004-AC-01・02
 *
 * 前提（実行時に確かめる）:
 *  - 手元の Supabase と手元のメール受け（Mailpit。MAIL_PROVIDER=local, MAIL_LOCAL_URL）が動いている
 *  - 保留の Cookie の偽造は createLoginTwoFactorSessionToken（JWT_SECRET を .env.local から読む）。手元のアプリにだけ効く
 *  - 回数の制限（IP 単位 30 回/600 秒・宛先単位 5 回/600 秒など）は、試験ごとに別の x-forwarded-for と別の宛先で避ける
 *  - 手元の Supabase の token_verifications（5 分に IP ごと 30 回。supabase/config.toml）は全 E2E で共有される。
 *    このファイルが GoTrue へ届かせる検証は 20 回ほどなので、他の spec と同時に流して 401 が増えたら、この上限を疑う
 *
 * HTTP の試験は結果が画面の幅で変わらないので、1本ずつ（幅の指定なし）流す。画面を開く試験だけ3つの幅で流す。
 * 確認コードと Cookie が通信記録に残らないよう trace は切る。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { createTestMember, type TestMember } from './member-session-helpers';
import { mailsTo, withLocalDb } from './order-email-test-utils';

const COOKIE_NAME = 'sb-login-2fa-session';
// session_id は proxy が誰にでも配る匿名の閲覧の印（ログインの Cookie ではない）なので含めない。
const SESSION_COOKIE_NAMES = ['sb-access-token', 'sb-refresh-token'];
const ORIGIN = 'http://localhost:3000';
const MINUTE = 60;
const WRONG_CODE = '00000000';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

type Reply = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  setCookies: string[];
};

type Client = {
  post: (path: string, data?: Record<string, unknown>) => Promise<Reply>;
  /** この窓口の Cookie 入れに残っている Cookie の名前（サーバーの破棄の指示が効いたかを見る） */
  jarNames: () => Promise<string[]>;
};

type ClientOptions = { ip: string; cookie?: string };

const test = base.extend<{ makeClient: (options: ClientOptions) => Promise<Client> }>({
  makeClient: async ({ playwright, baseURL }, provide) => {
    const base = baseURL ?? ORIGIN;
    const origin = new URL(base).origin;
    const contexts: APIRequestContext[] = [];
    await provide(async ({ ip, cookie }) => {
      const context = await playwright.request.newContext({
        baseURL: base,
        extraHTTPHeaders: { origin, 'x-forwarded-for': ip },
        storageState: {
          cookies: cookie
            ? [
                {
                  name: COOKIE_NAME,
                  value: cookie,
                  domain: new URL(base).hostname,
                  path: '/',
                  expires: -1,
                  httpOnly: true,
                  secure: false,
                  sameSite: 'Strict',
                },
              ]
            : [],
          origins: [],
        },
      });
      contexts.push(context);
      return {
        post: async (path, data) => {
          const response = await context.post(path, { data, maxRedirects: 0 });
          const headersArray = response.headersArray();
          return {
            status: response.status(),
            body: await response.json().catch(() => null),
            headers: response.headers(),
            setCookies: headersArray
              .filter((header) => header.name.toLowerCase() === 'set-cookie')
              .map((header) => header.value),
          };
        },
        jarNames: async () => (await context.storageState()).cookies.map((entry) => entry.name),
      };
    });
    await Promise.all(contexts.map((context) => context.dispose()));
  },
});

test.use({ trace: 'off' });

/** 回数の制限を試験ごとに分けるための送り元。手元の E2E サーバーだけで効く。 */
function uniqueIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

/** 実在しない会員の宛先。保留の Cookie の署名は本物で、Supabase には存在しない。 */
function forgedPerson(label: string): TestMember {
  return {
    userId: randomUUID(),
    email: `e2e-otp036-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`,
  };
}

/** パスワードを通ってから ageSeconds 秒たった保留の Cookie。exp は今から 300 秒先のまま。 */
function pendingToken(person: TestMember, ageSeconds = 0): string {
  return createLoginTwoFactorSessionToken({
    userId: person.userId,
    email: person.email,
    issuedAt: Math.floor(Date.now() / 1000) - ageSeconds,
    expiresInSeconds: 5 * MINUTE,
  });
}

function payloadOf(token: string): { email: string; iat: number; exp: number } {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as {
    email: string;
    iat: number;
    exp: number;
  };
}

/** 署名はそのままで、中身の宛先だけを書き換える。 */
function tamperEmail(token: string, email: string): string {
  const [payload, signature] = token.split('.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  parsed.email = email;
  return `${Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url')}.${signature}`;
}

function setCookieNamed(reply: Reply, name: string): string | undefined {
  return reply.setCookies.find((entry) => entry.startsWith(`${name}=`));
}

function valueOfSetCookie(raw: string): string {
  return raw.split(';')[0].slice(raw.indexOf('=') + 1);
}

/** 保留の Cookie を捨てる指示（値が空で Max-Age=0）か。 */
function expectClearsPendingCookie(reply: Reply): void {
  const raw = setCookieNamed(reply, COOKIE_NAME);
  expect(raw, `${COOKIE_NAME} を捨てる Set-Cookie が返ること`).toBeDefined();
  expect(valueOfSetCookie(raw as string)).toBe('');
  expect(raw as string).toMatch(/max-age=0/i);
}

/** 値のある Set-Cookie で書かれたログインの Cookie の名前。 */
function sessionCookiesWritten(reply: Reply): string[] {
  return SESSION_COOKIE_NAMES.filter((name) => {
    const raw = setCookieNamed(reply, name);
    return raw !== undefined && valueOfSetCookie(raw) !== '';
  });
}

function userEmailOf(reply: Reply): string | undefined {
  return (reply.body as { user?: { email?: string } } | null)?.user?.email;
}

function errorOf(reply: Reply): string | undefined {
  return (reply.body as { error?: string } | null)?.error;
}

function localMailUrl(): string {
  const url = process.env.MAIL_LOCAL_URL;
  if (!url || !isLocalUrl(url)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  return url;
}

/** その宛先に届いた確認コードのメールが count 通になるのを待つ（時間待ちではなく、届くまでの再確認）。 */
async function waitForMails(request: APIRequestContext, email: string, count: number): Promise<void> {
  await expect
    .poll(async () => (await mailsTo(request, email)).length, {
      timeout: 30_000,
      message: `${email} に確認コードのメールが ${count} 通届くこと`,
    })
    .toBe(count);
}

/** その宛先に届いた最新のメールから 8 桁の確認コードを読む。 */
async function readCode(request: APIRequestContext, email: string): Promise<string> {
  const [latest] = await mailsTo(request, email);
  expect(latest, `${email} にメールがあること`).toBeDefined();
  const response = await request.get(
    new URL(`/api/v1/message/${encodeURIComponent(latest.ID)}`, localMailUrl()).toString(),
    { timeout: 5_000 },
  );
  expect(response.ok()).toBe(true);
  const content = (await response.json()) as { Text?: string; HTML?: string };
  // リンクのハッシュや HTML 属性の数字を確認コードと取り違えないため。
  const text = `${content.Text ?? ''}\n${(content.HTML ?? '').replace(/<[^>]*>/g, ' ')}`.replace(/https?:\/\/\S+/g, ' ');
  const code = text.match(/\b(\d{8})\b/)?.[1];
  expect(code, 'メールに8桁の確認コードがあること').toBeDefined();
  return code as string;
}

/** 本物の会員に本物の確認コードを送らせ（保留の Cookie を偽造して再送の窓口を叩く）、そのコードを読む。 */
async function issueRealCode(
  request: APIRequestContext,
  makeClient: (options: ClientOptions) => Promise<Client>,
  member: TestMember,
  ip: string,
): Promise<string> {
  const client = await makeClient({ ip, cookie: pendingToken(member) });
  const resend = await client.post('/api/auth/login/resend');
  expect(resend.status).toBe(200);
  await waitForMails(request, member.email, 1);
  return readCode(request, member.email);
}

function wrongCodeFor(code: string): string {
  return code === WRONG_CODE ? '11111111' : WRONG_CODE;
}

async function cancelledWithoutActor(): Promise<number> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select count(*)::int as n from public.audit_logs
        where action = 'login' and outcome = 'cancelled' and detail = 'otp_step_abandoned' and actor_email is null`,
    );
    return result.rows[0].n as number;
  });
}

async function cancelledFor(email: string): Promise<number> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select count(*)::int as n from public.audit_logs
        where action = 'login' and outcome = 'cancelled' and detail = 'otp_step_abandoned' and actor_email = $1`,
      [email],
    );
    return result.rows[0].n as number;
  });
}

test.describe('FR-LOGIN-036 otp verify and resend pending cookie (HTTP)', () => {
  test('FR-LOGIN-001-AC-02 a correct code without the pending cookie gets 401 and no login cookie', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-001-ac02');
    const ip = uniqueIp();
    const code = await issueRealCode(request, makeClient, member, ip);

    // パスワードを通った印（保留の Cookie）が無いと、メールで届いた本物のコードだけでは入れない
    const withoutCookie = await makeClient({ ip });
    const rejected = await withoutCookie.post('/api/auth/otp/verify', { code });
    expect(rejected.status).toBe(401);
    expect(sessionCookiesWritten(rejected)).toEqual([]);
    expect(setCookieNamed(rejected, 'sb-access-token')).toBeUndefined();

    // 対照: 同じコードは、保留の Cookie があれば通る（コードが誤りだったから断られたのではない）
    const withCookie = await makeClient({ ip, cookie: pendingToken(member) });
    const accepted = await withCookie.post('/api/auth/otp/verify', { code });
    expect(accepted.status).toBe(200);
    expect(sessionCookiesWritten(accepted)).toContain('sb-access-token');
  });

  test('FREQ-335-AC-01 the 6th wrong code for one account gets 429 while another account is not consumed', async ({
    makeClient,
  }) => {
    const ip = uniqueIp();
    const accountA = forgedPerson('335-a');
    const accountB = forgedPerson('335-b');
    const clientA = await makeClient({ ip, cookie: pendingToken(accountA) });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const wrong = await clientA.post('/api/auth/otp/verify', { code: WRONG_CODE });
      expect(wrong.status, `${attempt} 回目の誤りは 401`).toBe(401);
    }
    const sixth = await clientA.post('/api/auth/otp/verify', { code: WRONG_CODE });
    expect(sixth.status).toBe(429);

    // 同じ送り元の別のアカウントは、A の6回で枠を減らされていない（初回は 429 でなく 401）
    const clientB = await makeClient({ ip, cookie: pendingToken(accountB) });
    const other = await clientB.post('/api/auth/otp/verify', { code: WRONG_CODE });
    expect(other.status).toBe(401);
  });

  test('FREQ-336-AC-01 a token older than 30 minutes is invalid even with a future exp, and a resend keeps the original iat', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-336-ac01');
    const ip = uniqueIp();

    // 発行から 25 分の保留を再送する。再発行された Cookie の iat は元のまま
    const originalIat = Math.floor(Date.now() / 1000) - 25 * MINUTE;
    const original = createLoginTwoFactorSessionToken({
      userId: member.userId,
      email: member.email,
      issuedAt: originalIat,
      expiresInSeconds: 5 * MINUTE,
    });
    const resender = await makeClient({ ip, cookie: original });
    const resend = await resender.post('/api/auth/login/resend');
    expect(resend.status).toBe(200);
    const reissued = setCookieNamed(resend, COOKIE_NAME);
    expect(reissued, '再送が保留の Cookie を再発行すること').toBeDefined();
    const reissuedPayload = payloadOf(valueOfSetCookie(reissued as string));
    expect(reissuedPayload.iat).toBe(originalIat);
    expect(reissuedPayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // 上限の起点（iat）が動かないので、再送のたびに 30 分の上限が延びることはない
    expect(Math.floor(Date.now() / 1000) - reissuedPayload.iat).toBeLessThan(30 * MINUTE);

    await waitForMails(request, member.email, 1);
    const code = await readCode(request, member.email);

    // 発行から 31 分のトークン。exp は未来のままだが、本物のコードを添えても無効
    const stale = pendingToken(member, 31 * MINUTE);
    expect(payloadOf(stale).exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const staleClient = await makeClient({ ip, cookie: stale });
    const refused = await staleClient.post('/api/auth/otp/verify', { code });
    expect(refused.status).toBe(401);
    expect(sessionCookiesWritten(refused)).toEqual([]);

    // 対照: 再発行された Cookie（iat は元のまま・30 分以内）では、同じコードが通る
    const reissuedClient = await makeClient({ ip, cookie: valueOfSetCookie(reissued as string) });
    const accepted = await reissuedClient.post('/api/auth/otp/verify', { code });
    expect(accepted.status).toBe(200);
  });

  test('FREQ-336-AC-02 resend is limited per account and per IP: the IP limit gives 429 and sends no mail', async ({
    request,
    makeClient,
  }) => {
    test.setTimeout(120_000);
    const ip = uniqueIp();
    const filler = forgedPerson('336-ac02-filler');
    const fillerClient = await makeClient({ ip, cookie: pendingToken(filler) });

    // 同じ宛先で 5 回は制限の手前（宛先が実在しないので送信は失敗しうるが、制限の 429 ではない）
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reply = await fillerClient.post('/api/auth/login/resend');
      expect(reply.status, `${attempt} 回目はアカウント単位の制限の手前`).not.toBe(429);
    }
    // 6 回目はアカウント単位の制限（この時点の IP の回数は 6 で、IP の上限 50 の手前）
    const accountLimited = await fillerClient.post('/api/auth/login/resend');
    expect(accountLimited.status).toBe(429);

    // IP の回数を 50 まで積む（以降の 429 は宛先単位の制限で、ここまでは IP の上限に届かない）
    for (let attempt = 7; attempt <= 50; attempt += 1) {
      const reply = await fillerClient.post('/api/auth/login/resend');
      expect(reply.status).toBe(429);
    }

    // 初めての宛先（宛先単位の枠は空）でも、IP の上限を超えた 51 回目は 429 でメールを送らない
    const member = await createTestMember('otp036-336-ac02');
    const limitedClient = await makeClient({ ip, cookie: pendingToken(member) });
    const ipLimited = await limitedClient.post('/api/auth/login/resend');
    expect(ipLimited.status).toBe(429);
    expect(errorOf(ipLimited)).toBe('Too many requests');
    expect(setCookieNamed(ipLimited, COOKIE_NAME)).toBeUndefined();

    // 対照: 別の送り元なら同じ宛先へ送れる。メールはこの 1 通だけ（429 の要求は送っていない）
    const otherIp = await makeClient({ ip: uniqueIp(), cookie: pendingToken(member) });
    const sent = await otherIp.post('/api/auth/login/resend');
    expect(sent.status).toBe(200);
    await waitForMails(request, member.email, 1);
  });

  test('FREQ-336-AC-03 the verify body is only the code and an email in the body does not change the destination', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-336-ac03');
    const other = forgedPerson('336-ac03-other');
    const ip = uniqueIp();
    const code = await issueRealCode(request, makeClient, member, ip);
    const client = await makeClient({ ip, cookie: pendingToken(member) });

    // email だけでは検証できない（本文に必要なのは code だけ）
    const emailOnly = await client.post('/api/auth/otp/verify', { email: other.email });
    expect(emailOnly.status).toBe(400);

    // 別の宛先を本文に混ぜても、検証されるのは保留の Cookie の宛先
    const mixed = await client.post('/api/auth/otp/verify', { code, email: other.email });
    expect(mixed.status).toBe(200);
    expect(userEmailOf(mixed)).toBe(member.email);
    expect(userEmailOf(mixed)).not.toBe(other.email);
  });

  for (const viewport of viewports) {
    test(`FREQ-336-AC-03 the verify screen sends a body with only the code (${viewport.name})`, async ({
      page,
    }: {
      page: Page;
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 本物の窓口は呼ばない。画面が送る本文だけを取り、断りの応答を返す
      await page.route('**/api/auth/otp/verify', async (route) => {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
      });

      await page.goto('/login');
      await setLoginTwoFactorCookie(page, 'user@example.com');
      await page.goto('/login/verify');

      const posted = page.waitForRequest(
        (request) => request.url().endsWith('/api/auth/otp/verify') && request.method() === 'POST',
      );
      for (let index = 0; index < 8; index += 1) {
        await page.getByLabel(`認証コード ${index + 1} 桁目`).fill('1');
      }
      await page.getByRole('button', { name: 'サインイン' }).click();

      const body = (await posted).postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['code']);
      expect(body.code).toBe('11111111');
    });
  }

  test('FREQ-336-AC-04 cancel without the pending cookie returns 200 and a clear instruction and records no audit log', async ({
    makeClient,
  }) => {
    const ip = uniqueIp();
    const before = await cancelledWithoutActor();

    const client = await makeClient({ ip });
    const reply = await client.post('/api/auth/login/cancel');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true });
    expectClearsPendingCookie(reply);

    expect(await cancelledWithoutActor()).toBe(before);

    // 対照: 有効な保留があれば同じ窓口は監査を残す（残さないことが、記録の仕組みの故障でないと分かる）
    const pending = forgedPerson('336-ac04');
    const withCookie = await makeClient({ ip, cookie: pendingToken(pending) });
    const cancelled = await withCookie.post('/api/auth/login/cancel');
    expect(cancelled.status).toBe(200);
    expectClearsPendingCookie(cancelled);
    expect(await cancelledFor(pending.email)).toBe(1);
  });

  test('SEC-AUTH-002-AC-01 six wrong codes give 429 and drop the pending, so a correct code afterwards gets 401', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-002-ac01');
    const ip = uniqueIp();
    const code = await issueRealCode(request, makeClient, member, ip);
    const wrong = wrongCodeFor(code);

    // Cookie 入れを持つ窓口で続ける。サーバーの破棄の指示は、その Cookie 入れから保留を消す
    const client = await makeClient({ ip, cookie: pendingToken(member) });
    expect(await client.jarNames()).toContain(COOKIE_NAME);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reply = await client.post('/api/auth/otp/verify', { code: wrong });
      expect(reply.status, `${attempt} 回目の誤りは 401`).toBe(401);
    }
    const sixth = await client.post('/api/auth/otp/verify', { code: wrong });
    expect(sixth.status).toBe(429);
    expectClearsPendingCookie(sixth);
    expect(await client.jarNames()).not.toContain(COOKIE_NAME);

    // 正しいコードを送っても、保留が無いので 401（ログインの Cookie も書かれない）
    const afterwards = await client.post('/api/auth/otp/verify', { code });
    expect(afterwards.status).toBe(401);
    expect(errorOf(afterwards)).toContain('もう一度ログインしてください');
    expect(sessionCookiesWritten(afterwards)).toEqual([]);

    // 破棄の指示を無視して、元の保留の Cookie をそのまま送り直す客でも、正しいコードでログインできない
    const ignoringClear = await makeClient({ ip, cookie: pendingToken(member) });
    const replay = await ignoringClear.post('/api/auth/otp/verify', { code });
    expect(replay.status).not.toBe(200);
    expect(sessionCookiesWritten(replay)).toEqual([]);
  });

  test('SEC-AUTH-002-AC-02 an email in the body does not change which account is counted or verified', async ({
    request,
    makeClient,
  }) => {
    const ip = uniqueIp();
    const attacker = forgedPerson('002-ac02-attacker');
    const victim = forgedPerson('002-ac02-victim');
    const member = await createTestMember('otp036-002-ac02');

    // 数え方: 本文に被害者の宛先を書いて送り続けても、数えるのは保留（attacker）の宛先
    const attackerClient = await makeClient({ ip, cookie: pendingToken(attacker) });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reply = await attackerClient.post('/api/auth/otp/verify', { code: WRONG_CODE, email: victim.email });
      expect(reply.status, `${attempt} 回目は 401`).toBe(401);
    }
    const sixth = await attackerClient.post('/api/auth/otp/verify', { code: WRONG_CODE, email: victim.email });
    expect(sixth.status).toBe(429);
    // 被害者の枠は潰されていない（保留の Cookie を持つ本人の初回は 429 でなく 401）
    const victimClient = await makeClient({ ip, cookie: pendingToken(victim) });
    const victimReply = await victimClient.post('/api/auth/otp/verify', { code: WRONG_CODE });
    expect(victimReply.status).toBe(401);

    // 検証: 本文の宛先ではなく保留の宛先（member）として検証される
    const code = await issueRealCode(request, makeClient, member, uniqueIp());
    const memberClient = await makeClient({ ip: uniqueIp(), cookie: pendingToken(member) });
    const verified = await memberClient.post('/api/auth/otp/verify', { code, email: victim.email });
    expect(verified.status).toBe(200);
    expect(userEmailOf(verified)).toBe(member.email);
  });

  test('SEC-AUTH-003-AC-01 a correct code with an email but without the pending cookie gets 401 and no session cookie', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-003-ac01');
    const ip = uniqueIp();
    const code = await issueRealCode(request, makeClient, member, ip);

    const withoutCookie = await makeClient({ ip });
    const reply = await withoutCookie.post('/api/auth/otp/verify', { email: member.email, code });
    expect(reply.status).toBe(401);
    expect(sessionCookiesWritten(reply)).toEqual([]);
    // session_id は proxy が全部の応答に付ける匿名の閲覧の印（SESSION_COOKIE_NAMES の注記）。ログインの Cookie ではないので数えない
    expect((await withoutCookie.jarNames()).filter((name) => name !== 'session_id')).toEqual([]);
  });

  test('SEC-AUTH-003-AC-02 a pending cookie whose destination was rewritten gets 401', async ({
    request,
    makeClient,
  }) => {
    const ip = uniqueIp();
    const victim = await createTestMember('otp036-003-ac02');
    const attacker = forgedPerson('003-ac02-attacker');
    // 被害者のメールを読める相手の想定: 被害者宛の本物のコードを持っている
    const code = await issueRealCode(request, makeClient, victim, ip);

    // 自分の（署名の本物の）保留の宛先を被害者に書き換える。署名は元のまま
    const genuine = pendingToken(attacker);
    const rewritten = tamperEmail(genuine, victim.email);
    expect(payloadOf(rewritten).email).toBe(victim.email);
    expect(rewritten.split('.')[1]).toBe(genuine.split('.')[1]);
    // 署名そのものを差し替えた Cookie（中身は書き換え済み）も同じく断られる
    const forgedSignature = `${rewritten.split('.')[0]}.${'A'.repeat(genuine.split('.')[1].length)}`;

    for (const cookie of [rewritten, forgedSignature]) {
      const client = await makeClient({ ip, cookie });
      const verify = await client.post('/api/auth/otp/verify', { code });
      expect(verify.status).toBe(401);
      expect(sessionCookiesWritten(verify)).toEqual([]);

      // 再送でも、書き換えた宛先へは送られない
      const resend = await client.post('/api/auth/login/resend');
      expect(resend.status).toBe(401);
    }
    // 被害者に届いているのは、最初の本物の 1 通だけ
    expect((await mailsTo(request, victim.email)).length).toBe(1);
  });

  test('SEC-AUTH-004-AC-01 a resend with a pending older than 30 minutes gets 401', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-004-ac01');
    const ip = uniqueIp();

    const staleClient = await makeClient({ ip, cookie: pendingToken(member, 31 * MINUTE) });
    const refused = await staleClient.post('/api/auth/login/resend');
    expect(refused.status).toBe(401);
    expect(setCookieNamed(refused, COOKIE_NAME)).toBeUndefined();

    // 対照: 25 分なら同じ宛先へ送れる。メールはこの 1 通だけ（上の 401 では送られていない）
    const freshClient = await makeClient({ ip, cookie: pendingToken(member, 25 * MINUTE) });
    const sent = await freshClient.post('/api/auth/login/resend');
    expect(sent.status).toBe(200);
    await waitForMails(request, member.email, 1);
  });

  test('SEC-AUTH-004-AC-02 an email in the resend body does not redirect the mail: it reaches only the pending address', async ({
    request,
    makeClient,
  }) => {
    const member = await createTestMember('otp036-004-ac02-pending');
    const other = await createTestMember('otp036-004-ac02-other');
    const ip = uniqueIp();

    const client = await makeClient({ ip, cookie: pendingToken(member) });
    const reply = await client.post('/api/auth/login/resend', { email: other.email });
    expect(reply.status).toBe(200);

    // 保留の宛先に 1 通届く。本文に書いた別の会員（実在）には届かない
    await waitForMails(request, member.email, 1);
    expect((await mailsTo(request, other.email)).length).toBe(0);
  });
});

