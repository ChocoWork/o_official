/**
 * FR-LOGIN-058 メールのコードの入力画面（/login/code）
 * 対応: FR-AUTH-026-AC-01〜05（設計: DD-AUTH-062）
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。始めの窓口を `page.request` で呼び（保留の Cookie がブラウザに入る）、
 * Mailpit のコードを読み、画面に入れる。要求ごとに別の x-real-ip と origin を付ける（回数の枠を使い切らないため・proxy の Origin の確かめ）。
 * 勧め（offerPasskey が真）の側は、仮想の認証器を足して /login/passkey に着くことを確かめる（画面の中身と往復は FR-LOGIN-059）。鍵を1本持つお客さん（勧めが偽）は戻り先へ着く。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readLatestCode } from './member-session-helpers';
import { withLocalDb } from './order-email-test-utils';
import { provisionPasskeyUser } from '../scripts/e2e/passkey-staff';
import { addVirtualAuthenticator } from './passkey-virtual-authenticator';

// 保留の Cookie とコードが通信記録に残るので、記録は取らない。
test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const ALWAYS_ON_LINE = 'コードの無い確認のメールが届いた時は、そのメールのリンクを押してから、もう一度お試しください。';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-code-screen-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** 始めの窓口を呼び、保留の Cookie をこの page の文脈に入れる。 */
async function startPending(page: Page, email: string): Promise<void> {
  const started = await page.request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
  expect(started.status()).toBe(202);
}

async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('確認コード 1桁目').click();
  await page.keyboard.type(code);
  await expect(page.getByLabel('確認コード 8桁目')).toHaveValue(code[7]);
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-058 email code screen (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FR-AUTH-026-AC-01 ${viewport.name}: 鍵を持つ会員は、メールのコードを入れると勧めを経ずに入れる`, async ({ page }) => {
      const customer = await withLocalDb(async (db) => {
        const created = await provisionPasskeyUser(db, { approvedPasskeys: 1, appRole: 'user' });
        // 作る時の magiclink が GoTrue の送信の間隔（60秒）を使うので、コードのメールが送られるよう送信の時刻を空に戻す。
        await db.query('update auth.users set recovery_sent_at = null, confirmation_sent_at = null where id = $1::uuid', [created.userId]);
        return created;
      });
      await startPending(page, customer.email);
      const code = await readLatestCode(customer.email, new Set());

      await page.goto('/login/code');
      await expect(page.getByRole('heading', { name: '確認コードを入力してください' })).toBeVisible();
      await expect(page.getByText('8桁のコードをお送りしました。5分以内に入力してください。')).toBeVisible();
      await expect(page.getByRole('button', { name: 'ログイン' })).toBeDisabled();
      await enterCode(page, code);
      await expect(page.getByRole('button', { name: 'ログイン' })).toBeEnabled();
      await page.getByRole('button', { name: 'ログイン' }).click();

      await expect(page).toHaveURL(`${ORIGIN}/`);
      const me = await page.request.get('/api/auth/me');
      expect(((await me.json()) as { authenticated?: boolean }).authenticated).toBe(true);
    });

    test(`FR-AUTH-026-AC-01 ${viewport.name}: 鍵を持たない新規のお客さんは、コードを入れると勧めの画面へ着く`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      const authenticator = await addVirtualAuthenticator(page);
      try {
        const email = uniqueEmail('offer');
        await startPending(page, email);
        const code = await readLatestCode(email, new Set());

        await page.goto('/login/code');
        await enterCode(page, code);
        await page.getByRole('button', { name: 'ログイン' }).click();

        await expect(page).toHaveURL(`${ORIGIN}/login/passkey`, { timeout: 15_000 });
        await expect(page.getByRole('heading', { name: 'パスキーを作りませんか' })).toBeVisible();
      } finally {
        await authenticator.remove();
      }
    });

    test(`FR-AUTH-026-AC-02 ${viewport.name}: 間違ったコードは文言を出し、入力を続けられる`, async ({ page }) => {
      const email = uniqueEmail('wrong');
      await startPending(page, email);
      const code = await readLatestCode(email, new Set());
      const wrong = code === '00000000' ? '11111111' : '00000000';

      await page.goto('/login/code');
      await enterCode(page, wrong);
      await page.getByRole('button', { name: 'ログイン' }).click();

      await expect(page.getByRole('alert').filter({ hasText: '確認コードが無効、または期限切れです。' })).toBeVisible();
      await expect(page).toHaveURL(/\/login\/code$/);
      await expect(page.getByLabel('確認コード 1桁目')).toBeEnabled();
    });

    test(`FR-AUTH-026-AC-03 ${viewport.name}: いつも出す案内があり、再送は待ちの間 disabled で残り時間が出る`, async ({ page }) => {
      const email = uniqueEmail('resend');
      await startPending(page, email);

      await page.goto('/login/code');
      await expect(page.getByText(ALWAYS_ON_LINE)).toBeVisible();
      await expect(page.getByRole('button', { name: 'コードを再送する' })).toBeDisabled();
      await expect(page.getByText(/後に再送可能/)).toBeVisible();
      await expect(page.getByLabel('確認コード 1桁目')).toBeFocused();
    });

    test(`FR-AUTH-026-AC-04 ${viewport.name}: 入れ直しで /login へ戻り、保留が捨てられて /login/code は /login へ送られる`, async ({ page }) => {
      const email = uniqueEmail('cancel');
      await startPending(page, email);

      await page.goto('/login/code');
      await page.getByRole('button', { name: 'メールアドレスを入れ直す' }).click();
      await expect(page).toHaveURL(/\/login$/);

      await page.goto('/login/code');
      await expect(page).toHaveURL(/\/login$/);
    });

    test(`FR-AUTH-026-AC-04 ${viewport.name}: 保留の Cookie が無ければ /login へ送られ、入力欄を見せない`, async ({ page }) => {
      await page.goto('/login/code');
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('確認コード 1桁目')).toHaveCount(0);
    });

    test(`FR-AUTH-026-AC-05 ${viewport.name}: 入力欄が横にはみ出さない`, async ({ page }) => {
      const email = uniqueEmail('layout');
      await startPending(page, email);

      await page.goto('/login/code');
      await expect(page.getByLabel('確認コード 8桁目')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      for (let n = 1; n <= 8; n += 1) {
        const box = await page.getByLabel(`確認コード ${n}桁目`).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
    });
  });
}
