/**
 * FR-LOGIN-030 ログインの後のセッションの Cookie と、認証の窓口の応答（本文・キャッシュ・送り先）
 * 対応: FREQ-320-AC-02 / SEC-AUTH-021-AC-01 / SEC-AUTH-022-AC-01 / SEC-AUTH-022-AC-02 / SEC-AUTH-024-AC-01 / SEC-AUTH-026-AC-01
 *
 * 会員は createTestMember で作り、loginAsMember（確認コードの本物のログイン）で本物の Cookie を受け取る。
 * 窓口は Playwright の request（HTTP）で叩き、/auth/callback だけ画面を開く。
 * - SEC-AUTH-022-AC-01 / SEC-AUTH-022-AC-02 は、現行のコードが満たさないと文書に書いてある（今は赤になるのが想定）。
 * - SEC-AUTH-026-AC-01 も、/auth/callback の画面が満たさないと文書に書いてある（今は赤になるのが想定）。
 * - SEC-AUTH-024-AC-01 の Secure は、AC の文面に無いので確かめない（本番ビルドの手元では付くが、別の AC に分ける）。
 * 通信記録にトークンが残らないよう trace は切る。失敗の報告にもトークンの値を出さない（真偽だけで比べる）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';

test.use({ trace: 'off' });
test.describe.configure({ timeout: 180_000 });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const ACCESS_COOKIE = 'sb-access-token';
const REFRESH_COOKIE = 'sb-refresh-token';
const CSRF_COOKIE = 'sb-csrf-token';
const LOGIN_2FA_COOKIE = 'sb-login-2fa-session';
const SEVEN_DAYS_SECONDS = 604_800;

/** 回数の制限を試験ごとに別の送り元で数えるための値（手元の E2E サーバーだけで効く）。 */
function uniqueSourceIp(): string {
  const bytes = randomBytes(2);
  return `198.18.${bytes[0]}.${(bytes[1] % 253) + 1}`;
}

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い');
  const origin = new URL(baseURL).origin;
  if (!isLocalUrl(origin)) throw new Error('この試験は手元のアプリだけで流す');
  return origin;
}

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

async function cookieMap(page: Page, origin: string): Promise<Map<string, Cookie>> {
  const cookies = await page.context().cookies(origin);
  return new Map(cookies.map((cookie) => [cookie.name, cookie]));
}

/**
 * 会員を作って本物のログインをする。otp/verify の応答は loginAsMember の中で捨てられるので、
 * page.request.post を一時的に包んで応答を取っておく（loginAsMember 本体は変えない）。
 */
async function loginCapturingOtpVerify(
  page: Page,
  label: string,
  member?: TestMember,
): Promise<{ member: TestMember; otpVerify: APIResponse; ip: string }> {
  const target = member ?? (await createTestMember(label));
  const ip = uniqueSourceIp();
  const api = page.request;
  const originalPost = api.post.bind(api);
  const holder: { otpVerify?: APIResponse } = {};
  api.post = (async (url: string, options?: Parameters<typeof originalPost>[1]) => {
    const response = await originalPost(url, options);
    if (url.endsWith('/api/auth/otp/verify')) holder.otpVerify = response;
    return response;
  }) as typeof api.post;
  try {
    await loginAsMember(page, target, ip);
  } finally {
    api.post = originalPost;
  }
  if (!holder.otpVerify) throw new Error('otp/verify の応答を取れなかった');
  return { member: target, otpVerify: holder.otpVerify, ip };
}

/**
 * 同じ会員への確認コードの再送は、GoTrue の送信間隔（手元は max_frequency=1s）の間は 429 で断られる。
 * 直前の送信時刻（auth.users.recovery_sent_at）から間隔を超えるまで、決め打ちの待ちではなく時刻を見て待つ。
 */
