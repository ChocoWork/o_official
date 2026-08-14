import { test, expect, Page } from '@playwright/test';

// FREQ-232: 勘定科目・支出概要・金額・支払い方法・メモをテンプレート保存し、選択して経費フォームへ反映
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

type Template = { name: string; category: string; item: string; partner: string; amount: number; paymentMethod: string; memo: string };

function metric(period: string) {
  return {
    period,
    salesAmount: 0, formattedSales: '¥0',
    cvr: 0, formattedCvr: '0.0%',
    aov: 0, formattedAov: '¥0',
    setPurchaseRate: 0, formattedSetPurchaseRate: '0.0%',
    inventoryConsumptionRate: 0, formattedInventoryConsumptionRate: '0.0%',
    ltv: 0, formattedLtv: '¥0',
    repeatRate: 0, formattedRepeatRate: '0.0%',
    returnRate: 0, formattedReturnRate: '0.0%',
    orderCount: 0, paidOrderCount: 0, customerCount: 0, repeatCustomerCount: 0,
    setOrderCount: 0, cancelledOrderCount: 0, soldItemCount: 0, publishedItemCount: 0,
  };
}

async function mockAdminApis(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true } }),
    }),
  );

  await page.route('**/api/admin/kpi', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          targetYear: 2026,
          monthlyYearOptions: [2026],
          monthlyKpiByYear: [{ year: 2026, metrics: Array.from({ length: 12 }, (_, i) => metric(`${i + 1}月`)) }],
          seasonalKpi: [metric('2026SS')],
        },
      }),
    }),
  );

  await page.route('**/api/admin/kpi/targets', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          currentSeason: '2026SS',
          seasons: ['2026SS'],
          definitions: [{ key: 'cvr', label: 'CVR', definition: '', priority: '◎' }],
          values: { cvr: { '2026SS': '3.0%' } },
        },
      }),
    }),
  );

  await page.route('**/api/admin/kpi/monthly-record**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { season: '2026SS', monthKeys: [], values: {} } }),
    }),
  );

  const finance = {
    seasonKey: '2026SS',
    plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
    expenses: [] as Array<Record<string, unknown>>,
    incomes: [] as Array<Record<string, unknown>>,
    products: [] as Array<Record<string, unknown>>,
    partners: ['旧取引先', '新取引先'] as string[],
    templates: [] as Template[],
  };

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { operation: string; template?: Template; templateName?: string };
      if (body.operation === 'template.create' && body.template) {
        if (finance.templates.some((template) => template.name === body.template!.name)) {
          route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '同じ名前のテンプレートが存在します。' }) });
          return;
        }
        finance.templates = [...finance.templates, body.template];
      }
      if (body.operation === 'template.update' && body.template && body.templateName) {
        finance.templates = finance.templates.map((template) => template.name === body.templateName ? body.template! : template);
      }
      if (body.operation === 'template.delete' && body.templateName) {
        finance.templates = finance.templates.filter((t) => t.name !== body.templateName);
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: finance }) });
  });

  return finance;
}

