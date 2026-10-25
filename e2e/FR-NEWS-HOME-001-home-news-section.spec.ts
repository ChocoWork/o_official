import { expect, test, type Locator, type Page } from '@playwright/test';

// NEWS 領域の要求のうち、ホーム / の ITEMS・LOOK・NEWS の区画に関わる受け入れ条件。
// FREQ-126（VIEW ALL を見出しの右に常時）・FREQ-146（共通 Button・矢印なし）・
// FREQ-149（NEWS は最大6件・総数が多い時だけ VIEW ALL）・FREQ-275（見出しの共通サイズ・下線）。
//
// 前提: 手元の Supabase を supabase/seed.sql で初期化済み（公開 NEWS 8件 = 6件より多い）。
// このファイルは DB を書き換えない。
// FREQ-149-AC-02 の「総数が6件以下」の側は、公開の NEWS を一時的に非公開へ変える必要があり、
// 並列の他テストと干渉するため、ここでは確かめない（seed のまま確かめられる「6件より多い」側のみ）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const SECTIONS = [
  { id: 'items', title: 'ITEMS', href: '/item', oldLabel: 'VIEW ALL ITEMS' },
  { id: 'look', title: 'LOOK', href: '/look', oldLabel: 'VIEW LOOKBOOK' },
  { id: 'news', title: 'NEWS', href: '/news', oldLabel: 'VIEW ALL NEWS' },
] as const;

const HEADING_TITLES = ['ITEMS', 'LOOK', 'NEWS', 'ABOUT', 'STOCKIST'] as const;

function viewAllLinks(page: Page, section: (typeof SECTIONS)[number]): Locator {
  return page
    .locator(`#${section.id} a[href="${section.href}"]`)
    .filter({ hasText: 'VIEW ALL' });
}

function sectionHeading(page: Page, section: (typeof SECTIONS)[number]): Locator {
  return page
    .locator(`#${section.id}`)
    .getByRole('heading', { level: 2, name: section.title, exact: true });
}

type Box = { left: number; right: number; top: number; bottom: number };

/** 見出しの文字（Range）の枠と、VIEW ALL リンクの枠を測る。 */
async function measure(
  page: Page,
  section: (typeof SECTIONS)[number],
): Promise<{ headingText: Box; headingBox: Box; links: Box[] }> {
  return page.evaluate(
    ({ id, title, href }) => {
      const root = document.getElementById(id);
      if (!root) throw new Error(`#${id} がない`);
      const heading = Array.from(root.querySelectorAll('h2')).find(
        (h) => h.textContent?.trim() === title,
      );
      if (!heading) throw new Error(`${title} の見出しがない`);
      const range = document.createRange();
      range.selectNodeContents(heading);
      const toBox = (r: DOMRect): Box => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      });
      const links = Array.from(
        root.querySelectorAll(`a[href="${href}"]`),
      )
        .filter((a) => a.textContent?.includes('VIEW ALL'))
        .map((a) => toBox(a.getBoundingClientRect()));
      return {
        headingText: toBox(range.getBoundingClientRect()),
        headingBox: toBox(heading.getBoundingClientRect()),
        links,
      };
    },
    { id: section.id, title: section.title, href: section.href },
  );
}

