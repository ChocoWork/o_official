import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const authRoutes = ['/login', '/auth/password-reset'] as const;

for (const viewport of viewports) {
  for (const route of authRoutes) {
    test(`${route} is centered in the dynamic viewport (${viewport.name})`, async ({ page }) => {
      // FREQ-94-AC-01: 固定ヘッダー下のmainではなく、100dvh全体の中央へ配置する
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route);

      const metrics = await page.evaluate(() => {
        const root = document.querySelector('#main-content > :first-child');
        const header = document.querySelector('header');
        const footer = document.querySelector('footer');
        if (!root || !header || !footer) throw new Error('Auth layout landmarks are missing');

        const rootBox = root.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const footerBox = footer.getBoundingClientRect();
        return {
          rootCenter: rootBox.top + rootBox.height / 2,
          viewportCenter: window.innerHeight / 2,
          rootTop: rootBox.top,
          headerBottom: headerBox.bottom,
          footerTop: footerBox.top,
          hasHorizontalOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });

      expect(Math.abs(metrics.rootCenter - metrics.viewportCenter)).toBeLessThan(1);
      expect(metrics.rootTop).toBeGreaterThanOrEqual(metrics.headerBottom);
      expect(metrics.footerTop).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(metrics.hasHorizontalOverflow).toBe(false);
    });
  }
}

test('login remains viewport-centered after switching to registration', async ({ page }) => {
  // FREQ-94-AC-02: タブ切替で共通ルートコンテナの中心を動かさない
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByRole('tab', { name: '会員登録' }).click();

  const centerDelta = await page.locator('#main-content > :first-child').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
  });
  expect(centerDelta).toBeLessThan(1);
});

test('short viewport keeps the login form reachable without clipping', async ({ page }) => {
  // FREQ-94-AC-03: 高さ不足時はmainを伸ばし、固定ヘッダーの下から全内容へ到達できる
  await page.setViewportSize({ width: 375, height: 568 });
  await page.goto('/login');

  const metrics = await page.evaluate(() => {
    const root = document.querySelector('#main-content > :first-child');
    const header = document.querySelector('header');
    if (!root || !header) throw new Error('Auth layout landmarks are missing');
    const rootBox = root.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    return {
      rootTop: rootBox.top,
      rootBottom: rootBox.bottom,
      headerBottom: headerBox.bottom,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics.rootTop).toBeGreaterThanOrEqual(metrics.headerBottom);
  expect(metrics.rootBottom).toBeLessThanOrEqual(metrics.scrollHeight);
});
