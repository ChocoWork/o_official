import { expect, test } from '@playwright/test';

// FREQ-282: ヒーローの SCROLL 下の縦線が、上から下へ伸びる動きだけを繰り返すこと。
// 引ききったまま少し待機してから即座に折り返す。フェードや縮小の戻りは挟まず、線が完全に消える瞬間も作らない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-HOME-019 ヒーローの縦線が動き続ける', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} 縦線が上から下へ伸びる動きだけを無限再生する`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const thread = page.locator('.hero-thread').first();
      await expect(thread).toBeAttached();

      // FREQ-282-AC-01
      await expect(thread).toHaveCSS('animation-name', 'heroThreadLoop');
      await expect(thread).toHaveCSS('animation-iteration-count', 'infinite');

      // 上端起点で伸びるだけ＝ transform-origin の Y は常に上端（0px）。
      // 下端起点に切り替えて縮める動きが入っていないことを担保する。
      const originY = await thread.evaluate(
        (el) => getComputedStyle(el).transformOrigin.split(' ')[1],
      );
      expect(originY).toBe('0px');

      // 1 サイクル（2.1s）を越えても止まっていないこと。停止していれば
      // transform は同じ値のまま変わらない。2 点比較だと偶然一致しうるので、
      // 複数回サンプリングして異なる値が出ることを見る。
      // 併せて、線が消える瞬間が無いこと（描画高さが常に 0 より大きく、
      // フェードも挟まないので opacity は常に 1）を確認する。
      const transforms = new Set<string>();
      for (let i = 0; i < 30; i += 1) {
        const { transform, opacity, height } = await thread.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            transform: style.transform,
            opacity: Number(style.opacity),
            height: el.getBoundingClientRect().height,
          };
        });
        transforms.add(transform);
        expect(opacity).toBe(1);
        expect(height).toBeGreaterThan(0);
        await page.waitForTimeout(100);
      }
      expect(transforms.size).toBeGreaterThan(1);
    });
  }

  test('prefers-reduced-motion: reduce で縦線が動かない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // FREQ-282-AC-02
    await expect(page.locator('.hero-thread').first()).toHaveCSS('animation-name', 'none');
  });
});
