import { randomBytes } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { createTestMember } from './member-session-helpers';
import { mailsTo, uniqueEmail, withLocalDb } from './order-email-test-utils';
import { stubTurnstileScript } from './turnstile-test-utils';

// パスワード再設定のリンクの一生を、手元の Supabase と手元のメール受け（Mailpit）の本物のメールで確かめる。
//
// 前提（実行時に確かめる）:
//  - 手元の Supabase と Mailpit（MAIL_PROVIDER=local, MAIL_LOCAL_URL）が動いている
//  - request の Turnstile は Cloudflare の「常に通る」試験用の鍵（.env.local）で、検証に外部ネットワークを使う
//  - 回数の制限（IP 単位・宛先単位）は、試験ごとに別の x-real-ip（E2E のアプリが CLIENT_IP_HEADER で信頼する送り元）と別の宛先で避ける
//
// SEC-AUTH-019-AC-01（偽の x-forwarded-host で申請するとメールが届かない）はこのファイルで確かめない。
// 許可の一覧で止まるのは VERCEL_ENV=production かつ https の本番の設定だけで、手元の E2E の設定では
// isEmailOriginAllowed が常に通り、x-forwarded-host は無視されるものの、サイトの住所で作ったリンクのメールは送られる。
// 本番の設定を作らずに「メールが届かない」ことは観測できないので、結合テスト
// tests/integration/api/auth/site-url-guard.test.ts に任せる。

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const ORIGIN = 'http://localhost:3000';
const RESET_SUBJECT = 'Password reset';
const EXPIRED_NOTICE = '有効期限';

/** 回数の制限を試験ごとに分けるための送り元。手元の E2E サーバーだけで効く。 */
function uniqueIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

function uniquePassword(): string {
  return `E2e-${randomBytes(12).toString('hex')}!`;
}

async function requestReset(
  request: APIRequestContext,
  email: string,
  headers: Record<string, string> = {},
) {
  return request.post('/api/auth/password-reset/request', {
    data: { email, turnstileToken: 'e2e-probe' },
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-real-ip': uniqueIp(), ...headers },
  });
}

type ResetMail = { html: string; text: string; token: string | null };

