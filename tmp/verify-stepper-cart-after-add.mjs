import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const base = 'http://localhost:3002';

const result = { added: false, cartStepperFound: false };

try {
  await page.goto(`${base}/item`, { waitUntil: 'networkidle' });
  const firstItemLink = page.locator('a[href^="/item/"]').first();
  const href = await firstItemLink.getAttribute('href');
  if (!href) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  await page.goto(`${base}${href}`, { waitUntil: 'networkidle' });
  const addToCart = page.getByRole('button', { name: /add to cart/i }).first();
  if ((await addToCart.count()) > 0) {
    await addToCart.click();
    result.added = true;
  }

  await page.goto(`${base}/cart`, { waitUntil: 'networkidle' });
  const dec = page.getByRole('button', { name: 'decrease' }).first();
  const inc = page.getByRole('button', { name: 'increase' }).first();

  if ((await dec.count()) > 0) {
    result.cartStepperFound = true;
    await dec.hover();
    await page.screenshot({ path: 'tmp/stepper-cart-hover-decrease.png' });
    await inc.hover();
    await page.screenshot({ path: 'tmp/stepper-cart-hover-increase.png' });
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
