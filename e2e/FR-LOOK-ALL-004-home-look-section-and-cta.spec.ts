import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-ALL-004 HOMEのLOOKセクション', () => {
  test('FR-LOOK-ALL-004-AC-01 HOMEのLOOKセクションでカード表示とLOOK一覧導線を確認する', async ({ page }) => {
    await page.goto('/');

    const lookSection = page.locator('#look');
    await expect(lookSection).toBeVisible();

    // 1カード内に /look リンクが複数あるため、カード画像で件数を判定する。
    // FREQ-132 のホバー用 2 枚目画像はカード数に含めない。
    const lookCards = lookSection.locator(
      'a[href^="/look/"] img:not([data-testid="look-card-image-hover"])',
    );
    // FREQ-148: DOM には最大8件描画される（xl 未満は先頭6件のみ表示）
    const cardCount = await lookCards.count();
    expect(cardCount).toBeGreaterThan(0);
    expect(cardCount).toBeLessThanOrEqual(8);

    // 区画の見出し「LOOK」が出ている
    await expect(lookSection.getByRole('heading', { name: 'LOOK', exact: true })).toBeVisible();

    // 一覧への入口は、公開の LOOK が表示数より多い時に出る（FR-LOOK-ALL-004-AC-02 が全幅で確かめる）。
    // 見本の公開の LOOK は 7 件で、既定の幅 1280px の表示数 6 件を超えるので、入口は必ずあり、押すと /look へ移る
    const entrance = lookSection.locator('a[href="/look"]');
    await expect(entrance).toHaveCount(1);
    await expect(entrance).toBeVisible();
    await entrance.click();
    await expect(page).toHaveURL(/\/look$/);
  });
});