/** その宛先に届いた再設定のメールを、本文と鍵つきで読む（Mailpit は新しい順）。 */
async function resetMails(request: APIRequestContext, email: string): Promise<ResetMail[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const found = (await mailsTo(request, email)).filter((message) => message.Subject.includes(RESET_SUBJECT));
  const mails: ResetMail[] = [];
  for (const message of found) {
    const response = await request.get(
      new URL(`/api/v1/message/${encodeURIComponent(message.ID)}`, mailUrl).toString(),
      { timeout: 5_000 },
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { Text?: string; HTML?: string };
    const text = (body.Text ?? '').replace(/\r\n/g, '\n');
    mails.push({
      html: body.HTML ?? '',
      text,
      token: text.match(/\/auth\/password-reset\/verify\?token=([0-9a-f]{64})/)?.[1] ?? null,
    });
  }
  return mails;
}

async function waitForResetMails(request: APIRequestContext, email: string, count: number): Promise<ResetMail[]> {
  await expect
    .poll(async () => (await resetMails(request, email)).length, {
      timeout: 30_000,
      message: `${email} に再設定のメールが ${count} 通届くこと`,
    })
    .toBe(count);
  return resetMails(request, email);
}

/** ブラウザの文脈の通信（リンクの確かめ・パスワードの更新）も、試験ごとの送り元で数えさせる。 */
async function useUniqueSource(page: Page): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': uniqueIp() });
}

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-009 reset link lifecycle (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FREQ-70-AC-04 the heading uses the same font as the login tabs and is the largest text on the page', async ({ page }) => {
      await stubTurnstileScript(page);

      await page.goto('/login');
      const loginTabFamily = await page
        .getByRole('tab', { name: 'ログイン' })
        .evaluate((el) => getComputedStyle(el).fontFamily);

      await page.goto('/auth/password-reset');
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toContainText('パスワード再設定');
      await expect(page.locator('#email')).toBeVisible();

      const metrics = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const root = document.querySelector('main') ?? document.body;
        const sizeOf = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
        let largestOther = 0;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el === h1 || h1?.contains(el)) continue;
          const hasOwnText = Array.from(el.childNodes).some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
          );
          const rect = el.getBoundingClientRect();
          if (!hasOwnText || rect.width === 0 || rect.height === 0) continue;
          largestOther = Math.max(largestOther, sizeOf(el));
        }
        const input = document.querySelector('#email');
        return {
          headingFamily: h1 ? getComputedStyle(h1).fontFamily : '',
          headingSize: h1 ? sizeOf(h1) : 0,
          inputSize: input ? sizeOf(input) : 0,
          largestOther,
        };
      });

      const firstFamily = (family: string) => family.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
      // /login のタブと同じ書体で、acumin-pro 系のサンセリフ
      expect(firstFamily(metrics.headingFamily)).toBe(firstFamily(loginTabFamily));
      expect(metrics.headingFamily.toLowerCase()).toContain('acumin-pro');
      // 対比: 本文・入力欄より大きく、ページ内の他の文字より小さくない
      expect(metrics.headingSize).toBeGreaterThan(metrics.inputSize);
      expect(metrics.headingSize).toBeGreaterThan(0);
      expect(metrics.headingSize).toBeGreaterThanOrEqual(metrics.largestOther);
    });

    test('SEC-AUTH-018-AC-01 reopening a link that already changed the password shows the expiry notice and no password form', async ({ page, request }) => {
      await useUniqueSource(page);
      const member = await createTestMember('pwreset-reuse');
      const issued = await requestReset(request, member.email);
      expect(issued.status()).toBe(200);
      const [mail] = await waitForResetMails(request, member.email, 1);
      expect(mail.token).not.toBeNull();
      const verifyUrl = `/auth/password-reset/verify?token=${mail.token}`;

      // 1回目: リンクからパスワードを実際に変える
      await page.goto(verifyUrl);
      await expect(page.locator('#newPassword')).toBeVisible();
      const password = uniquePassword();
      await page.locator('#newPassword').fill(password);
      await page.locator('#confirmNewPassword').fill(password);
      await page.getByRole('button', { name: 'パスワードを更新' }).click();
      await expect(page.getByText('パスワードを更新しました')).toBeVisible();

      // 2回目: 同じリンクを開き直す
      await page.goto(verifyUrl);
      // 画面は理由を読むと ?error= を URL から外す（page.tsx の history.replaceState）ので、?error= は待たず、再設定の画面に着いてから案内を見る。
      await expect(page).toHaveURL(/\/auth\/password-reset$/);
      await expect(page.locator('p[role="alert"]', { hasText: EXPIRED_NOTICE })).toBeVisible();
      await expect(page.locator('#newPassword')).toHaveCount(0);
    });

    test('SEC-AUTH-018-AC-02 after requesting again, opening the first link shows the expiry notice', async ({ page, request }) => {
      await useUniqueSource(page);
      const member = await createTestMember('pwreset-supersede');

      expect((await requestReset(request, member.email)).status()).toBe(200);
      const [first] = await waitForResetMails(request, member.email, 1);
      expect(first.token).not.toBeNull();

      expect((await requestReset(request, member.email)).status()).toBe(200);
      const both = await waitForResetMails(request, member.email, 2);
      // 2本目が別のリンクとして届いていること（1本目を使い回して送り直していないこと）
      expect(both.some((mail) => mail.token !== null && mail.token !== first.token)).toBe(true);

      await page.goto(`/auth/password-reset/verify?token=${first.token}`);
      // 画面は理由を読むと ?error= を URL から外す（page.tsx の history.replaceState）ので、?error= は待たず、再設定の画面に着いてから案内を見る。
      await expect(page).toHaveURL(/\/auth\/password-reset$/);
      await expect(page.locator('p[role="alert"]', { hasText: EXPIRED_NOTICE })).toBeVisible();
      await expect(page.locator('#newPassword')).toHaveCount(0);
    });
  });
}

