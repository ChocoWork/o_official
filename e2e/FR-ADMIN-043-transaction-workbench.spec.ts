import { test, expect, Page } from '@playwright/test';

// FREQ-257: 取引管理タブのダッシュボード化。
// 1つの表＋サマリー3枚＋確認キュー、検索と登録は Drawer、証憑はD&D／クリック選択。
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

const RECEIPT = {
  id: 900, storagePath: '2026/1/invoice.pdf', fileName: 'invoice.pdf',
  mimeType: 'application/pdf', fileSize: 1024, createdAt: '2026-01-15T00:00:00.000Z',
};

// id:1 訂正あり（履歴 update）/ id:2,3 金額の重複（同日・同取引先・同額）/ id:4 証憑なし
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-01-15', category: '広告宣伝費', item: '広告出稿',
    partner: 'A社', amount: 10000, paymentMethod: '現金', memo: '冬キャンペーン', seasonTag: null,
    receipts: [RECEIPT],
  },
  {
    id: 2, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 3, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '二重入力の疑い', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 4, entryType: 'expense', date: '2026-06-01', category: '通信費', item: 'システム・ツール利用料',
    partner: '', amount: 3300, paymentMethod: '銀行', memo: 'SaaS', seasonTag: null,
    receipts: [],
  },
];

const INCOMES = [
  {
    id: 5, entryType: 'income', date: '2026-06-20', category: '売上高', item: 'オンライン販売',
    partner: '', amount: 120000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 6, entryType: 'income', date: '2026-12-31', category: '売上高', item: '卸売',
    partner: 'A社', amount: 250000, paymentMethod: '売掛金', memo: '年末締め', seasonTag: '2026AW',
    receipts: [RECEIPT],
  },
];

const REVISIONS = [
  {
    id: 1, entryId: 1, operation: 'update', changedAt: '2026-01-20T10:15:00.000Z',
    before: { date: '2026-01-15', category: '広告宣伝費', item: '広告出稿', partner: 'A社', amount: '9000' },
    after: { date: '2026-01-15', category: '広告宣伝費', item: '広告出稿', partner: 'A社', amount: '10000' },
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

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    const req = route.request();
    const isReceipt = new URL(req.url()).pathname.endsWith('/receipt');

    if (isReceipt) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: 99, storagePath: '2026/4/new.pdf', fileName: 'new.pdf', mimeType: 'application/pdf', fileSize: 100 },
        }),
      });
      return;
    }

    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, resourceId: '7' }) });
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
          partners: ['A社', 'B社'],
          templates: [],
          fixedAssets: [],
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: REVISIONS,
          cumulativeEntries: [],
        },
      }),
    });
  });
}

