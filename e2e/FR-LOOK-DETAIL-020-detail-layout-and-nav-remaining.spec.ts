import { expect, Page, test } from '@playwright/test';

// LOOK 詳細の見た目の受け入れ基準のうち、他の FR-LOOK-DETAIL-* が試していない物を埋める。
// FREQ-176-AC-02 / FREQ-180-AC-02 / FREQ-181-AC-02・03 / FREQ-182-AC-02 / FREQ-183-AC-02・03 /
// FREQ-344-AC-02 / FREQ-289-AC-01・02
// 手元の Supabase の seed（ルック1: 画像2枚・紐づけ商品2件、商品1: 画像2枚）だけを使う。

const LOOK_PATH = '/look/1';
const ITEM_PATH = '/item/1';

const THREE_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

// モバイルの固定ボトムナビは FREQ-343 が置き換えたため、インラインナビは tablet / desktop だけ。
const INLINE_NAV_VIEWPORTS = [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const LG_VIEWPORTS = [
  { name: 'lg-min (1024x1366)', width: 1024, height: 1366 },
  { name: 'desktop (1280x800)', width: 1280, height: 800 },
] as const;

const SHORT_DESKTOP = { width: 1280, height: 725 } as const;

async function openLookDetail(page: Page): Promise<void> {
  await page.goto(LOOK_PATH);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function openInlineNav(page: Page) {
  await openLookDetail(page);
  const nav = page.locator('[data-testid="look-detail-bottom-nav"]');
  await nav.scrollIntoViewIfNeeded();
  await expect(nav).toBeVisible();
  return nav;
}

test.describe('FR-LOOK-DETAIL-020 LOOK 詳細の配置・ナビの残りの受け入れ基準', () => {
  for (const vp of THREE_VIEWPORTS) {
    test(`FREQ-176-AC-02 ${vp.name} 上端・下端・アイテム間のすべての線の太さが 1px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openLookDetail(page);

      const list = page.locator(
        '[data-ui-list][data-ui-list-variant="showcase"]',
      );
      await expect(list).toBeVisible();

      const listWidths = await list.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { top: cs.borderTopWidth, bottom: cs.borderBottomWidth };
      });
      expect(listWidths.top).toBe('1px');
      expect(listWidths.bottom).toBe('1px');

      // アイテム間の線: 最後以外のアイテムの下辺（最後の下辺は並びの下端の線が担う）
      const items = list.locator('[data-list-item]');
      const itemCount = await items.count();
      expect(itemCount).toBeGreaterThanOrEqual(2);
      const itemBottomWidths = await items.evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).borderBottomWidth),
      );
      for (const width of itemBottomWidths.slice(0, -1)) {
        expect(width).toBe('1px');
      }
    });
  }

  for (const vp of LG_VIEWPORTS) {
    test(`FREQ-180-AC-02 ${vp.name} メイン画像枠の縦横比が 2/3（±2%）`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openLookDetail(page);

      const frame = page.locator(
        '[data-testid="look-detail-main-image-frame"]',
      );
      await expect(frame).toBeVisible();
      const box = await frame.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;

      const ratio = box.width / box.height;
      expect(ratio).toBeGreaterThanOrEqual((2 / 3) * 0.98);
      expect(ratio).toBeLessThanOrEqual((2 / 3) * 1.02);
    });
  }

  for (const vp of INLINE_NAV_VIEWPORTS) {
    test(`FREQ-181-AC-02 ${vp.name} 中央・右カラムの左に 1px の縦区切り線が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const nav = await openInlineNav(page);

      const columns = nav.locator(':scope > *');
      await expect(columns).toHaveCount(3);

      // Tailwind v4 の divide-x は前側の列の右ボーダーとして線を付ける。
      // 中央の列の左・右の列の左に出る線は、隣の列の右辺か当の列の左辺のどちらかで 1px になる。
      const widths = await columns.evaluateAll((els) =>
        els.map((el) => {
          const cs = getComputedStyle(el);
          return {
            left: cs.borderLeftWidth,
            right: cs.borderRightWidth,
            height: el.getBoundingClientRect().height,
          };
        }),
      );
      // 左の列の左・右の列の右には線が出ない
      expect(widths[0].left).toBe('0px');
      expect(widths[2].right).toBe('0px');
      // 中央の列の左（左列の右辺 or 中央列の左辺）
      expect([widths[0].right, widths[1].left]).toContain('1px');
      // 右の列の左（中央列の右辺 or 右列の左辺）
      expect([widths[1].right, widths[2].left]).toContain('1px');
      // 縦の線: 列に高さがある
      for (const column of widths) {
        expect(column.height).toBeGreaterThan(0);
      }
    });

    test(`FREQ-181-AC-03 ${vp.name} ナビの中に LOOK のテーマ名が出ない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const nav = await openInlineNav(page);

      const theme = (
        await page.getByRole('heading', { level: 1 }).innerText()
      ).trim();
      expect(theme.length).toBeGreaterThan(0);

      const navText = await nav.innerText();
      expect(navText).not.toContain(theme);
      // 見える文字だけでなく、リンクの名前（aria-label）にも出ない
      const labels = await nav
        .locator('[aria-label]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
      for (const label of labels) {
        expect(label ?? '').not.toContain(theme);
      }
    });

    test(`FREQ-182-AC-02 ${vp.name} アイコンの線幅が 1・塗りなし・線の色が文字の色`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const nav = await openInlineNav(page);

      const icons = nav.locator('[data-testid="look-detail-nav-icon"]');
      await expect(icons).toHaveCount(3);

      const metrics = await icons.evaluateAll((els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          const parent = el.parentElement;
          return {
            strokeWidth: style.strokeWidth,
            fill: style.fill,
            stroke: style.stroke,
            color: style.color,
            parentColor: parent ? getComputedStyle(parent).color : '',
          };
        }),
      );
      for (const metric of metrics) {
        expect(parseFloat(metric.strokeWidth)).toBeCloseTo(1, 1);
        expect(metric.fill).toBe('none');
        expect(metric.stroke).toBe(metric.color);
        expect(metric.stroke).toBe(metric.parentColor);
      }
    });

    test(`FREQ-183-AC-02 ${vp.name} アイコンの大きさが var(--lk-size-7xl)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const nav = await openInlineNav(page);

      const expectedSize = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.width = 'var(--lk-size-7xl)';
        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      expect(expectedSize).toBeGreaterThan(0);

      const icons = nav.locator('[data-testid="look-detail-nav-icon"]');
      await expect(icons).toHaveCount(3);
      const sizes = await icons.evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      for (const size of sizes) {
        expect(size.width).toBeCloseTo(expectedSize, 0);
        expect(size.height).toBeCloseTo(expectedSize, 0);
      }
    });

    test(`FREQ-183-AC-03 ${vp.name} 3カラムのラベルの letter-spacing がすべて同一`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const nav = await openInlineNav(page);

      const labels = nav.locator('p');
      await expect(labels).toHaveCount(3);
      await expect(labels).toHaveText(['PREV LOOK', 'LOOK LIST', 'NEXT LOOK']);

      const spacings = await labels.evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).letterSpacing),
      );
      expect(spacings).toHaveLength(3);
      expect(new Set(spacings).size).toBe(1);
    });
  }

  for (const vp of THREE_VIEWPORTS) {
    test(`FREQ-344-AC-02 ${vp.name} 画面の右端を越える要素が無い`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openLookDetail(page);

      // はみ出し元を特定できるよう列挙する。左側へのはみ出しは md 以上の画像列で意図的に行っており、
      // スクロールを生まないので見ない。
      const overflowing = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        return Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            // 祖先の overflow で切り取られた後の表示領域で調べる（カルーセルの次のスライド等）。
            let left = r.left;
            let right = r.right;
            let top = r.top;
            let bottom = r.bottom;
            for (
              let parent = el.parentElement;
              parent &&
              parent !== document.body &&
              parent !== document.documentElement;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const clips = (overflow: string) =>
                ['hidden', 'clip', 'scroll', 'auto'].includes(overflow);
              const bounds = parent.getBoundingClientRect();
              if (clips(style.overflowX)) {
                const clipLeft = bounds.left + parent.clientLeft;
                left = Math.max(left, clipLeft);
                right = Math.min(right, clipLeft + parent.clientWidth);
              }
              if (clips(style.overflowY)) {
                const clipTop = bounds.top + parent.clientTop;
                top = Math.max(top, clipTop);
                bottom = Math.min(bottom, clipTop + parent.clientHeight);
              }
            }
            return right > left && bottom > top && right > limit + 0.5;
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            const cls =
              typeof el.className === 'string' ? el.className : '(svg)';
            return `${el.tagName}.${cls.slice(0, 60)} [${r.left.toFixed(1)}, ${r.right.toFixed(1)}]`;
          })
          // フォーカス時のみ表示されるスキップリンクは常時 viewport 外に置くため除外
          .filter((desc) => !desc.includes('sr-only'));
      });
      expect(overflowing).toEqual([]);
    });
  }

  test('FREQ-289-AC-01 desktop（1280x725）ITEM 詳細のインジケータ下端が viewport 下端から 12px 以上離れる', async ({
    page,
  }) => {
    await page.setViewportSize(SHORT_DESKTOP);
    await page.goto(ITEM_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const indicator = page.locator(
      '[data-testid="item-detail-main-image-indicator"]',
    );
    await expect(indicator).toBeVisible();
    const box = await indicator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    expect(box.y + box.height).toBeLessThanOrEqual(SHORT_DESKTOP.height - 12);
  });

  test('FREQ-289-AC-02 desktop（1280x725）LOOK 詳細のインジケータ下端が viewport 下端から 12px 以上離れる', async ({
    page,
  }) => {
    await page.setViewportSize(SHORT_DESKTOP);
    await openLookDetail(page);

    const indicator = page.locator(
      '[data-testid="look-detail-main-image-indicator"]',
    );
    await expect(indicator).toBeVisible();
    const box = await indicator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    expect(box.y + box.height).toBeLessThanOrEqual(SHORT_DESKTOP.height - 12);
  });
});
