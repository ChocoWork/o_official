import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-94: お客様情報タブの表示ビューを「ラベル左／値右」の1行レイアウトにする。
// TextField の leadingText（入力左端に文言を置く）を使い、shape=underline の
// 読み取り専用フィールドで氏名/フリガナ/メールアドレス/電話番号を1行ずつ表示する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const PROFILE = {
  email: 'demo@gmail.com',
  fullName: 'YAMADA TARO',
  kanaName: 'ヤマダ タロウ',
  phone: '090-1234-5678',
  address: {
    postalCode: '1500001',
    prefecture: '東京都',
    city: '渋谷区',
    address: '神宮前1-2-3',
    building: '',
  },
};

for (const viewport of VIEWPORTS) {
  test.describe(`FR-ACCOUNT-025 profile labeled fields (${viewport.name})`, () => {
    test('ラベル左・値右の1行レイアウトで表示し、編集ボタンでフォームに切り替わる', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockOtpAuthentication(page);

      await page.route('**/api/profile', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(PROFILE),
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      });

      await page.route('**/api/orders', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) });
      });

      await loginAndOpenAccount(page, PROFILE.email);

      // AC-01: 各ラベルが表示され、値はフィールド値として右寄せで格納される
      for (const label of ['氏名', 'フリガナ', 'メールアドレス', '電話番号']) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByLabel('氏名')).toHaveValue(PROFILE.fullName);
      await expect(page.getByLabel('フリガナ')).toHaveValue(PROFILE.kanaName);
      await expect(page.getByLabel('メールアドレス')).toHaveValue(PROFILE.email);
      await expect(page.getByLabel('電話番号')).toHaveValue(PROFILE.phone);

      // AC-02: 4行すべてが underline + leadingText の下線区切りで構成される
      const rows = page.locator(
        'label.text-field[data-ui-text-field-shape="underline"][data-ui-text-field-has-leading-text="true"]',
      );
      await expect(rows).toHaveCount(4);

      // 値は右寄せ（ラベル左／値右の対比）
      const textAlign = await page.getByLabel('氏名').evaluate((el) => getComputedStyle(el).textAlign);
      expect(textAlign).toBe('right');

      // AC-03: 「編集」ボタンで編集フォームへ切り替わる
      const editButton = page.getByRole('button', { name: '編集' });
      await expect(editButton).toBeVisible();
      await editButton.click();
      await expect(page.getByRole('button', { name: '変更を保存' })).toBeVisible();
      await expect(page.getByLabel('氏名')).toBeEditable();
    });
  });
}
