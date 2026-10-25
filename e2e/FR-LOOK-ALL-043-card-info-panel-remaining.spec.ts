import { expect, test, type Locator, type Page } from '@playwright/test';

// LOOK カード下の情報パネル（lg 未満）の残りの受け入れ基準:
// FREQ-139-AC-02/03/04（余白と文字の大きさ）、FREQ-142-AC-03（文字と枠線の距離）、
// FREQ-144-AC-02/03/04（関連 ITEM の価格・色）、FREQ-151-AC-02/03（下線と遷移）。
// すべてモバイル（390px）・タブレット（768px）が対象。PC は情報パネルが出ない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, panelInset: 13 },
  { name: 'tablet', width: 768, height: 1024, panelInset: 21 },
] as const;

const TARGETS = [
  { name: 'HOME LOOK セクション', path: '/', scope: '#look' },
  { name: '/look 一覧', path: '/look', scope: 'main' },
] as const;

type Target = (typeof TARGETS)[number];

/** 半角の円記号（U+00A5）。全角の「￥」（U+FFE5）は含めない */
const HALF_WIDTH_YEN = '¥';

async function openTarget(page: Page, vp: (typeof VIEWPORTS)[number], target: Target) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(target.path);
  await expect(page.locator(target.scope)).toBeVisible();
}

/** 関連 ITEM（.look-related-items）を持つ最初の、表示されている LOOK カード */
async function relatedCard(page: Page, target: Target): Promise<Locator> {
  const card = page
    .locator(`${target.scope} [data-testid="look-card"]:visible`)
    .filter({ has: page.locator('.look-related-items') })
    .first();
  await expect(
    card,
    `${target.name} に関連アイテム付きの LOOK カードが見つかりませんでした`,
  ).toBeAttached();
  await card.scrollIntoViewIfNeeded();
  return card;
}

/** Tailwind v4 の scale-x は `scale` プロパティを使うため、scale と transform の両方から読む */
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

type StyleSnapshot = { fontWeight: string; color: string; text: string };

const readStyle = (el: HTMLElement): StyleSnapshot => {
  const cs = getComputedStyle(el);
  return {
    fontWeight: cs.fontWeight,
    color: cs.color,
    text: (el.textContent ?? '').trim(),
  };
};

/** カード内の全関連 ITEM の価格（各リンクの 2 つ目の span） */
const priceSpans = (card: Locator) =>
  card.locator('a.look-related-item-text div > span:nth-child(2)');

/** カード内の全関連 ITEM の名前（各リンクの 1 つ目の span） */
const nameSpans = (card: Locator) =>
  card.locator('a.look-related-item-text div > span:nth-child(1)');

