import { expect, test, type Page } from '@playwright/test';

// FREQ-145: mobile / tablet のシーズンタイトル（例: 2028 AW）の字間を狭める。
// FREQ-143 で一度広げた字間拡大を取り消し、tracking-widest（0.1em）より詰める。
// 色をより黒く・字を太くする強調（FREQ-143-REQ-01/02）は維持する。
// desktop はオーバーレイ表示のため対象外。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

type SeasonStyle = {
  text: string;
  opacity: number;
  fontWeight: number;
  letterSpacingPx: number;
  fontSizePx: number;
};

async function readSeasonStyle(page: Page): Promise<SeasonStyle> {
  const caption = page.locator('[data-testid="look-card-caption"]').first();
  await caption.scrollIntoViewIfNeeded();
  const label = caption.locator('p').first();
  await expect(label).toBeVisible();
  return label.evaluate((el) => {
    const cs = getComputedStyle(el);
    const parse = (v: string) => (v === 'normal' ? 0 : parseFloat(v) || 0);
    const slashAlpha = cs.color.match(/\/\s*([\d.]+)\s*\)/);
    let opacity = 1;
    if (slashAlpha) opacity = parseFloat(slashAlpha[1]);
    else {
      const nums = cs.color.match(/[\d.]+/g) ?? [];
      opacity = nums.length >= 4 ? parseFloat(nums[3]) : 1;
    }
    return {
      text: (el.textContent ?? '').trim(),
      opacity,
      fontWeight: Number(cs.fontWeight),
      letterSpacingPx: parse(cs.letterSpacing),
      fontSizePx: parseFloat(cs.fontSize) || 0,
    };
  });
}

test.describe('FR-LOOK-ALL-032 シーズンタイトルの字間を狭める（mobile / tablet）', () => {
  for (const vp of VIEWPORTS) {
    for (const path of ['/', '/look'] as const) {
      test(`${vp.name} ${path} でシーズンタイトルの字間が詰まっている`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const style = await readSeasonStyle(page);

        // AC-01: letter-spacing は 0.1em（従来 tracking-widest）より狭い
        expect(style.letterSpacingPx).toBeLessThan(style.fontSizePx * 0.1);
        // AC-02: 濃さ・太さの強調は維持（FREQ-143）
        expect(style.opacity, `color alpha (${style.text})`).toBeGreaterThan(0.5);
        expect(style.fontWeight).toBeGreaterThanOrEqual(500);
      });
    }
  }
});
