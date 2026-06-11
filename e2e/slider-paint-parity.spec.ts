import { test, expect } from '@playwright/test';
import sharp from 'sharp';

// Regression: single vs range tracks must paint with identical device-row patterns
// (same solid + same AA rows) at integer AND fractional DPRs across viewport widths.
// Relies on the component's useTrackPaintSnap (no style injection here).
const DPRS = [1, 1.25, 1.5, 1.75, 2];
const WIDTHS: number[] = [];
for (let w = 360; w <= 1240; w += 40) WIDTHS.push(w);

async function profile(png: Buffer, rc: { x: number; y: number; width: number; height: number }, dpr: number) {
  const pad = 8;
  const left = Math.max(0, Math.round(rc.x * dpr));
  const top = Math.max(0, Math.round((rc.y - pad) * dpr));
  const w = Math.round(rc.width * dpr);
  const h = Math.round((rc.height + pad * 2) * dpr);
  const { data, info } = await sharp(png).extract({ left, top, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const sx = Math.round(info.width * 0.25); // left quarter: solid #000 fill on both sliders
  let solid = 0, gray = 0;
  for (let y = 0; y < info.height; y++) {
    const v = data[(y * info.width + sx) * ch];
    if (v < 30) solid++;
    else if (v < 220) gray++;
  }
  return { solid, gray };
}

for (const dpr of DPRS) {
  test(`track paint parity @ DPR=${dpr}`, async ({ browser }) => {
    test.setTimeout(180000);
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 900, height: 800 } });
    const page = await context.newPage();
    await page.goto('/ui');
    await page.waitForLoadState('networkidle');

    const bad: string[] = [];
    for (const vw of WIDTHS) {
      await page.setViewportSize({ width: vw, height: 800 });
      await page.getByText('SINGLE VALUE').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(120); // let resize/scrollend snap settle
      const rects = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ui-slider-track]')).map((t) => {
        const r = t.getBoundingClientRect(); const sl = t.closest('[data-ui-slider]');
        return { isRange: !!sl?.querySelector('[data-ui-slider-range-input]'), x: r.x, y: r.y, width: r.width, height: r.height };
      }));
      const png = await page.screenshot();
      let s: { solid: number; gray: number } | undefined, r: { solid: number; gray: number } | undefined;
      for (const rc of rects) { const m = await profile(png, rc, dpr); if (rc.isRange) r = m; else s = m; }
      if (s && r && (s.solid !== r.solid || s.gray !== r.gray)) {
        bad.push(`w=${vw}: single(solid=${s.solid},gray=${s.gray}) range(solid=${r.solid},gray=${r.gray})`);
      }
    }
    console.log(`DPR=${dpr}: ${bad.length} mismatched widths of ${WIDTHS.length}`);
    for (const b of bad) console.log('  ' + b);
    await context.close();
    expect(bad, `DPR=${dpr} paint mismatches`).toEqual([]);
  });
}
