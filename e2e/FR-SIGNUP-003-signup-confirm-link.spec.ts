/**
 * FR-SIGNUP-003 会員登録の確認メールのリンク（/api/auth/confirm）
 * 対応: FR-LOGIN-004-AC-01・SEC-AUTH-006-AC-01・SEC-AUTH-006-AC-02・SEC-AUTH-007-AC-01・SEC-AUTH-007-AC-02・SEC-AUTH-007-AC-03
 *
 * 手元の Supabase とメール受け（Mailpit）だけを使う。印（token_hash）は管理 API の generateLink で作る（メールは送られない）。
 *
 * 決まった動き（ユーザーの決定、2026-10-25）: 確認のリンクは、登録を始めたブラウザでだけログインさせる。
 * 登録を始めていない別のブラウザで開いた時は、メールの確認（登録の完了）だけを済ませ、session は作らずに /login へ 303 で送り、
 * 登録が終わったのでログインするよう画面で知らせる。「このアカウントでログインしますか」と確かめる画面は無い。
 *
 * 現在の結果（2026-10-26、波 1-B。ADR-0413）:
 * - SEC-AUTH-007-AC-01・AC-02・AC-03 は、確認の窓口が登録を始めたブラウザ（控えの Cookie の番号と、確認した利用者のメールを
 *   一緒にハッシュした印が登録の控えに当たる）でだけ session を作ることを確かめる。通る。
 * - SEC-AUTH-006-AC-02 は同じブラウザで開けば session を作り 303 で送る守り。通る。
 * - FR-LOGIN-004-AC-01 は Confirm email が有効な前提。手元の supabase/config.toml は波 6 で本番と同じ
 *   enable_confirmations = true にした。確認メールのリンクは、`token_hash` と `type=signup` を持つ確認の窓口へのリンク
 *   でなければ、開いても session の Cookie が書かれず赤になる。そのため波 6 は supabase/config.toml に
 *   [auth.email.template.confirmation]（supabase/templates/confirmation.html。`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`）
 *   を足した。GoTrue の既定の ConfirmationURL（/auth/v1/verify）は印を GoTrue が使い切り、fragment で戻すので窓口では読めない。
 * - SEC-AUTH-006-AC-01 は、確認の窓口が type=signup の印だけを受け、magiclink・recovery・email の印では
 *   verifyOtp を呼ばず session の Cookie も書かないこと（窓口で開いた印そのものが GoTrue でまだ使える）を確かめる。通る。
 *
 * 「登録を始めたブラウザ」の作り方（手元の Confirm email の有無（切り替えの前後）どちらでも動く）:
 * 切り替えの前は、手元で本当に登録を送ると、その場で確認済みになり session が付くので、確認のリンクの印が残らない。
 * 切り替えの後は、本当の確認メールの印を使えるが、印を取り出す手間と期限（5 分）に左右されない。どちらでも同じ状態になるよう、
 * 未確認の会員と signup の印を管理 API の generateLink で先に作る（本番の確認メールの印と同じ状態）。
 * そのメールの登録を、Playwright の context（ブラウザ A）の /login の画面から送る（会員がいるので 202 が返る）。
 * 2026-11-01 から、未確認の会員の登録は確認メールを送り直す（SEC-AUTH-016-AC-04）。送り直しは GoTrue の印を作り直すので、
 * 先に作った印は使えなくなることがある（送り直しの間隔の枠に当たると印が残るので、時間で結果が変わる）。
 * 開く印は、登録を送った後に generateLink で作り直した物を使う（reissueSignupToken）。
 * 登録の応答で、アプリが「登録を始めた」目印の Cookie をそのブラウザに置くなら、ブラウザ A の context に入る。
 * 確認のリンクは、同じ context（SEC-AUTH-006-AC-02）か、Cookie の無い別の context（SEC-AUTH-007-AC-01）で開く。
 *
 * 行き先（SEC-AUTH-026・ADR-0412・ADR-0413）: 確認のリンクの URL の値（redirect_to など）は読まない。
 * 登録の時に /login?next=… から送った戻り先（無ければ /）を、登録したメールに結んでサーバーに控え、同じ端末の Cookie
 * （sb-return-intent）で session を作る前に使い切る。控えが無い端末（別のブラウザ）や、別のメールの印は、
 * 戻り先を使わず session も作らずに /login?registered=1 へ送る（控えの Cookie は消さない）。
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
const RETURN_PATH = '/stockist';

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

/** 回数の制限は送り元ごとに数える。見出しの無い要求が集まる「送り元なし」の枠を全部の E2E で使い切らないよう、試験ごとに別の送り元にする。 */
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

/** 登録を送った後の、未確認の会員の今の signup の印を作り直して返す（登録の送り直しが前の印を無効にするため）。 */
async function reissueSignupToken(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email, password: strongPassword() });
  if (error || !data.properties?.hashed_token) {
    throw new Error(`signup の印を作り直せない（status: ${error?.status ?? '不明'}）`);
  }
  return data.properties.hashed_token;
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
    headers: { 'x-real-ip': uniqueForwardedFor() },
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

