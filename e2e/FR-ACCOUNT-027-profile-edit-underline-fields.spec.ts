import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

// FREQ-97: お客様情報タブの編集フォームを、表示ビューと同じ「ラベル左・値右」の
// shape=underline + leadingText の編集可能フィールドに変更する（枠付きボックス入力を置換）。
// FREQ-96: 下線フィールドはクリック/フォーカスしても下線を黒にせずグレー維持する。

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
  test.describe(`FR-ACCOUNT-027 profile edit underline fields (${viewport.name})`, () => {
    test('編集フォームが underline + leadingText の編集可能フィールドで表示され、フォーカス中の行の下線が黒になる', async ({
      page,
    }) => {
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
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      });

      await page.route('**/api/profile/addresses', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ addresses: [] }),
        });
      });

      await loginAndOpenAccount(page, PROFILE.email);

      // 表示ビューから編集フォームへ切り替える
      await page.getByRole('button', { name: '編集' }).click();
      await expect(page.getByRole('button', { name: '変更を保存' })).toBeVisible();

      // FREQ-97-AC-01: 編集フォームが underline + leadingText の4行で構成される
      const rows = page.locator(
        'form.account-profile-view label.text-field[data-ui-text-field-shape="underline"][data-ui-text-field-has-leading-text="true"]',
      );
      await expect(rows).toHaveCount(4);
      // 枠付きボックス（account-card）は使わない
      await expect(page.locator('form.account-card')).toHaveCount(0);

      // 氏名・フリガナ・電話番号は編集可能
      await expect(page.getByLabel('氏名')).toBeEditable();
      await expect(page.getByLabel('フリガナ')).toBeEditable();
      await expect(page.getByLabel('電話番号')).toBeEditable();

      // FREQ-97-AC-02: メールアドレスは readOnly
      const emailReadOnly = await page
        .getByLabel('メールアドレス')
        .evaluate((el) => (el as HTMLInputElement).readOnly);
      expect(emailReadOnly).toBe(true);

      // 実際に入力できる（右寄せの値として反映される）
      await page.getByLabel('氏名').fill('佐藤 花子');
      await expect(page.getByLabel('氏名')).toHaveValue('佐藤 花子');
      await page.getByLabel('電話番号').fill('08033334444');
      await expect(page.getByLabel('電話番号')).toHaveValue('080-3333-4444');

      // FREQ-97-AC-03: 編集画面ではカーソルがある（フォーカス中の）編集可能フィールドの下線が黒になる
      const controlOf = (label: string) =>
        page
          .getByLabel(label)
          .locator('xpath=ancestor::span[contains(@class,"text-field__control")]');

      const leadOf = (label: string) =>
        controlOf(label).locator('.text-field__leading-text');

      await page.getByLabel('氏名').focus();
      expect(
        await controlOf('氏名').evaluate((el) => getComputedStyle(el).borderBottomColor),
      ).toBe('rgb(0, 0, 0)');
      // 下線に合わせ、左側の見出し文字も黒になる
      expect(
        await leadOf('氏名').evaluate((el) => getComputedStyle(el).color),
      ).toBe('rgb(0, 0, 0)');
      // フォーカスしていない行は下線・見出し文字ともグレーのまま
      expect(
        await controlOf('フリガナ').evaluate((el) => getComputedStyle(el).borderBottomColor),
      ).toBe('rgba(0, 0, 0, 0.1)');
      expect(
        await leadOf('フリガナ').evaluate((el) => getComputedStyle(el).color),
      ).toBe('rgba(0, 0, 0, 0.2)');

      // フォーカスを移すと元の行はグレーへ戻り、移った先が黒になる
      await page.getByLabel('フリガナ').focus();
      expect(
        await controlOf('フリガナ').evaluate((el) => getComputedStyle(el).borderBottomColor),
      ).toBe('rgb(0, 0, 0)');
      expect(
        await controlOf('氏名').evaluate((el) => getComputedStyle(el).borderBottomColor),
      ).toBe('rgba(0, 0, 0, 0.1)');

      // readOnly のメールアドレスはフォーカスしても黒にならない（淡色維持）
      await page.getByLabel('メールアドレス').focus();
      expect(
        await controlOf('メールアドレス').evaluate((el) => getComputedStyle(el).borderBottomColor),
      ).toBe('rgba(0, 0, 0, 0.1)');
    });
  });
}