async function openEntries(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '取引管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '取引管理', exact: true })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-043 transaction workbench (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('支出・収入が1つの表に統合され、必要な列がそろう', async ({ page }) => {
      // FREQ-257-AC-01
      await openEntries(page);

      await expect(page.getByText('6件').first()).toBeVisible();
      for (const header of ['日付', '種別', '勘定科目', '摘要・取引先', '金額', '証憑', '更新履歴', '状態']) {
        await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
      }

      // 旧構成の2表は消えていること
      await expect(page.getByText(/^支出一覧/)).toHaveCount(0);
      await expect(page.getByText(/^収入一覧/)).toHaveCount(0);
    });

    test('状態が訂正あり・要確認・登録済みで色分けされる', async ({ page }) => {
      // FREQ-257-AC-02
      await openEntries(page);

      const table = page.getByRole('region', { name: '取引一覧' });

      const revised = table.getByText('訂正あり', { exact: true }).first();
      await expect(revised).toBeVisible();
      await expect(revised).toHaveCSS('color', 'rgb(185, 28, 28)');

      const review = table.getByText('要確認', { exact: true }).first();
      await expect(review).toBeVisible();
      await expect(review).toHaveCSS('color', 'rgb(180, 83, 9)');

      const reviewButton = table
        .getByRole('button', { name: /の要確認の理由を開く（未確認\d+件）/ })
        .first();
      const registered = table.getByText('登録済み', { exact: true }).first();
      await expect(reviewButton).toHaveText(/^要確認$/);
      await expect(registered).toBeVisible();

      const reviewBox = await review.boundingBox();
      const registeredBox = await registered.boundingBox();
      expect(reviewBox?.width).toBe(registeredBox?.width);
      expect(reviewBox?.x).toBe(registeredBox?.x);
      await expect(review).toHaveCSS('white-space', 'nowrap');
      await expect(registered).toHaveCSS('white-space', 'nowrap');
      expect(
        await registered.evaluate((badge) => badge.scrollWidth <= badge.clientWidth),
      ).toBe(true);
    });

    test('サマリー3枚が角丸8pxの白い面で並ぶ', async ({ page }) => {
      // FREQ-257-AC-03
      await openEntries(page);

      for (const name of ['取引ステータス', '証憑ステータス', '今月の収支']) {
        const panel = page.getByRole('region', { name });
        await expect(panel).toBeVisible();
        await expect(panel).toHaveCSS('border-top-left-radius', '8px');
        await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      }

      const status = page.getByRole('region', { name: '取引ステータス' });
      await expect(status.getByText('合計')).toBeVisible();
      await expect(status.getByText('6件')).toBeVisible();
    });

    test('状態タブで一覧を絞り込める', async ({ page }) => {
      // FREQ-257-AC-04
      await openEntries(page);

      await expect(page.getByRole('tab', { name: 'すべて' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '証憑未添付（1）' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '要確認（2）' })).toBeVisible();
      await expect(page.getByRole('tab', { name: '訂正あり（1）' })).toBeVisible();

      await page.getByRole('tab', { name: '証憑未添付（1）' }).click();
      await expect(page.getByText('1-1 / 1件')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '取引一覧' }).getByText('システム・ツール利用料'),
      ).toBeVisible();
    });

    test('検索条件は詳細条件Drawerに集約され、組み合わせで絞り込める', async ({ page }) => {
      // FREQ-257-AC-05
      await openEntries(page);

      // 初期表示では条件の入力欄が画面に無い
      await expect(page.getByLabel('取引年月日（開始）')).toHaveCount(0);

      await page.getByRole('button', { name: '詳細条件' }).click();
      await expect(page.getByLabel('取引年月日（開始）')).toBeVisible();
      await expect(page.getByLabel('取引年月日（終了）')).toBeVisible();
      await expect(page.getByLabel('取引金額（下限）')).toBeVisible();
      await expect(page.getByLabel('取引金額（上限）')).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：相手先' })).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：科目' })).toBeVisible();
      await expect(page.getByRole('button', { name: '絞り込み：収支区分' })).toBeVisible();
      await expect(page.getByLabel('絞り込み：キーワード')).toBeVisible();

      // 取引先 A社（id:1 支出・id:6 収入）× 2026-06-01以降 → 収入1件だけ残る
      await page.getByRole('button', { name: '絞り込み：相手先' }).click();
      await page.getByRole('option', { name: 'A社', exact: true }).click();
      await page.getByLabel('取引年月日（開始）').fill('2026-06-01');
      await page.getByRole('button', { name: '適用して閉じる' }).click();

      await expect(page.getByText('1-1 / 1件')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '取引一覧' }).getByText('卸売 / A社'),
      ).toBeVisible();
    });

    test('新規取引と訂正はDrawerで入力する', async ({ page }) => {
      // FREQ-257-AC-06
      await openEntries(page);

      // 常設フォームは無い
      await expect(page.getByRole('button', { name: '事業形態' })).toHaveCount(0);

      await page.getByRole('button', { name: '新規取引' }).click();
      await expect(page.getByRole('heading', { name: '新規支出を登録' })).toBeVisible();
      await expect(page.getByRole('button', { name: '事業形態' })).toBeVisible();
      await expect(page.getByRole('button', { name: '勘定科目' })).toBeVisible();
      await expect(page.getByLabel('取引日')).toBeVisible();
      await page.getByRole('button', { name: '取引の入力を閉じる' }).click();

      await page.getByRole('button', { name: '広告出稿を編集' }).click();
      await expect(page.getByRole('heading', { name: '支出を訂正（#1）' })).toBeVisible();
    });

    test('行末の操作列から削除確認を開き、キャンセルと確定を選べる', async ({ page }) => {
      // FREQ-257-AC-10
      await openEntries(page);

      const table = page.getByLabel('取引一覧');
      await expect(table.getByRole('columnheader', { name: '操作' })).toBeVisible();
      await page.getByRole('button', { name: '広告出稿を削除' }).click();
      const dialog = page.getByRole('dialog', { name: '取引を削除' });
      await expect(dialog).toContainText('広告出稿 / A社');
      await expect(dialog).toContainText('¥10,000');
      await dialog.getByRole('button', { name: 'キャンセル' }).click();
      await expect(dialog).toBeHidden();

      await page.getByRole('button', { name: '広告出稿を削除' }).click();
      await dialog.getByRole('button', { name: '削除を確定' }).click();
      await expect(page.getByText('支出をSupabaseから削除しました。')).toBeVisible();
    });

    test('新規取引フォームは既存UIコンポーネントの角丸を使う', async ({ page }) => {
      // FREQ-257-AC-06
      await openEntries(page);
      await page.getByRole('button', { name: '新規取引' }).click();

      const drawer = page
        .locator('[data-ui-drawer]')
        .filter({ has: page.getByRole('heading', { name: '新規支出を登録' }) });
      await expect(drawer).toHaveAttribute('data-ui-drawer-shape', 'rounded');
      await expect(
        drawer
          .getByRole('button', { name: '事業形態' })
          .locator('xpath=ancestor::*[@data-ui-single-select][1]'),
      ).toHaveAttribute('data-ui-single-select-shape', 'rounded');
      await expect(drawer.getByLabel('取引日').locator('..').locator('..')).toHaveAttribute(
        'data-ui-text-field-shape',
        'rounded',
      );
      await expect(drawer.getByLabel('取引日')).toHaveCSS('border-radius', '8px');
      await expect(drawer.getByLabel(/^金額/)).toHaveCSS('border-radius', '8px');
      await expect(drawer.getByPlaceholder('任意のメモを入力')).toHaveCSS(
        'border-radius',
        '8px',
      );
      await expect(drawer.getByRole('button', { name: '取消', exact: true })).toHaveAttribute(
        'data-ui-button-shape',
        'rounded',
      );
      await expect(drawer.getByRole('button', { name: '保存', exact: true })).toHaveAttribute(
        'data-ui-button-shape',
        'rounded',
      );
    });

    test('証憑はドラッグ＆ドロップとクリック選択の両方で追加できる', async ({ page }) => {
      // FREQ-257-AC-07
      await openEntries(page);

      // 未添付の行は橙の警告アイコン
      const missing = page.locator('[data-receipt-state="missing"]');
      await expect(missing).toHaveCount(1);
      await expect(missing).toHaveCSS('color', 'rgb(180, 83, 9)');

      await missing.click();
      await expect(page.getByRole('heading', { name: '証憑を追加' })).toBeVisible();
      const zone = page.locator('[data-ui-file-drop-zone]').first();
      await expect(zone).toBeVisible();
      await expect(zone.getByText('ドラッグ＆ドロップ／クリックで選択')).toBeVisible();

      // クリック選択の経路（input[type=file]）でアップロードできる
      await page.getByLabel('システム・ツール利用料に証憑を添付').setInputFiles({
        name: 'receipt.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
      });
      await expect(page.getByText('receipt.pdf を添付しました。')).toBeVisible();
    });

    test('確認キューとチェックリストが右カラムに並ぶ', async ({ page }) => {
      // FREQ-257-AC-08
      await openEntries(page);

      const queue = page.getByRole('region', { name: '確認キュー' });
      await expect(queue.getByText('証憑未添付')).toBeVisible();
      await expect(queue.getByText('金額確認')).toBeVisible();
      await expect(queue.getByText('訂正内容確認')).toBeVisible();

      await queue.getByRole('button', { name: '証憑未添付の取引を一覧で絞り込む' }).click();
      await expect(page.getByRole('tab', { name: '証憑未添付（1）' })).toHaveAttribute('aria-selected', 'true');

      const checklist = page.getByRole('region', { name: '電子帳簿保存法 チェックリスト' });
      for (const label of ['日付検索', '金額検索', '取引先検索', '訂正履歴']) {
        await expect(checklist.getByText(label)).toBeVisible();
      }
      await expect(checklist.getByText('対応済み').first()).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-257-AC-09
      await openEntries(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}

// 目視確認用のスクリーンショット。参照デザインと同じ 1600px と、
// 2カラムが解ける 1280px の両方を撮る。
test.describe('FR-ADMIN-043 screenshot', () => {
  for (const width of [1280, 1600]) {
    test(`取引管理の全体像 ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockAdminApis(page);
      await openEntries(page);
      await page.screenshot({
        path: `test-results/transaction-workbench-${width}.png`,
        fullPage: true,
      });

      // 表の列が面からはみ出さない（横スクロールで隠れない）こと。
      const dimensions = await page.evaluate(() => {
        const container = document.querySelector(
          '[aria-label="取引一覧"] [data-ui-data-table]',
        );
        if (!container) return null;
        return { clientWidth: container.clientWidth, scrollWidth: container.scrollWidth };
      });
      expect(dimensions).not.toBeNull();
      expect(dimensions!.scrollWidth).toBeLessThanOrEqual(dimensions!.clientWidth + 1);
    });
  }
});
