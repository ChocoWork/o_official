import { expect, test, type Page } from '@playwright/test';

// FREQ-279: ITEM カードのスクロール連動リビール。
// hyke.jp（cmn_ani_cvr / cmn_ani_rup）と同じく、画像・文字を *別々に* 監視し、
// その要素自身が画面に入ってから「画像＝白カバーが右へ退く」
// 「文字＝マスクの下から迫り上がる」を始める。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** リビールのアニメーション（カバー 0.5s+0.5s / 文字 1.0s+0.5s）が終わるまでの猶予 */
const REVEAL_SETTLE_MS = 2000;

async function firstOffscreenCard(page: Page) {
  const cards = page.locator('[data-testid="item-card"]');
  const count = await cards.count();
  const height = page.viewportSize()?.height ?? 800;
  for (let i = 0; i < count; i += 1) {
    const box = await cards.nth(i).boundingBox();
    if (box && box.y > height) return cards.nth(i);
  }
  return null;
}

test.describe('FR-ITEM-ALL-031 ITEM カードのスクロール連動リビール', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 画面外の画像はスクロールで data-reveal が true になる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');
      await expect(page.locator('[data-testid="item-card"]').first()).toBeVisible();

      const target = await firstOffscreenCard(page);
      test.skip(target === null, '画面外に出る ITEM カードがないため対象外');
      if (!target) return;

      // AC-01: 画面外では発火しない
      const cover = target.locator('.reveal-cover').first();
      await expect(cover).not.toHaveAttribute('data-reveal', 'true');

      await target.scrollIntoViewIfNeeded();
      await expect(cover).toHaveAttribute('data-reveal', 'true');
    });

    test(`${vp.name} 画像だけが画面に入っている間は文字のモーションが始まらない`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');

      const target = await firstOffscreenCard(page);
      test.skip(target === null, '画面外に出る ITEM カードがないため対象外');
      if (!target) return;

      // カード上端だけが見える位置まで進める（画像は入るが文字はまだ画面外）
      await target.evaluate((el) => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: top - window.innerHeight + 40, behavior: 'instant' });
      });
      await page.waitForTimeout(REVEAL_SETTLE_MS);

      // AC-05: 文字は自分が画面に入るまで待つ
      // （監視対象は translateY で外に出ている .reveal-rise ではなくマスク側）
      const mask = target.locator('.reveal-mask').first();
      await expect(mask).not.toHaveAttribute('data-reveal', 'true');
      // 未リビール中はマスクの外に退避している（＝定位置ではない）
      await expect(mask.locator('.reveal-rise').first()).not.toHaveCSS(
        'transform',
        'matrix(1, 0, 0, 1, 0, 0)',
      );

      await mask.scrollIntoViewIfNeeded();
      await expect(mask).toHaveAttribute('data-reveal', 'true');
    });

    test(`${vp.name} リビール後は画像カバーが reveal-cover-act で動き、商品名が定位置に戻る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');

      const card = page.locator('[data-testid="item-card"]').first();
      await expect(card).toBeVisible();
      const cover = card.locator('.reveal-cover').first();
      await expect(cover).toHaveAttribute('data-reveal', 'true');
      await page.waitForTimeout(REVEAL_SETTLE_MS);

      // AC-02: 画像枠の ::after が左→右のカバーアニメーションを持つ
      const coverAnimation = await cover.evaluate(
        (el) => getComputedStyle(el, '::after').animationName,
      );
      expect(coverAnimation).toBe('reveal-cover-act');

      // AC-03: 迫り上がり完了後は定位置に戻る（fill-mode forwards のため単位行列）
      // transform が乗るのは .reveal-rise。商品名自体は常に none なので見ても意味がない
      await expect(card.locator('.reveal-rise').first()).toHaveCSS(
        'transform',
        'matrix(1, 0, 0, 1, 0, 0)',
      );
    });

    test(`${vp.name} ホームの ITEM カードもリビールの対象になる`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // AC-04: ホームでも同じ仕組みが効いている
      const card = page.locator('[data-testid="item-card"]').first();
      await expect(card).toHaveAttribute('data-reveal-group', '');
      await expect(card.locator('.reveal-cover').first()).toHaveCount(1);
    });
  }
});

test.describe('FR-ITEM-ALL-031 JS 無効でも商品が隠れない', () => {
  test.use({ javaScriptEnabled: false });

  test('JS 無効ならリビールの初期状態が適用されない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/item');

    // AC-06: 初期状態は @media (scripting: enabled) の中にあるので適用されない。
    // ここが効かないと、解除役の JS が居ないまま白カバーが残り商品が見えなくなる。
    const cover = page.locator('.reveal-cover').first();
    await expect(cover).toBeAttached();
    const coverContent = await cover.evaluate(
      (el) => getComputedStyle(el, '::after').content,
    );
    expect(coverContent).toBe('none');

    await expect(page.locator('.reveal-rise').first()).toHaveCSS('transform', 'none');
    await expect(page.locator('[data-testid="item-name"]').first()).toBeVisible();
  });
});
