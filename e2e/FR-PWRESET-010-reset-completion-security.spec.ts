import { randomBytes } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';

// 再設定の完了まわりの受け入れ基準を、実際に届くメールのリンクから作った再設定 Cookie で確かめる。
//   FREQ-319-AC-05  再設定の後、更新前に取得したアクセストークンが管理 API で 401 になる
//   SEC-AUTH-014-AC-02  15 文字のパスワードでの再設定が 400、印は消費されない
//   SEC-AUTH-020-AC-01  再設定の後、別の端末のセッションが 401 になる
//   SEC-AUTH-027-AC-01  再設定の Cookie を保留の2段目の Cookie に入れても通らない
//
// FREQ-319-AC-05 の前半（updateUserById が error を返したとき 500 で「更新しました」を出さない）は、
// 本番ビルドに失敗を差し込む手段が無く E2E では確かめられない。ここでは後半だけを確かめる。
//
// 再設定のメール・再設定 Cookie・アクセストークンが通信記録に残らないよう、ファイルの最上位で trace を切る。
// （test.describe の中では worker 単位の設定を変えられず、読み込みで落ちる。）
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

type Viewport = (typeof viewports)[number];

const APP_ORIGIN = 'http://localhost:3000';
const RESET_COOKIE = 'sb-password-reset-session';
const LOGIN_2FA_COOKIE = 'sb-login-2fa-session';
const MISSING_PENDING_MESSAGE = 'セッションの有効期限が切れました。もう一度ログインしてください。';

/** 回数の制限は送り元ごとに数える。試験ごとに別の値を使い、全部の E2E が共有する枠を使い切らない。 */
function uniqueSource(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

function newPassword(length = 16): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

async function newClient(browser: Browser, viewport: Viewport): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: APP_ORIGIN,
    viewport: { width: viewport.width, height: viewport.height },
  });
}

type MailpitSummary = { messages?: Array<{ ID: string; Subject?: string }> };
type MailpitMessage = { Text?: string };

/** 手元のメール受けから、宛先に届いた再設定メールのリンクのトークンを読む。まだ届いていなければ null。 */
async function readResetToken(email: string): Promise<string | null> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) {
    throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  }
  const searchUrl = new URL('/api/v1/search', mailUrl);
  searchUrl.searchParams.set('query', `to:${email}`);
  // トークン入りの応答をブラウザの文脈の通信記録へ載せないため、Node で読む。
  const search = await fetch(searchUrl, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
  if (!search.ok) throw new Error(`手元のメール受けを検索できない: ${search.status}`);
  const summary = (await search.json()) as MailpitSummary;
  const mail = (summary.messages ?? []).find((message) => message.Subject === 'Password reset');
  if (!mail) return null;
  const detail = await fetch(new URL(`/api/v1/message/${encodeURIComponent(mail.ID)}`, mailUrl), {
    signal: AbortSignal.timeout(5_000),
    redirect: 'manual',
  });
  if (!detail.ok) throw new Error(`手元の再設定メールを取得できない: ${detail.status}`);
  const message = (await detail.json()) as MailpitMessage;
  return message.Text?.match(/token=([0-9a-f]{64})/)?.[1] ?? null;
}

/**
 * 再設定の申請 → 届いたメールのリンクのトークン → link の POST までを実際の経路で進め、
 * 発行された再設定 Cookie の値を返す。Cookie は ctx の Cookie 入れにも残る。
 */
async function issueResetCookie(ctx: BrowserContext, member: TestMember, source: string): Promise<string> {
  const headers = { origin: APP_ORIGIN, 'x-forwarded-for': source };

  const requested = await ctx.request.post('/api/auth/password-reset/request', {
    headers,
    data: { email: member.email, turnstileToken: 'e2e-turnstile-token' },
    maxRedirects: 0,
  });
  expect(requested.status()).toBe(200);

  const found: { token: string | null } = { token: null };
  await expect
    .poll(
      async () => {
        found.token = await readResetToken(member.email);
        return found.token !== null;
      },
      { message: '再設定メールが届かない', timeout: 20_000 },
    )
    .toBe(true);

  const linked = await ctx.request.post('/api/auth/password-reset/link', {
    headers,
    data: { token: found.token },
    maxRedirects: 0,
  });
  expect(linked.status()).toBe(200);

  const cookie = (await ctx.cookies(APP_ORIGIN)).find((entry) => entry.name === RESET_COOKIE);
  expect(cookie?.value, '再設定 Cookie が発行されていない').toBeTruthy();
  return cookie!.value;
}

