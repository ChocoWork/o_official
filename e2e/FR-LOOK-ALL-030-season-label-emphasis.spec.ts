import { expect, test, type Page } from '@playwright/test';

// FREQ-143: mobile / tablet のシーズン表記（例: 2028 AW）を、
// 添付見本のように「文字色をより黒く・字を太く・字間を広げて」強調する。
// 「/01」などの番号要素は追加しない。desktop はオーバーレイ表示のため対象外。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

type SeasonStyle = {
  text: string;
  opacity: number; // 文字色の不透明度（黒 rgba の alpha）
  fontWeight: number;
  letterSpacingPx: number;
  fontSizePx: number;
};

// mobile/tablet で表示されるキャプションのシーズンラベル（先頭の <p>）の
// 算出スタイルを読み取る。
async function readSeasonStyle(page: Page): Promise<SeasonStyle> {
  const caption = page.locator('[data-testid="look-card-caption"]').first();
  await caption.scrollIntoViewIfNeeded();
  const label = caption.locator('p').first();
  await expect(label).toBeVisible();
  return label.evaluate((el) => {
    const cs = getComputedStyle(el);
    const parse = (v: string) => (v === 'normal' ? 0 : parseFloat(v) || 0);
    // color は oklab / rgba いずれの形式でも alpha を抽出する
    const alphaMatch = cs.color.match(/[\d.]+\s*\)\s*$/);
    const slashAlpha = cs.color.match(/\/\s*([\d.]+)\s*\)/);
    let opacity = 1;
    if (slashAlpha) opacity = parseFloat(slashAlpha[1]);
    else if (alphaMatch) {
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

test.describe('FR-LOOK-ALL-030 シーズンラベルの強調（mobile / tablet）', () => {
  for (const vp of VIEWPORTS) {
    for (const path of ['/', '/look'] as const) {
      test(`${vp.name} ${path} でシーズン表記が濃く・太くなる`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(path);
        const style = await readSeasonStyle(page);

        // AC-01: 文字色は従来（黒 50%）より濃い
        expect(style.opacity, `color alpha (${style.text})`).toBeGreaterThan(0.5);
        // AC-02: font-weight は 500 以上
        expect(style.fontWeight).toBeGreaterThanOrEqual(500);
        // 字間は FREQ-145 で狭める方針に変更（検証は FR-LOOK-ALL-032 が担う）。
        // AC-04: 「{4桁年} {SS|AW}」形式のまま。番号（数字/スラッシュ）を含まない
        expect(style.text).toMatch(/^\d{4} (SS|AW)$/);
        expect(style.text).not.toContain('/');
      });
    }
  }
});
