/**
 * FR-LOGIN-038 ログインの後の戻り先（サーバーに控え、番号だけを HttpOnly の Cookie で渡す）
 * 対応: FR-AUTH-005-AC-01〜07 / SEC-AUTH-026-AC-02・AC-03 / SEC-AUTH-032-AC-01・AC-02
 *
 * 設計: ADR-0412（docs/03_BasicDesign/decisions/ADR-0412-return-intent-server-side-cookie-id.md）。
 * ログインを始める POST（/api/auth/login・/api/auth/oauth/start・/api/auth/register）が戻り先を確かめて控え、
 * 番号は Cookie sb-return-intent にだけ置く。出口（POST /api/auth/post-login・確認のリンク・Google の戻り）で使い切る。
 *
 * 手元の Supabase とメール受け（Mailpit）だけで流す。会員は画面から入れるようにパスワード付きで作る。
 * - 画面の幅は 3 つ（390・768・1280）すべてで流す。幅の例外は使わない。
 * - 管理者・サポーターの 2 段目（TOTP）は、手元の GoTrue の TOTP が無効でも流れるよう FR-LOGIN-032 と同じ材料で作る
 *   （auth.mfa_factors に verified の行・auth.mfa_amr_claims に totp の行を足し、refresh で aal2 にする）。
 *   本物の enroll-totp → verify の流れは FR-LOGIN-032 が受け持つ。ここで確かめるのは「aal2 になった後に戻り先が使い切られる」こと。
 * - Google の本物の画面は開かない。開始の窓口の応答（200 と url と Cookie）だけを確かめる。
 * - page.request.post で状態を変える窓口を叩く所には Origin を付ける（proxy の Origin 検査に通すため。付け忘れは 403）。
 * Cookie・確認コードが通信記録に残らないよう trace は切る。失敗の報告にも番号の値を出さない（真偽だけで比べる）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { injectTurnstileToken } from './turnstile-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ timeout: 180_000 });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const RETURN_INTENT_COOKIE = 'sb-return-intent';
const ACCESS_COOKIE = 'sb-access-token';
const CSRF_COOKIE = 'sb-csrf-token';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_INTENT_MAX_AGE_SECONDS = 900;

// ---- 基本の部品 ----

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

type ParsedCookie = { name: string; value: string; attributes: string[] };

/** Set-Cookie の1行を、名前・値・属性（小文字）に分ける。 */
function parseSetCookie(line: string): ParsedCookie {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  return {
    name: eq < 0 ? pair : pair.slice(0, eq),
    value: eq < 0 ? '' : pair.slice(eq + 1),
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}

/** 応答の Set-Cookie のうち、その名前のもの（入った順）。 */
function setCookiesNamed(headers: ReadonlyArray<{ name: string; value: string }>, name: string): ParsedCookie[] {
  return headers
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => parseSetCookie(header.value))
    .filter((cookie) => cookie.name === name);
}

function expectClearedReturnIntent(headers: ReadonlyArray<{ name: string; value: string }>, label: string): void {
  const cookies = setCookiesNamed(headers, RETURN_INTENT_COOKIE);
  expect(cookies.length, `${label}: ${RETURN_INTENT_COOKIE} の Set-Cookie がある`).toBeGreaterThan(0);
  const last = cookies[cookies.length - 1];
  expect(last.value, `${label}: 値が空`).toBe('');
  expect(last.attributes, `${label}: Max-Age=0 で消す`).toContain('max-age=0');
}

// ---- 会員 ----