test.describe('FR-PWRESET-009 reset link lifecycle (API contract)', () => {
  test('FREQ-319-AC-02 an unregistered address gets the same status and body as a registered one, and no mail is sent', async ({ request }) => {
    const member = await createTestMember('pwreset-same');
    const unknownEmail = uniqueEmail('pwreset-unknown');

    const unknown = await requestReset(request, unknownEmail);
    const known = await requestReset(request, member.email);

    // HTTP ステータスとレスポンス本文が登録済みの場合と同一
    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(known.status());
    expect(await unknown.text()).toBe(await known.text());

    // 登録済みの宛先にメールが届いてから、未登録の宛先に何も届いていないことを見る
    await waitForResetMails(request, member.email, 1);
    expect(await mailsTo(request, unknownEmail)).toHaveLength(0);
  });

  test('FREQ-319-AC-03 opening the link with GET and posting it repeatedly do not consume the token, and the reset can still be completed', async ({ request }) => {
    const member = await createTestMember('pwreset-noconsume');
    expect((await requestReset(request, member.email)).status()).toBe(200);
    const [mail] = await waitForResetMails(request, member.email, 1);
    expect(mail.token).not.toBeNull();
    const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-real-ip': uniqueIp() };

    // 1度 GET しただけでは消費されない: 確認ページへ 303 で送るだけ
    const opened = await request.get(`/api/auth/password-reset/link?token=${mail.token}`, { maxRedirects: 0 });
    expect(opened.status()).toBe(303);
    expect(opened.headers()['location']).toContain('/auth/password-reset/verify');

    // link の POST を複数回行っても消費されない（2回とも有効なリンクとして受け付けられる）
    for (const attempt of [1, 2]) {
      const linked = await request.post('/api/auth/password-reset/link', { data: { token: mail.token }, headers });
      expect(linked.status(), `link の POST の ${attempt} 回目`).toBe(200);
    }

    // その後に、同じリンクから出た再設定 Cookie で再設定を完了できる
    const confirmed = await request.post('/api/auth/password-reset/confirm', {
      data: { new_password: uniquePassword() },
      headers,
    });
    expect(confirmed.status()).toBe(200);
  });

  test('FREQ-332-AC-04 expires_at is 10 minutes after issue, the cookie Max-Age is 600 and the mail says it is valid for 10 minutes', async ({ request }) => {
    const member = await createTestMember('pwreset-ttl');
    const issued = await requestReset(request, member.email);
    expect(issued.status()).toBe(200);
    const [mail] = await waitForResetMails(request, member.email, 1);
    expect(mail.token).not.toBeNull();

    // 発行される password_reset_tokens の expires_at が発行時刻の 10 分後
    // （アプリと DB の時計の小さなずれは許す。5 分や 1 時間の期限は弾く）
    const rows = await withLocalDb(async (db) => {
      const result = await db.query(
        `select extract(epoch from (expires_at - created_at)) as ttl_seconds
           from public.password_reset_tokens
          where email = $1 and used = false`,
        [member.email],
      );
      return result.rows as Array<{ ttl_seconds: string | number }>;
    });
    expect(rows).toHaveLength(1);
    expect(Math.abs(Number(rows[0].ttl_seconds) - 600)).toBeLessThanOrEqual(30);

    // 再設定 Cookie の Max-Age が 600
    const link = await request.post('/api/auth/password-reset/link', {
      data: { token: mail.token },
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-real-ip': uniqueIp() },
    });
    expect(link.status()).toBe(200);
    const resetCookie = link
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value)
      .find((value) => value.startsWith('sb-password-reset-session='));
    expect(resetCookie, '再設定 Cookie が発行されること').toBeDefined();
    expect(resetCookie).toMatch(/Max-Age=600(?:;|$)/i);

    // 再設定メールの本文（html / text とも）に「10分間有効」を含む記述がある
    expect(mail.text).toContain('10分間有効');
    expect(mail.html).toContain('10分間有効');
  });

  test('SEC-AUTH-016-AC-02 requesting a reset for an unregistered address returns 200 and nothing reaches that inbox', async ({ request }) => {
    const member = await createTestMember('pwreset-norelay');
    const unknownEmail = uniqueEmail('pwreset-norelay-unknown');

    const unknown = await requestReset(request, unknownEmail);
    const known = await requestReset(request, member.email);
    expect(unknown.status()).toBe(200);
    expect(known.status()).toBe(200);

    // 送る仕組みが動いている（登録済みの宛先には届く）ことを確かめてから、未登録の受け箱が空であることを見る
    await waitForResetMails(request, member.email, 1);
    expect(await mailsTo(request, unknownEmail)).toHaveLength(0);
  });
});
