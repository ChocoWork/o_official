import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// FREQ-93: ログイン／会員登録タブの寸法を基準に、近接・整列・反復・対比を統一すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test('auth JSX uses lk-text classes instead of inline font-size tokens', () => {
  for (const file of ['LoginModal.tsx', 'RegisterModal.tsx']) {
    const source = readFileSync(join(process.cwd(), 'src', 'components', file), 'utf8');
    expect(source).not.toMatch(/fontSize:\s*["']var\(--lk-size-/);
  }
});

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-022 auth layout hierarchy (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');
    });

    test('tabs repeat one font size and selection uses underline contrast', async ({ page }) => {
      const login = page.getByRole('tab', { name: 'ログイン' });
      const register = page.getByRole('tab', { name: '会員登録' });
      const styles = async (locator: typeof login) =>
        locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            fontSize: parseFloat(style.fontSize),
            borderBottomWidth: parseFloat(style.borderBottomWidth),
          };
        });

      const active = await styles(login);
      const inactive = await styles(register);
      await expect(login).toHaveClass(/\blk-text-lg\b/);
      await expect(register).toHaveClass(/\blk-text-lg\b/);
      expect(Math.abs(active.fontSize - inactive.fontSize)).toBeLessThan(0.1);
      expect(active.borderBottomWidth).toBeGreaterThan(inactive.borderBottomWidth);
    });

    test('type scale descends from tabs to actions, fields and support text', async ({ page }) => {
      const fontSize = async (selector: string) =>
        page.locator(selector).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

      const tab = await fontSize('#auth-tab-login');
      const action = await fontSize('button[type="submit"]');
      const field = await fontSize('#email');
      const support = await fontSize('[data-auth-support-row] a');

      expect(tab).toBeGreaterThan(action);
      expect(action).toBeGreaterThan(field);
      expect(field).toBeGreaterThan(support);
      await expect(page.locator('[data-auth-support-row] a')).toHaveClass(/\blk-text-xs\b/);
      await expect(page.getByText('OR', { exact: true })).toHaveClass(/\blk-text-xs\b/);
    });

    test('tabs, fields, primary action and alternate action share one grid', async ({ page }) => {
      const edges = await page.evaluate(() => {
        const rect = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const loginTab = rect('#auth-tab-login');
        const registerTab = rect('#auth-tab-register');
        const email = rect('#email');
        const primary = rect('button[type="submit"]');
        const alternate = rect('[data-auth-alternate] button');
        const tabs = {
          left: loginTab.left,
          right: registerTab.right,
        };
        return { tabs, email, primary, alternate };
      });

      for (const control of [edges.email, edges.primary, edges.alternate]) {
        expect(Math.abs(control.left - edges.tabs.left)).toBeLessThan(1);
        expect(Math.abs(control.right - edges.tabs.right)).toBeLessThan(1);
      }
    });

    test('fields and auth buttons use the compact shared component sizes', async ({ page }) => {
      await expect(page.locator('[data-ui-text-field]')).toHaveCount(2);
      for (const field of await page.locator('[data-ui-text-field]').all()) {
        await expect(field).toHaveAttribute('data-ui-size', 'sm');
      }

      for (const button of await page.locator('#auth-panel [data-ui-button]').all()) {
        await expect(button).toHaveAttribute('data-ui-button-size', 'md');
      }

      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(page.locator('[data-ui-text-field]')).toHaveCount(3);
      for (const field of await page.locator('[data-ui-text-field]').all()) {
        await expect(field).toHaveAttribute('data-ui-size', 'sm');
      }
      for (const button of await page.locator('#auth-panel [data-ui-button]').all()) {
        await expect(button).toHaveAttribute('data-ui-button-size', 'md');
      }
    });

    test('primary and Google actions have identical compact dimensions', async ({ page }) => {
      const assertSameDimensions = async () => {
        const primary = await page.locator('button[type="submit"]').boundingBox();
        const alternate = await page
          .locator('[data-auth-alternate] button')
          .boundingBox();
        expect(primary).not.toBeNull();
        expect(alternate).not.toBeNull();
        expect(Math.abs(primary!.height - alternate!.height)).toBeLessThan(1);
        expect(Math.abs(primary!.width - alternate!.width)).toBeLessThan(1);
        expect(primary!.height).toBe(40);
      };

      await assertSameDimensions();
      await page.getByRole('tab', { name: '会員登録' }).click();
      await assertSameDimensions();
    });

    test('switching tabs keeps fields and action rows fixed', async ({ page }) => {
      const positions = async () => {
        const boxTop = async (locator: import('@playwright/test').Locator) => {
          const box = await locator.boundingBox();
          expect(box).not.toBeNull();
          return box!.y;
        };
        return {
          email: await boxTop(page.locator('#email')),
          password: await boxTop(page.locator('#password')),
          primary: await boxTop(page.locator('button[type="submit"]')),
          divider: await boxTop(page.getByText('OR', { exact: true })),
          alternate: await boxTop(page.locator('[data-auth-alternate] button')),
        };
      };

      const login = await positions();
      const loginSupport = await page.locator('[data-auth-support-row]').boundingBox();

      await page.getByRole('tab', { name: '会員登録' }).click();
      const register = await positions();
      const registerSupport = await page.locator('[data-auth-support-row]').boundingBox();

      for (const key of Object.keys(login) as Array<keyof typeof login>) {
        expect(Math.abs(login[key] - register[key])).toBeLessThan(1);
      }
      expect(loginSupport).not.toBeNull();
      expect(registerSupport).not.toBeNull();
      expect(Math.abs(loginSupport!.y - registerSupport!.y)).toBeLessThan(1);
      expect(Math.abs(loginSupport!.height - registerSupport!.height)).toBeLessThan(1);
    });

    test('form is grouped near its tabs', async ({ page }) => {
      const metrics = await page.evaluate(() => {
        const tablist = document.querySelector('#auth-tab-login')!.getBoundingClientRect();
        const email = document.querySelector('#email')!.getBoundingClientRect();
        return {
          tabToFieldGap: email.top - tablist.bottom,
        };
      });

      expect(metrics.tabToFieldGap).toBeLessThanOrEqual(34.5);
    });
  });
}