type Member = { userId: string; email: string; password: string };

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('会員を作れるのは手元の Supabase だけ');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 画面から入るので、パスワードを知っている会員を手元の Supabase にだけ作る。role を渡すと DB の役割もそろえる。 */
async function createMember(label: string, role?: 'admin'): Promise<Member> {
  const email = `e2e-return-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const { data, error } = await localAdmin()
    .auth.admin.createUser({ email, password, email_confirm: true })
    .catch(() => {
      // SDK の例外に秘密値が含まれても、失敗の報告へ引き継がないため。
      throw new Error('手元の会員を作る要求に失敗した');
    });
  if (error || !data.user) {
    throw new Error(`手元の会員を作れない（status: ${error?.status ?? '不明'}, code: ${error?.code ?? '不明'}）`);
  }
  if (role) {
    await withLocalDb((db) => assignRole(db, data.user.id, role));
  }
  return { userId: data.user.id, email, password };
}

/** auth.users の役割（app_metadata）と public.user_roles の割り当てを同じ役割にそろえる（FR-LOGIN-032 と同じ）。 */
async function assignRole(db: PgClient, userId: string, role: 'admin'): Promise<void> {
  await db.query(
    `update auth.users
        set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', $2::text)
      where id = $1::uuid`,
    [userId, role],
  );
  const assigned = await db.query(
    `insert into public.user_roles (user_id, role_id, active, expires_at)
     select $1::uuid, r.id, true, null from public.roles r where r.code = $2
     on conflict (user_id, role_id) do update set active = true, expires_at = null`,
    [userId, role],
  );
  if (assigned.rowCount !== 1) throw new Error(`役割 ${role} の行が手元の DB に無い`);
}

/** 2要素の登録（verified の totp）を1つ足す。登録済みの管理者の状態を作る（FR-LOGIN-032 と同じ）。 */
async function addVerifiedTotpFactor(db: PgClient, userId: string): Promise<void> {
  await db.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
     values (gen_random_uuid(), $1::uuid, $2, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`,
    [userId, `e2e-${randomBytes(4).toString('hex')}`],
  );
}

// ---- 画面からのログイン ----

/** 画面から送る /api/auth/* に、試験ごとの送り元を付ける（回数の制限を共有の枠で使い切らないため）。 */
async function routeSourceIp(page: Page, ip: string): Promise<void> {
  for (const pattern of ['**/api/auth/login', '**/api/auth/otp/verify', '**/api/auth/post-login']) {
    await page.route(pattern, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), 'x-real-ip': ip } });
    });
  }
}

/** 今開いている /login の画面で、パスワードと確認コードを入れてサインインする。サインインを押すところまで。 */
async function signInOnLoginScreen(page: Page, member: Member): Promise<void> {
  // 新しく届いたメールだけを確認コードとして読むため、送る前に既存のメールを控える。
  const previousIds = new Set((await readMailpitMessages(member.email)).map((message) => message.ID));
  await injectTurnstileToken(page);
  await page.getByLabel('EMAIL').fill(member.email);
  await page.getByLabel('PASSWORD').fill(member.password);
  await page.getByRole('button', { name: 'ログイン' }).click();

  await expect(page).toHaveURL(/\/login\/verify$/);
  const code = await readLatestCode(member.email, previousIds);
  for (let index = 0; index < 8; index += 1) {
    await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(code[index]);
  }
  await page.getByRole('button', { name: 'サインイン' }).click();
}

/** ログインし終えた後の着地を、pathname + search で待つ。 */
async function expectLandedOn(page: Page, expected: string): Promise<void> {
  await expect
    .poll(
      () => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      },
      { timeout: 25_000, message: `ログインの後に ${expected} へ着く` },
    )
    .toBe(expected);
}

/** evil.example への要求を止めて記録し、店のサイトの外への移動も記録する。 */
async function watchOutsideTraffic(page: Page, origin: string): Promise<{ requestedEvil: string[]; outside: () => string[] }> {
  const requestedEvil: string[] = [];
  await page.route(/^https?:\/\/evil\.example(?::\d+)?(?:\/|$)/, async (route) => {
    requestedEvil.push(route.request().url());
    await route.abort();
  });
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  const outside = () =>
    visited.filter((visitedUrl) => {
      try {
        return new URL(visitedUrl).origin !== origin;
      } catch {
        return true;
      }
    });
  return { requestedEvil, outside };
}

// ---- API だけでのログイン（page.request。Cookie はブラウザの文脈と共有される） ----

type ApiLoginBody = { next?: unknown };

