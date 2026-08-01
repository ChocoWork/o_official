import { test, expect, Page } from '@playwright/test';

// FREQ-260: 固定資産の入力を取引管理と固定資産タブで二重に行わせず、取引を単一の入口として連携させる。
// 取引管理＝購入日・取引先・支払額・支払方法・証憑（取得仕訳）、
// 固定資産＝耐用年数・償却方法・事業専用割合・使用開始日・除却日（減価償却仕訳）。
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
  mimeType: 'application/pdf', fileSize: 1024, createdAt: '2026-08-01T00:00:00.000Z',
};

const EXPENSES = [
  // 台帳と連携済み（証憑あり）→ 状態は「取引連携済み」
  {
    id: 1, entryType: 'expense', date: '2026-08-01', category: '工具器具備品', item: '業務用PC',
    partner: '株式会社A', amount: 300000, paymentMethod: '銀行', memo: '', seasonTag: null,
    fixedAssetExempt: false, receipts: [RECEIPT],
  },
  // 固定資産科目なのに台帳へ未登録 → 確認キュー「固定資産の登録待ち」に出る
  {
    id: 2, entryType: 'expense', date: '2026-09-10', category: 'ソフトウェア', item: '受注管理ソフト',
    partner: '株式会社B', amount: 250000, paymentMethod: '銀行', memo: '', seasonTag: null,
    fixedAssetExempt: false, receipts: [RECEIPT],
  },
  // 費用科目で10万円以上 → 科目の付け間違いの疑い（suspect）
  {
    id: 3, entryType: 'expense', date: '2026-09-20', category: '消耗品費', item: '什器一式',
    partner: '株式会社C', amount: 150000, paymentMethod: '銀行', memo: '', seasonTag: null,
    fixedAssetExempt: false, receipts: [RECEIPT],
  },
];

const FIXED_ASSETS = [
  // 取引 id=1 と連携済み
  {
    id: 11, name: '業務用PC', account: '工具器具備品', acquiredOn: '2026-08-01',
    acquisitionCost: 300000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, serviceStartedOn: null, entryId: 1, memo: '',
  },
  // 期首残高の移行で入れた資産（取引を経由していない）
  {
    id: 12, name: '工業用ミシン', account: '工具器具備品', acquiredOn: '2026-03-15',
    acquisitionCost: 600000, usefulLife: 6, method: 'straightLine',
    businessUseRatio: 100, disposedOn: null, serviceStartedOn: null, entryId: null, memo: '',
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
    if (new URL(req.url()).pathname.endsWith('/receipt')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { url: 'https://example.com/x.pdf' } }) });
      return;
    }
    if (req.method() === 'POST') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, resourceId: '9' }) });
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
          incomes: [],
          products: [],
          partners: ['株式会社A', '株式会社B', '株式会社C'],
          templates: [],
          fixedAssets: FIXED_ASSETS,
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: {},
          revisions: [],
          cumulativeEntries: [],
        },
      }),
    });
  });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function openAccounting(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
}

async function openAssets(page: Page) {
  await openAccounting(page);
  await page.getByRole('tab', { name: '帳簿', exact: true }).click();
  await page.getByRole('tab', { name: '固定資産', exact: true }).click();
  await expect(page.getByRole('region', { name: '資産一覧' })).toBeVisible();
}

async function openEntries(page: Page) {
  await openAccounting(page);
  await page.getByRole('tab', { name: '取引管理', exact: true }).click();
}