function confirmReset(ctx: BrowserContext, source: string, password: string) {
  return ctx.request.post('/api/auth/password-reset/confirm', {
    headers: { origin: APP_ORIGIN, 'x-forwarded-for': source },
    data: { new_password: password },
    maxRedirects: 0,
  });
}

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-010 reset completion security (${viewport.name})`, () => {
    test(
      'FREQ-319-AC-05 an access token taken before the reset gets 401 on an admin endpoint after the reset',
      async ({ browser }) => {
        test.setTimeout(90_000);
        const member = await createTestMember('pwreset-010-319');
        const source = uniqueSource();
        const before = await newClient(browser, viewport);
        const resetter = await newClient(browser, viewport);
        try {
          // 更新前に取得したアクセストークン
          const page = await before.newPage();
          await loginAsMember(page, member, source);
          const accessToken = (await before.cookies(APP_ORIGIN)).find((entry) => entry.name === 'sb-access-token')?.value;
          expect(accessToken, '更新前のアクセストークンが無い').toBeTruthy();
          const bearer = { authorization: `Bearer ${accessToken}`, 'x-forwarded-for': source };

          // 再設定の前は、トークンもセッションも生きている（権限が無いので 401 ではなく 403）。
          // これで、後の 401 が再設定による失効だと言える。
          const beforeReset = await resetter.request.get('/api/admin/kpi', { headers: bearer, maxRedirects: 0 });
          expect(beforeReset.status()).toBe(403);

          await issueResetCookie(resetter, member, source);
          const confirmed = await confirmReset(resetter, source, newPassword());
          expect(confirmed.status()).toBe(200);

          // 再設定完了後、更新前に取得したアクセストークンで管理 API を叩くと 401
          const afterReset = await resetter.request.get('/api/admin/kpi', { headers: bearer, maxRedirects: 0 });
          expect(afterReset.status()).toBe(401);
        } finally {
          await before.close();
          await resetter.close();
        }
      },
    );

    test(
      'SEC-AUTH-014-AC-02 resetting with a 15 character password is 400 and the token is not consumed',
      async ({ browser }) => {
        test.setTimeout(60_000);
        const member = await createTestMember('pwreset-010-014');
        const source = uniqueSource();
        const ctx = await newClient(browser, viewport);
        try {
          await issueResetCookie(ctx, member, source);

          // 15 文字の新しいパスワードで再設定を完了しようとすると 400
          const short = await confirmReset(ctx, source, newPassword(15));
          expect(short.status()).toBe(400);
          // 「再設定の Cookie が無い・印が使用済み」の 400 ではなく、長さの検証による 400 であること
          expect(((await short.json()) as { code?: string }).code).toBe('validation_error');

          // 印が消費されていないので、同じ Cookie のまま 16 文字なら完了できる
          const long = await confirmReset(ctx, source, newPassword(16));
          expect(long.status()).toBe(200);
        } finally {
          await ctx.close();
        }
      },
    );

    test(
      'SEC-AUTH-020-AC-01 after the reset is completed the session on another device gets 401',
      async ({ browser }) => {
        test.setTimeout(90_000);
        const member = await createTestMember('pwreset-010-020');
        const sourceA = uniqueSource();
        const sourceB = uniqueSource();
        const deviceA = await newClient(browser, viewport);
        const deviceB = await newClient(browser, viewport);
        try {
          // 端末 A: ログインしたまま
          const pageA = await deviceA.newPage();
          await loginAsMember(pageA, member, sourceA);

          // 再設定の前は、端末 A の Cookie で更新できる。これで、後の 401 が再設定による失効だと言える。
          const beforeReset = await deviceA.request.post('/api/auth/refresh', {
            headers: { origin: APP_ORIGIN, 'x-forwarded-for': sourceA },
            maxRedirects: 0,
          });
          expect(beforeReset.status()).toBe(200);

          // 端末 B: 再設定を完了する
          await issueResetCookie(deviceB, member, sourceB);
          const confirmed = await confirmReset(deviceB, sourceB, newPassword());
          expect(confirmed.status()).toBe(200);

          // 再設定の完了の後に、端末 A の Cookie で /api/auth/refresh を叩くと 401
          const afterReset = await deviceA.request.post('/api/auth/refresh', {
            headers: { origin: APP_ORIGIN, 'x-forwarded-for': sourceA },
            maxRedirects: 0,
          });
          expect(afterReset.status()).toBe(401);
        } finally {
          await deviceA.close();
          await deviceB.close();
        }
      },
    );

    test(
      'SEC-AUTH-027-AC-01 a password reset cookie put into the pending second step cookie is rejected',
      async ({ browser }) => {
        test.setTimeout(60_000);
        const member = await createTestMember('pwreset-010-027');
        const source = uniqueSource();
        const resetter = await newClient(browser, viewport);
        const attacker = await newClient(browser, viewport);
        try {
          // 有効な再設定の Cookie の値
          const resetCookieValue = await issueResetCookie(resetter, member, source);

          // その値を sb-login-2fa-session に入れて OTP を送る
          await attacker.addCookies([
            {
              name: LOGIN_2FA_COOKIE,
              value: resetCookieValue,
              url: APP_ORIGIN,
              httpOnly: true,
              sameSite: 'Strict',
            },
          ]);
          const verified = await attacker.request.post('/api/auth/otp/verify', {
            headers: { origin: APP_ORIGIN, 'x-forwarded-for': source },
            data: { code: '00000000' },
            maxRedirects: 0,
          });

          expect(verified.status()).toBe(401);
          // 確認コードの誤りではなく、2段目の Cookie として断られたこと
          expect(((await verified.json()) as { error?: string }).error).toBe(MISSING_PENDING_MESSAGE);
          // ログインのセッションが発行されていないこと
          const issued = (await attacker.cookies(APP_ORIGIN)).map((entry) => entry.name);
          expect(issued).not.toContain('sb-access-token');
          expect(issued).not.toContain('sb-refresh-token');
        } finally {
          await resetter.close();
          await attacker.close();
        }
      },
    );
  });
}