function postJson(page: Page, origin: string, path: string, ip: string, data?: unknown): Promise<APIResponse> {
  return page.request.post(new URL(path, origin).toString(), {
    headers: { origin, 'x-real-ip': ip },
    data,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
}

/** パスワードの段（POST /api/auth/login）を API で通す。next は本文にそのまま入れる。 */
function startLoginByApi(page: Page, origin: string, member: Member, ip: string, body: ApiLoginBody = {}): Promise<APIResponse> {
  return postJson(page, origin, '/api/auth/login', ip, {
    email: member.email,
    password: member.password,
    turnstileToken: 'e2e-probe',
    ...body,
  });
}

/** 確認コードの段（メールの 8 桁 → POST /api/auth/otp/verify）まで API で通す。 */
async function finishOtpByApi(page: Page, origin: string, member: Member, ip: string, previousIds: ReadonlySet<string>): Promise<void> {
  const code = await readLatestCode(member.email, previousIds);
  const verify = await postJson(page, origin, '/api/auth/otp/verify', ip, { code });
  expect(verify.status(), '確認コードが通る').toBe(200);
}

async function mailIdsOf(email: string): Promise<Set<string>> {
  return new Set((await readMailpitMessages(email)).map((message) => message.ID));
}

// ---- 管理者の 2 段目（aal2）の材料 ----

type Claims = { session_id?: string; aal?: string };

function claimsOf(jwt: string): Claims {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims;
}

async function accessTokenOf(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  const cookie = (await page.context().cookies(origin)).find((c) => c.name === ACCESS_COOKIE);
  if (!cookie?.value) throw new Error(`${ACCESS_COOKIE} の Cookie が無い`);
  return cookie.value;
}

/** ログイン済みの session に totp の印を足し、アプリの refresh を通して aal2 の Cookie にする（FR-LOGIN-032 と同じ）。 */
async function elevateCookieToAal2(page: Page, ip: string): Promise<void> {
  const sessionId = claimsOf(await accessTokenOf(page)).session_id;
  if (!sessionId) throw new Error('JWT に session_id が無い');
  await withLocalDb((db) =>
    db.query(
      `insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
       values (gen_random_uuid(), $1::uuid, now(), now(), 'totp')`,
      [sessionId],
    ),
  );
  const origin = new URL(page.url()).origin;
  const refreshed = await postJson(page, origin, '/api/auth/refresh', ip);
  if (!refreshed.ok()) throw new Error(`session を更新できない: ${refreshed.status()}`);
  if (claimsOf(await accessTokenOf(page)).aal !== 'aal2') {
    throw new Error('JWT が aal2 にならない（手元の GoTrue が amr の行から aal を出す前提が崩れた）');
  }
}

// ======================================================================================

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-038 login return-to (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-005-AC-01 ヘッダーのログインから入ると、開いていた頁（検索条件つき）へ戻る (${viewport.name})`, async ({ page }) => {
      const member = await createMember(`ac01-${viewport.name}`);
      await routeSourceIp(page, uniqueSourceIp());

      await page.goto('/stockist?from=e2e');
      const headerLogin = page.getByRole('banner').getByRole('link', { name: 'ログイン', exact: true });
      await expect(headerLogin).toHaveAttribute('href', '/login?next=%2Fstockist%3Ffrom%3De2e');
      await headerLogin.click();
      await expect(page).toHaveURL(/\/login\?next=/);

      await signInOnLoginScreen(page, member);

      await expectLandedOn(page, '/stockist?from=e2e');
      expect(new URL(page.url()).hash, 'fragment は付かない').toBe('');
    });

    test(`FR-AUTH-005-AC-02 /account を未ログインで開いてログインすると /account へ戻る (${viewport.name})`, async ({ page }) => {
      const member = await createMember(`ac02-${viewport.name}`);
      await routeSourceIp(page, uniqueSourceIp());

      await page.goto('/account');
      const gateLogin = page.locator('#main-content').getByRole('link', { name: 'ログイン', exact: true });
      await expect(gateLogin).toHaveAttribute('href', '/login?next=%2Faccount');
      await gateLogin.click();
      await expect(page).toHaveURL(/\/login\?next=/);

      await signInOnLoginScreen(page, member);

      await expectLandedOn(page, '/account');
    });

    test(`FR-AUTH-005-AC-03 /login を直接開いてログインすると / へ着く (${viewport.name})`, async ({ page }) => {
      const member = await createMember(`ac03-${viewport.name}`);
      await routeSourceIp(page, uniqueSourceIp());

      await page.goto('/login');
      await signInOnLoginScreen(page, member);

      await expectLandedOn(page, '/');
    });

    for (const [label, next] of [
      ['protocol-relative', '//evil.example'],
      ['tab-prefixed', '%2F%09%2Fevil.example'],
    ] as const) {
      test(`FR-AUTH-005-AC-04 外の住所・不正な値（${label}）の next では / へ着き、evil.example へ出ない (${viewport.name})`, async ({
        page,
        baseURL,
      }) => {
        const origin = originOf(baseURL);
        const member = await createMember(`ac04-${label}-${viewport.name}`);
        await routeSourceIp(page, uniqueSourceIp());
        const watch = await watchOutsideTraffic(page, origin);

        await page.goto(`/login?next=${next}`);
        await signInOnLoginScreen(page, member);

        await expectLandedOn(page, '/');
        expect(watch.requestedEvil, 'evil.example へ要求が出ない').toEqual([]);
        expect(watch.outside(), '店のサイトの外へ移らない').toEqual([]);
      });
    }

    test(`FR-AUTH-005-AC-04 ログインの窓口へ外の next を直接送っても、控えは作られず Cookie は Max-Age=0 で消される (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      const member = await createMember(`ac04-api-${viewport.name}`);
      await page.goto('/');

      const response = await startLoginByApi(page, origin, member, uniqueSourceIp(), { next: '//evil.example' });

      expect(response.status(), 'ログインそのものは止まらない').toBe(200);
      expectClearedReturnIntent(response.headersArray(), 'next=//evil.example');
    });

    test(`FR-AUTH-005-AC-05 管理者は確認コードの後に /auth/verified で 2 段目を通してから戻り先（/item）へ移る (${viewport.name})`, async ({ page }) => {
      const ip = uniqueSourceIp();
      const member = await createMember(`ac05-next-${viewport.name}`, 'admin');
      await withLocalDb((db) => addVerifiedTotpFactor(db, member.userId));
      await routeSourceIp(page, ip);

      await page.goto('/login?next=%2Fitem');
      await signInOnLoginScreen(page, member);

      // 確認コードを通しても aal1 のうちは戻り先へ移らず、2 段目（TOTP の入力）に止まる。戻り先は使い切られない。
      await expect(page).toHaveURL(/\/auth\/verified$/);
      await expect(page.getByLabel('認証コード（6〜8桁）')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/\/auth\/verified$/);

      // TOTP を通した状態（aal2）にして 2 段目の頁を開き直すと、戻り先が使い切られてそこへ移る。
      await elevateCookieToAal2(page, ip);
      await page.goto('/auth/verified');
      await expectLandedOn(page, '/item');
    });

    test(`FR-AUTH-005-AC-05 戻り先の無い管理者は 2 段目の後に /admin へ移る (${viewport.name})`, async ({ page }) => {
      const ip = uniqueSourceIp();
      const member = await createMember(`ac05-none-${viewport.name}`, 'admin');
      await withLocalDb((db) => addVerifiedTotpFactor(db, member.userId));
      await routeSourceIp(page, ip);

      await page.goto('/login');
      await signInOnLoginScreen(page, member);

      await expect(page).toHaveURL(/\/auth\/verified$/);
      await expect(page.getByLabel('認証コード（6〜8桁）')).toBeVisible({ timeout: 15_000 });

      await elevateCookieToAal2(page, ip);
      await page.goto('/auth/verified');
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 25_000, message: '2 段目の後に /admin 配下へ着く' })
        .toMatch(/^\/admin(\/|$)/);
    });

    for (const next of ['/login', '/api/auth/me', '/auth/verified'] as const) {
      test(`FR-AUTH-005-AC-06 戻り先が ${next} の時は / へ着く (${viewport.name})`, async ({ page }) => {
        const member = await createMember(`ac06-${viewport.name}`);
        await routeSourceIp(page, uniqueSourceIp());

        await page.goto(`/login?next=${encodeURIComponent(next)}`);
        await signInOnLoginScreen(page, member);

        await expectLandedOn(page, '/');
      });
    }

    test(`FR-AUTH-005-AC-07 使った戻り先は 2 回目に使えない (${viewport.name})`, async ({ page, baseURL }) => {
      const origin = originOf(baseURL);
      const ip = uniqueSourceIp();
      const member = await createMember(`ac07-${viewport.name}`);
      await routeSourceIp(page, ip);
      // 画面からの post-login を止める（後に登録した route が勝つ）。画面は失敗の既定で / へ倒れ、控えは使われずに残る。
      await page.route('**/api/auth/post-login', (route) => route.abort());

      await page.goto('/login?next=%2Fstockist');
      await signInOnLoginScreen(page, member);
      await expectLandedOn(page, '/');

      // page.route は page.request に掛からない。残った控えを API で 2 回続けて使う。
      const first = await postJson(page, origin, '/api/auth/post-login', ip);
      expect(first.status()).toBe(200);
      expect(((await first.json()) as { redirectTo?: string }).redirectTo, '1 回目は戻り先').toBe('/stockist');
      expectClearedReturnIntent(first.headersArray(), '1 回目');

      const second = await postJson(page, origin, '/api/auth/post-login', ip);
      expect(second.status()).toBe(200);
      expect(((await second.json()) as { redirectTo?: string }).redirectTo, '2 回目は使えず既定').toBe('/');
    });

    for (const redirectTo of ['%2F%09%2Fevil.example', '//evil.example', '/.//evil.example'] as const) {
      test(`SEC-AUTH-026-AC-02 確認のリンクの redirect_to=${redirectTo} では外へ出ず、店の /login へ送る (${viewport.name})`, async ({ request, baseURL }) => {
        const origin = originOf(baseURL);
        for (const tokenQuery of ['', '&token_hash=invalid-token&type=signup']) {
          const response = await request.get(`/api/auth/confirm?redirect_to=${redirectTo}${tokenQuery}`, {
            maxRedirects: 0,
            failOnStatusCode: false,
            headers: { 'x-real-ip': uniqueSourceIp() },
          });
          expect(response.status(), '303 で送る').toBe(303);
          const location = response.headers()['location'];
          expect(location, 'Location がある').toBeTruthy();
          const target = new URL(location, origin);
          expect(target.origin, 'Location は店のサイトの中').toBe(origin);
          expect(target.pathname, '固定の /login').toBe('/login');
        }
      });
    }

    test(`SEC-AUTH-026-AC-03 ログインの窓口へ外の next を送って成功させても、確認コードの後の行き先は / になる (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      const ip = uniqueSourceIp();
      const member = await createMember(`sec026-${viewport.name}`);
      await page.goto('/');
      const previousIds = await mailIdsOf(member.email);

      const login = await startLoginByApi(page, origin, member, ip, { next: '//evil.example' });
      expect(login.status(), '外の next でもログインは進む').toBe(200);
      await finishOtpByApi(page, origin, member, ip, previousIds);

      const destination = await postJson(page, origin, '/api/auth/post-login', ip);
      expect(destination.status()).toBe(200);
      expect(((await destination.json()) as { redirectTo?: string }).redirectTo, '外の住所には着かず / になる').toBe('/');
    });

    test(`SEC-AUTH-032-AC-01 控えの Cookie は HttpOnly・SameSite=Lax・Path=/・Max-Age=900 で、番号は URL・応答・Location に出ない (${viewport.name})`, async ({ page }) => {
      const member = await createMember(`sec032a-${viewport.name}`);
      await routeSourceIp(page, uniqueSourceIp());

      // 通ったすべての URL・要求の本文・Location・応答の本文を集める（番号は後で真偽だけで探す）。
      const seen: string[] = [];
      const pending: Array<Promise<unknown>> = [];
      const headerReads: Array<Promise<unknown>> = [];
      const authBodyReads: Array<Promise<unknown>> = [];
      let loginHeaders: ReadonlyArray<{ name: string; value: string }> = [];
      page.on('request', (request) => {
        seen.push(request.url());
        const body = request.postData();
        if (body) seen.push(body);
      });
      page.on('response', (response: Response) => {
        seen.push(response.url());
        const location = response.headers()['location'];
        if (location) seen.push(location);
        const isLoginPost = new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST';
        if (isLoginPost) {
          headerReads.push(response.headersArray().then((headers) => (loginHeaders = headers)).catch(() => undefined));
        }
        if (['document', 'fetch', 'xhr'].includes(response.request().resourceType())) {
          // 番号が通るログインの窓口とページの本文は必ず読み切る。それ以外は画面の移動で読めなくなることがあるので下で上限をつける。
          const type = response.request().resourceType();
          const reads = type === 'document' || new URL(response.url()).pathname.startsWith('/api/auth/') ? authBodyReads : pending;
          reads.push(response.text().then((text) => seen.push(text)).catch(() => undefined));
        }
      });

      await page.goto('/login?next=%2Fstockist');
      await signInOnLoginScreen(page, member);
      await expectLandedOn(page, '/stockist');
      await Promise.allSettled(headerReads);
      await Promise.allSettled(authBodyReads);
      await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 10_000))]);

      const issued = setCookiesNamed(loginHeaders, RETURN_INTENT_COOKIE).at(-1);
      expect(issued, `ログインの応答が ${RETURN_INTENT_COOKIE} を発行する`).toBeDefined();
      expect(issued?.attributes, 'HttpOnly').toContain('httponly');
      expect(issued?.attributes, 'SameSite=Lax').toContain('samesite=lax');
      expect(issued?.attributes, 'Path=/').toContain('path=/');
      expect(issued?.attributes, `Max-Age=${LOGIN_INTENT_MAX_AGE_SECONDS}`).toContain(`max-age=${LOGIN_INTENT_MAX_AGE_SECONDS}`);
      expect(TOKEN_PATTERN.test(issued?.value ?? ''), '値は 43 文字の base64url（256 ビット）').toBe(true);

      const token = issued?.value ?? '';
      expect(
        seen.some((entry) => entry.includes(token)),
        '番号が URL・要求の本文・Location・応答の本文のどこにも出ない',
      ).toBe(false);
    });

    test(`SEC-AUTH-032-AC-01 Google の開始でも 200 の本文は Supabase の url だけで、番号は Cookie にだけ置かれる (${viewport.name})`, async ({ page, baseURL }) => {
      const origin = originOf(baseURL);
      await page.goto('/');

      const response = await postJson(page, origin, '/api/auth/oauth/start', uniqueSourceIp(), {
        provider: 'google',
        next: '/stockist',
      });

      expect(response.status(), '開始は 200').toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { url?: unknown };
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
      expect(typeof body.url === 'string' && body.url.startsWith(`${supabaseUrl}/auth/v1/authorize`), '本文の url は Supabase の authorize').toBe(true);
      const issued = setCookiesNamed(response.headersArray(), RETURN_INTENT_COOKIE).at(-1);
      expect(issued, `${RETURN_INTENT_COOKIE} の Set-Cookie がある`).toBeDefined();
      expect(issued?.attributes).toContain('httponly');
      expect(issued?.attributes).toContain('samesite=lax');
      expect(TOKEN_PATTERN.test(issued?.value ?? ''), '値は 43 文字の base64url').toBe(true);
      expect(text.includes(issued?.value ?? ''), '番号が本文に出ない').toBe(false);
      expect((body.url as string).includes(issued?.value ?? ''), '番号が authorize の url に出ない').toBe(false);
    });

    test(`SEC-AUTH-032-AC-02 ログインの中断（cancel）とログアウトで、控えの Cookie が Max-Age=0 で消える (${viewport.name})`, async ({
      page,
      baseURL,
    }) => {
      const origin = originOf(baseURL);
      await page.goto('/');

      // 中断: next つきで確認コードの入力前（保留）まで進み、cancel で消える。
      const cancelled = await createMember(`sec032b-cancel-${viewport.name}`);
      const started = await startLoginByApi(page, origin, cancelled, uniqueSourceIp(), { next: '/stockist' });
      expect(started.status()).toBe(200);
      expect(setCookiesNamed(started.headersArray(), RETURN_INTENT_COOKIE).at(-1)?.value ?? '', '開始で控えの Cookie が置かれる').not.toBe('');
      const cancel = await postJson(page, origin, '/api/auth/login/cancel', uniqueSourceIp());
      expect(cancel.status()).toBe(200);
      expectClearedReturnIntent(cancel.headersArray(), 'cancel');

      // ログアウト: ログインを終えた端末（戻り先は使い切っていない）で、ログアウトの応答が消す。
      const loggedIn = await createMember(`sec032b-logout-${viewport.name}`);
      const ip = uniqueSourceIp();
      const previousIds = await mailIdsOf(loggedIn.email);
      const second = await startLoginByApi(page, origin, loggedIn, ip, { next: '/stockist' });
      expect(second.status()).toBe(200);
      await finishOtpByApi(page, origin, loggedIn, ip, previousIds);
      const csrf = (await page.context().cookies(origin)).find((cookie) => cookie.name === CSRF_COOKIE)?.value;
      if (!csrf) throw new Error('CSRF の Cookie が無い');
      const logout = await page.request.post(new URL('/api/auth/logout', origin).toString(), {
        headers: { origin, 'x-csrf-token': csrf, 'x-real-ip': uniqueSourceIp() },
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      expect(logout.status()).toBe(200);
      expectClearedReturnIntent(logout.headersArray(), 'logout');
    });
  });
}
