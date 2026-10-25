import { expect, test } from '@playwright/test';

test.describe('FR-LOOK-DETAIL-006 metadata / aria-label', () => {
  // FREQ-178: 通常表示の「Back to Lookbook」リンクは削除された（検証は FR-LOOK-DETAIL-010）
  test('FR-LOOK-DETAIL-006-AC-01 title/descriptionメタと PREV/NEXT aria-label を提供する', async ({ page }) => {
    await page.goto('/look/1');

    // 頁の題にその LOOK のテーマを含む（見出しは CSS で大文字化されるので、元の文字を textContent で読む）
    const theme = ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').trim();
    expect(theme.length).toBeGreaterThan(0);
    await expect(page).toHaveTitle(new RegExp(theme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);

    // LOOK 1 は先頭なので次へのリンクだけがある（行き先のテーマを含む aria-label は FR-LOOK-DETAIL-006-AC-02 が確かめる）
    await expect(page.locator('a[aria-label^="Next look"]')).toHaveCount(1);
  });
});