/**
 * 窓口で開いた印そのものが、まだ使える（消費されていない）ことの確かめ。GoTrue へ直接渡して session が返れば、
 * 窓口は verifyOtp を呼ばず、印の不備でもなかった。呼ばれていれば印は使用済みで 4xx になる。
 */
async function expectTokenNotConsumed(
  gotrue: { url: string; anonKey: string },
  type: LinkType,
  tokenHash: string,
): Promise<void> {
  const response = await fetch(`${gotrue.url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: gotrue.anonKey },
    body: JSON.stringify({ type, token_hash: tokenHash }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status, `type=${type} の印が、窓口で開いた後に GoTrue で確かめられない（消費された、または印が不正）`).toBe(200);
}

// ---- Mailpit ----

type MailpitList = { messages?: Array<{ ID: string }> };
type MailpitMessage = { HTML?: string; Text?: string; Subject?: string };

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

/**
 * ブラウザ（page の context）の /login の画面から会員登録を送る。確認メールを送った旨が出るまで待つ。
 * next を渡すと /login?next=… から入り、登録の本文の next としてサーバーに控えられる。
 */
async function submitSignupFromBrowser(page: Page, email: string, next?: string): Promise<void> {
  const password = strongPassword();
  await stubTurnstileScript(page);
  const sourceIp = uniqueForwardedFor();
  await page.route('**/api/auth/register', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-real-ip': sourceIp } }),
  );
  await page.goto(next === undefined ? '/login' : `/login?next=${encodeURIComponent(next)}`);
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
    route.continue({ headers: { ...route.request().headers(), 'x-real-ip': sourceIp } }),
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

    test('SEC-AUTH-016-AC-04 an unconfirmed member who registers again gets the confirmation mail again and the same 202', async ({ page, request }) => {
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      // 確認のリンクを開かないまま切れた未確認の会員（generateLink はメールを送らない）。
      const issued = await issueTokenHash(admin, 'signup', `016d-${viewport.name}`);
      try {
        // GoTrue の送り直しの間隔（手元は max_frequency = 1s）を空けてから登録し直す。
        await page.waitForTimeout(2_000);
        const [registered] = await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register'),
          submitSignupFromBrowser(page, issued.email),
        ]);
        // 応答は新規の登録と同じ 202（画面も同じ「確認メールを送信しました」）。
        expect(registered.status()).toBe(202);

        // 受け箱に確認メール（GoTrue の確認の雛形）が届き、そのリンクで登録が終わる。
        const mail = await latestMailTo(request, issued.email);
        expect(mail.Subject, '届いたのが確認メールでない').toBe('メールアドレスの確認');
        await page.goto(confirmLinkOf(mail));
        await expect
          .poll(async () => (await admin.auth.admin.getUserById(issued.userId)).data.user?.email_confirmed_at ?? null, {
            message: '送り直した確認メールのリンクでメールが確認済みにならない',
          })
          .toBeTruthy();
      } finally {
        await removeUsers(admin, [issued.userId]);
      }
    });

    test('SEC-AUTH-006-AC-01 magiclink, recovery and email tokens do not write a session cookie', async ({ request }) => {
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

          // 窓口で開いた印そのものが消費されていないこと（verifyOtp が呼ばれていないこと。偽の印でたまたま書かれなかったのでもないこと）。
          await expectTokenNotConsumed({ url, anonKey }, type, issued.tokenHash);
        }
      } finally {
        await removeUsers(admin, userIds);
      }
    });

    test('SEC-AUTH-006-AC-02 signup token opened on the browser that submitted the signup writes session cookies and redirects with 303 to the saved return path', async ({ page }) => {
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      const issued = await issueTokenHash(admin, 'signup', `006b-${viewport.name}`);
      try {
        // ブラウザ A（この page の context）で登録を送る。
        await submitSignupFromBrowser(page, issued.email, RETURN_PATH);
        const before = await page.context().cookies();
        expect(before.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), '確認のリンクを開く前に session の Cookie がある').toBeUndefined();

        // 同じブラウザ A で確認のリンクを開く。URL の redirect_to は読まれない（別の道を付けて、無視されることも確かめる）。
        const tokenHash = await reissueSignupToken(admin, issued.email);
        const hop = await openConfirmLinkInBrowser(page, { tokenHash, type: 'signup', redirectTo: '/item' });

        // 登録を始めたブラウザで type=signup の印を開くと、session の Cookie が書かれ、登録の時に控えた戻り先へ 303 で送られる。
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe(RETURN_PATH);
        const after = await page.context().cookies();
        expect(after.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), `${ACCESS_COOKIE} の Cookie が書かれない`).toBeTruthy();
        expect(after.find((cookie) => cookie.name === REFRESH_COOKIE && cookie.value !== ''), `${REFRESH_COOKIE} の Cookie が書かれない`).toBeTruthy();
      } finally {
        await removeUsers(admin, [issued.userId]);
      }
    });

    test('SEC-AUTH-007-AC-01 signup token opened on a browser that did not start the signup confirms the email but logs nobody in', async ({ page, browser, baseURL }) => {
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
        const tokenHash = await reissueSignupToken(admin, issued.email);
        const hop = await openConfirmLinkInBrowser(pageB, { tokenHash, type: 'signup' });

        // 303 で /login へ送られる。
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe('/login');
        expect(new URL(location, 'http://localhost').searchParams.get('registered'), '確認だけ済んだ案内（registered=1）が付かない').toBe('1');

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

    test('SEC-AUTH-007-AC-02 signup token with a return path opened on a browser without the return-intent cookie ignores the saved return path and goes to /login', async ({ page, browser, baseURL }) => {
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      const issued = await issueTokenHash(admin, 'signup', `007b-${viewport.name}`);
      // ブラウザ B は、Cookie も保存も共有しない別の context。
      const otherBrowser = await browser.newContext({ baseURL, viewport: { width: viewport.width, height: viewport.height } });
      try {
        // ブラウザ A で戻り先つきの登録を送る。控えの Cookie はブラウザ A にだけ入る。
        await submitSignupFromBrowser(page, issued.email, RETURN_PATH);
        expect(await otherBrowser.cookies(), 'ブラウザ B に Cookie が残っている').toEqual([]);

        // 控えの Cookie を持たないブラウザ B で開く。戻り先は使わず /login へ送る（URL の redirect_to も読まない）。
        const pageB = await otherBrowser.newPage();
        const tokenHash = await reissueSignupToken(admin, issued.email);
        const hop = await openConfirmLinkInBrowser(pageB, { tokenHash, type: 'signup', redirectTo: RETURN_PATH });
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe('/login');
        expect(new URL(location, 'http://localhost').searchParams.get('registered'), '確認だけ済んだ案内（registered=1）が付かない').toBe('1');

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
      } finally {
        await otherBrowser.close();
        await removeUsers(admin, [issued.userId]);
      }
    });

    test('SEC-AUTH-007-AC-03 signup token of another email opened on the browser that started a signup does not log in and keeps the return-intent cookie', async ({ page }) => {
      test.setTimeout(120_000);
      const { admin } = localSupabase();
      // X: ブラウザ A が登録を送るメール。Y: 攻撃者のメールの確認の印（別の利用者）。どちらも未確認の会員。
      const x = await issueTokenHash(admin, 'signup', `007c-x-${viewport.name}`);
      const y = await issueTokenHash(admin, 'signup', `007c-y-${viewport.name}`);
      try {
        await submitSignupFromBrowser(page, x.email, RETURN_PATH);
        const intentBefore = (await page.context().cookies()).find((cookie) => cookie.name === 'sb-return-intent' && cookie.value !== '');
        expect(intentBefore, '前提: 登録を始めたブラウザに控えの Cookie がある').toBeTruthy();

        // 同じブラウザ A で、別の利用者 Y の確認のリンクを開く。
        const hop = await openConfirmLinkInBrowser(page, { tokenHash: y.tokenHash, type: 'signup' });

        // 番号は合っても別のメールの印なので、session を作らず /login へ 303。
        expect(hop.status()).toBe(303);
        const location = hop.headers()['location'];
        expect(location, 'Location が無い').toBeTruthy();
        expect(new URL(location, 'http://localhost').pathname).toBe('/login');
        expect(new URL(location, 'http://localhost').searchParams.get('registered'), '確認だけ済んだ案内（registered=1）が付かない').toBe('1');
        const hopHeaders = await hop.headersArray();
        expect(writtenCookieValue(hopHeaders, ACCESS_COOKIE), `別のメールの印で ${ACCESS_COOKIE} の Cookie が書かれた`).toBeNull();
        expect(writtenCookieValue(hopHeaders, REFRESH_COOKIE), `別のメールの印で ${REFRESH_COOKIE} の Cookie が書かれた`).toBeNull();
        const after = await page.context().cookies();
        expect(after.find((cookie) => cookie.name === ACCESS_COOKIE && cookie.value !== ''), `${ACCESS_COOKIE} が保存された`).toBeUndefined();

        // Y のメールは確認済み（登録は終わっている）。X の登録の控えの Cookie は残る（攻撃者のリンクで壊されない）。
        const confirmed = await admin.auth.admin.getUserById(y.userId);
        expect(confirmed.data.user?.email_confirmed_at, 'Y の確認のリンクを開いてもメールが確認済みにならない').toBeTruthy();
        expect(after.find((cookie) => cookie.name === 'sb-return-intent' && cookie.value === intentBefore?.value), '控えの Cookie が消えた').toBeTruthy();
      } finally {
        await removeUsers(admin, [x.userId, y.userId]);
      }
    });
  });
}
