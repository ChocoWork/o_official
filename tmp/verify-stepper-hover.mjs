import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const base = 'http://localhost:3002';

const result = {
  ui: { found: false },
  cart: { found: false },
  item: { found: false, path: null },
};

try {
  // UI page (field variant)
  await page.goto(`${base}/ui`, { waitUntil: 'networkidle' });
  const uiSection = page.locator('section', { hasText: 'Stepper' }).first();
  const uiDec = uiSection.getByRole('button', { name: 'decrease' });
  const uiInc = uiSection.getByRole('button', { name: 'increase' });
  if (await uiDec.count()) {
    result.ui.found = true;
    await uiDec.hover();
    await page.screenshot({ path: 'tmp/stepper-ui-hover-decrease.png' });
    await uiInc.hover();
    await page.screenshot({ path: 'tmp/stepper-ui-hover-increase.png' });
  }

  // cart page (compact variant)
  await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
  const cartDec = page.getByRole('button', { name: 'decrease' }).first();
  const cartInc = page.getByRole('button', { name: 'increase' }).first();
  if ((await cartDec.count()) > 0) {
    result.cart.found = true;
    await cartDec.hover();
    await page.screenshot({ path: 'tmp/stepper-cart-hover-decrease.png' });
    await cartInc.hover();
    await page.screenshot({ path: 'tmp/stepper-cart-hover-increase.png' });
  }

  // item detail page: open from first item link
  await page.goto(`${base}/item`, { waitUntil: 'networkidle' });
  const firstItemLink = page.locator('a[href^="/item/"]').first();
  if ((await firstItemLink.count()) > 0) {
    const href = await firstItemLink.getAttribute('href');
    result.item.path = href;
    if (href) {
      await page.goto(`${base}${href}`, { waitUntil: 'networkidle' });
      const itemDec = page.getByRole('button', { name: 'decrease' }).first();
      const itemInc = page.getByRole('button', { name: 'increase' }).first();
      if ((await itemDec.count()) > 0) {
        result.item.found = true;
        await itemDec.hover();
        await page.screenshot({ path: 'tmp/stepper-item-hover-decrease.png' });
        await itemInc.hover();
        await page.screenshot({ path: 'tmp/stepper-item-hover-increase.png' });
      }
    }
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
