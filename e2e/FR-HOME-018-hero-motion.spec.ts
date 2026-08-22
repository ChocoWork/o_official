import { expect, test } from '@playwright/test';

// FREQ-278: ヒーローのモーション。
// ブランド名は TextReveal（1文字ずつ）、縦線は loading ページの
// Motion Ideas「THREAD DRAW」（threadDraw）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('FR-HOME-018 ヒーローのモーション', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} ブランド名が1文字ずつの span に分割され、完了後は全文字が見える`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const heading = page.locator('h1', { hasText: 'Le Fil des Heures' }).first();
      await expect(heading).toBeVisible();

      // AC-01: 1文字につき1つの span（"Le Fil des Heures" = 17文字）
      const chars = heading.locator('span');
      await expect(chars).toHaveCount('Le Fil des Heures'.length);

      // モーション完了を待ってから最終状態を確認する
      // （delay 200ms + 16文字 * 30ms + duration 400ms ≒ 1080ms）
      await page.waitForTimeout(1500);
      const first = chars.first();
      const last = chars.last();
      await expect(first).toHaveCSS('opacity', '1');
      await expect(last).toHaveCSS('opacity', '1');
      // translateY(0) 適用済みのため none ではなく単位行列になる
      await expect(first).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      await expect(last).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    });

    test(`${vp.name} 縦線が threadDraw で動き、ブランド名が 6xl サイズになる`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('main, body')).toBeTruthy();

      // AC-02: SCROLL ラベル下の縦線。デモ用の infinite ではなく 1 回だけ引く
      const thread = page.locator('.hero-thread').first();
      await expect(thread).toHaveCSS('animation-name', 'threadDraw');
      await expect(thread).toHaveCSS('animation-iteration-count', '1');
      await expect(thread).toHaveCSS('animation-fill-mode', 'both');

      // AC-03: font-size が --lk-size-6xl の算出値と一致する
      const heading = page.locator('h1', { hasText: 'Le Fil des Heures' }).first();
      const [actual, expected] = await Promise.all([
        heading.evaluate((el) => getComputedStyle(el).fontSize),
        page.evaluate(() => {
          const probe = document.createElement('div');
          probe.style.fontSize = 'var(--lk-size-6xl)';
          document.body.appendChild(probe);
          const size = getComputedStyle(probe).fontSize;
          probe.remove();
          return size;
        }),
      ]);
      expect(actual).toBe(expected);
    });
  }
  test('見出しのアクセシブル名が1文字ずつに分解されない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // FREQ-278-AC-04: span 分割は視覚上のもので、支援技術には元の文字列を渡す
    // フッターにも同名の h3 があるため、ヒーローの h1 に限定する
    const heading = page.getByRole('heading', {
      name: 'Le Fil des Heures',
      exact: true,
      level: 1,
    });
    await expect(heading).toHaveCount(1);
  });

  test('prefers-reduced-motion: reduce でヒーローのモーションが止まる', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // FREQ-278-AC-05: 文字・縦線とも動かず、文字は最初から見えている
    const firstChar = page
      .locator('h1', { hasText: 'Le Fil des Heures' })
      .first()
      .locator('span')
      .first();
    await expect(firstChar).toHaveCSS('transition-duration', '0s');
    await expect(firstChar).toHaveCSS('opacity', '1');
    await expect(page.locator('.hero-thread').first()).toHaveCSS('animation-name', 'none');
  });

  test('CSP が inline style を落とさず、style-src-elem は締まったまま', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const response = await page.goto('/');

    // FREQ-280-AC-02: <style> / <link> 側は 'unsafe-inline' なしで締める
    const csp = response?.headers()['content-security-policy'] ?? '';
    const styleElem = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('style-src-elem'));
    expect(styleElem).toBeTruthy();
    expect(styleElem).not.toContain("'unsafe-inline'");

    // FREQ-280-AC-01: style 属性が CSP でブロックされると 16px に落ちる。
    // 価格は style={{ fontSize: var(--lk-size-2xs) }} で描画される代表例。
    const price = page.locator('[data-testid="item-price"]').first();
    await expect(price).toBeAttached();
    const [actual, expected] = await Promise.all([
      price.evaluate((el) => getComputedStyle(el).fontSize),
      page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.fontSize = 'var(--lk-size-2xs)';
        document.body.appendChild(probe);
        const size = getComputedStyle(probe).fontSize;
        probe.remove();
        return size;
      }),
    ]);
    expect(actual).toBe(expected);
  });
});
