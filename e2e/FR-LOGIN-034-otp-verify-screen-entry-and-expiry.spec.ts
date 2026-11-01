import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { test, expect, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { injectTurnstileToken } from './turnstile-test-utils';

// FREQ-334（確認コードの専用画面への入り方）、FR-LOGIN-006（再送の待ち）、FR-LOGIN-007（一般の会員）、
// FR-LOGIN-008（5分の期限）、SEC-AUTH-029（Supabase 側の 5 分の期限）の受け入れ基準を /login/verify で確かめる。
//
// 本物の確認コードを扱う試験（FR-LOGIN-007-AC-01・FR-LOGIN-008-AC-02・SEC-AUTH-029-AC-02）があるので、
// 確認コードと 2FA の Cookie が通信記録に残らないよう、最上位で trace を切る（e2e/member-session-helpers.ts と同じ理由）。
test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const MOCK_EMAIL = 'user@example.com';
const EXPIRY_NOTICE = 'コードは5分間有効です';
const OTP_INPUT_FIRST = '認証コード 1 桁目';
const INVALID_OTP_MESSAGE = '認証コードが無効、または期限切れです。';
// session_id は proxy が誰にでも配る匿名の閲覧の印（ログインの Cookie ではない）なので含めない。
const SESSION_COOKIES = ['sb-access-token', 'sb-refresh-token'];

/** 回数の制限は送り元ごとに数える。見出しの無い要求が集まる「送り元なし」の枠を全試験で使い切らないよう、試験ごとに別の値を付ける。 */
function uniqueSourceIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${Math.max(1, c)}`;
}

function localMailUrl(): string {
  const url = process.env.MAIL_LOCAL_URL;
  if (!url || !isLocalUrl(url)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  return url;
}

type TestMemberWithPassword = { userId: string; email: string; password: string };

/** 画面から入るので、パスワードを知っている会員を手元の Supabase にだけ作る。 */
async function createMemberWithPassword(label: string): Promise<TestMemberWithPassword> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('会員を作れるのは手元の Supabase だけ');
  const email = `e2e-verify-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const password = `E2e-${randomBytes(12).toString('hex')}!`;
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin
    .createUser({ email, password, email_confirm: true })
    .catch(() => {
      throw new Error('手元の会員を作る要求に失敗した');
    });
  if (error || !data.user) {
    throw new Error(`手元の会員を作れない（status: ${error?.status ?? '不明'}, code: ${error?.code ?? '不明'}）`);
  }
  return { userId: data.user.id, email, password };
}

async function listMailIds(email: string): Promise<string[]> {
  const searchUrl = new URL('/api/v1/search', localMailUrl());
  searchUrl.searchParams.set('query', `to:${email}`);
  // 確認コード入りの応答をブラウザの通信記録へ載せないため、Node で読む。
  const response = await fetch(searchUrl, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
  if (!response.ok) throw new Error(`手元のメール受けを検索できない: ${response.status}`);
  const body = (await response.json()) as { messages?: Array<{ ID: string }> };
  return (body.messages ?? []).map((message) => message.ID);
}

/** 既に届いていたメールを除き、新しく届いたメールの 8 桁の確認コードを返す。 */
async function waitForNewLoginCode(email: string, previousIds: ReadonlySet<string>): Promise<string> {
  let code = '';
  await expect
    .poll(
      async () => {
        const latest = (await listMailIds(email)).find((id) => !previousIds.has(id));
        if (!latest) return '';
        const response = await fetch(new URL(`/api/v1/message/${encodeURIComponent(latest)}`, localMailUrl()), {
          signal: AbortSignal.timeout(5_000),
          redirect: 'manual',
        });
        if (!response.ok) return '';
        const content = (await response.json()) as { Text?: string; HTML?: string };
        // リンクのハッシュや HTML 属性の数字を確認コードと取り違えないため、リンクとタグを除いて探す。
        const text = `${content.Text ?? ''}\n${(content.HTML ?? '').replace(/<[^>]*>/g, ' ')}`.replace(
          /https?:\/\/\S+/g,
          ' ',
        );
        code = text.match(/\b(\d{8})\b/)?.[1] ?? '';
        return code;
      },
      { message: '確認コードのメールが届かない', timeout: 15_000 },
    )
    .toMatch(/^\d{8}$/);
  return code;
}

/** パスワード検証の後の状態（2FA Cookie）を本物の会員で置き、再送の入口で本物の確認コードを送らせて読む。 */
async function sendRealLoginCode(page: Page, member: TestMemberWithPassword, sourceIp: string): Promise<string> {
  await page.goto('/login');
  const origin = new URL(page.url()).origin;
  await setLoginTwoFactorCookie(page, member.email, member.userId);
  const previousIds = new Set(await listMailIds(member.email));
  const resend = await page.request.post(new URL('/api/auth/login/resend', origin).toString(), {
    headers: { origin, 'x-real-ip': sourceIp },
    maxRedirects: 0,
  });
  expect(resend.status()).toBe(200);
  return waitForNewLoginCode(member.email, previousIds);
}

/** /api/auth/login をモックする。本物の 2FA Cookie は発行されないので、テスト側で置く。 */
async function mockPasswordStep(page: Page) {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        step: 'otp',
        message: '認証コードを送信しました。メールに届いたコードを入力してください。',
      }),
    });
  });
}

