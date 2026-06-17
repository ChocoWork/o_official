const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:3000/cart', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'C:\\work\\o_official\\cart-current.png', fullPage: false });
  console.log('done');
  await browser.close();
})();
