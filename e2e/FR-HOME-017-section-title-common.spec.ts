import { expect, test } from "@playwright/test";

// FREQ-275: ITEMS / LOOK / NEWS / ABOUT / STOCKIST の見出しを共通化。
// 文字サイズは hyke.jp 準拠で 1024px 未満 20px / 以上 28px、いずれも下線あり。

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, fontSize: 20 },
  { name: "tablet", width: 768, height: 1024, fontSize: 20 },
  { name: "desktop", width: 1280, height: 900, fontSize: 28 },
] as const;

const TITLES = ["ITEMS", "LOOK", "NEWS", "ABOUT", "STOCKIST"] as const;

type Style = { fontSize: string; textDecorationLine: string };

async function readStyles(
  page: import("@playwright/test").Page,
  title: string,
): Promise<Style[]> {
  return page
    .getByRole("heading", { level: 2, name: title, exact: true })
    .evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return {
          fontSize: cs.fontSize,
          textDecorationLine: cs.textDecorationLine,
        };
      }),
    );
}

test.describe("FR-HOME-017 セクション見出しの共通化", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: FREQ-275-AC-01/AC-02/AC-03 見出しが共通サイズ・共通下線`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");

      for (const title of TITLES) {
        const styles = await readStyles(page, title);
        expect(styles.length, `${title} の見出しが見つからない`).toBeGreaterThan(
          0,
        );

        for (const style of styles) {
          expect(style.fontSize, `${title} の font-size`).toBe(
            `${vp.fontSize}px`,
          );
          expect(style.textDecorationLine, `${title} の下線`).toBe("underline");
        }
      }
    });
  }
});