async function openCostInputTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理' }).click();
  // FREQ-257 以降、取引の入力欄は「新規取引」Drawer の中にある。
  await page.getByRole('button', { name: '新規取引' }).click();
  await page.getByRole('button', { name: 'テンプレート', exact: true }).waitFor();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-025 expense templates (${viewport.name})`, () => {
    test.setTimeout(60_000);

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('現在の入力をテンプレート保存（名前初期値=支出概要/金額）できる', async ({ page }) => {
      // FREQ-232-AC-01 / AC-02
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: '支出摘要' }).click();
      await page.getByRole('option', { name: '縫製外注' }).click();
      await page.getByPlaceholder('0').fill('50000');

      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();

      await expect(page.getByPlaceholder('テンプレート名')).toHaveValue('縫製外注 / ¥50,000');
      await page.getByPlaceholder('テンプレート名').fill('縫製外注（定番）');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();

      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await expect(page.getByRole('option', { name: '縫製外注（定番）' })).toBeVisible();
    });

    test('保存済みテンプレートを選ぶと支出概要・金額がフォームへ反映される', async ({ page }) => {
      // FREQ-232-AC-03
      await mockAdminApis(page);
      await openCostInputTab(page);

      // 先にテンプレートを1件作る。
      await page.getByRole('button', { name: '支出摘要' }).click();
      await page.getByRole('option', { name: '縫製外注' }).click();
      await page.getByPlaceholder('0').fill('50000');
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('縫製外注（定番）');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible({ timeout: 15_000 });

      // 別の支出概要・金額へ変更。
      await page.getByRole('button', { name: '支出摘要' }).click();
      await page.getByRole('option', { name: '広告出稿' }).click();
      await page.getByPlaceholder('0').fill('12000');

      // テンプレートを選び直すと戻る。
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '縫製外注（定番）' }).click();

      await expect(page.getByRole('button', { name: '支出摘要' })).toHaveText(/縫製外注/);
      await expect(page.getByPlaceholder('0')).toHaveValue('50000');
    });

    test('適用後の変更を上書きまたは重複しない別名で保存できる', async ({ page }) => {
      // FREQ-232-AC-06
      const finance = await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('毎月の家賃');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();

      await page.getByLabel('取引日').fill('2026-06-15');
      await page.getByRole('button', { name: 'シーズンタグ' }).click();
      await page.getByRole('option', { name: '2026 S/S' }).click();
      await page.getByPlaceholder('0').fill('85000');
      await page.getByRole('button', { name: '取引先' }).click();
      await page.getByRole('option', { name: '新取引先' }).click();
      await page.getByRole('button', { name: '変更を上書き' }).click();
      const overwriteDialog = page.getByRole('dialog', { name: 'テンプレートの変更を上書き' });
      await expect(overwriteDialog).toContainText('毎月の家賃');
      await overwriteDialog.getByRole('button', { name: 'キャンセル' }).click();
      await expect(page.getByPlaceholder('0')).toHaveValue('85000');
      await page.getByRole('button', { name: '変更を上書き' }).click();
      await page.getByRole('button', { name: '上書きを確定' }).click();
      await expect(page.getByText('テンプレートを上書きしました。')).toBeVisible();
      expect(finance.templates.find((template) => template.name === '毎月の家賃')?.partner).toBe('新取引先');

      await page.getByRole('button', { name: '取引先' }).click();
      await page.getByRole('option', { name: '旧取引先' }).click();
      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '毎月の家賃' }).click();
      await expect(page.getByRole('button', { name: '取引先' })).toHaveText(/新取引先/);
      await expect(page.getByLabel('取引日')).toHaveValue('2026-06-15');
      await expect(page.getByRole('button', { name: 'シーズンタグ' })).toHaveText(/2026 S\/S/);

      await page.getByRole('button', { name: '別名で保存' }).click();
      const nameInput = page.getByPlaceholder('テンプレート名');
      await expect(nameInput).toHaveValue('毎月の家賃');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();
      await expect(page.getByText('同じ名前のテンプレートが存在します。')).toBeVisible();
      await nameInput.fill('毎月の家賃（増額後）');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible({ timeout: 15_000 });

      const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('テンプレートを削除できる', async ({ page }) => {
      // FREQ-232-AC-03（削除）
      await mockAdminApis(page);
      await openCostInputTab(page);

      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      await page.getByPlaceholder('テンプレート名').fill('使い捨て');
      await page.getByRole('button', { name: 'テンプレートを保存' }).click();
      await expect(page.getByText('テンプレートを保存しました。')).toBeVisible({ timeout: 15_000 });

      await page.getByRole('button', { name: '選択中のテンプレートを削除' }).click();
      await expect(page.getByText('テンプレートを削除しました。')).toBeVisible();

      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await expect(page.getByRole('option', { name: '使い捨て' })).toHaveCount(0);
    });

    test('テンプレート名の入力中はDrawerを維持し、閉じる前に未保存確認を表示する', async ({ page }) => {
      // FREQ-232-AC-05
      await mockAdminApis(page);
      const templateCreateRequests: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/admin/kpi/cost-profit')) {
          templateCreateRequests.push(request.postData() ?? '');
        }
      });
      await openCostInputTab(page);

      await page.getByRole('button', { name: 'テンプレート', exact: true }).click();
      await page.getByRole('option', { name: '＋ 現在の入力を保存' }).click();
      const nameInput = page.getByPlaceholder('テンプレート名');
      await nameInput.focus();
      await nameInput.dispatchEvent('compositionstart', { data: '' });
      await nameInput.pressSequentially('月次の外注費');
      await nameInput.dispatchEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 229,
        isComposing: true,
      });
      await nameInput.dispatchEvent('compositionend', { data: '外注費' });

      await expect(nameInput).toHaveValue(/月次の外注費$/);
      await expect(page.getByRole('button', { name: '取引の入力を閉じる' })).toBeVisible();
      expect(templateCreateRequests.some((body) => body.includes('"operation":"template.create"'))).toBe(false);

      await page.locator('[data-ui-drawer="true"]').click({ position: { x: 8, y: 8 } });
      const discardDialog = page.getByRole('dialog', { name: '未保存のテンプレートがあります' });
      await expect(discardDialog).toBeVisible();
      await discardDialog.getByRole('button', { name: '入力を続ける' }).click();
      await expect(nameInput).toHaveValue(/月次の外注費$/);

      await page.getByRole('button', { name: '取引の入力を閉じる' }).click();
      await expect(discardDialog).toBeVisible();
      await discardDialog.getByRole('button', { name: '破棄して閉じる' }).click();
      await expect(page.getByRole('button', { name: '取引の入力を閉じる' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-232-AC-04
      await mockAdminApis(page);
      await openCostInputTab(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
