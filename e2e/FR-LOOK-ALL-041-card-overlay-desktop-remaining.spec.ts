import { expect, test, type Locator, type Page } from '@playwright/test';

// FREQ-128〜131・134・150: PC（lg: 1024px 以上）の LOOK カード画像上オーバーレイの
// 残りの受け付け基準（キャプション非表示・下半分の位置・大文字・黒グラデーション・
// ホバーでの題と関連アイテムの入れ替え・左端そろえ・非ホバー行の下線なし）。
// 受け付け基準はすべて PC 専用のため desktop（1280px）だけで検証する。
// 関連アイテムを持つ LOOK は seed の LOOK 1・5（supabase/seed.sql）。

const PAGES = [
  { label: 'HOME の LOOK セクション', path: '/', scope: '#look' },
  { label: '/look 一覧', path: '/look', scope: 'main' },
] as const;

type Target = (typeof PAGES)[number];

// FREQ-277: ホームは 2xl 未満で 7 件目以降を非表示にするため、表示中のカードだけを対象にする
const cardWithItems = (page: Page, target: Target): Locator =>
  page
    .locator(
      `${target.scope} [data-testid="look-card"]:has([data-testid="look-card-overlay-items"]):visible`,
    )
    .first();

async function openDesktop(page: Page, target: Target): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(target.path);
  await expect(page.locator(target.scope)).toBeVisible();
  const card = cardWithItems(page, target);
  await expect(
    card,
    `${target.label} に関連アイテム付きカードが見つかりませんでした`,
  ).toBeVisible();
  return card;
}

// Tailwind v4 の scale-x は `scale` プロパティを使うため、
// transform 行列と scale の両方から水平スケールを読む
const getScaleX = (underline: Locator) =>
  underline.evaluate((el) => {
    const cs = getComputedStyle(el);
    if (cs.scale && cs.scale !== 'none') {
      return Number.parseFloat(cs.scale.split(' ')[0]);
    }
    if (cs.transform === 'none') {
      return 1;
    }
    return new DOMMatrixReadOnly(cs.transform).a;
  });

const readOverlayBackground = (card: Locator) =>
  card
    .locator('[data-testid="look-card-overlay"]')
    .evaluate((el) => getComputedStyle(el).backgroundImage);

/**
 * 計算後の background-image を読み、縦の linear-gradient の下端・上端の色（不透明度）を返す。
 * ビルドの最小化が `to top` の向きを消して段の並びを逆にする（先頭が上端になる）ことがあるので、
 * 向きの書き方（to top / 0deg は先頭が下端、向き無し / to bottom / 180deg は先頭が上端）で、どちらの端が上かを決める。
 */