/** SingleSelect（button + listbox）から値を選ぶ。 */
async function chooseOption(page: Page, selectLabel: string, optionText: string | RegExp) {
  await page.getByRole('button', { name: selectLabel, exact: true }).click();
  await page.getByRole('option', { name: optionText }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-046 fixed asset transaction link (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('固定資産の登録方法を「取引から登録／直接登録」で切り替えられ、既定は取引から登録', async ({ page }) => {
      // FREQ-260-AC-03
      await openAssets(page);

      const simulation = page.getByRole('region', { name: '償却シミュレーション' });
      const fromEntryTab = simulation.getByRole('tab', { name: '取引から登録', exact: true });
      const directTab = simulation.getByRole('tab', { name: '直接登録', exact: true });

      await expect(fromEntryTab).toBeVisible();
      await expect(directTab).toBeVisible();
      await expect(fromEntryTab).toHaveAttribute('aria-selected', 'true');

      await directTab.click();
      await expect(
        simulation.getByText('取得仕訳は生成されないため、別途取引管理へ登録してください。', { exact: false }),
      ).toBeVisible();

      await expectNoHorizontalScroll(page);
    });

    test('取引から登録すると取得金額・取得日が読み取り専用になる', async ({ page }) => {
      // FREQ-260-AC-04
      await openAssets(page);

      const simulation = page.getByRole('region', { name: '償却シミュレーション' });
      // 台帳へ未連携の固定資産取引（ソフトウェア 250,000）だけが候補に出る
      await chooseOption(page, '連携する購入取引', /受注管理ソフト/);

      await expect(simulation.getByTestId('asset-acquisition-cost-readonly')).toHaveText('¥250,000');
      await expect(simulation.getByText('取得金額・取得日は取引管理で訂正できます。')).toBeVisible();
      // 金額・取得日を直せる入力欄は出さない（取引が単一の情報源）。
      // 耐用年数・事業専用割合は台帳側の項目なので編集できたままにする。
      await expect(simulation.getByLabel(/^取得金額/)).toHaveCount(0);
      await expect(simulation.getByLabel(/^取得日/)).toHaveCount(0);
      await expect(simulation.getByLabel(/^事業専用割合/)).toBeVisible();

      await expectNoHorizontalScroll(page);
    });

    test('使用開始日を任意入力できる', async ({ page }) => {
      // FREQ-260-AC-02
      await openAssets(page);

      const serviceStarted = page.getByLabel('使用開始日（任意・未入力なら取得日）');
      await expect(serviceStarted).toBeVisible();

      await chooseOption(page, '連携する購入取引', /受注管理ソフト/);
      // 取得日より前は選べない
      await expect(serviceStarted).toHaveAttribute('min', '2026-09-10');

      await expectNoHorizontalScroll(page);
    });

    test('資産一覧に取引連携の状態と管理番号が並ぶ', async ({ page }) => {
      // FREQ-260-AC-09
      await openAssets(page);

      const list = page.getByRole('region', { name: '資産一覧' });
      await expect(list.getByRole('columnheader', { name: '状態', exact: true })).toBeVisible();

      // 取引と連携し証憑もある資産／取引を経由していない資産
      await expect(list.getByText('取引連携済み', { exact: true })).toBeVisible();
      await expect(list.getByText('直接登録', { exact: true })).toBeVisible();

      // 管理番号は取得年と id から導出する
      await expect(list.getByText('FA-2026-0011', { exact: true })).toBeVisible();
      await expect(list.getByText('FA-2026-0012', { exact: true })).toBeVisible();

      await expectNoHorizontalScroll(page);
    });

    test('資産の詳細に 購入取引→固定資産→取得仕訳→減価償却仕訳 が並ぶ', async ({ page }) => {
      // FREQ-260-AC-10
      await openAssets(page);

      await page.getByRole('button', { name: '業務用PCの詳細' }).click();

      const detail = page.getByRole('region', { name: '固定資産の来歴' });
      await expect(detail).toBeVisible();

      const headings = detail.getByRole('heading');
      await expect(headings.nth(0)).toHaveText('購入取引');
      await expect(headings.nth(1)).toHaveText('固定資産');
      await expect(headings.nth(2)).toHaveText('取得仕訳');
      await expect(headings.nth(3)).toHaveText(/減価償却仕訳/);

      // 取得仕訳は取引から生成される：工具器具備品 300,000 / 普通預金 300,000
      await expect(detail.getByText(/工具器具備品.*¥300,000/)).toBeVisible();
      await expect(detail.getByText(/普通預金.*¥300,000/)).toBeVisible();
      await expect(detail.getByText('FA-2026-0011', { exact: false })).toBeVisible();

      await expectNoHorizontalScroll(page);
    });

    test('直接登録の資産は取得仕訳が無いことを詳細で警告する', async ({ page }) => {
      // FREQ-260-AC-10
      await openAssets(page);

      await page.getByRole('button', { name: '工業用ミシンの詳細' }).click();

      const detail = page.getByRole('region', { name: '固定資産の来歴' });
      await expect(detail.getByText('購入取引なし（直接登録）')).toBeVisible();
      await expect(
        detail.getByText('取得仕訳がありません。取引管理へ購入取引を登録してください。'),
      ).toBeVisible();

      await expectNoHorizontalScroll(page);
    });

    test('確認キューに「固定資産の登録待ち」が出て、該当取引は要確認になる', async ({ page }) => {
      // FREQ-260-AC-08
      await openEntries(page);

      const queue = page.getByRole('region', { name: '確認キュー' });
      await expect(queue.getByText('固定資産の登録待ち')).toBeVisible();

      // 台帳へ未登録なのは「受注管理ソフト」の1件だけ（業務用PCは連携済み）
      await expect(queue.getByText('受注管理ソフト')).toBeVisible();
      await expect(queue.getByText('業務用PC')).toHaveCount(0);

      await expectNoHorizontalScroll(page);
    });

    test('固定資産科目の取引を保存すると台帳登録へ誘導し、費用として処理させない', async ({ page }) => {
      // FREQ-260-AC-06
      await openEntries(page);

      await page.getByRole('button', { name: '新規取引' }).click();
      const drawer = page
        .locator('[data-ui-drawer]')
        .filter({ has: page.getByRole('heading', { name: '新規支出を登録' }) });
      await expect(drawer).toBeVisible();
      await page.getByLabel('取引日').fill('2026-08-01');
      await chooseOption(page, '勘定科目', /工具器具備品/);
      await drawer.getByLabel(/^金額/).fill('300000');
      await drawer.getByRole('button', { name: '保存', exact: true }).click();

      const dialog = page.getByRole('dialog', { name: 'この取引は固定資産です' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '固定資産として登録' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '勘定科目を修正' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'あとで確認' })).toBeVisible();
      // 資産科目で取得仕訳が立っている以上、費用として処理する逃げ道は出さない
      await expect(dialog.getByRole('button', { name: 'このまま費用として処理' })).toHaveCount(0);

      await expectNoHorizontalScroll(page);
    });

    test('10万円以上の消耗品費は科目の修正を促し、台帳へ直行させない', async ({ page }) => {
      // FREQ-260-AC-06
      await openEntries(page);

      await page.getByRole('button', { name: '新規取引' }).click();
      const drawer = page
        .locator('[data-ui-drawer]')
        .filter({ has: page.getByRole('heading', { name: '新規支出を登録' }) });
      await expect(drawer).toBeVisible();
      await page.getByLabel('取引日').fill('2026-09-20');
      await chooseOption(page, '勘定科目', /消耗品費/);
      await drawer.getByLabel(/^金額/).fill('150000');
      await drawer.getByRole('button', { name: '保存', exact: true }).click();

      const dialog = page.getByRole('dialog', { name: '10万円以上の支出です' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '勘定科目を修正' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'このまま費用として処理' })).toBeVisible();
      // 科目が費用のままなので、台帳へ直行させてはいけない
      await expect(dialog.getByRole('button', { name: '固定資産として登録' })).toHaveCount(0);

      await expectNoHorizontalScroll(page);
    });

    test('「固定資産として登録」で固定資産ビューへ移り、取得金額が引き継がれる', async ({ page }) => {
      // FREQ-260-AC-07
      await openEntries(page);

      await page.getByRole('button', { name: '新規取引' }).click();
      const drawer = page
        .locator('[data-ui-drawer]')
        .filter({ has: page.getByRole('heading', { name: '新規支出を登録' }) });
      await expect(drawer).toBeVisible();
      await page.getByLabel('取引日').fill('2026-08-01');
      await chooseOption(page, '勘定科目', /工具器具備品/);
      await drawer.getByLabel(/^金額/).fill('300000');
      await drawer.getByRole('button', { name: '保存', exact: true }).click();

      await page
        .getByRole('dialog', { name: 'この取引は固定資産です' })
        .getByRole('button', { name: '固定資産として登録' })
        .click();

      const simulation = page.getByRole('region', { name: '償却シミュレーション' });
      await expect(simulation).toBeVisible();
      await expect(simulation.getByRole('tab', { name: '取引から登録', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(simulation.getByTestId('asset-acquisition-cost-readonly')).toHaveText('¥300,000');

      await expectNoHorizontalScroll(page);
    });
  });
}
