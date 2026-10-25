/**
 * FR-SIGNUP-003 会員登録の確認メールのリンク（/api/auth/confirm）
 * 対応: FR-LOGIN-004-AC-01・SEC-AUTH-006-AC-01・SEC-AUTH-006-AC-02・SEC-AUTH-007-AC-01
 *
 * 手元の Supabase とメール受け（Mailpit）だけを使う。印（token_hash）は管理 API の generateLink で作る（メールは送られない）。
 *
 * 決まった動き（ユーザーの決定、2026-10-25）: 確認のリンクは、登録を始めたブラウザでだけログインさせる。
 * 登録を始めていない別のブラウザで開いた時は、メールの確認（登録の完了）だけを済ませ、session は作らずに /login へ 303 で送り、
 * 登録が終わったのでログインするよう画面で知らせる。「このアカウントでログインしますか」と確かめる画面は無い。
 *
 * 現在の結果:
 * - SEC-AUTH-007-AC-01 だけが、上の動きをコードに入れる（/api/auth/confirm を登録を始めたブラウザに結ぶ）まで赤になる。
 *   今のコードは結び付けが無く、どのブラウザで開いても session を作る。直す時期はユーザーが決める（trace-matrix の TM-AUTH-64）。
 * - SEC-AUTH-006-AC-02 は今のコードで通る（同じブラウザで開けば session を作り 303 で送る）。結び付けを入れた後も緑のままでなければならない守り。
 * - FR-LOGIN-004-AC-01 は Confirm email が有効な前提。手元の supabase/config.toml は無効（enable_confirmations = false）で、
 *   登録するとその場でログインし確認メールも出ない。有効にし、確認メールの文面を
 *   `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=signup` へのリンクにするまで赤。
 * - SEC-AUTH-006-AC-01 は今のコードが満たさない（要件に「今のコードは満たさない」と明記）ので赤。
 *
 * 「登録を始めたブラウザ」の作り方（手元で Confirm email が無効でも動く）:
 * 手元で本当に登録を送ると、その場で確認済みになり session が付くので、確認のリンクの印が残らない。
 * そこで未確認の会員と signup の印を管理 API の generateLink で先に作る（本番の確認メールの印と同じ状態）。
 * そのメールの登録を、Playwright の context（ブラウザ A）の /login の画面から送る（会員がいるので 202 が返る）。
 * 登録の応答で、アプリが「登録を始めた」目印の Cookie をそのブラウザに置くなら、ブラウザ A の context に入る。
 * 確認のリンクは、同じ context（SEC-AUTH-006-AC-02）か、Cookie の無い別の context（SEC-AUTH-007-AC-01）で開く。
 *
 * 結び付けの規則（コードを直す人への前提。SEC-AUTH-007・SEC-AUTH-016）:
 * /api/auth/register の 202 は 2 通りある（新規の登録＝signUp を呼ぶ枝と、登録済みのメール＝見つかった枝）。
 * 「登録を始めた」目印の Cookie は、この両方の 202 で同じように置く。片方でしか置かないと、応答が変わって
 * 登録済みかどうかが分かってしまう（SEC-AUTH-016）。このテストは手元の設定の都合で登録済みの枝を通るので、
 * 新規の枝でだけ置く実装にすると SEC-AUTH-006-AC-02 が正しい直しの後に赤くなる。
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type APIRequestContext, type APIResponse, type Page, type Response } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { stubTurnstileScript } from './turnstile-test-utils';

// 確認のリンクの印・パスワードをブラウザの通信記録に残さない。
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const ACCESS_COOKIE = 'sb-access-token';
const REFRESH_COOKIE = 'sb-refresh-token';
const REDIRECT_PATH = '/auth/verified';

function localSupabase(): { admin: SupabaseClient; url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey || !isLocalUrl(url)) {
    throw new Error('この試験が使えるのは手元の Supabase だけ');
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return { admin, url, anonKey };
}

function uniqueEmail(label: string): string {
  return `e2e-signup-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

function strongPassword(): string {
  return `E2e-${randomBytes(12).toString('hex')}!`;
}

/** 回数の制限は送り元ごとに数える。全部の E2E が共有する 127.0.0.1 の枠を使い切らないよう、試験ごとに別の送り元にする。 */
function uniqueForwardedFor(): string {
  const octet = () => 1 + (randomBytes(1)[0] % 250);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type LinkType = 'signup' | 'magiclink' | 'recovery' | 'email';

/**
 * その type で /api/auth/confirm に渡す token_hash を作る。
 * email は GoTrue が magiclink の印を受けるので、magiclink の印を使う。
 * 作った会員は後で消すため id を返す。
 */
async function issueTokenHash(admin: SupabaseClient, type: LinkType, label: string): Promise<{ tokenHash: string; email: string; userId: string }> {
  const email = uniqueEmail(label);
  const password = strongPassword();
  if (type === 'signup') {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email, password });
    if (error || !data.properties?.hashed_token || !data.user) {
      throw new Error(`signup の印を作れない（status: ${error?.status ?? '不明'}）`);
    }
    return { tokenHash: data.properties.hashed_token, email, userId: data.user.id };
  }
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`手元の会員を作れない（status: ${created.error?.status ?? '不明'}）`);
  }
  const linkType = type === 'recovery' ? 'recovery' : 'magiclink';
  const { data, error } = await admin.auth.admin.generateLink({ type: linkType, email });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`${linkType} の印を作れない（status: ${error?.status ?? '不明'}）`);
  }
  return { tokenHash: data.properties.hashed_token, email, userId: created.data.user.id };
}