const readVerticalGradient = (background: string) => {
  const bottomFirst = /^linear-gradient\(\s*(to top|0deg)/.test(background);
  const topFirst = /^linear-gradient\(\s*(to bottom|180deg|rgba?\()/.test(background);
  const colors = [
    ...background.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/g),
  ].map((m) => ({
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  }));
  const bottom = bottomFirst ? colors[0] : colors[colors.length - 1];
  const top = bottomFirst ? colors[colors.length - 1] : colors[0];
  return { vertical: bottomFirst || topFirst, colors, bottom, top };
};

test.describe('FR-LOOK-ALL-041 PC のカード画像上オーバーレイ（残りの受け付け基準）', () => {
  for (const target of PAGES) {
    test(`FREQ-128-AC-02 desktop ${target.label} で画像の下の文字（look-card-caption）が出ない`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const captions = page.locator(`${target.scope} [data-testid="look-card-caption"]`);
      expect(await captions.count()).toBeGreaterThan(0);
      await expect(card.locator('[data-testid="look-card-caption"]')).toBeHidden();
      // 全カードのキャプションが非表示
      const visibleCount = await captions.evaluateAll(
        (els) =>
          els.filter((el) => {
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              cs.display !== 'none' &&
              cs.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          }).length,
      );
      expect(visibleCount).toBe(0);
    });

    test(`FREQ-128-AC-04 desktop ${target.label} でオーバーレイの文字が画像の下半分にある`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const layout = await card.locator('[data-testid="look-card-overlay"]').evaluate((overlay) => {
        const image = overlay.parentElement!.getBoundingClientRect();
        const season = overlay.querySelector<HTMLElement>('p')!.getBoundingClientRect();
        const theme = overlay.querySelector<HTMLElement>('h3')!.getBoundingClientRect();
        return {
          imageTop: image.top,
          imageBottom: image.bottom,
          seasonTop: season.top,
          themeBottom: theme.bottom,
        };
      });
      const imageMiddle = (layout.imageTop + layout.imageBottom) / 2;
      expect(layout.seasonTop).toBeGreaterThan(imageMiddle);
      expect(layout.themeBottom).toBeGreaterThan(imageMiddle);
      expect(layout.themeBottom).toBeLessThanOrEqual(layout.imageBottom + 0.5);
    });

    test(`FREQ-129-AC-02 desktop ${target.label} でテーマが大文字（text-transform: uppercase）で出る`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const theme = card.locator('[data-testid="look-card-overlay"] h3');
      await expect(theme).toHaveCSS('text-transform', 'uppercase');
    });

    test(`FREQ-129-AC-03 desktop ${target.label} でオーバーレイの背景に下から上へ透明になる黒の linear-gradient がある`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const background = await readOverlayBackground(card);
      // 縦の linear-gradient（向きの書き方はビルドで変わるので、下端・上端を読み分ける）
      const gradient = readVerticalGradient(background);
      expect(gradient.vertical, `縦の linear-gradient である（実際: ${background}）`).toBe(true);
      expect(gradient.colors.length).toBeGreaterThan(1);
      // すべての段が黒（rgb 0,0,0）
      for (const c of gradient.colors) {
        expect([c.r, c.g, c.b]).toEqual([0, 0, 0]);
      }
      // 下から上へ透明になる: 下端は不透明度のある黒、上端は完全な透明
      expect(gradient.bottom.a).toBeGreaterThan(0);
      expect(gradient.top.a).toBe(0);
    });

    test(`FREQ-130-AC-02 desktop ${target.label} でグラデーションの上端側の色が完全な透明（alpha 0）になる`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const background = await readOverlayBackground(card);
      // 縦のグラデーションの上端側の色（向きの書き方で先頭か末尾かが変わるので読み分ける）
      const gradient = readVerticalGradient(background);
      expect(gradient.vertical, `縦の linear-gradient である（実際: ${background}）`).toBe(true);
      expect([gradient.top.r, gradient.top.g, gradient.top.b, gradient.top.a]).toEqual([0, 0, 0, 0]);
    });

    test(`FREQ-131-AC-02 desktop ${target.label} でカードに乗ると関連アイテムのブロックの opacity が 1 になり商品名と価格が出る`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const items = card.locator('[data-testid="look-card-overlay-items"]');
      await card.locator('a[href^="/look/"]').first().hover();
      await expect(items).toHaveCSS('opacity', '1');
      const firstRow = items.locator('[data-testid="look-card-overlay-item"]').first();
      await expect(firstRow).toBeVisible();
      await expect(firstRow.locator('span').nth(0)).toHaveText(/\S/);
      await expect(firstRow.locator('span').nth(1)).toHaveText(/[¥￥]\s?[\d,]+/);
    });

    test(`FREQ-131-AC-03 desktop ${target.label} で乗っていない時は題の opacity が 1・関連アイテムのブロックの opacity が 0 になる`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      await page.mouse.move(0, 0);
      await expect(card.locator('[data-testid="look-card-overlay-title"]')).toHaveCSS(
        'opacity',
        '1',
      );
      await expect(card.locator('[data-testid="look-card-overlay-items"]')).toHaveCSS(
        'opacity',
        '0',
      );
    });

    test(`FREQ-134-AC-02 desktop ${target.label} で題のブロックと関連アイテムのブロックの左端が 1px 以内で一致する`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      const leftDiff = await card.locator('[data-testid="look-card-overlay"]').evaluate((overlay) => {
        const title = overlay.querySelector<HTMLElement>('[data-testid="look-card-overlay-title"]')!;
        const items = overlay.querySelector<HTMLElement>('[data-testid="look-card-overlay-items"]')!;
        return Math.abs(title.getBoundingClientRect().left - items.getBoundingClientRect().left);
      });
      expect(leftDiff).toBeLessThanOrEqual(1);
    });

    test(`FREQ-150-AC-02 desktop ${target.label} でカードに乗っていても関連 ITEM の行に乗っていない時は下線の scale-x が 0 になる`, async ({
      page,
    }) => {
      const card = await openDesktop(page, target);
      // カード中央（画像上・行の外）にカーソルを置く
      await card.locator('a[href^="/look/"]').first().hover();
      await expect(card.locator('[data-testid="look-card-overlay-items"]')).toHaveCSS(
        'opacity',
        '1',
      );
      const rows = card.locator('[data-testid="look-card-overlay-item"]');
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);
      for (let i = 0; i < rowCount; i += 1) {
        const underline = rows.nth(i).locator('.underline-animation-left2right');
        expect(await getScaleX(underline)).toBe(0);
      }
    });
  }
});
