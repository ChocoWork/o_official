import { test, expect } from '@playwright/test';
import sharp from 'sharp';

const SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
const DPR = Number(process.env.DPR ?? 3);

// Count vertical extent of "painted" (clearly non-white) rows inside a track rect.
async function paintedRows(png: Buffer, rect: { x: number; y: number; width: number; height: number }) {
  // Expand vertically a bit so we capture the full painted band even if it bleeds past the layout box.
  const pad = 6;
  const left = Math.max(0, Math.round(rect.x * DPR));
  const top = Math.max(0, Math.round((rect.y - pad) * DPR));
  const w = Math.round(rect.width * DPR);
  const h = Math.round((rect.height + pad * 2) * DPR);

  const region = await sharp(png)
    .extract({ left, top, width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = region;
  const ch = info.channels;
  // Sample the left quarter: single fill (0-50%) and range fill (0-100%) are BOTH solid black here,
  // and no thumb sits here (single thumb @50%, range thumbs @0/100%). Apples-to-apples black band.
  const sampleX = Math.round(info.width * 0.25);
  let firstRow = -1;
  let lastRow = -1;
  for (let y = 0; y < info.height; y++) {
    const idx = (y * info.width + sampleX) * ch;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    // track bg is rgba(0,0,0,0.2) over white ≈ (204,204,204). Treat anything clearly darker than white as painted.
    const painted = r < 245 || g < 245 || b < 245;
    if (painted) {
      if (firstRow === -1) firstRow = y;
      lastRow = y;
    }
  }
  if (firstRow === -1) return 0;
  return (lastRow - firstRow + 1) / DPR; // back to CSS px
}

test('Slider PAINTED track band: single vs range', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: DPR, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('/ui');
  await page.waitForLoadState('networkidle');
  await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const results: Record<string, { single: number; range: number }> = {};

  for (const size of SIZES) {
    const sizeBtn = page.locator('button').filter({ hasText: new RegExp(`^${size}$`, 'i') }).first();
    await sizeBtn.click();
    await page.waitForTimeout(250);

    const rects = await page.evaluate(() => {
      const tracks = Array.from(document.querySelectorAll('[data-ui-slider-track]'));
      return tracks.map((t) => {
        const r = t.getBoundingClientRect();
        const slider = t.closest('[data-ui-slider]');
        const isRange = !!slider?.querySelector('[data-ui-slider-range-input]');
        return { isRange, x: r.x, y: r.y, width: r.width, height: r.height };
      });
    });

    const png = await page.screenshot({ fullPage: false });

    let single = 0, range = 0;
    for (const rc of rects) {
      const band = await paintedRows(png, rc);
      if (rc.isRange) range = band; else single = band;
    }
    results[size] = { single, range };
    console.log(`[${size.toUpperCase()}] painted single=${single.toFixed(3)}px range=${range.toFixed(3)}px diff=${Math.abs(single - range).toFixed(3)}px`);
  }

  await context.close();

  for (const size of SIZES) {
    const { single, range } = results[size];
    expect(
      Math.abs(single - range),
      `[${size}] painted single(${single.toFixed(3)}) vs range(${range.toFixed(3)})`
    ).toBeLessThanOrEqual(1 / DPR + 0.01);
  }
});