test.describe('FR-LOOK-ALL-043 LOOK カード情報パネル（lg 未満）の残りの受け入れ基準', () => {
  for (const vp of VIEWPORTS) {
    for (const target of TARGETS) {
      const label = `${vp.name} ${target.name}`;

      test(`FREQ-139-AC-02 ${label} テーマの文字が関連アイテムの文字の 1.5 倍以上になる`, async ({
        page,
      }) => {
        test.fail(vp.name === 'mobile', 'FREQ-139-AC-02 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const sizes = await card.evaluate((el) => {
          const title = el.querySelector<HTMLElement>(
            '[data-testid="look-card-caption"] h3',
          );
          const item = el.querySelector<HTMLElement>(
            'a.look-related-item-text div > span:nth-child(1)',
          );
          return {
            title: title ? parseFloat(getComputedStyle(title).fontSize) : null,
            item: item ? parseFloat(getComputedStyle(item).fontSize) : null,
          };
        });
        expect(sizes.title, 'テーマ（h3）が見つかりません').not.toBeNull();
        expect(sizes.item, '関連アイテムの文字が見つかりません').not.toBeNull();
        expect(sizes.title! / sizes.item!).toBeGreaterThanOrEqual(1.5);
      });

      test(`FREQ-139-AC-03 ${label} シーズンとテーマの間隔がテーマと罫線の間隔より小さい`, async ({
        page,
      }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const gaps = await card.evaluate((el) => {
          const season = el.querySelector<HTMLElement>(
            '[data-testid="look-card-caption"] p',
          );
          const title = el.querySelector<HTMLElement>(
            '[data-testid="look-card-caption"] h3',
          );
          const divider = el.querySelector<HTMLElement>(
            '[data-testid="look-card-divider"]',
          );
          if (!season || !title || !divider) return null;
          const s = season.getBoundingClientRect();
          const t = title.getBoundingClientRect();
          const d = divider.getBoundingClientRect();
          return { seasonToTitle: t.top - s.bottom, titleToDivider: d.top - t.bottom };
        });
        expect(gaps, 'シーズン・テーマ・罫線のいずれかが見つかりません').not.toBeNull();
        expect(gaps!.seasonToTitle).toBeLessThan(gaps!.titleToDivider);
      });

      test(`FREQ-139-AC-04 ${label} 罫線の上と下の余白が等しい`, async ({ page }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const margins = await card
          .locator('[data-testid="look-card-divider"]')
          .evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
              top: parseFloat(cs.marginTop),
              bottom: parseFloat(cs.marginBottom),
            };
          });
        expect(margins.top).toBeGreaterThan(0);
        expect(margins.top).toBe(margins.bottom);
      });

      test(`FREQ-142-AC-03 ${label} 情報パネルの文字が枠線から水平方向に離れる`, async ({
        page,
      }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);
        const caption = card.locator('[data-testid="look-card-caption"]');

        // 文字は表示アニメーション（左外から滑り込む）が終わると定位置（移動量 0）に
        // 落ち着く。落ち着いた後の位置で、枠線（カードの左端）からの距離を測る。
        const rise = card.locator('.reveal-rise').first();
        await expect
          .poll(
            () =>
              rise.evaluate((el) => {
                const t = getComputedStyle(el).transform;
                return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41;
              }),
            { message: '情報パネルの文字が定位置に落ち着きません' },
          )
          .toBe(0);

        const cardBox = await card.boundingBox();
        const captionBox = await caption.boundingBox();
        expect(cardBox).not.toBeNull();
        expect(captionBox).not.toBeNull();
        const inset = captionBox!.x - cardBox!.x;
        expect(inset).toBeGreaterThanOrEqual(vp.panelInset - 2);
        expect(inset).toBeLessThanOrEqual(vp.panelInset + 2);
      });

      test(`FREQ-144-AC-02 ${label} 関連 ITEM の価格の太さ・色が ITEM カードの価格と一致する`, async ({
        page,
      }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);
        const prices = priceSpans(card);
        const count = await prices.count();
        expect(count, '関連 ITEM の価格が見つかりません').toBeGreaterThan(0);

        const looks: StyleSnapshot[] = [];
        for (let i = 0; i < count; i += 1) {
          looks.push(await prices.nth(i).evaluate(readStyle));
        }

        // 参照値: ITEM 一覧の ITEM カードの価格（item-price）
        await page.goto('/item');
        const itemPrice = page.locator('[data-testid="item-price"]').first();
        await expect(itemPrice).toBeAttached();
        const reference = await itemPrice.evaluate(readStyle);

        for (const look of looks) {
          expect(look.fontWeight).toBe(reference.fontWeight);
          expect(look.color).toBe(reference.color);
        }
      });

      test(`FREQ-144-AC-03 ${label} 関連 ITEM の価格が半角の「¥」で始まる`, async ({ page }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);
        const prices = priceSpans(card);
        const count = await prices.count();
        expect(count, '関連 ITEM の価格が見つかりません').toBeGreaterThan(0);

        for (let i = 0; i < count; i += 1) {
          const text = ((await prices.nth(i).textContent()) ?? '').trim();
          expect(text.startsWith(HALF_WIDTH_YEN), `価格 "${text}" が半角「¥」で始まっていません`).toBe(true);
        }
      });

      test(`FREQ-144-AC-04 ${label} 関連 ITEM の名前・価格の文字が黒になる`, async ({ page }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const names = nameSpans(card);
        const prices = priceSpans(card);
        const nameCount = await names.count();
        const priceCount = await prices.count();
        expect(nameCount, '関連 ITEM の名前が見つかりません').toBeGreaterThan(0);
        expect(priceCount, '関連 ITEM の価格が見つかりません').toBe(nameCount);

        // 従来のグレー #474747（rgb(71, 71, 71)）ではなく黒であること
        for (let i = 0; i < nameCount; i += 1) {
          await expect(names.nth(i)).toHaveCSS('color', 'rgb(0, 0, 0)');
          await expect(prices.nth(i)).toHaveCSS('color', 'rgb(0, 0, 0)');
        }
      });

      test(`FREQ-151-AC-02 ${label} 関連 ITEM のリンクに乗っていない時は下線が出ない`, async ({
        page,
      }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const links = card.locator('a.look-related-item-text');
        const count = await links.count();
        expect(count, '関連 ITEM のリンクが見つかりません').toBeGreaterThan(0);

        // カーソルはどのリンクの上にも置いていない状態で、すべての下線が scale-x 0
        for (let i = 0; i < count; i += 1) {
          const underline = links.nth(i).locator('.underline-animation-left2right');
          expect(await getScaleX(underline)).toBe(0);
        }
      });

      test(`FREQ-151-AC-03 ${label} 関連 ITEM のリンクを押すとその ITEM の頁へ移る`, async ({
        page,
      }) => {
        await openTarget(page, vp, target);
        const card = await relatedCard(page, target);

        const link = card.locator('a.look-related-item-text').first();
        await expect(link).toBeAttached();
        await link.click();
        await expect(page).toHaveURL(/\/item\/\d+/);
      });
    }
  }
});
