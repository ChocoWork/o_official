import { test, expect, Page } from '@playwright/test';

// FREQ-258: 帳簿タブを「仕訳・元帳」「固定資産」「決算・試算表」の3枚に畳む。
// 仕訳・元帳＝科目ツリー＋月次累積収支推移＋仕訳一覧＋仕訳詳細＋照合結果、
// 固定資産＝サマリー4枚＋資産一覧＋償却推移＋固定資産登録＋償却予定表、
// 決算・試算表＝財務3表／試算表／決算整理の切替と貸借対照表の構成・詳細。
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
  id: 900, storagePath: '2026/6/invoice.pdf', fileName: 'invoice.pdf',
  mimeType: 'application/pdf', fileSize: 1024, createdAt: '2026-06-18T00:00:00.000Z',
};

// 普通預金（1040）に借方・貸方の両方が立つように支出と収入を混ぜる。
const EXPENSES = [
  {
    id: 1, entryType: 'expense', date: '2026-06-12', category: '荷造運賃', item: '国内配送料（6月分）',
    partner: '物流会社C', amount: 128000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [RECEIPT],
  },
  {
    id: 2, entryType: 'expense', date: '2026-06-18', category: '仕入高', item: '生地・材料仕入',
    partner: '生地仕入先B', amount: 650000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 3, entryType: 'expense', date: '2026-06-21', category: '広告宣伝費', item: '広告出稿',
    partner: '広告代理店A', amount: 320000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [],
  },
  {
    id: 6, entryType: 'expense', date: '2026-07-01', category: 'ソフトウェア', item: '在庫管理システム',
    partner: 'システム会社D', amount: 1000000, paymentMethod: '銀行', memo: '', seasonTag: null,
    fixedAssetExempt: false, receipts: [RECEIPT],
  },
];

const INCOMES = [
  {
    id: 4, entryType: 'income', date: '2026-06-22', category: '売上高', item: 'オンライン販売',
    partner: 'EC売上', amount: 1240000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 5, entryType: 'income', date: '2026-03-15', category: '売上高', item: '卸売',
    partner: 'セレクトショップB', amount: 780000, paymentMethod: '銀行', memo: '', seasonTag: '2026SS',
    receipts: [RECEIPT],
  },
  {
    id: 7, entryType: 'income', date: '2026-07-05', category: '売上高', item: 'オンライン注文',
    partner: '', amount: 59600, paymentMethod: 'Stripe', memo: '', seasonTag: null,
    receipts: [],
  },
  {
    id: 8, entryType: 'income', date: '2026-07-05', category: '売上高', item: 'オンライン注文',
    partner: '', amount: 22222, paymentMethod: 'Stripe', memo: '', seasonTag: null,
    receipts: [],
  },
];

// 定額法・一括償却の2件。予測年度の列と償却完了予定を出すのに使う。
const FIXED_ASSETS = [
  {
    id: 11, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2025-06-15',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, memo: '',
  },
  {
    id: 12, name: 'ノートPC', account: '工具器具備品', acquiredOn: '2026-04-01',
    acquisitionCost: 180000, usefulLife: 4, method: 'lumpSum3Year',
    businessUseRatio: 80, disposedOn: null, memo: '',
  },
];

const REVISIONS = [
  {
    id: 1, entryId: 2, operation: 'update', changedAt: '2026-06-20T10:15:00.000Z',
    before: { date: '2026-06-18', category: '仕入高', item: '生地・材料仕入', partner: '生地仕入先B', amount: '600000' },
    after: { date: '2026-06-18', category: '仕入高', item: '生地・材料仕入', partner: '生地仕入先B', amount: '650000' },
  },
];

export async function mockAdminApis(page: Page): Promise<void> {
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
    if (new URL(req.url()).pathname.endsWith('/receipt')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { url: 'https://example.com/x.pdf' } }) });
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
          partners: ['物流会社C', '生地仕入先B'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          // 期首残高（前年度末）。普通預金に前期末残高が立つ。
          previousClosingBalances: { '1040': 3340000, '2910': 3340000 },
          revisions: REVISIONS,
          cumulativeEntries: [
            { id: 101, entryType: 'income', date: '2025-12-20', category: '売上高', item: '前年売上', partner: '', amount: 100000, paymentMethod: '銀行', memo: '' },
            { id: 102, entryType: 'expense', date: '2025-12-25', category: '広告宣伝費', item: '前年広告', partner: '', amount: 30000, paymentMethod: 'クレジットカード', memo: '' },
            { id: 103, entryType: 'income', date: '2026-01-10', category: '売上高', item: '当年売上', partner: '', amount: 20000, paymentMethod: '現金', memo: '' },
            { id: 104, entryType: 'expense', date: '2026-02-05', category: '広告宣伝費', item: '当年広告', partner: '', amount: 5000, paymentMethod: '銀行', memo: '' },
          ],
        },
      }),
    });
  });
}