async function removeUsers(admin: SupabaseClient, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {
      // 後片付けの失敗で試験の結果を変えない。
    }
  }
}

/** 窓口を、リダイレクトを辿らずに開く。 */
async function openConfirmLink(
  request: APIRequestContext,
  params: { tokenHash: string; type: LinkType; redirectTo?: string },
): Promise<APIResponse> {
  const query = new URLSearchParams({ token_hash: params.tokenHash, type: params.type });
  if (params.redirectTo) query.set('redirect_to', params.redirectTo);
  return request.get(`/api/auth/confirm?${query.toString()}`, {
    maxRedirects: 0,
    failOnStatusCode: false,
    headers: { 'x-forwarded-for': uniqueForwardedFor() },
  });
}

/** 応答の Set-Cookie から、その名前で値のある Cookie が書かれたかを読む。 */
function writtenCookieValue(headers: ReadonlyArray<{ name: string; value: string }>, name: string): string | null {
  for (const header of headers) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const pair = header.value.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name && pair.slice(eq + 1).trim() !== '') {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

/** 印が本物であることの確かめ。GoTrue へ直接渡して session が返れば、窓口が session を作らなかった理由は印の不備ではない。 */
async function expectTokenVerifiable(
  admin: SupabaseClient,
  gotrue: { url: string; anonKey: string },
  type: LinkType,
  label: string,
): Promise<void> {
  const issued = await issueTokenHash(admin, type, `${label}-ctl`);
  try {
    const response = await fetch(`${gotrue.url}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: gotrue.anonKey },
      body: JSON.stringify({ type, token_hash: issued.tokenHash }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status, `${type} の印を作る手順が、GoTrue で確かめられる印を作れていない`).toBe(200);
  } finally {
    await removeUsers(admin, [issued.userId]);
  }
}

// ---- Mailpit ----

type MailpitList = { messages?: Array<{ ID: string }> };
type MailpitMessage = { HTML?: string; Text?: string };

function mailUrl(): string {
  const url = process.env.MAIL_LOCAL_URL;
  if (!url || !isLocalUrl(url)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  return url;
}

/** 宛先へ届いた最新のメールの本文を読む。届くまで待つ。 */
async function latestMailTo(request: APIRequestContext, email: string): Promise<MailpitMessage> {
  let messageId = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(new URL('/api/v1/search', mailUrl()).toString(), {
          params: { query: `to:${email}` },
          timeout: 5_000,
        });
        const body = (await response.json()) as MailpitList;
        messageId = body.messages?.[0]?.ID ?? '';
        return messageId !== '';
      },
      { timeout: 30_000, message: `${email} への確認メールが届かない（Confirm email が有効か確かめる）` },
    )
    .toBe(true);
  const response = await request.get(new URL(`/api/v1/message/${encodeURIComponent(messageId)}`, mailUrl()).toString(), {
    timeout: 5_000,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as MailpitMessage;
}

/** メール本文のリンクのうち、確認のためのもの（印を含む）を取り出す。 */
function confirmLinkOf(mail: MailpitMessage): string {
  const hrefs = [...(mail.HTML ?? '').matchAll(/href="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, '&'));
  const textLinks = (mail.Text ?? '').match(/https?:\/\/\S+/g) ?? [];
  const link = [...hrefs, ...textLinks].find((href) => /token|confirm|verify/i.test(href));
  expect(link, '確認メールに確認のリンクが無い').toBeTruthy();
  return link as string;
}

/** ブラウザ（page の context）の /login の画面から会員登録を送る。確認メールを送った旨が出るまで待つ。 */
async function submitSignupFromBrowser(page: Page, email: string): Promise<void> {
  const password = strongPassword();
  await stubTurnstileScript(page);
  const sourceIp = uniqueForwardedFor();
  await page.route('**/api/auth/register', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': sourceIp } }),
  );
  await page.goto('/login');
  await page.getByRole('tab', { name: '会員登録' }).click();
  const panel = page.getByRole('tabpanel');
  await panel.getByLabel('Email').fill(email);
  await panel.getByLabel('Password', { exact: true }).fill(password);
  await panel.getByLabel('Confirm Password', { exact: true }).fill(password);
  // ボット検証の印が入るまで送らない（入る前だと「ボット検証を完了してください」で止まる）。
  await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');
  await panel.getByRole('button', { name: '登録して確認メールを受け取る' }).click();
  await expect(page.getByText(/確認メールを送信しました|Confirmation email sent/)).toBeVisible();
}

/** ブラウザで確認のリンクを開き、窓口の最初の応答（リダイレクト）を返す。印は 1 回しか使えないので、開くのは 1 回だけにする。 */
async function openConfirmLinkInBrowser(
  page: Page,
  params: { tokenHash: string; type: LinkType; redirectTo?: string },
): Promise<Response> {
  const query = new URLSearchParams({ token_hash: params.tokenHash, type: params.type });
  if (params.redirectTo) query.set('redirect_to', params.redirectTo);
  const sourceIp = uniqueForwardedFor();
  await page.route(/\/api\/auth\/confirm/, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': sourceIp } }),
  );
  const [hop] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/confirm'),
    page.goto(`/api/auth/confirm?${query.toString()}`),
  ]);
  return hop;
}

async function expectLoggedOutHeader(page: Page): Promise<void> {
  await expect(page.getByRole('banner').getByRole('link', { name: 'ログイン', exact: true })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'アカウント', exact: true })).toHaveCount(0);
}

for (const viewport of viewports) {
  test.describe(`FR-SIGNUP-003 signup confirm link (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FR-LOGIN-004-AC-01 register tab sends a confirmation mail and its link finishes the signup', async ({ page, request }) => {
      test.fail(true, 'ENV enable_confirmations=false（手元の Supabase の mailer_autoconfirm が true） — 手元の supabase/config.toml が本番と違う');
      test.setTimeout(120_000);
      const { admin, url, anonKey } = localSupabase();
      const email = uniqueEmail(`ui-${viewport.name}`);

      // 前提: 本番と同じく Confirm email が有効であること。無効だと登録した場面でログインし、確認メールも出ない。
      const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey }, signal: AbortSignal.timeout(10_000) });
      const settingsBody = (await settings.json()) as { mailer_autoconfirm?: boolean };
      expect(settingsBody.mailer_autoconfirm, '手元の Supabase の Confirm email が無効（supabase/config.toml の enable_confirmations）').toBe(false);

      await submitSignupFromBrowser(page, email);

      // まだログインした状態にならない。
      const cookiesAfterSubmit = await page.context().cookies();
      expect(cookiesAfterSubmit.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== '')).toBeUndefined();
      await expectLoggedOutHeader(page);

      // 届いたメールのリンクを開くと登録が終わり、ログインした状態になる。
      try {
        const link = confirmLinkOf(await latestMailTo(request, email));
        await page.goto(link);
        await expect
          .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), {
            message: '確認のリンクを開いても session の Cookie が書かれない',
          })
          .toBe(true);
        await expect(page.getByRole('banner').getByRole('link', { name: 'アカウント', exact: true })).toBeVisible();
      } finally {
        const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const created = listed.data?.users.find((user) => user.email === email);
        if (created) await removeUsers(admin, [created.id]);
      }
    });

    test('SEC-AUTH-006-AC-01 magiclink, recovery and email tokens do not write a session cookie', async ({ request }) => {
      test.fail(true, 'SEC-AUTH-006 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      test.setTimeout(120_000);
      const { admin, url, anonKey } = localSupabase();
      const userIds: string[] = [];
      try {
        for (const type of ['magiclink', 'recovery', 'email'] as const) {
          const issued = await issueTokenHash(admin, type, `006a-${type}`);
          userIds.push(issued.userId);

          const response = await openConfirmLink(request, { tokenHash: issued.tokenHash, type });

          // type=<magiclink|recovery|email> の印で開くと、sb-access-token の Cookie が書かれない。
          expect(writtenCookieValue(response.headersArray(), ACCESS_COOKIE), `type=${type} の印で ${ACCESS_COOKIE} の Cookie が書かれた`).toBeNull();
          expect(
            (await request.storageState()).cookies.find((cookie) => cookie.name === ACCESS_COOKIE),
            `type=${type} の印で ${ACCESS_COOKIE} が保存された`,
          ).toBeUndefined();

          // 印が本物だったこと（偽の印でたまたま書かれなかったのではないこと）。
          await expectTokenVerifiable(admin, { url, anonKey }, type, `006a-${type}`);
        }
      } finally {
        await removeUsers(admin, userIds);
      }
    });

    test('SEC-AUTH-006-AC-02 signup token opened on the browser that submitted the signup writes session cookies and redirects with 303', async ({ page }) => {
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      const issued = await issueTokenHash(admin, 'signup', `006b-${viewport.name}`);
      try {
        // ブラウザ A（この page の context）で登録を送る。
        await submitSignupFromBrowser(page, issued.email);
        const before = await page.context().cookies();
        expect(before.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), '確認のリンクを開く前に session の Cookie がある').toBeUndefined();

        // 同じブラウザ A で確認のリンクを開く。
        const hop = await openConfirmLinkInBrowser(page, { tokenHash: issued.tokenHash, type: 'signup', redirectTo: REDIRECT_PATH });

        // 登録を始めたブラウザで type=signup の印を開くと、session の Cookie が書かれ、redirect_to の内部の道へ 303 で送られる。
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe(REDIRECT_PATH);
        const after = await page.context().cookies();
        expect(after.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), `${ACCESS_COOKIE} の Cookie が書かれない`).toBeTruthy();
        expect(after.find((cookie) => cookie.name === REFRESH_COOKIE && cookie.value !== ''), `${REFRESH_COOKIE} の Cookie が書かれない`).toBeTruthy();
      } finally {
        await removeUsers(admin, [issued.userId]);
      }
    });

    test('SEC-AUTH-007-AC-01 signup token opened on a browser that did not start the signup confirms the email but logs nobody in', async ({ page, browser, baseURL }) => {
      test.fail(true, 'SEC-AUTH-007 今のコードは満たさない（docs/02_Requirements/areas/auth.md）');
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      const issued = await issueTokenHash(admin, 'signup', `007a-${viewport.name}`);
      // ブラウザ B は、Cookie も保存も共有しない別の context。
      const otherBrowser = await browser.newContext({ baseURL, viewport: { width: viewport.width, height: viewport.height } });
      try {
        // ブラウザ A（この page の context）で登録を送る。メールは、まだ確認されていない。
        await submitSignupFromBrowser(page, issued.email);
        const unconfirmed = await admin.auth.admin.getUserById(issued.userId);
        expect(unconfirmed.data.user?.email_confirmed_at ?? null, '前提: 開く前はメールが未確認').toBeNull();

        // 登録を始めていないブラウザ B で、確認のリンクを開く。
        expect(await otherBrowser.cookies(), 'ブラウザ B に Cookie が残っている').toEqual([]);
        const pageB = await otherBrowser.newPage();
        const hop = await openConfirmLinkInBrowser(pageB, { tokenHash: issued.tokenHash, type: 'signup', redirectTo: REDIRECT_PATH });

        // 303 で /login へ送られる（redirect_to の道へは送られない）。
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe('/login');

        // session の Cookie が書かれず、ブラウザ B に保存されない。
        const hopHeaders = await hop.headersArray();
        expect(writtenCookieValue(hopHeaders, ACCESS_COOKIE), `ブラウザ B で ${ACCESS_COOKIE} の Cookie が書かれた`).toBeNull();
        expect(writtenCookieValue(hopHeaders, REFRESH_COOKIE), `ブラウザ B で ${REFRESH_COOKIE} の Cookie が書かれた`).toBeNull();
        const cookiesB = await otherBrowser.cookies();
        expect(cookiesB.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), `ブラウザ B に ${ACCESS_COOKIE} が保存された`).toBeUndefined();
        expect(cookiesB.find((cookie) => cookie.name === REFRESH_COOKIE && cookie.value !== ''), `ブラウザ B に ${REFRESH_COOKIE} が保存された`).toBeUndefined();

        // メールは確認済みになっている（登録は終わっている）。
        const confirmed = await admin.auth.admin.getUserById(issued.userId);
        expect(confirmed.data.user?.email_confirmed_at, '確認のリンクを開いてもメールが確認済みにならない').toBeTruthy();

        // /login に、登録が終わったのでログインするよう知らせる文が出る。「このアカウントでログインしますか」の確かめの画面は経ない。
        await pageB.waitForURL((url) => url.pathname === '/login');
        await expect(pageB.getByText(/会員登録が完了しました/).first()).toBeVisible();
        await expect(pageB.getByText(/ログインしてください/).first()).toBeVisible();
        await expect(pageB.getByText(/このアカウントでログイン/)).toHaveCount(0);
        await expectLoggedOutHeader(pageB);
      } finally {
        await otherBrowser.close();
        await removeUsers(admin, [issued.userId]);
      }
    });
  });
}
