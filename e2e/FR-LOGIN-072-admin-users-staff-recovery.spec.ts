/**
 * FR-LOGIN-072 管理画面「ユーザー」の店員のやり直しのメールの失敗と、招待の取り消しの確認
 * 対応: FR-AUTH-052-AC-01・02（設計: SCR-AUTH-016、DD-AUTH-090）。AC-02 は店員のパスキーの画面で、削除が下限以外の理由（500）で失敗した時の文
 *
 * 手元のアプリ（本番ビルド）・手元の Supabase・手元の Mailpit で、店長が画面から操作する。店長・店員は provisionStaff（ソフトの認証器）で用意し、
 * パスキーでログインして Cookie を得る（page.request と画面は同じ Cookie）。やり直しの窓口は `page.route` の中の `route.fetch()` で本物を動かす
 * （やり直しは本当に起き、招待は本当に発行される）。その応答だけを、窓口の本物の失敗の形（502・`mail_failed`。`staff-invite-http.ts` の写し）に替える。
 * やり直しは店長への知らせを積むので、afterEach で `skipPasskeyNotificationsOf` を流す（FR-LOGIN-070 と同じ）。
 */
import { expect, test, type Page } from '@playwright/test';
import { addUnapprovedPasskey, provisionStaff, skipPasskeyNotificationsOf } from '../scripts/e2e/passkey-staff';
import { withLocalDb } from './order-email-test-utils';
import { loginViaApp } from './passkey-app-api';

test.use({ trace: 'off' });

const NAVIGATION = { timeout: 30_000 };
const MAIL_FAILED_MESSAGE = 'メールを送れませんでした。もう一度、招待を出してください。';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

function uniqueIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 253);
  return `10.${octet()}.${octet()}.${octet()}`;
}

async function adminLoggedIn(page: Page): Promise<string> {
  const admin = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
  const login = await loginViaApp(page.request, { authenticator: admin.authenticators[0], ip: uniqueIp() });
  expect(login.status).toBe(200);
  return admin.userId;
}

function rowOf(page: Page, email: string) {
  return page.getByRole('row').filter({ hasText: email });
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-072 admin users staff recovery (${viewport.name})`, () => {
    const cleanup: string[] = [];

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test.afterEach(async () => {
      for (const userId of cleanup.splice(0)) await withLocalDb((db) => skipPasskeyNotificationsOf(db, userId));
    });

    test(`FR-AUTH-052-AC-01 ${viewport.name}: やり直しのメールが送れなかった時は、ダイアログが閉じ、行が「招待中」で役割の欄が見え、通知に既存の文が出る。取り消しは確認の後に行が戻る`, async ({ page }) => {
      test.setTimeout(120_000);
      cleanup.push(await adminLoggedIn(page));
      const target = await withLocalDb((db) => provisionStaff(db, { role: 'supporter', approvedPasskeys: 2 }));
      cleanup.push(target.userId);

      // 本物の窓口を動かし（やり直しも招待の発行も本当に起きる）、応答だけをメールの失敗に替える。
      let realStatus: number | null = null;
      await page.route('**/api/admin/staff/*/redo', async (route) => {
        const real = await route.fetch();
        realStatus = real.status();
        await route.fulfill({
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ error: MAIL_FAILED_MESSAGE, code: 'mail_failed' }),
        });
      });

      await page.goto('/admin?tab=USER');
      await expect(page.getByRole('button', { name: '店員を招待' })).toBeVisible(NAVIGATION);
      const row = rowOf(page, target.email);
      await expect(row.getByText('認めた鍵 2本')).toBeVisible(NAVIGATION);
      await row.getByRole('button', { name: 'パスキーを全部消してやり直す' }).click();
      const dialog = page.getByRole('dialog', { name: 'パスキーを全部消してやり直す' });
      await dialog.getByLabel(/確認のため/).fill('やり直し');
      await dialog.getByLabel(/理由/).fill('端末を紛失したため、やり直します');
      await dialog.getByRole('button', { name: 'やり直しを送る' }).click();

      await expect(dialog).toHaveCount(0, NAVIGATION);
      expect(realStatus).toBe(200);
      await expect(page.getByRole('alert').filter({ hasText: MAIL_FAILED_MESSAGE })).toBeVisible(NAVIGATION);
      const reloaded = rowOf(page, target.email);
      await expect(reloaded.getByText('招待中')).toBeVisible(NAVIGATION);
      await expect(reloaded.getByRole('combobox')).toBeVisible();

      // 取り消しは確認が出て、確認した後に行が戻る
      await reloaded.getByRole('button', { name: '招待を取り消す' }).click();
      const confirm = page.getByRole('dialog', { name: '招待を取り消す' });
      await expect(confirm).toContainText('この招待を取り消します。よろしいですか。');
      await confirm.getByRole('button', { name: '取り消す' }).click();
      await expect(page.getByText(`${target.email} への招待を取り消しました。`)).toBeVisible(NAVIGATION);
      await expect(rowOf(page, target.email).getByText('招待中')).toHaveCount(0);
    });

    test(`FR-AUTH-052-AC-02 ${viewport.name}: 鍵の削除が下限以外の理由（500）で失敗した時は、「もう一度お試しください」の文を出し、下限の文は出さない。鍵は残る`, async ({ page }) => {
      test.setTimeout(120_000);
      const staff = await withLocalDb((db) => provisionStaff(db, { role: 'admin', approvedPasskeys: 2 }));
      cleanup.push(staff.userId);
      const login = await loginViaApp(page.request, { authenticator: staff.authenticators[0], ip: uniqueIp() });
      expect(login.status).toBe(200);
      // 認めていない鍵なら、認めた鍵が2本でも消せる（削除ボタンが有効になる）
      await addUnapprovedPasskey({ email: staff.email, authenticator: staff.authenticators[0] });

      // 削除の窓口だけ、本物には届けず 500 にする（一覧などは本物のまま）
      await page.route('**/api/auth/passkey/*', async (route) => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        return route.fulfill({
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: JSON.stringify({ error: 'passkey_manage_failed' }),
        });
      });

      await page.goto('/admin/passkeys');
      await expect(page.locator('main ul > li')).toHaveCount(3, NAVIGATION);
      const enabled = page.getByRole('button', { name: /を削除$/ }).and(page.locator(':enabled'));
      await expect(enabled).toHaveCount(1);
      await enabled.click();
      await page.getByRole('button', { name: '削除する' }).click();

      await expect(page.getByText('削除できませんでした。もう一度お試しください。')).toBeVisible(NAVIGATION);
      await expect(page.getByText('削除できませんでした。認めた鍵は2本以上が必要です。')).toHaveCount(0);
      await expect(page.locator('main ul > li')).toHaveCount(3);
    });
  });
}
