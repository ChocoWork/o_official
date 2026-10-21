import { test, expect, viewports, settingsScene, noOverflow } from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ADMIN-098 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('申し込みを先頭に置き、受付・種類・注意書きを17項目の保存に含め、変えた人も更新する', async ({ page }) => {
      // FREQ-485-AC-01, FREQ-485-AC-05, FREQ-485-AC-08
      const state = await settingsScene(page);
      const region = page.getByRole('region', { name: '申し込み', exact: true });
      const toggle = region.getByRole('switch', { name: 'お客様からの申し込みを受け付ける', exact: true });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      expect(await page.getByRole('region', { name: '返品', exact: true }).getByRole('heading', { level: 4 }).allTextContents())
        .toEqual(['申し込み', '返送', '受付の期限', '理由ごとの設定', '手数料', '受け取り']);
      await toggle.click();
      await region.getByRole('combobox', { name: '申し込みの種類', exact: true }).selectOption('cancellations_only');
      await region.getByRole('textbox', { name: '申し込みの画面の注意書き', exact: true }).fill('  まず内容をお確かめください。\n写真も添えてください。  ');
      expect(state.puts.length).toBe(0);
      await page.getByRole('button', { name: '保存する', exact: true }).click();
      await expect.poll(() => state.puts.length).toBe(1);
      expect(Object.keys(state.puts[0]).length).toBe(17);
      expect(state.puts[0]).toMatchObject({
        requestsEnabled: false, requestTypes: 'cancellations_only', noticeText: 'まず内容をお確かめください。\n写真も添えてください。',
      });
      await expect(region.getByText(/最後に変えた人: admin@example.com/)).toBeVisible();
      await expect(page.getByRole('region', { name: '返送', exact: true }).getByText('まだ変えていません', { exact: true })).toBeVisible();
      // 窓口の答えには配送の追跡の設定（グループ E-4）も付く。返品の欄の保存の後も欄は残り、保存の本文（17項目）には混ざらない
      await expect(page.getByRole('heading', { name: '配送の追跡', level: 3 })).toBeVisible();
      await expect(page.getByRole('switch', { name: '配送の追跡（17TRACK）を使う', exact: true })).toHaveAttribute('aria-checked', 'false');
      await noOverflow(page);
    });

    test('理由ごとの4列を保存し、不明は無効のオフで説明を結ぶ', async ({ page }) => {
      // FREQ-485-AC-04, FREQ-485-AC-05
      const state = await settingsScene(page);
      const reasons = page.getByRole('region', { name: '理由ごとの設定', exact: true });
      await expect(reasons.getByRole('group')).toHaveCount(10);
      const other = reasons.getByRole('group', { name: 'その他', exact: true });
      await other.getByRole('checkbox', { name: '出す', exact: true }).uncheck();
      await other.getByRole('combobox', { name: 'ご希望', exact: true }).selectOption('refund_only');
      await other.getByRole('combobox', { name: '写真', exact: true }).selectOption('required');
      await other.getByRole('textbox', { name: '写真の案内の文', exact: true }).fill('  全体が分かる写真をお願いします。  ');
      const unknown = reasons.getByRole('group', { name: '不明', exact: true }).getByRole('checkbox', { name: '出す', exact: true });
      await expect(unknown).toBeDisabled(); await expect(unknown).not.toBeChecked();
      await expect(unknown).toHaveAccessibleDescription('「不明」はお客様に出しません。');
      await page.getByRole('button', { name: '保存する', exact: true }).click();
      await expect.poll(() => state.puts.length).toBe(1);
      expect(state.puts[0].reasons.find((row) => row.reason === 'other')).toEqual({
        reason: 'other', shown: false, resolutions: 'refund_only', photo: 'required',
        photoInstructions: '全体が分かる写真をお願いします。', shippingPayer: 'customer', outOfStockExchange: 'decline',
      });
      expect(state.puts[0].reasons.length).toBe(10);
      expect(state.puts[0].reasons.every((row) => Object.keys(row).length === 7)).toBe(true);
      await expect(reasons.getByText(/最後に変えた人: admin@example.com/)).toBeVisible();
    });

    test('注意書き2001字・写真の案内501字は保存を止め、境界ちょうどなら保存できる', async ({ page }) => {
      // FREQ-485-AC-03
      const state = await settingsScene(page);
      const notice = page.getByRole('textbox', { name: '申し込みの画面の注意書き', exact: true });
      const row = page.getByRole('group', { name: '破損・不良', exact: true });
      const photo = row.getByRole('textbox', { name: '写真の案内の文', exact: true });
      await notice.fill('あ'.repeat(2001)); await photo.fill('あ'.repeat(501));
      await page.getByRole('button', { name: '保存する', exact: true }).click();
      await expect(notice).toHaveAccessibleDescription('2000字までで入れてください。');
      await expect(photo).toHaveAccessibleDescription('500字までで入れてください。');
      await expect(notice).toBeFocused(); expect(state.puts.length).toBe(0);
      await notice.fill('あ'.repeat(2000)); await photo.fill('あ'.repeat(500));
      await page.getByRole('button', { name: '保存する', exact: true }).click();
      await expect.poll(() => state.puts.length).toBe(1);
      expect(state.puts[0].noticeText?.length).toBe(2000);
      expect(state.puts[0].reasons.find((item) => item.reason === 'defective')?.photoInstructions?.length).toBe(500);
    });
  });
}
