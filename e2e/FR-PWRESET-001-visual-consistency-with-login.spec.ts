import { test, expect } from '@playwright/test';

// FREQ-70 / FREQ-92: パスワード再設定ページの見た目を /login と統一すること
// （FREQ-92 でログインの下線ミニマルデザインへ刷新：FREQ-70 の角丸カードを置換）
const viewports = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const radiusOf = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-001 visual consistency with login (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/password-reset');
    });

    test('has no card frame and a square submit button (minimal design like login)', async ({ page }) => {
      // FREQ-92: 角丸カードを撤去し、送信ボタンは直角（ログインの下線ミニマルデザインへ統一）
      const container = page.locator('form').locator('xpath=..').locator('xpath=..');
      const submit = page.getByRole('button', { name: '再設定メールを送信' });
      const frame = await container.evaluate((el) => ({
        borderWidth: parseFloat(getComputedStyle(el).borderTopWidth),
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
      }));
      expect(frame.borderWidth).toBe(0);
      expect(frame.radius).toBe(0);
      expect(await radiusOf(submit)).toBe(0);
    });

    test('email input is an underline field with a leading mail icon', async ({ page }) => {
      // FREQ-92: 入力欄は下線のみ＋先頭アイコン（ログインと同じ）
      await expect(page.locator('i.ri-mail-line')).toBeVisible();
      const styles = await page.locator('#email').evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          top: s.borderTopStyle,
          bottom: s.borderBottomStyle,
          radius: parseFloat(s.borderTopLeftRadius),
        };
      });
      expect(styles.bottom).toBe('solid');
      expect(styles.top).toBe('none');
      expect(styles.radius).toBe(0);
    });

    test('is centered full-height with footer not visible', async ({ page }) => {
      // FREQ-70-AC-02: Footer 非表示＋縦中央
      const vh = viewport.height;
      const footer = await page.locator('footer').boundingBox();
      const card = await page
        .locator('form')
        .locator('xpath=..')
        .locator('xpath=..')
        .boundingBox();
      expect(footer!.y).toBeGreaterThanOrEqual(vh - 1);
      const cardCenter = card!.y + card!.height / 2;
      expect(Math.abs(cardCenter - vh / 2)).toBeLessThanOrEqual(vh * 0.15);
    });

    test('heading uses the same font as login tabs and is the largest text (contrast)', async ({
      page,
    }) => {
      // FREQ-70-AC-04: 見出しは login タブと同じサンセリフ、かつ本文/入力より大きい
      const heading = page.getByRole('heading', { level: 1 });
      const headingFont = await heading.evaluate((el) => ({
        family: getComputedStyle(el).fontFamily,
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
      const inputSize = await page
        .locator('#email')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

      // login タブと同じ acumin-pro 系サンセリフ（Didot セリフでないこと）
      expect(headingFont.family.toLowerCase()).toContain('acumin-pro');
      expect(headingFont.family.toLowerCase()).not.toContain('didot');
      // 対比: 見出しが入力欄より大きい
      expect(headingFont.size).toBeGreaterThan(inputSize);
    });

    test('submit button is disabled until email is filled', async ({ page }) => {
      // FREQ-70-AC-03: 未入力時は無効、入力で有効
      const submit = page.getByRole('button', { name: '再設定メールを送信' });
      await expect(submit).toBeDisabled();
      await page.locator('#email').fill('test@example.com');
      await expect(submit).toBeEnabled();
    });

    test('does not introduce horizontal overflow', async ({ page }) => {
      // FREQ-70-AC-08: 狭い画面を含め、共通フォーム幅がviewportを超えない
      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('uses the same field and button sizing contract as login', async ({ page }) => {
      // FREQ-70-AC-05: 共通UIのsize propsをloginと揃え、直値で上書きしない
      const resetEmail = page.locator('#email').locator('xpath=..').locator('xpath=..');
      const resetSubmit = page.getByRole('button', { name: '再設定メールを送信' });

      await expect(resetEmail).toHaveAttribute('data-ui-size', 'sm');
      await expect(resetSubmit).toHaveAttribute('data-ui-size', 'md');

      const resetMetrics = {
        field: await page.locator('#email').boundingBox(),
        button: await resetSubmit.boundingBox(),
      };

      await page.goto('/login');
      const loginEmail = page.locator('#email');
      const loginSubmit = page.getByRole('button', { name: 'ログイン', exact: true });
      const loginMetrics = {
        field: await loginEmail.boundingBox(),
        button: await loginSubmit.boundingBox(),
      };

      expect(Math.abs(resetMetrics.field!.width - loginMetrics.field!.width)).toBeLessThan(1);
      expect(Math.abs(resetMetrics.field!.height - loginMetrics.field!.height)).toBeLessThan(1);
      expect(Math.abs(resetMetrics.button!.width - loginMetrics.button!.width)).toBeLessThan(1);
      expect(Math.abs(resetMetrics.button!.height - loginMetrics.button!.height)).toBeLessThan(1);
    });

    test('repeats the login form 13px grid and LiftKit type hierarchy', async ({ page }) => {
      // FREQ-70-AC-06: 13pxグリッド＋CTA前8px（計21px）の近接階層を反復する
      const heading = page.getByRole('heading', { level: 1 });
      const email = page.locator('#email');
      const submit = page.getByRole('button', { name: '再設定メールを送信' });
      const emailBox = await email.boundingBox();
      const submitBox = await submit.boundingBox();

      await expect(heading).toHaveClass(/\blk-text-lg\b/);
      expect(Math.abs(submitBox!.y - (emailBox!.y + emailBox!.height) - 21)).toBeLessThan(1);
    });
  });
}

test('completed reset exposes an xs auxiliary link without changing the form width', async ({ page }) => {
  // FREQ-70-AC-07: 完了導線はloginの補助リンクと同じ最小階層にする
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, email: 'test@example.com' }) });
  });
  await page.route('**/api/auth/password-reset/confirm', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/auth/password-reset');
  await page.locator('#newPassword').fill('password123');
  await page.getByRole('button', { name: 'パスワードを更新' }).click();

  await expect(page.getByRole('link', { name: 'ログインへ' })).toHaveClass(/\blk-text-xs\b/);
});
