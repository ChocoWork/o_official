import { expect, test } from '@playwright/test';

test.describe('FR-UI-001 FloatingButton alignment', () => {
  test('speed-dial main icon and action icons are visually centered', async ({ page }) => {
    await page.goto('/ui');
    await page.waitForLoadState('networkidle');

    const mainButton = page.locator('[data-ui-floating-button] .floating-button__main');
    await expect(mainButton).toBeVisible();

    const mainIcon = page.locator('[data-ui-floating-button] .floating-button__main-icon');
    await expect(mainIcon).toBeVisible();

    const mainRect = await mainButton.boundingBox();
    const mainIconRect = await mainIcon.boundingBox();
    expect(mainRect).not.toBeNull();
    expect(mainIconRect).not.toBeNull();

    if (mainRect && mainIconRect) {
      const mainCenterX = mainRect.x + mainRect.width / 2;
      const mainCenterY = mainRect.y + mainRect.height / 2;
      const iconCenterX = mainIconRect.x + mainIconRect.width / 2;
      const iconCenterY = mainIconRect.y + mainIconRect.height / 2;

      expect(Math.abs(iconCenterX - mainCenterX)).toBeLessThanOrEqual(1);
      expect(Math.abs(iconCenterY - mainCenterY)).toBeLessThanOrEqual(1);
    }

    await mainButton.click();
    const actionButton = page.locator('[data-ui-floating-button] .floating-button__action').first();
    await expect(actionButton).toBeVisible();

    const actionButtons = await page.locator('[data-ui-floating-button] .floating-button__action').elementHandles();
    for (const action of actionButtons) {
      const actionRect = await action.boundingBox();
      const actionIcon = await action.$('.floating-button__action-icon');
      const actionIconRect = actionIcon ? await actionIcon.boundingBox() : null;

      expect(actionRect).not.toBeNull();
      expect(actionIconRect).not.toBeNull();

      if (actionRect && actionIconRect) {
        const actionCenterX = actionRect.x + actionRect.width / 2;
        const actionCenterY = actionRect.y + actionRect.height / 2;
        const iconCenterX = actionIconRect.x + actionIconRect.width / 2;
        const iconCenterY = actionIconRect.y + actionIconRect.height / 2;

        expect(Math.abs(iconCenterX - actionCenterX)).toBeLessThanOrEqual(1);
        expect(Math.abs(iconCenterY - actionCenterY)).toBeLessThanOrEqual(1);
      }
    }
  });
});
