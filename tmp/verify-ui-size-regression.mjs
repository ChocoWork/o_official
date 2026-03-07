import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3002/ui';
const sizes = ['sm', 'md', 'lg'];

const sectionByHeading = async (page, heading) => {
  const h2 = page.locator('section h2', { hasText: heading }).first();
  const section = h2.locator('xpath=ancestor::section[1]');
  return { h2, section };
};

const getBox = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) return null;
  return { width: Number(box.width.toFixed(1)), height: Number(box.height.toFixed(1)) };
};

const results = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });

try {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  for (const s of sizes) {
    await page.getByRole('button', { name: new RegExp(`^${s}$`, 'i') }).click();
    await page.waitForTimeout(150);

    const row = { size: s };

    // Button ICON ONLY
    const { section: buttonSection } = await sectionByHeading(page, 'Button');
    const iconOnlyBtn = buttonSection.getByRole('button', { name: 'Add to wishlist' });
    row.iconOnly = await getBox(iconOnlyBtn);

    // Stepper controls (field variant)
    const { section: stepperSection } = await sectionByHeading(page, 'Stepper');
    const decBtn = stepperSection.getByRole('button', { name: 'decrease' });
    const incBtn = stepperSection.getByRole('button', { name: 'increase' });
    row.stepperDec = await getBox(decBtn);
    row.stepperInc = await getBox(incBtn);
    row.stepperDecVisible = await decBtn.isVisible();
    row.stepperIncVisible = await incBtn.isVisible();

    // Segment control
    const { section: segmentSection } = await sectionByHeading(page, 'Tab / Segment Control');
    const segmentPill = segmentSection.getByRole('button', { name: 'TOPS' }).first();
    row.segmentTops = await getBox(segmentPill);

    // Search field icon alignment proxy: icon and input center Y delta
    const { section: searchSection } = await sectionByHeading(page, 'Search Field');
    const searchInput = searchSection.locator('input[type="search"]').first();
    const searchIcon = searchSection.locator('.ri-search-line').first();
    const inputBox = await searchInput.boundingBox();
    const iconBox = await searchIcon.boundingBox();
    row.searchInput = inputBox ? { width: Number(inputBox.width.toFixed(1)), height: Number(inputBox.height.toFixed(1)) } : null;
    if (inputBox && iconBox) {
      const inputCy = inputBox.y + inputBox.height / 2;
      const iconCy = iconBox.y + iconBox.height / 2;
      row.searchCenterDelta = Number(Math.abs(inputCy - iconCy).toFixed(2));
    } else {
      row.searchCenterDelta = null;
    }

    // Floating button
    const { section: floatSection } = await sectionByHeading(page, 'Float Button');
    const floatBtn = floatSection.locator('button').filter({ has: page.locator('.ri-add-line, .ri-close-line') }).first();
    row.floatButton = await getBox(floatBtn);

    // Map
    const { section: mapSection } = await sectionByHeading(page, 'Map');
    const mapFrame = mapSection.locator('iframe').first();
    row.map = await getBox(mapFrame);

    // Badge variants
    const { section: badgeSection } = await sectionByHeading(page, 'Badge');
    const count3 = badgeSection.locator('span', { hasText: '3' }).first();
    const count12 = badgeSection.locator('span', { hasText: '12' }).first();
    const newBadge = badgeSection.locator('span', { hasText: 'NEW' }).first();
    row.badge3 = await getBox(count3);
    row.badge12 = await getBox(count12);
    row.badgeNew = await getBox(newBadge);

    // keep evidence
    await page.screenshot({ path: `tmp/ui-${s}.png`, fullPage: true });

    results.push(row);
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