test.describe('FR-NEWS-HOME-001 home ITEMS / LOOK / NEWS sections', () => {
  for (const vp of VIEWPORTS) {
    test.describe(vp.name, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await expect(
          page.getByRole('heading', { level: 2, name: 'NEWS', exact: true }),
        ).toBeVisible();
      });

      // FREQ-126-AC-01 / 02 / 03: 見出しの右に該当一覧への VIEW ALL リンクが表示される
      const expectViewAllRightOfHeading = async (
        page: Page,
        section: (typeof SECTIONS)[number],
      ) => {
        await expect(sectionHeading(page, section)).toBeVisible();
        const link = viewAllLinks(page, section);
        await expect(link).toHaveCount(1);
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', section.href);

        const { headingText, headingBox, links } = await measure(page, section);
        expect(links).toHaveLength(1);
        const box = links[0];
        // 見出しの文字より右にある
        expect(
          box.left,
          `${section.title}: VIEW ALL の左端が見出しの文字の右端より右`,
        ).toBeGreaterThanOrEqual(headingText.right - 0.5);
        // 見出しと同じ行にある（見出しの下に回り込まない）
        const centerY = (box.top + box.bottom) / 2;
        expect(
          centerY,
          `${section.title}: VIEW ALL の縦の中心が見出しの行の中`,
        ).toBeGreaterThanOrEqual(headingBox.top - 0.5);
        expect(centerY).toBeLessThanOrEqual(headingBox.bottom + 0.5);
      };

      test(`FREQ-126-AC-01 ${vp.name}: ITEMS の見出しの右に /item への VIEW ALL が表示される`, async ({
        page,
      }) => {
        test.fail(true, 'FREQ-126 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
        await expectViewAllRightOfHeading(page, SECTIONS[0]);
      });

      test(`FREQ-126-AC-02 ${vp.name}: LOOK の見出しの右に /look への VIEW ALL が表示される`, async ({
        page,
      }) => {
        test.fail(true, 'FREQ-126 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
        await expectViewAllRightOfHeading(page, SECTIONS[1]);
      });

      test(`FREQ-126-AC-03 ${vp.name}: NEWS の見出しの右に /news への VIEW ALL が表示される`, async ({
        page,
      }) => {
        test.fail(true, 'FREQ-126 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
        await expectViewAllRightOfHeading(page, SECTIONS[2]);
      });

      // FREQ-126-AC-04: 従来の下部中央の VIEW ALL ボタンが表示されない
      // （文字の側は今のコードが満たす。位置の側は満たさないので、別のテストに分けて test.fail を付ける）
      test(`FREQ-126-AC-04 ${vp.name}: VIEW ALL ITEMS / VIEW LOOKBOOK / VIEW ALL NEWS の従来のボタンの文字が表示されない`, async ({
        page,
      }) => {
        for (const section of SECTIONS) {
          // 従来のボタンの文字そのものが無い
          await expect(
            page
              .locator(`#${section.id}`)
              .getByText(section.oldLabel, { exact: true }),
            `${section.oldLabel} の文字`,
          ).toHaveCount(0);
        }
      });

      test(`FREQ-126-AC-04 ${vp.name}: 区画の下（見出しの行より下）に VIEW ALL のリンクが表示されない`, async ({
        page,
      }) => {
        test.fail(true, 'FREQ-126 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
        for (const section of SECTIONS) {
          // 区画の下（見出しより下）に VIEW ALL のリンクが無い
          const { headingBox, links } = await measure(page, section);
          for (const box of links) {
            expect(
              box.top,
              `${section.title}: VIEW ALL が見出しの行より下にない`,
            ).toBeLessThan(headingBox.bottom);
          }
        }
      });

      // FREQ-146-AC-01: VIEW ALL に data-ui-button="true"（secondary）が付く
      test(`FREQ-146-AC-01 ${vp.name}: ITEM / LOOK / NEWS の VIEW ALL に data-ui-button=true と secondary が付く`, async ({
        page,
      }) => {
        for (const section of SECTIONS) {
          const link = viewAllLinks(page, section);
          await expect(link, `${section.title}`).toHaveCount(1);
          await expect(link).toHaveAttribute('data-ui-button', 'true');
          await expect(link).toHaveAttribute(
            'data-ui-button-variant',
            'secondary',
          );
        }
      });

      // FREQ-146-AC-02: VIEW ALL 内に右矢印アイコン（ri-arrow-right-line）が無い
      test(`FREQ-146-AC-02 ${vp.name}: VIEW ALL の中に ri-arrow-right-line が無い`, async ({
        page,
      }) => {
        for (const section of SECTIONS) {
          const link = viewAllLinks(page, section);
          await expect(link, `${section.title}`).toHaveCount(1);
          await expect(link.locator('.ri-arrow-right-line')).toHaveCount(0);
        }
      });

      // FREQ-149-AC-01: どの幅でも NEWS 記事が最大6件（取得件数どおり）表示される
      test(`FREQ-149-AC-01 ${vp.name}: NEWS の記事が6件表示される（seed の公開8件のうち上限の6件）`, async ({
        page,
      }) => {
        const cards = page.locator('#news article');
        await expect(cards).toHaveCount(6);
        for (let i = 0; i < 6; i += 1) {
          await expect(cards.nth(i)).toBeVisible();
        }
      });

      // FREQ-149-AC-02【半分だけ】: AC は「6件より多い時だけ VIEW ALL が出る」の両側を求める。ここで試すのは
      // 「6件より多い（seed の公開8件）→ 出る」の側だけ。「6件以下 → 出ない」の側は、公開の NEWS を非公開へ変える
      // 必要があり、並列の他のテスト（FR-HOME-013 など）の件数と干渉するので E2E にしない（未了の側は
      // docs/02_Requirements/areas/news.md の FREQ-149-AC-02 に記録する）。
      test(`FREQ-149-AC-02 ${vp.name}: 【6件より多い側のみ】公開 NEWS が6件より多い（seed 8件）ので NEWS の VIEW ALL が表示される`, async ({
        page,
      }) => {
        await expect(page.locator('#news article')).toHaveCount(6);
        const link = viewAllLinks(page, SECTIONS[2]);
        await expect(link).toHaveCount(1);
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', '/news');
      });

      // FREQ-275-AC-01: ITEMS / LOOK / NEWS / ABOUT / STOCKIST の見出しが同一の font-size
      test(`FREQ-275-AC-01 ${vp.name}: 5つの見出しがすべて同一の font-size`, async ({
        page,
      }) => {
        const sizes: { title: string; px: number }[] = [];
        for (const title of HEADING_TITLES) {
          const found = await page
            .getByRole('heading', { level: 2, name: title, exact: true })
            .evaluateAll((els) =>
              els.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
            );
          expect(found.length, `${title} の見出しが見つからない`).toBeGreaterThan(
            0,
          );
          for (const px of found) sizes.push({ title, px });
        }
        const base = sizes[0].px;
        expect(base, '見出しの font-size が解決されている').toBeGreaterThan(0);
        for (const { title, px } of sizes) {
          expect(
            Math.abs(px - base),
            `${title} の font-size ${px}px（基準 ${sizes[0].title} ${base}px）`,
          ).toBeLessThanOrEqual(0.5);
        }
      });

      // FREQ-275-AC-03: 5つの見出しすべての text-decoration-line が underline
      test(`FREQ-275-AC-03 ${vp.name}: 5つの見出しすべてに下線がある`, async ({
        page,
      }) => {
        for (const title of HEADING_TITLES) {
          const lines = await page
            .getByRole('heading', { level: 2, name: title, exact: true })
            .evaluateAll((els) =>
              els.map((el) => getComputedStyle(el).textDecorationLine),
            );
          expect(lines.length, `${title} の見出しが見つからない`).toBeGreaterThan(
            0,
          );
          for (const line of lines) {
            expect(line, `${title} の text-decoration-line`).toBe('underline');
          }
        }
      });
    });
  }
});