export async function openLedgerTab(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await expect(page.getByRole('tab', { name: '仕訳・元帳', exact: true })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-044 ledger three views (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('帳簿タブのサブタブが3つ（仕訳・元帳／固定資産／決算・試算表）である', async ({ page }) => {
      // FREQ-258-AC-01
      await openLedgerTab(page);

      for (const label of ['仕訳・元帳', '固定資産', '決算・試算表']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      // 旧構成の5サブタブは消えていること
      for (const label of ['仕訳帳', '総勘定元帳', '固定資産台帳', '合計残高試算表', '決算']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toHaveCount(0);
      }
    });

    test('仕訳・元帳に科目ツリー・月次累積収支推移・仕訳一覧・仕訳詳細・照合結果がそろう', async ({ page }) => {
      // FREQ-258-AC-02
      await openLedgerTab(page);

      await expect(page.getByRole('heading', { name: '仕訳・元帳', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '仕訳帳CSV' })).toBeVisible();
      await expect(page.getByRole('button', { name: '総勘定元帳CSV' })).toBeVisible();

      // 左：科目ツリー（会計区分の見出しと科目検索）
      await expect(page.getByRole('region', { name: '勘定科目' })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: '勘定科目を検索' })).toBeVisible();
      await expect(page.getByRole('button', { name: '勘定科目を検索する' })).toBeVisible();
      await expect(page.getByRole('button', { name: '仕訳を検索する' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^資産/ })).toBeVisible();

      // 中央：全取引の月次累積収支推移と仕訳一覧
      const trend = page.getByRole('region', { name: '月次累積収支推移' });
      await expect(trend).toBeVisible();
      await expect(trend.getByRole('img', { name: '2026年の月次累積収支推移' })).toBeVisible();
      for (const month of Array.from({ length: 12 }, (_, index) => `${index + 1}月`)) {
        await expect(trend.getByText(month, { exact: true })).toBeVisible();
      }
      for (const [label, value] of [
        ['期首残高', '¥70,000'],
        ['当年収入', '¥20,000'],
        ['当年支出', '¥5,000'],
        ['当年末残高', '¥85,000'],
      ] as const) {
        await expect(trend.getByText(label, { exact: true }).locator('..')).toContainText(value);
      }
      await expect(trend).toContainText('取引管理に入力した全収入・全支出による管理指標です。');
      await expect(page.getByRole('region', { name: '仕訳一覧' })).toBeVisible();
      for (const header of ['日付', '伝票No.', '相手勘定科目', '取引先', '摘要', '借方', '貸方', '残高', '証憑']) {
        await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
      }

      // 右：仕訳詳細（借方・貸方と操作）
      const detail = page.getByRole('region', { name: '仕訳詳細' });
      await expect(detail).toBeVisible();
      await expect(detail.getByText('借方', { exact: true })).toBeVisible();
      await expect(detail.getByText('貸方', { exact: true })).toBeVisible();
      await expect(detail.getByRole('button', { name: '証憑を表示' })).toBeVisible();
      await expect(detail.getByRole('button', { name: '修正' })).toBeVisible();

      // 下：照合結果（元帳残高＝試算表残高）
      const reconcile = page.getByRole('region', { name: '照合結果' });
      await expect(reconcile).toBeVisible();
      await expect(reconcile.getByText('元帳残高（最終残高）')).toBeVisible();
      await expect(reconcile.getByText(/試算表残高/)).toBeVisible();
      await expect(reconcile.getByText('貸借一致')).toBeVisible();
      await expect(reconcile.getByText('差額', { exact: true })).toBeVisible();
    });

    test('ワイドデスクトップでは仕訳一覧を左2列へ広げて仕訳詳細を右列に通す', async ({ page }) => {
      test.skip(viewport.name !== 'desktop');
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openLedgerTab(page);

      await expect(page.getByRole('heading', { name: '月次累積収支推移', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '仕訳一覧', exact: true })).toBeVisible();

      const accountBox = await page.getByRole('region', { name: '勘定科目' }).boundingBox();
      const trendBox = await page.getByRole('region', { name: '月次累積収支推移' }).boundingBox();
      const listBox = await page.getByRole('region', { name: '仕訳一覧' }).boundingBox();
      const detailBox = await page.getByRole('region', { name: '仕訳詳細' }).boundingBox();
      expect(accountBox).not.toBeNull();
      expect(trendBox).not.toBeNull();
      expect(listBox).not.toBeNull();
      expect(detailBox).not.toBeNull();
      expect(accountBox?.width).toBeGreaterThanOrEqual(215);
      expect(accountBox?.width).toBeLessThanOrEqual(225);
      expect(detailBox?.width).toBeGreaterThanOrEqual(302);
      expect(detailBox?.width).toBeLessThanOrEqual(312);
      expect(Math.abs(listBox!.x - accountBox!.x)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(listBox!.x + listBox!.width - (trendBox!.x + trendBox!.width)),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(detailBox!.y - trendBox!.y)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(detailBox!.y + detailBox!.height - (listBox!.y + listBox!.height)),
      ).toBeLessThanOrEqual(1);
    });

    test('科目ツリーで科目を選んでも月次累積収支推移は固定され、仕訳一覧と照合結果は切り替わる', async ({ page }) => {
      // FREQ-258-AC-03
      await openLedgerTab(page);

      // 普通預金（資金科目）には全取引の相手方が並ぶ
      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('普通預金');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await page.getByRole('button', { name: /1040\s*普通預金/ }).click();
      await expect(page.getByRole('region', { name: '仕訳一覧' })).toContainText('仕入高');
      await expect(page.getByRole('region', { name: '照合結果' })).toContainText('普通預金');
      const trend = page.getByRole('region', { name: '月次累積収支推移' });
      await expect(trend.getByText('当年末残高', { exact: true }).locator('..')).toContainText('¥85,000');
      const trendTextBeforeAccountSelection = await trend.textContent();

      // 別科目に切り替えると一覧の内容が変わる
      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('広告宣伝費');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /広告宣伝費/ })
        .last()
        .click();
      await expect(page.getByRole('region', { name: '仕訳一覧' })).toContainText('広告出稿');
      await expect(page.getByRole('region', { name: '照合結果' })).toContainText('広告宣伝費');
      await expect(trend).toHaveText(trendTextBeforeAccountSelection ?? '');
    });

    test('2科目選択でも月次累積表は不変で、総勘定元帳CSVは選択科目へ追従する', async ({ page }) => {
      test.skip(viewport.name !== 'desktop');
      await openLedgerTab(page);
      const trend = page.getByRole('region', { name: '月次累積収支推移' });
      const table = trend.getByRole('table', { name: '月次累積収支推移の月別累積収支' });
      const before = await table.textContent();

      const tree = page.getByRole('region', { name: '勘定科目' });
      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('普通預金');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await tree.getByRole('button', { name: /1040\s*普通預金/ }).click();
      await expect(table).toHaveText(before ?? '');
      const firstDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '総勘定元帳CSV' }).click();
      const first = await firstDownload;
      expect(first.suggestedFilename()).toContain('普通預金');
      const firstStream = await first.createReadStream();
      expect(firstStream).not.toBeNull();
      const firstChunks: Buffer[] = [];
      for await (const chunk of firstStream!) firstChunks.push(Buffer.from(chunk));
      expect(Buffer.concat(firstChunks).toString('utf8')).toContain('普通預金');

      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('広告宣伝費');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await tree.getByRole('button', { name: /広告宣伝費/ }).last().click();
      await expect(table).toHaveText(before ?? '');
      const secondDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '総勘定元帳CSV' }).click();
      const second = await secondDownload;
      expect(second.suggestedFilename()).toContain('広告宣伝費');
      const secondStream = await second.createReadStream();
      expect(secondStream).not.toBeNull();
      const secondChunks: Buffer[] = [];
      for await (const chunk of secondStream!) secondChunks.push(Buffer.from(chunk));
      expect(Buffer.concat(secondChunks).toString('utf8')).toContain('広告宣伝費');
    });

    test('Stripe注文は売上高元帳の貸方と伝票全体の正式科目で表示する', async ({ page }) => {
      await openLedgerTab(page);

      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('売上高');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /4010\s*売上高/ })
        .last()
        .click();

      const list = page.getByRole('region', { name: '仕訳一覧' });
      const orderRow = list.getByRole('row').filter({ hasText: 'オンライン注文' }).first();
      await orderRow.getByRole('button', { name: /の明細を表示/ }).click();
      const cells = orderRow.getByRole('cell');
      await expect(cells.nth(5)).toHaveText('—');
      await expect(cells.nth(6)).toHaveText('22,222');

      const detail = page.getByRole('region', { name: '仕訳詳細' });
      await expect(detail).toContainText(
        '一覧は選択中の勘定科目の元帳行、以下は伝票全体の仕訳です。',
      );
      await expect(detail.getByText('クレジット売掛金', { exact: true })).toBeVisible();
      await expect(detail.getByText('売上高', { exact: true })).toBeVisible();
      await expect(detail.getByText('¥22,222', { exact: true })).toHaveCount(2);
      await expect(detail.getByText('Stripe', { exact: true })).toHaveCount(0);
    });

    test('関連仕訳のオンライン注文を語中で折り返さない', async ({ page }) => {
      await openLedgerTab(page);

      await page.getByRole('searchbox', { name: '勘定科目を検索' }).fill('売上高');
      await page.getByRole('button', { name: '勘定科目を検索する' }).click();
      await page
        .getByRole('region', { name: '勘定科目' })
        .getByRole('button', { name: /4010\s*売上高/ })
        .last()
        .click();

      const list = page.getByRole('region', { name: '仕訳一覧' });
      await list
        .getByRole('row')
        .filter({ hasText: 'オンライン注文' })
        .first()
        .getByRole('button', { name: /の明細を表示/ })
        .click();

      const relatedDescription = page
        .getByRole('region', { name: '仕訳詳細' })
        .getByText('（オンライン注文）', { exact: true })
        .first();
      await expect(relatedDescription).toHaveCSS('white-space', 'nowrap');
    });

    test('固定資産にサマリー4枚・資産一覧・償却推移・シミュレーション・予定表がそろう', async ({ page }) => {
      // FREQ-258-AC-04
      await openLedgerTab(page);
      await page.getByRole('tab', { name: '固定資産', exact: true }).click();

      await expect(page.getByRole('heading', { name: '固定資産', exact: true })).toBeVisible();
      for (const label of ['当期償却', '来期予測', '必要経費算入額', '登録待ち']) {
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      }
      await page.getByRole('button', { name: '絞り込み' }).click();
      await expect(page.getByLabel('資産カテゴリで絞り込み')).toBeVisible();

      await expect(page.getByRole('region', { name: '資産一覧' })).toBeVisible();
      const assetSearch = page.getByRole('searchbox', { name: '資産を検索' });
      await expect(assetSearch).toBeVisible();
      await assetSearch.fill('対象外の資産名');
      await expect(page.getByRole('region', { name: '資産一覧' })).toContainText('工業用ミシン');
      await page.getByRole('button', { name: '資産を検索する' }).click();
      await expect(page.getByRole('region', { name: '資産一覧' })).not.toContainText('工業用ミシン');
      await page
        .getByRole('region', { name: '資産一覧' })
        .getByRole('button', { name: '入力内容をクリア' })
        .click();
      await expect(page.getByRole('region', { name: '減価償却推移' })).toBeVisible();
      await expect(page.getByText('償却方法フィルター')).toBeVisible();
      await expect(page.getByRole('button', { name: '台帳CSV' })).toBeVisible();
      await expect(page.getByRole('button', { name: '減価償却予定表CSV' })).toBeVisible();

      const simulation = page.getByRole('region', { name: '固定資産登録' });
      await expect(simulation).toBeVisible();
      await expect(simulation.getByRole('list', { name: '固定資産候補一覧' })).toBeVisible();
      await expect(simulation.getByText('候補選択', { exact: true })).toBeVisible();
      await expect(simulation.getByText('判定', { exact: true }).first()).toBeVisible();

      const plan = page.getByRole('region', { name: '減価償却予定表' });
      await expect(plan).toBeVisible();
      await expect(plan.getByRole('columnheader', { name: /2026年度\s*（実績）/ })).toBeVisible();
      await expect(plan.getByRole('columnheader', { name: /2027年度\s*（予測）/ })).toBeVisible();
      await expect(plan.getByRole('columnheader', { name: '償却完了予定' })).toBeVisible();
      await expect(plan).toContainText('工業用ミシン');
    });

    test('固定資産登録が入力額から年間償却額を出す', async ({ page }) => {
      // FREQ-258-AC-05
      await openLedgerTab(page);
      await page.getByRole('tab', { name: '固定資産', exact: true }).click();

      const simulation = page.getByRole('region', { name: '固定資産登録' });
      await simulation.getByRole('radio', { name: /在庫管理システム/ }).check();
      await simulation.getByRole('button', { name: '固定資産にする', exact: true }).click();
      // 耐用年数10年 → 定額法償却率 0.1 → 年間 ¥100,000
      await simulation.getByRole('spinbutton').first().fill('10');
      await expect(simulation).toContainText('¥100,000');
    });

    test('決算・試算表に財務3表・試算表・決算整理の切替と貸借対照表の構成がある', async ({ page }) => {
      // FREQ-258-AC-06
      await openLedgerTab(page);
      await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();

      await expect(page.getByRole('heading', { name: '決算・試算表', exact: true })).toBeVisible();
      for (const label of ['貸借対照表', '損益計算書', 'キャッシュフロー計算書', '合計残高試算表', '決算整理']) {
        await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: '表示中のCSV出力' })).toBeVisible();
      await expect(page.getByRole('button', { name: '財務諸表CSV' })).toBeVisible();

      // 左：構成図・12か月推移・増減要因
      const composition = page.getByRole('region', { name: '貸借対照表の構成' });
      await expect(composition).toBeVisible();
      for (const label of ['流動資産', '固定資産', '流動負債', '固定負債', '純資産']) {
        await expect(composition.getByText(label, { exact: true }).first()).toBeVisible();
      }
      await expect(composition.getByText('貸借一致')).toBeVisible();
      await expect(page.getByRole('region', { name: /資産・負債・純資産の推移/ })).toBeVisible();
      await expect(page.getByRole('region', { name: /増減要因/ })).toBeVisible();

      // 右：詳細ツリーと重要差異
      const detail = page.getByRole('region', { name: '貸借対照表 詳細' });
      await expect(detail).toBeVisible();
      await expect(detail.getByRole('searchbox', { name: '科目を検索' })).toBeVisible();
      await expect(page.getByRole('button', { name: '貸借対照表の科目を検索する' })).toBeVisible();
      for (const header of ['科目', '当月残高', '前月残高', '増減額', '増減率', '構成比']) {
        await expect(detail.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
      }
      await expect(detail.getByText('資産の部', { exact: true })).toBeVisible();
      await expect(detail.getByText('負債の部', { exact: true })).toBeVisible();
      await expect(detail.getByText('純資産の部', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: /重要差異/ })).toBeVisible();

      await page.getByRole('tab', { name: '損益計算書', exact: true }).click();
      const profitAndLoss = page.getByRole('region', { name: '損益計算書 詳細' });
      await expect(profitAndLoss).toBeVisible();
      await expect(profitAndLoss.locator('table').locator('..').locator('..')).toHaveClass(/rounded-md/);

      await page.getByRole('tab', { name: 'キャッシュフロー計算書', exact: true }).click();
      const cashFlow = page.getByRole('region', { name: 'キャッシュフロー計算書 詳細' });
      await expect(cashFlow.locator('table').locator('..')).toHaveClass(/rounded-md/);
    });

    test('貸借対照表の比較基準を期首比に切り替えると比較列の見出しが変わる', async ({ page }) => {
      // FREQ-258-AC-07
      await openLedgerTab(page);
      await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();

      const detail = page.getByRole('region', { name: '貸借対照表 詳細' });
      await expect(detail.getByRole('columnheader', { name: '前月残高', exact: true })).toBeVisible();

      await page.getByRole('tab', { name: '期首比', exact: true }).click();
      await expect(detail.getByRole('columnheader', { name: '期首残高', exact: true })).toBeVisible();
      await expect(detail.getByRole('columnheader', { name: '前月残高', exact: true })).toHaveCount(0);
    });

    test('決算・試算表から合計残高試算表と決算整理を開ける', async ({ page }) => {
      // FREQ-258-AC-08
      await openLedgerTab(page);
      await page.getByRole('tab', { name: '決算・試算表', exact: true }).click();

      await page.getByRole('tab', { name: '合計残高試算表', exact: true }).click();
      for (const header of ['コード', '勘定科目', '会計区分', '借方合計', '貸方合計']) {
        await expect(page.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('columnheader', { name: 'コード' }).locator('xpath=ancestor::table/parent::div')).toHaveClass(/rounded-md/);

      await page.getByRole('tab', { name: '決算整理', exact: true }).click();
      await expect(page.getByText('決算整理を入力')).toBeVisible();
      await expect(page.getByRole('button', { name: '決算整理を保存' })).toBeVisible();
      await expect(page.getByRole('button', { name: '2026年を締める' })).toBeVisible();
      await expect(page.getByRole('button', { name: '決算整理を保存' })).toHaveAttribute('data-ui-button-shape', 'rounded');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-258-AC-09
      await openLedgerTab(page);

      for (const tab of ['仕訳・元帳', '固定資産', '決算・試算表']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${tab} で横スクロールが出ている`).toBeLessThanOrEqual(1);
      }
    });
  });
}