async function waitForResendInterval(userId: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('送信時刻を読めるのは手元の Supabase だけ');
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await expect
    .poll(
      async () => {
        const { data } = await admin.auth.admin.getUserById(userId);
        const sentAt = data.user?.recovery_sent_at;
        return sentAt ? Date.now() - new Date(sentAt).getTime() : Number.POSITIVE_INFINITY;
      },
      { message: '直前の確認コードの送信から GoTrue の送信間隔（1秒）を超えるまで待つ', intervals: [200], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1_200);
}

/** ログアウトの窓口を、その端末の CSRF の印つきで叩く。 */
async function logout(page: Page, origin: string): Promise<APIResponse> {
  const csrf = (await cookieMap(page, origin)).get(CSRF_COOKIE)?.value;
  if (!csrf) throw new Error('CSRF の Cookie が無い');
  return page.request.post(new URL('/api/auth/logout', origin).toString(), {
    headers: { origin, 'x-csrf-token': csrf, 'x-forwarded-for': uniqueSourceIp() },
    maxRedirects: 0,
  });
}

/** Set-Cookie の1行を、名前・値・属性（小文字）に分ける。 */
function parseSetCookie(line: string): { name: string; attributes: string[] } {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  return { name: pair.split('=')[0], attributes: attributes.map((attribute) => attribute.toLowerCase()) };
}

// 窓口と Cookie の確認は HTTP が中心で、画面の幅で結果が変わらない。幅ごとに会員を作ってログインすると
// 本物の確認コードと DB の書き込みが3倍になるので、1つの幅（desktop）だけ流す。画面を開く SEC-AUTH-026-AC-01 だけ3つの幅で流す。
for (const viewport of [viewports[2]]) {
  test.describe(`FR-LOGIN-030 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FREQ-320-AC-02 sb-access-token の Max-Age が 604800 で、ログアウトで他の端末が切れない (${viewport.name})`, async ({
      page,
      browser,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      const beforeLogin = Date.now() / 1000;
      const { member } = await loginCapturingOtpVerify(page, 'cookie-maxage');
      const afterLogin = Date.now() / 1000;

      // Max-Age は Cookie の期限（expires = 受け取った時刻 + Max-Age）から読む。受け取った時刻はログインの前後に挟まる。
      const access = (await cookieMap(page, origin)).get(ACCESS_COOKIE);
      expect(access, 'ログインの後に sb-access-token がある').toBeDefined();
      expect(access!.expires, 'sb-access-token は期限つき（Max-Age あり）').toBeGreaterThan(0);
      expect(access!.expires).toBeGreaterThanOrEqual(beforeLogin + SEVEN_DAYS_SECONDS - 2);
      expect(access!.expires).toBeLessThanOrEqual(afterLogin + SEVEN_DAYS_SECONDS + 2);

      // 別の端末（別のブラウザの文脈）で同じ会員がログインしている状態で、この端末だけログアウトする。
      const otherContext = await browser.newContext({
        baseURL,
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        const otherPage = await otherContext.newPage();
        // 同じ会員への確認コードの再送は、手元の supabase/config.toml の [auth.email] max_frequency（1s）の間は GoTrue が 429 で断り、
        // アプリの再送の窓口が 500 になる。1回目のログインの直後に2回目を始めないよう、その間隔を超えるまで待つ。
        await waitForResendInterval(member.userId);
        await loginCapturingOtpVerify(otherPage, 'cookie-maxage-other', member);

        const loggedOut = await logout(page, origin);
        expect(loggedOut.status(), 'この端末のログアウトは 200').toBe(200);
        expect((await cookieMap(page, origin)).get(ACCESS_COOKIE)?.value ?? '', 'この端末の sb-access-token は消える').toBe('');

        // 他の端末のセッションは生きている: 本人と分かり、refresh も通る（失効していれば 401）。
        const me = await otherPage.request.get(new URL('/api/auth/me', origin).toString(), { maxRedirects: 0 });
        expect(me.status(), '他の端末の /api/auth/me は 200').toBe(200);
        const meBody = (await me.json()) as { authenticated?: boolean; user?: { id?: string } };
        expect(meBody.authenticated, '他の端末は認証されたまま').toBe(true);
        expect(meBody.user?.id === member.userId, '他の端末は同じ会員のまま').toBe(true);

        const refreshed = await otherPage.request.post(new URL('/api/auth/refresh', origin).toString(), {
          headers: { origin, 'x-forwarded-for': uniqueSourceIp() },
          maxRedirects: 0,
        });
        expect(refreshed.status(), '他の端末の refresh は 200（セッションが失効していない）').toBe(200);
      } finally {
        await otherContext.close();
      }
    });

    test(`SEC-AUTH-021-AC-01 ログアウトの後に、写しておいた refresh token での更新が誤りになる (${viewport.name})`, async ({
      page,
      request,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey || !isLocalUrl(supabaseUrl)) {
        throw new Error('手元の Supabase の公開値が env に無い');
      }

      await loginCapturingOtpVerify(page, 'logout-revoke');
      const copiedRefreshToken = (await cookieMap(page, origin)).get(REFRESH_COOKIE)?.value;
      expect(copiedRefreshToken, 'ログアウトの前に refresh token の Cookie がある').toBeTruthy();

      const loggedOut = await logout(page, origin);
      expect(loggedOut.status(), 'ログアウトは 200').toBe(200);

      // アプリを通さず、Supabase Auth の更新の窓口へ直に送る。
      const refreshed = await request.post(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        headers: { apikey: anonKey },
        data: { refresh_token: copiedRefreshToken },
        maxRedirects: 0,
      });
      expect(refreshed.ok(), `写した refresh token での更新が誤りになる（status ${refreshed.status()}）`).toBe(false);
      expect(refreshed.status(), '更新の誤りは 4xx').toBeGreaterThanOrEqual(400);
      expect(refreshed.status()).toBeLessThan(500);
      const body = (await refreshed.json().catch(() => ({}))) as Record<string, unknown>;
      expect('access_token' in body, '更新の応答に新しい access token が無い').toBe(false);
    });

    test(`SEC-AUTH-022-AC-01 /api/auth/refresh と /api/auth/otp/verify の応答の本文に access_token・refresh_token・app_metadata の字が無い (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      test.fail(true, 'SEC-AUTH-022 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const origin = originOf(baseURL);
      const { otpVerify } = await loginCapturingOtpVerify(page, 'body-no-token');
      const refresh = await page.request.post(new URL('/api/auth/refresh', origin).toString(), {
        headers: { origin, 'x-forwarded-for': uniqueSourceIp() },
        maxRedirects: 0,
      });

      // 失敗の報告にトークンを出さないよう、本文そのものではなく字の有無（真偽）で比べる。
      const responses = [
        { label: '/api/auth/otp/verify', status: otpVerify.status(), text: await otpVerify.text() },
        { label: '/api/auth/refresh', status: refresh.status(), text: await refresh.text() },
      ];
      for (const { label, status, text } of responses) {
        expect.soft(status, `${label} は成功の応答（本文を確かめる前提）`).toBe(200);
        for (const word of ['access_token', 'refresh_token', 'app_metadata']) {
          expect.soft(text.includes(word), `${label} の本文に ${word} の字が無い`).toBe(false);
        }
      }
    });

    test(`SEC-AUTH-022-AC-02 login・otp/verify・refresh・mfa/enroll-totp・mfa/verify・mfa/status の応答に Cache-Control: no-store が付く (${viewport.name})`, async ({
      page,
      request,
      baseURL,
    }) => {
      test.fail(true, 'SEC-AUTH-022 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const origin = originOf(baseURL);
      const url = (path: string) => new URL(path, origin).toString();
      const anonymousHeaders = () => ({ origin, 'x-forwarded-for': uniqueSourceIp() });
      const anonymousPost = (path: string, data: unknown) =>
        request.post(url(path), { headers: anonymousHeaders(), data, maxRedirects: 0 });
      const factorId = '00000000-0000-4000-8000-000000000000';

      const { otpVerify } = await loginCapturingOtpVerify(page, 'cache-control');
      const memberPost = (path: string, data?: unknown) =>
        page.request.post(url(path), { headers: anonymousHeaders(), data, maxRedirects: 0 });

      const checks: Array<{ label: string; response: APIResponse }> = [
        // login: 本文が足りない誤りと、整った本文のボット判定・パスワードの誤り（Turnstile の設定で 403 か 401）
        { label: 'login（本文の誤り）', response: await anonymousPost('/api/auth/login', {}) },
        {
          label: 'login（整った本文）',
          response: await anonymousPost('/api/auth/login', {
            email: `e2e-nobody-${randomBytes(4).toString('hex')}@example.com`,
            password: 'Wrong-pass-1234!',
          }),
        },
        // otp/verify: ログインの成功の応答と、パスワードを通った印が無い応答
        { label: 'otp/verify（成功）', response: otpVerify },
        { label: 'otp/verify（印なし）', response: await anonymousPost('/api/auth/otp/verify', { code: '12345678' }) },
        // refresh: 未ログイン・ログイン済み
        { label: 'refresh（未ログイン）', response: await anonymousPost('/api/auth/refresh', {}) },
        { label: 'mfa/enroll-totp（未ログイン）', response: await anonymousPost('/api/auth/mfa/enroll-totp', {}) },
        { label: 'mfa/verify（未ログイン）', response: await anonymousPost('/api/auth/mfa/verify', { factorId, code: '123456' }) },
        {
          label: 'mfa/status（未ログイン）',
          response: await request.get(url('/api/auth/mfa/status'), { headers: anonymousHeaders(), maxRedirects: 0 }),
        },
        // 会員（管理者でも補助でもない）: mfa の窓口は 403
        { label: 'mfa/enroll-totp（会員）', response: await memberPost('/api/auth/mfa/enroll-totp', {}) },
        { label: 'mfa/verify（会員）', response: await memberPost('/api/auth/mfa/verify', { factorId, code: '123456' }) },
        {
          label: 'mfa/status（会員）',
          response: await page.request.get(url('/api/auth/mfa/status'), { maxRedirects: 0 }),
        },
        // refresh は新しい対に替えるので最後
        { label: 'refresh（ログイン済み）', response: await memberPost('/api/auth/refresh', {}) },
      ];

      for (const { label, response } of checks) {
        const cacheControl = response.headers()['cache-control'] ?? '';
        expect.soft(cacheControl, `${label}（status ${response.status()}）に Cache-Control: no-store が付く`).toMatch(/\bno-store\b/i);
      }
    });

    test(`SEC-AUTH-024-AC-01 ログインの後の Cookie の属性が決まりどおり（sb-access-token・sb-refresh-token は HttpOnly・SameSite=Lax、sb-login-2fa-session は HttpOnly・SameSite=Strict） (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      await loginCapturingOtpVerify(page, 'cookie-flags');

      const cookies = await cookieMap(page, origin);
      for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
        const cookie = cookies.get(name);
        expect.soft(cookie, `ログインの後に ${name} がある`).toBeDefined();
        expect.soft(cookie?.httpOnly, `${name} は HttpOnly`).toBe(true);
        expect.soft(cookie?.sameSite, `${name} は SameSite=Lax`).toBe('Lax');
      }

      // sb-login-2fa-session は確認コードの検証で消えるので、本物のログインの窓口（/api/auth/login）の応答の Set-Cookie を読む。
      // 窓口にはパスワードを通す必要があるので、既知のパスワードの会員を別に作る。
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceKey || !isLocalUrl(supabaseUrl)) throw new Error('会員を作れるのは手元の Supabase だけ');
      const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const email = `e2e-cookie-flags-pw-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
      const password = `E2e-${randomBytes(12).toString('hex')}!`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data.user) throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}）`);
      try {
        const login = await page.request.post(new URL('/api/auth/login', origin).toString(), {
          headers: { origin, 'x-forwarded-for': uniqueSourceIp() },
          data: { email, password, turnstileToken: 'e2e-probe' },
          maxRedirects: 0,
        });
        expect(login.status(), 'パスワードを通ると確認コードの段へ進む（200）').toBe(200);
        const issued = login
          .headersArray()
          .filter((header) => header.name.toLowerCase() === 'set-cookie')
          .map((header) => parseSetCookie(header.value))
          .find((cookie) => cookie.name === LOGIN_2FA_COOKIE);
        expect(issued, `アプリが ${LOGIN_2FA_COOKIE} を発行する`).toBeDefined();
        expect.soft(issued?.attributes, `${LOGIN_2FA_COOKIE} は HttpOnly`).toContain('httponly');
        expect.soft(issued?.attributes, `${LOGIN_2FA_COOKIE} は SameSite=Strict`).toContain('samesite=strict');
      } finally {
        await admin.auth.admin.deleteUser(created.data.user.id).catch(() => undefined);
      }
    });
  });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-030 callback screen (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-026-AC-01 ログイン済みで /auth/callback?next=//evil.example を開いても、店のサイトの中（/auth/verified）に留まる (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      test.fail(true, 'SEC-AUTH-026 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      const origin = originOf(baseURL);
      await loginCapturingOtpVerify(page, 'open-redirect');

      // 外へ出てしまった時に本当の外部へ通信しないよう、evil.example への要求は止めて記録する。
      const requestedEvil: string[] = [];
      await page.route(/^https?:\/\/evil\.example(?::\d+)?(?:\/|$)/, async (route) => {
        requestedEvil.push(route.request().url());
        await route.abort();
      });
      const visited: string[] = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(frame.url());
      });

      await page.goto('/auth/callback?next=//evil.example');

      const atVerifiedOrOutside = () =>
        requestedEvil.length > 0 ||
        visited.some((visitedUrl) => {
          try {
            const parsed = new URL(visitedUrl);
            return parsed.origin !== origin || parsed.pathname === '/auth/verified';
          } catch {
            return true;
          }
        });
      await expect.poll(atVerifiedOrOutside, { timeout: 15_000 }).toBe(true);

      expect(requestedEvil, 'evil.example へ要求が出ない').toEqual([]);
      expect(
        visited.filter((visitedUrl) => {
          try {
            return new URL(visitedUrl).origin !== origin;
          } catch {
            return true;
          }
        }),
        '店のサイトの外へ移らない',
      ).toEqual([]);
      expect(
        visited.some((visitedUrl) => new URL(visitedUrl).pathname === '/auth/verified'),
        '既定の道（/auth/verified）に替わる',
      ).toBe(true);
    });
  });
}
