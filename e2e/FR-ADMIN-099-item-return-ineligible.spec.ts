import type { Page } from '@playwright/test';
import { loadReturnCreateMaterials } from '@/lib/orders/returns/return-store';
import { SEED_IMAGE_PNG_BASE64 } from '../scripts/e2e/seed-storage';
import { fulfillJson, mockOrderList, openOrderTab } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  newReturnRouteState, mockReturnRoutes, orderWithReturns, returnSummaryOf, openReturnsDialog, openCreateDialog,
} from './return-test-utils';
import { test, expect, viewports, shipped, noOverflow, type RR } from './return-request-test-utils';

test.use({ trace: 'off' });
async function itemScene(page: Page, rr: RR, id: number, initial: boolean) {
  const state = { value: initial, posts: [] as Array<{ method: string; values: string[] }> };
  await mockAdminSessionAs(page, 'admin');
  await page.route('**/api/admin/item-color-presets**', (route) => fulfillJson(route, { data: [] }));
  await page.route('**/api/admin/items/' + id + '/**', (route) => fulfillJson(route, { data: [] }));
  await page.route((url) => url.pathname === '/api/admin/items' || url.pathname === '/api/admin/items/' + id, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      const item = {
        id, name: 'E2Eシャツ', description: '試験の商品説明', price: 5000, category: 'TOPS',
        image_url: '/placeholder.png', image_urls: ['/placeholder.png'], colors: [{ name: 'ホワイト', hex: '#ffffff' }],
        sizes: ['M'], product_details: '', material: '', origin: '', care: '', product_note: '', status: 'private',
        return_ineligible: state.value,
      };
      await fulfillJson(route, { data: new URL(route.request().url()).pathname.endsWith('/' + id) ? item : [item] });
      return;
    }
    const payload = route.request().postDataBuffer();
    if (!payload) throw new Error('商品の本文が無い');
    const form = await new Request('http://localhost:3000/api/admin/items', {
      method, headers: { 'content-type': route.request().headers()['content-type'] }, body: new Uint8Array(payload),
    }).formData();
    const values = form.getAll('return_ineligible').map(String);
    state.posts.push({ method, values });
    if (values.length !== 1 || !['true', 'false'].includes(values[0])) throw new Error('返品不可の欄が違う');
    state.value = values[0] === 'true';
    await rr.setItem(id, state.value);
    await fulfillJson(route, { data: { id } });
  });
  return state;
}
for (const viewport of viewports) {
  test.describe('FR-ADMIN-099 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('編集は印の最初の値を読み、オンとオフを FormData に1つずつ送る', async ({ page, rr }) => {
      // FREQ-482-AC-02
      const fx = await shipped(rr);
      const state = await itemScene(page, rr, fx.itemId, true);
      await page.goto('/admin/item/edit/' + fx.itemId);
      const checkbox = page.getByRole('checkbox', { name: '返品不可（お客様のご都合による返品・交換を受けない）', exact: true });
      await expect(checkbox).toBeChecked();
      await expect(checkbox).toHaveAttribute('id', 'item-return-ineligible');
      await expect(page.getByTestId('item-return-ineligible')).toBeChecked();
      await checkbox.uncheck();
      await page.getByRole('button', { name: '更新', exact: true }).click();
      await expect.poll(() => state.posts.length).toBe(1);
      expect(state.posts[0]).toEqual({ method: 'PUT', values: ['false'] });
      await page.goto('/admin/item/edit/' + fx.itemId);
      await expect(checkbox).not.toBeChecked();
      await checkbox.check();
      await page.getByRole('button', { name: '更新', exact: true }).click();
      await expect.poll(() => state.posts.length).toBe(2);
      expect(state.posts[1]).toEqual({ method: 'PUT', values: ['true'] });
      expect((await rr.db.query('select return_ineligible from public.items where id=$1', [fx.itemId])).rows[0].return_ineligible).toBe(true);
    });

    test('新規はオフから始まり、商品仕様と公開設定の間に返品の節があり、保存で false を送る', async ({ page, rr }) => {
      // FREQ-482-AC-01, FREQ-482-AC-02
      const fx = await shipped(rr);
      const state = await itemScene(page, rr, fx.itemId, false);
      await page.goto('/admin/item/create');
      await expect(page.getByTestId('item-return-ineligible')).not.toBeChecked();
      const headings = await page.getByTestId('item-form-fields').getByRole('heading', { level: 2 }).allTextContents();
      const spec = headings.indexOf('商品仕様');
      expect(headings.slice(spec, spec + 3)).toEqual(['商品仕様', '返品', '公開設定']);
      // 必須の欄は見出しの末尾に aria-hidden の「*」が付く。getByLabel の exact はその「*」まで含めて比べるので、アクセシブルな名前で探す
      await page.getByRole('textbox', { name: '商品名', exact: true }).fill('E2E新規商品');
      await page.getByLabel('PRODUCT DETAILS', { exact: true }).fill('試験の商品説明');
      await page.getByRole('spinbutton', { name: '価格（円）', exact: true }).fill('5000');
      // 新規の画面は色の行が1つも無い状態で始まる（ItemForm の colors の初期値が空配列）ので、行を足してから入れる
      await page.getByRole('button', { name: 'カラーを追加', exact: true }).click();
      await page.getByPlaceholder('カラー名', { exact: true }).first().fill('ホワイト');
      await page.getByRole('button', { name: 'M', exact: true }).click();
      await page.locator('input[type=file]').setInputFiles({
        name: 'item.png', mimeType: 'image/png', buffer: Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64'),
      });
      await page.getByRole('button', { name: '保存', exact: true }).last().click();
      await expect.poll(() => state.posts.length).toBe(1);
      expect(state.posts[0]).toEqual({ method: 'POST', values: ['false'] });
      await noOverflow(page);
    });

    test('お店が返品を作る画面では返品不可を警告し、作成を止めない', async ({ page, rr }) => {
      // FREQ-482-AC-06
      const fx = await shipped(rr);
      await rr.setItem(fx.itemId, true);
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, () => [orderWithReturns({ id: fx.orderId, summary: returnSummaryOf({ orderId: fx.orderId }) })]);
      const state = newReturnRouteState({
        orderId: fx.orderId, returnableUnits: 1, materials: await loadReturnCreateMaterials(rr.client, fx.orderId),
      });
      await mockReturnRoutes(page, fx.orderId, state);
      await openOrderTab(page);
      await openReturnsDialog(page, fx.orderId);
      const dialog = await openCreateDialog(page, fx.orderId);
      const row = dialog.getByRole('group', { name: 'E2Eシャツ（ホワイト / M）', exact: true });
      await expect(row.getByText('返品不可の品です', { exact: true })).toBeVisible();
      await row.getByLabel('返品する数', { exact: true }).fill('1');
      await expect(dialog.getByRole('button', { name: '返品を作る', exact: true })).toBeEnabled();
      await noOverflow(page);
    });
  });
}
