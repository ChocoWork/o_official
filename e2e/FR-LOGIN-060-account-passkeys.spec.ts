/**
 * FR-LOGIN-060 アカウントの「ログイン方法」タブ: パスキーの一覧・追加・名前の変更・削除
 * 対応: FR-AUTH-029-AC-01〜06（設計: DD-AUTH-065）
 *
 * Chromium の仮想の認証器（CDP。e2e/passkey-virtual-authenticator.ts）で、`navigator.credentials` を本物のまま動かす。
 * 会員は新しいアドレスのメールのコードで作る（登録は、10分以内のコードのログインを求める）。
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で流す。会員ごとに別のアドレス、試験ごとに別の x-real-ip
 * （`playwright.config.ts` が文脈ごとに付ける）。保留の Cookie・コードが通信記録に残るので `trace` は取らない。仮想の認証器は試験の終わりで必ず外す。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readLatestCode, readMailpitMessages } from './member-session-helpers';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './passkey-virtual-authenticator';

test.use({ trace: 'off' });

const ORIGIN = 'http://localhost:3000';
const VALID_TURNSTILE_TOKEN = 'test-turnstile-token';
const NAVIGATION = { timeout: 15_000 };
const SECURITY_URL = '/account?tab=security';
const EMPTY_TEXT = 'パスキーはまだありません。作ると、メールのコードを待たずにログインできます。';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

function uniqueEmail(label: string): string {
  return `e2e-account-passkeys-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
}

/** 新しいお客さんがメールのコードで入る（確定を押した後、勧めの画面か行き先へ移る）。 */
async function signInByCode(page: Page, email: string): Promise<void> {
  const previous = new Set((await readMailpitMessages(email)).map((message) => message.ID));
  const started = await page.request.post('/api/auth/email-code/start', {
    headers: { origin: ORIGIN, 'x-real-ip': uniqueIp() },
    data: { email, turnstileToken: VALID_TURNSTILE_TOKEN },
    maxRedirects: 0,
  });
  expect(started.status()).toBe(202);
  const code = await readLatestCode(email, previous);

  await page.goto('/login/code');
  await page.getByLabel('確認コード 1桁目').click();
  await page.keyboard.type(code);
  await expect(page.getByLabel('確認コード 8桁目')).toHaveValue(code[7]);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page).not.toHaveURL(/\/login\/code/, NAVIGATION);
}

/** コードで入り、「ログイン方法」のタブを開く。 */
async function openSecurityTab(page: Page, label: string): Promise<void> {
  await signInByCode(page, uniqueEmail(label));
  await page.goto(SECURITY_URL);
  await expect(page.getByRole('heading', { name: 'パスキー' })).toBeVisible(NAVIGATION);
}