async function submitCredentials(page: Page, email: string, password: string) {
  await injectTurnstileToken(page);
  await page.getByLabel('EMAIL').fill(email);
  await page.getByLabel('PASSWORD').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-034 otp verify screen entry and expiry (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FREQ-334-AC-02 パスワード検証成功後に /login/verify へ着地し、ブラウザバックで資格情報フォームへ戻らない (${viewport.name})`, async ({
      page,
    }) => {
      await mockPasswordStep(page);

      // 戻り先が /login ではなく直前のページになることを見るため、先に別のページを挟む。
      await page.goto('/');
      await page.goto('/login');
      await expect(page.getByLabel('EMAIL')).toBeVisible();
      await expect(page.getByLabel('PASSWORD')).toBeVisible();

      await setLoginTwoFactorCookie(page, MOCK_EMAIL);
      await submitCredentials(page, MOCK_EMAIL, 'Password123456789!');

      // パスワード検証成功後に /login/verify へ着地する
      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByLabel(OTP_INPUT_FIRST)).toBeVisible();

      // ブラウザバックで資格情報フォームへ戻らない（replace なら /login の履歴が残らず、直前の / へ戻る）
      await page.goBack();
      await expect(page).not.toHaveURL(/\/login(\/|$)/);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByLabel('EMAIL')).toHaveCount(0);
      await expect(page.getByLabel('PASSWORD')).toHaveCount(0);
    });

    test(`FREQ-334-AC-03 有効な 2FA Cookie を持って /login を開くと /login/verify へ遷移する (${viewport.name})`, async ({
      page,
    }) => {
      // Cookie を置くにはオリジンが要るので、先に同一オリジンのページを開く。
      await page.goto('/login');
      await expect(page.getByLabel('EMAIL')).toBeVisible();

      await setLoginTwoFactorCookie(page, MOCK_EMAIL);
      await page.goto('/login');

      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByLabel(OTP_INPUT_FIRST)).toBeVisible();
      await expect(page.getByLabel('EMAIL')).toHaveCount(0);
    });

    test(`FR-LOGIN-006-AC-01 認証コードを送った直後は残り時間が出て「再送信」が無く、60 秒たつと「再送信」が出る (${viewport.name})`, async ({
      page,
    }) => {
      await page.clock.install();
      await mockPasswordStep(page);

      await page.goto('/login');
      await setLoginTwoFactorCookie(page, MOCK_EMAIL);
      await submitCredentials(page, MOCK_EMAIL, 'Password123456789!');

      // 送った直後: 「後に再送可能」を含む残り時間が出て、「再送信」ボタンは出ない
      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByText(/\d+分 \d{2}秒後に再送可能/)).toBeVisible();
      await expect(page.getByRole('button', { name: '再送信' })).toHaveCount(0);

      // 60 秒たつと「再送信」ボタンが出る（待ちの表示は消える）
      await page.clock.fastForward(61_000);
      await expect(page.getByRole('button', { name: '再送信' })).toBeVisible();
      await expect(page.getByText(/後に再送可能/)).toHaveCount(0);
    });

    test(`FR-LOGIN-007-AC-01 一般の会員は戻り先なしでパスワードと確認コードを通すと / へ移り、TOTP を求められない (${viewport.name})`, async ({
      page,
    }) => {
      const member = await createMemberWithPassword(`ac01-${viewport.name}`);
      const sourceIp = uniqueSourceIp();
      // 回数の制限を試験ごとの送り元で数えさせる（本物のログインと確認コードの検証の窓口に付ける）
      for (const pattern of ['**/api/auth/login', '**/api/auth/otp/verify']) {
        await page.route(pattern, async (route) => {
          await route.continue({ headers: { ...route.request().headers(), 'x-real-ip': sourceIp } });
        });
      }
      const previousIds = new Set<string>();

      await page.goto('/login');
      await submitCredentials(page, member.email, member.password);

      // 本物のパスワード検証の後、専用画面で 8 桁を求められる
      await expect(page).toHaveURL(/\/login\/verify$/);
      const code = await waitForNewLoginCode(member.email, previousIds);
      for (let index = 0; index < 8; index += 1) {
        await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(code[index]);
      }
      await page.getByRole('button', { name: 'サインイン' }).click();

      // 一般の会員（user）は戻り先が無いので / へ移り、TOTP の入力を求められない（FR-AUTH-005-AC-03）
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/');
      await expect(page).not.toHaveURL(/\/auth\/verified/);
      await expect(page.locator('body')).not.toContainText('TOTP');
    });

    test(`FR-LOGIN-008-AC-01 確認の画面に「コードは5分間有効です」が表示される (${viewport.name})`, async ({ page }) => {
      await page.goto('/login');
      await setLoginTwoFactorCookie(page, MOCK_EMAIL);
      await page.goto('/login/verify');

      await expect(page.getByText(EXPIRY_NOTICE)).toBeVisible();
    });

    test(`FR-LOGIN-008-AC-02 5 分を過ぎた後は正しいコードを送ってもログインできず、/login/verify を開き直すと /login へ移る (${viewport.name})`, async ({
      page,
    }) => {
      const member = await createMemberWithPassword(`ac02-${viewport.name}`);
      const sourceIp = uniqueSourceIp();

      // 正しい（本物の）確認コードを送らせて読む
      const code = await sendRealLoginCode(page, member, sourceIp);
      const origin = new URL(page.url()).origin;

      // 送ってから 5 分を過ぎた状態: 保留の Cookie の期限（5 分）が切れたものに差し替える
      const expiredToken = createLoginTwoFactorSessionToken({
        userId: member.userId,
        email: member.email,
        expiresInSeconds: -10,
      });
      await page.context().addCookies([
        { name: 'sb-login-2fa-session', value: expiredToken, url: origin, httpOnly: true, sameSite: 'Strict' },
      ]);

      // 正しいコードを送ってもログインできない
      const verify = await page.request.post(new URL('/api/auth/otp/verify', origin).toString(), {
        headers: { origin, 'x-real-ip': sourceIp },
        data: { code },
        maxRedirects: 0,
      });
      expect(verify.status()).toBe(401);
      const cookies = await page.context().cookies(origin);
      for (const name of SESSION_COOKIES) {
        expect(cookies.some((cookie) => cookie.name === name && cookie.value !== '')).toBe(false);
      }

      // /login/verify を開き直すと /login へ移り、入力欄は出ない
      await page.goto('/login/verify');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel(OTP_INPUT_FIRST)).toHaveCount(0);
    });

    test(`SEC-AUTH-029-AC-02 送ってから 5 分を過ぎたメール OTP を送ると 401 になる (${viewport.name})`, async ({ page }) => {
      const member = await createMemberWithPassword(`sec029-${viewport.name}`);
      const sourceIp = uniqueSourceIp();

      const code = await sendRealLoginCode(page, member, sourceIp);
      const origin = new URL(page.url()).origin;

      // Supabase 側の送信時刻を 6 分前へずらす（待たずに「送ってから 5 分を過ぎた」状態にする）。
      // 保留の Cookie は有効なまま（Cookie の 5 分とは別に、Supabase 側の期限だけを見るため）。
      await withLocalDb(async (db) => {
        const tokens = await db.query(
          `update auth.one_time_tokens set created_at = created_at - interval '6 minutes' where user_id = $1`,
          [member.userId],
        );
        expect(tokens.rowCount).toBeGreaterThan(0);
        await db.query(
          `update auth.users set recovery_sent_at = recovery_sent_at - interval '6 minutes'
           where id = $1 and recovery_sent_at is not null`,
          [member.userId],
        );
      });

      const verify = await page.request.post(new URL('/api/auth/otp/verify', origin).toString(), {
        headers: { origin, 'x-real-ip': sourceIp },
        data: { code },
        maxRedirects: 0,
      });
      expect(verify.status()).toBe(401);
      expect(await verify.json()).toMatchObject({ error: INVALID_OTP_MESSAGE });
    });
  });
}
