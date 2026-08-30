import { expect, test } from "@playwright/test";

// FREQ-275: ITEMS / LOOK / NEWS / ABOUT / STOCKIST の見出しを共通化。
// 文字サイズは hyke.jp 準拠で 1024px 未満 20px 相当 / 以上 28px 相当、いずれも下線あり。
//
// FREQ-314: 固定 px をやめ、黄金比スケール --lk-size-4xl / --lk-size-9xl に乗せた。
// スケールは流体（--lk-size-md が 14〜15px）なので、期待値は実測して比べる。
// FREQ-275-AC の「正確に 20px / 28px」は FREQ-314-REQ-02 で撤回。

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, token: "4xl" },
  { name: "tablet", width: 768, height: 1024, token: "4xl" },
  { name: "desktop", width: 1280, height: 900, token: "9xl" },
] as const;

const TITLES = ["ITEMS", "LOOK", "NEWS", "ABOUT", "STOCKIST"] as const;

type Style = { fontSize: string; textDecorationLine: string };

/** `font-size: var(--lk-size-<token>)` の実測 px。 */
async function tokenPx(
  page: import("@playwright/test").Page,
  token: string,
): Promise<number> {
  return page.evaluate((name: string) => {
    const el = document.createElement("span");
    el.style.position = "absolute";
    el.style.visibility = "hidden";
    el.style.fontSize = `var(--lk-size-${name})`;
    document.body.appendChild(el);
    const px = Number.parseFloat(getComputedStyle(el).fontSize);
    el.remove();
    return px;
  }, token);
}

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

      const expected = await tokenPx(page, vp.token);
      expect(expected, `--lk-size-${vp.token} が解決されていない`).toBeGreaterThan(0);

      for (const title of TITLES) {
        const styles = await readStyles(page, title);
        expect(styles.length, `${title} の見出しが見つからない`).toBeGreaterThan(
          0,
        );

        for (const style of styles) {
          expect(
            Math.abs(Number.parseFloat(style.fontSize) - expected),
            `${title} の font-size が ${style.fontSize}（期待 --lk-size-${vp.token} = ${expected}px）`,
          ).toBeLessThanOrEqual(0.5);
          expect(style.textDecorationLine, `${title} の下線`).toBe("underline");
        }
      }
    });
  }
});