/** パスキーの一覧の行。ヘッダーなどの別の listitem と混ざらないよう、タブの中の一覧に絞る。 */
function rows(page: Page) {
  return page.locator('.account-card ul > li');
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-060 account passkeys (${viewport.name})`, () => {
    let authenticators: VirtualAuthenticator[] = [];

    test.beforeEach(async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', '仮想の認証器は Chromium だけ');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const authenticator of authenticators) await authenticator.remove();
      authenticators = [];
    });

    test(`FR-AUTH-029-AC-01 ${viewport.name}: 空の文 → 追加 → 名前の変更 → 2本目 → 1本削除（確認の文）→ 最後の1本を削除（追加の文）→ 空へ戻る`, async ({ page }) => {
      test.setTimeout(120_000);
      const first = await addVirtualAuthenticator(page);
      authenticators.push(first);
      await openSecurityTab(page, 'flow');

      await expect(page.getByText('パスキーを登録すると、この端末の顔認証・指紋・PIN でログインできます。')).toBeVisible();
      await expect(page.getByText(EMPTY_TEXT)).toBeVisible();

      // 追加（コードで入った直後なので、登録のための入り直しの規則を満たす）
      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'パスキーを追加しました。' })).toBeVisible(NAVIGATION);
      await expect(rows(page)).toHaveCount(1);
      await expect(page.getByText(EMPTY_TEXT)).toHaveCount(0);
      expect(await first.credentials()).toHaveLength(1);
      await expect(rows(page).getByText(/\d{4}年\d{1,2}月\d{1,2}日 に作成/)).toBeVisible();

      // 名前の変更
      await page.getByRole('button', { name: /名前を変更/ }).click();
      await page.getByLabel('名前', { exact: true }).fill('仕事の PC');
      await page.getByRole('button', { name: '保存' }).click();
      await expect(rows(page).getByText('仕事の PC', { exact: true })).toBeVisible(NAVIGATION);
      await expect(page.getByLabel('名前', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '仕事の PCの名前を変更' })).toBeFocused();
      // 読み直しても名前が残っている（窓口が本当に変えた）
      await page.reload();
      await expect(rows(page).getByText('仕事の PC', { exact: true })).toBeVisible(NAVIGATION);

      // 2本目: 同じ認証器では excludeCredentials で already_registered になる。Chrome は内蔵の認証器を同時に1つしか持てないので、1つ目を外してから2つ目を足す
      await first.remove();
      const second = await addVirtualAuthenticator(page);
      authenticators.push(second);
      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(rows(page)).toHaveCount(2, NAVIGATION);
      expect(await second.credentials()).toHaveLength(1);

      // 1本削除: 2本の時は追加の文が出ない
      await page.getByRole('button', { name: '仕事の PCを削除' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'このパスキーを削除しますか' })).toBeVisible();
      await expect(dialog.getByText('削除すると、このパスキーではログインできなくなります。')).toBeVisible();
      await expect(dialog.getByText(/最後のパスキーです/)).toHaveCount(0);
      await dialog.getByRole('button', { name: '削除する' }).click();
      await expect(rows(page)).toHaveCount(1, NAVIGATION);
      await expect(page.getByRole('status').filter({ hasText: 'パスキーを削除しました。' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'パスキー' })).toBeFocused();
      // 読み直しても、消した行は戻らない
      await page.reload();
      await expect(rows(page)).toHaveCount(1, NAVIGATION);
      await expect(rows(page).getByText('仕事の PC', { exact: true })).toHaveCount(0);

      // 最後の1本: 追加の文が出る。消すと空へ戻る
      await page.getByRole('button', { name: /を削除$/ }).click();
      await expect(page.getByRole('dialog').getByText('最後のパスキーです。削除しても、メールのコードか Google でログインできます。')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: '削除する' }).click();
      await expect(page.getByText(EMPTY_TEXT)).toBeVisible(NAVIGATION);
      await expect(rows(page)).toHaveCount(0);
      // 読み直しても空のまま
      await page.reload();
      await expect(page.getByText(EMPTY_TEXT)).toBeVisible(NAVIGATION);
      await expect(rows(page)).toHaveCount(0);
    });

    test(`FR-AUTH-029-AC-02 ${viewport.name}: 古いコードのログイン（Google 経由に近い状況）で追加すると、再ログインの文と「メールのコードでログイン」が出る`, async ({ page }) => {
      test.setTimeout(120_000);
      authenticators.push(await addVirtualAuthenticator(page));
      await openSecurityTab(page, 'reauth');
      // 窓口は、`amr` に otp・passkey が無い、または10分より古い時に registration_not_allowed の reauth_required を返す。その応答を差し替える。
      await page.route('**/api/auth/passkey/register/start', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'registration_not_allowed', reason: 'reauth_required' }),
        }),
      );

      await page.getByRole('button', { name: 'パスキーを追加' }).click();

      await expect(
        page.getByText('安全のため、メールのコードでもう一度ログインしてから追加してください。'),
      ).toBeVisible(NAVIGATION);
      const link = page.getByRole('link', { name: 'メールのコードでログイン' });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', '/login?next=%2Faccount%3Ftab%3Dsecurity');
      await expect(rows(page)).toHaveCount(0);
    });

    test(`FR-AUTH-029-AC-03 ${viewport.name}: 一覧の行が折り返して読め、ボタンは今の Button（size md）のまま、横にはみ出さない`, async ({ page }) => {
      test.setTimeout(120_000);
      authenticators.push(await addVirtualAuthenticator(page));
      await openSecurityTab(page, 'layout');
      await page.getByRole('button', { name: 'パスキーを追加' }).click();
      await expect(rows(page)).toHaveCount(1, NAVIGATION);
      // 日本語41字（123バイト）は送らず、案内を出す
      await page.getByRole('button', { name: /名前を変更/ }).click();
      await page.getByLabel('名前', { exact: true }).fill('あ'.repeat(41));
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('名前は1〜64字（日本語は40字まで）で入力してください。')).toBeVisible();
      await page.getByRole('button', { name: 'キャンセル' }).click();
      // 長い名前でも折り返す（名前は UTF-8 で120バイトまで。日本語は40字まで）
      await page.getByRole('button', { name: /名前を変更/ }).click();
      await page.getByLabel('名前', { exact: true }).fill('とても長い名前のパスキー'.repeat(2));
      await page.getByRole('button', { name: '保存' }).click();
      await expect(page.getByLabel('名前', { exact: true })).toHaveCount(0, NAVIGATION);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, '横にはみ出さない').toBeLessThanOrEqual(0);
      const row = rows(page);
      const rowBox = await row.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(viewport.width);
      for (const name of [/名前を変更/, /を削除$/, 'パスキーを追加']) {
        const button = page.getByRole('button', { name });
        await expect(button).toHaveAttribute('data-ui-button-size', 'md');
        // 大きさは、リポジトリの Button（size md）にそのまま従う（ログインの画面どうしをそろえる）。高さの下限は Button の側で決める。
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
    });

    test(`FR-AUTH-029-AC-04 ${viewport.name}: 「ログイン方法」は4つのタブの隣に出て、お客様情報に「パスワードを変更」のリンクが無い。/account/password は直に開くと使える`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInByCode(page, uniqueEmail('tabs'));
      await page.goto('/account?tab=profile');
      await expect(page.getByRole('heading', { level: 1, name: 'ACCOUNT' })).toBeVisible(NAVIGATION);
      await expect(page.locator('.animate-pulse')).toHaveCount(0, NAVIGATION);
      const tabs = page.locator(viewport.width >= 768 ? 'div.hidden.md\\:block' : '.account-mobile-tabs').locator('[data-ui-tab-item]');
      await expect(tabs).toHaveText(['お客様情報', '配送情報', '購入履歴', 'お問い合わせ', 'ログイン方法']);
      await expect(page.getByRole('link', { name: 'パスワードを変更' })).toHaveCount(0);
      await expect(page.locator('a[href="/account/password"]')).toHaveCount(0);

      await page.goto('/account/password');
      await expect(page.getByRole('heading', { level: 1, name: 'パスワードの変更' })).toBeVisible(NAVIGATION);
    });

    test(`FR-AUTH-029-AC-05 ${viewport.name}: 「ログイン方法」のタブを押すと tab=security になり、パスキーの見出しが出る`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInByCode(page, uniqueEmail('tabclick'));
      await page.goto('/account?tab=profile');
      await expect(page.getByRole('heading', { level: 1, name: 'ACCOUNT' })).toBeVisible(NAVIGATION);
      const scope = viewport.width >= 768 ? page.locator('div.hidden.md\\:block') : page.locator('.account-mobile-tabs');
      await scope.getByText('ログイン方法', { exact: true }).click();
      await expect(page).toHaveURL(/\/account\?tab=security/, NAVIGATION);
      await expect(page.getByRole('heading', { name: 'パスキー' })).toBeVisible();
    });

    test(`FR-AUTH-029-AC-06 ${viewport.name}: 5つのタブの字が欠けず、重ならず、全部が画面の中に見える`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInByCode(page, uniqueEmail('tabfit'));
      await page.goto('/account?tab=profile');
      await expect(page.getByRole('heading', { level: 1, name: 'ACCOUNT' })).toBeVisible(NAVIGATION);
      await expect(page.locator('.animate-pulse')).toHaveCount(0, NAVIGATION);
      const tabs = page.locator(viewport.width >= 768 ? 'div.hidden.md\\:block' : '.account-mobile-tabs').locator('[data-ui-tab-item]');
      await expect(tabs).toHaveCount(5);
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const tab of await tabs.all()) {
        await expect(tab).toBeInViewport({ ratio: 1 });
        // Button は overflow: hidden。字が箱より広いと scrollWidth が clientWidth を越える（字が欠けている）
        expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        boxes.push((await tab.boundingBox())!);
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const overlaps = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
          expect(overlaps).toBe(false);
        }
      }
    });
  });
}
