import { test, expect, Page } from '@playwright/test';

// FREQ-248 / FREQ-249: 財務3表のCSVエクスポート・C/F検算、
// 証憑（電子取引データ）の添付と訂正削除履歴。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

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

const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-03-10', category: '広告宣伝費', item: '広告出稿',
    partner: 'A社', amount: 30000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [
      {
        id: 11, storagePath: '2026/1/receipt.pdf', fileName: 'invoice.pdf',
        mimeType: 'application/pdf', fileSize: 12345, createdAt: '2026-03-10T00:00:00.000Z',
      },
    ],
  },
  {
    id: 2, entryType: 'expense', date: '2026-04-01', category: '通信費', item: 'システム・ツール利用料',
    partner: '', amount: 3300, paymentMethod: '銀行', memo: '', seasonTag: null, receipts: [],
  },
];

const INCOMES = [
  {
    id: 3, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 500000, paymentMethod: '銀行', memo: '', seasonTag: null, receipts: [],
  },
];

// 登録 → 訂正 → 削除 の3件
const REVISIONS = [
  {
    id: 3, entryId: 9, operation: 'delete', changedAt: '2026-07-03T09:00:00.000Z',
    before: { date: '2026-07-01', category: '雑費', item: 'その他', partner: '', amount: '12000' },
    after: { date: '2026-07-01', category: '雑費', item: 'その他', partner: '', amount: '12000' },
  },
  {
    id: 2, entryId: 9, operation: 'update', changedAt: '2026-07-02T09:00:00.000Z',
    before: { date: '2026-07-01', category: '雑費', item: 'その他', partner: '', amount: '10000' },
    after: { date: '2026-07-01', category: '雑費', item: 'その他', partner: '', amount: '12000' },
  },
  {
    id: 1, entryId: 9, operation: 'insert', changedAt: '2026-07-01T09:00:00.000Z',
    before: { date: null, category: null, item: null, partner: null, amount: null },
    after: { date: '2026-07-01', category: '雑費', item: 'その他', partner: '', amount: '10000' },
  },
];

async function mockAdminApis(page: Page): Promise<void> {
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

  // 証憑API：アップロードと署名付きURL発行
  const uploads: Array<{ entryId: string }> = [];
  await page.exposeFunction('__receiptUploads', () => uploads);

  // 証憑APIは cost-profit のサブパスなので、1つのハンドラでパスを見て分岐する。
  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    const isReceipt = new URL(req.url()).pathname.endsWith('/receipt');

    if (isReceipt) {
      if (req.method() === 'POST') {
        uploads.push({ entryId: 'uploaded' });
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { id: 99, storagePath: '2026/2/new.pdf', fileName: 'new.pdf', mimeType: 'application/pdf', fileSize: 100 },
          }),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { url: 'https://example.invalid/signed', fileName: 'invoice.pdf', expiresIn: 300 } }),
      });
      return;
    }

    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          fiscalYear: 2026,
          seasonKey: '2026SS',
          businessType: 'soleProprietor',
          plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
          expenses: EXPENSES,
          incomes: INCOMES,
          products: [],
          partners: ['A社'],
          templates: [],
          fixedAssets: [],
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: REVISIONS,
        },
      }),
    });
  });
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByText('損益計算書（P/L）')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-038 receipts & revisions (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('財務3表のCSVボタンとC/F検算が表示される', async ({ page }) => {
      // FREQ-248-AC-01 / AC-02
      await openAccounting(page);

      await expect(page.getByRole('button', { name: '損益計算書CSV' })).toBeVisible();
      await expect(page.getByRole('button', { name: '貸借対照表CSV' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'キャッシュフローCSV' })).toBeVisible();
      await expect(
        page.getByText('C/F 検算：期首 + 営業CF + 投資CF + 財務CF = 期末（一致）'),
      ).toBeVisible();
    });

    test('取引一覧に証憑列があり添付済みが表示される', async ({ page }) => {
      // FREQ-249-AC-04
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      await expect(page.getByRole('columnheader', { name: '証憑' }).first()).toBeVisible();
      // 添付済みの取引はPDFリンクが出る
      await expect(page.getByRole('button', { name: 'invoice.pdfを開く' })).toBeVisible();
      // 未添付の取引にも「＋添付」がある
      await expect(page.getByText('＋添付').first()).toBeVisible();
    });

    test('証憑をアップロードできる', async ({ page }) => {
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      await page.getByLabel('システム・ツール利用料に証憑を添付').setInputFiles({
        name: 'receipt.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      });

      await expect(page.getByText('receipt.pdf を添付しました。')).toBeVisible();
      const uploads = await page.evaluate(() => (window as unknown as {
        __receiptUploads: () => Promise<Array<{ entryId: string }>>;
      }).__receiptUploads());
      expect(uploads.length).toBeGreaterThan(0);
    });

    test('訂正・削除の履歴が登録・訂正・削除の順で確認できる', async ({ page }) => {
      // FREQ-249-AC-02 / AC-03
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      const history = page.getByText('訂正・削除の履歴（3件）');
      await expect(history).toBeVisible();
      await history.click();

      await expect(page.getByRole('columnheader', { name: '変更前' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '変更後' })).toBeVisible();

      // 削除・訂正・登録の3区分が並ぶ（新しい順）
      await expect(page.getByRole('cell', { name: '削除', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: '訂正', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: '登録', exact: true })).toBeVisible();

      // 訂正行に変更前後の金額が出る
      const updateRow = page.getByRole('row').filter({ hasText: '訂正' });
      await expect(updateRow).toContainText('¥10,000');
      await expect(updateRow).toContainText('¥12,000');
    });

    test('訂正は削除・再登録ではなく expense.update で行う', async ({ page }) => {
      // FREQ-249-AC-06
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      const posted: Array<Record<string, unknown>> = [];
      page.on('request', (request) => {
        if (
          request.method() === 'POST'
          && request.url().includes('/api/admin/kpi/cost-profit')
          && !request.url().includes('/receipt')
        ) {
          posted.push(request.postDataJSON() as Record<string, unknown>);
        }
      });

      await page.getByRole('button', { name: '広告出稿を訂正' }).click();

      // フォームが訂正モードになり、当該取引の値が読み込まれる
      await expect(page.getByRole('heading', { name: '支出を訂正（#1）' })).toBeVisible();
      await expect(page.getByPlaceholder('0')).toHaveValue('30000');
      await expect(page.getByRole('button', { name: '訂正を取消' })).toBeVisible();

      await page.getByPlaceholder('0').fill('35000');
      await page.getByRole('button', { name: '訂正を保存' }).click();

      await expect(page.getByText('支出を訂正しました。履歴に記録されます。')).toBeVisible();

      const update = posted.find((body) => body.operation === 'expense.update');
      expect(update).toBeTruthy();
      expect(update).toMatchObject({ expenseId: 1, fiscalYear: 2026 });
      expect((update as { expense: Record<string, unknown> }).expense).toMatchObject({
        amount: 35000,
        category: '広告宣伝費',
      });
      // 削除は発行されない（履歴が途切れるため）
      expect(posted.some((body) => body.operation === 'expense.delete')).toBe(false);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-249-AC-05
      await openAccounting(page);
      await page.getByRole('tab', { name: '取引管理', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
