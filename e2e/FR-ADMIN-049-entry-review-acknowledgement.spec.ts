import { test, expect, Page } from '@playwright/test';

// FREQ-263: 要確認の取引を、理由と確認手順を見たうえで確認済み（登録済み）にできる。
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

// id:2,3 は同日・同取引先・同額で重複の疑い。id:4 は科目マスタに無い科目。
const EXPENSES = [
  {
    id: 2, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '', seasonTag: null,
    receipts: [RECEIPT],
  },
  {
    id: 3, entryType: 'expense', date: '2026-03-31', category: '仕入高', item: '生地・材料仕入',
    partner: 'B社', amount: 90000, paymentMethod: '買掛金', memo: '二重入力の疑い', seasonTag: null,
    receipts: [RECEIPT],
  },
  {
    id: 4, entryType: 'expense', date: '2026-06-01', category: '謎科目', item: '用途不明の支払',
    partner: 'C社', amount: 5000, paymentMethod: '銀行', memo: '', seasonTag: null,
    receipts: [RECEIPT],
  },
];

type Ack = { entryRef: string; reason: string; note: string; reviewedAt: string };

async function mockAdminApis(page: Page, acks: Ack[]): Promise<void> {
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

  // 確認済みの記録はサーバー側の状態として保持し、再取得で反映されることまで検証する。
  await page.route('**/api/admin/kpi/cost-profit**', async (route) => {
    const req = route.request();

    if (req.method() === 'POST') {
      const body = req.postDataJSON() as {
        operation: string;
        entryRef?: string;
        reason?: string;
        note?: string;
        acknowledged?: boolean;
      };
      if (body.operation === 'entry.reviewAck') {
        const index = acks.findIndex(
          (ack) => ack.entryRef === body.entryRef && ack.reason === body.reason,
        );
        if (body.acknowledged) {
          const next = {
            entryRef: body.entryRef ?? '',
            reason: body.reason ?? '',
            note: body.note ?? '',
            reviewedAt: '2026-07-01T09:00:00.000Z',
          };
          if (index >= 0) acks[index] = next;
          else acks.push(next);
        } else if (index >= 0) {
          acks.splice(index, 1);
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }

    await route.fulfill({
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
          partners: ['B社', 'C社'],
          templates: [],
          fixedAssets: [],
          closing: {
            closingInventoryGoods: 0, closingInventoryMaterials: 0,
            allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
          },
          previousClosingBalances: null,
          revisions: [],
          reviewAcks: acks,
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

/** 重複の疑いで要確認になっている id:2 の確認パネルを開く。 */
async function openReviewPanel(page: Page) {
  await page
    .getByRole('button', { name: /生地・材料仕入の要確認の理由を開く/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: '取引の確認' })).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-049 entry review acknowledgement (${viewport.name})`, () => {
    let acks: Ack[];

    test.beforeEach(async ({ page }) => {
      acks = [];
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page, acks);
    });

    test('要確認の状態から確認パネルを開ける', async ({ page }) => {
      // FREQ-263-AC-01
      await openEntries(page);

      // 状態が「登録済み」だけの取引は押せない（開く導線を持たない）
      await expect(
        page.getByRole('button', { name: /の要確認の理由を開く/ }),
      ).toHaveCount(3);

      await openReviewPanel(page);
      await expect(page.getByText('未確認 1 / 1件。すべて確認すると「登録済み」に戻ります。')).toBeVisible();
    });

    test('なぜ要確認か・何を確認すべきかがパネルに表示される', async ({ page }) => {
      // FREQ-263-AC-02
      await openEntries(page);
      await openReviewPanel(page);

      const panel = page.getByRole('region', { name: '重複の疑い' });
      await expect(panel.getByText(/同じ日付・同じ取引先・同じ金額の取引が他にもあります/)).toBeVisible();
      await expect(panel.getByText('確認すること')).toBeVisible();
      await expect(panel.getByText('下の該当取引と、摘要・注文番号・証憑を見比べる')).toBeVisible();
      await expect(panel.getByText('同じ取引が二重に入っていたら、余分な1件を削除する')).toBeVisible();

      // 検知に使った実データ（該当取引）も並ぶ
      await expect(panel.getByText('同じ日付・取引先・金額の取引（1件）')).toBeVisible();
      await expect(panel.getByText('二重入力の疑い')).toHaveCount(0);
      await expect(panel.getByText('2026/03/31　仕入高　¥90,000')).toBeVisible();
    });

    test('取引確認画面は既存UIコンポーネントの角丸を使う', async ({ page }) => {
      // FREQ-263-AC-02
      await openEntries(page);
      await openReviewPanel(page);

      const drawer = page
        .locator('[data-ui-drawer]')
        .filter({ has: page.getByRole('heading', { name: '取引の確認' }) });
      await expect(drawer).toHaveAttribute('data-ui-drawer-shape', 'rounded');
      await expect(drawer.locator('[data-ui-panel][aria-label="確認対象の取引"]')).toHaveAttribute(
        'data-ui-panel-radius',
        'rounded',
      );
      await expect(drawer.getByRole('region', { name: '重複の疑い' })).toHaveAttribute(
        'data-ui-panel-radius',
        'rounded',
      );
      await expect(drawer.getByLabel('確認メモ（任意）').locator('..')).toHaveAttribute(
        'data-ui-text-area-field-shape',
        'rounded',
      );
      await expect(drawer.getByRole('button', { name: '確認済みにする' })).toHaveAttribute(
        'data-ui-button-shape',
        'rounded',
      );
    });

    test('科目未登録の取引には理由と該当科目名が出る', async ({ page }) => {
      // FREQ-263-AC-03
      await openEntries(page);
      await page.getByRole('button', { name: /用途不明の支払の要確認の理由を開く/ }).click();

      const panel = page.getByRole('region', { name: '勘定科目が未登録' });
      await expect(panel.getByText(/決算書のどの区分に載るかが決まらず/)).toBeVisible();
      await expect(panel.getByText('「謎科目」')).toBeVisible();
    });

    test('確認済みにすると状態が登録済みに変わる', async ({ page }) => {
      // FREQ-263-AC-04
      await openEntries(page);
      await openReviewPanel(page);

      await page.getByLabel('確認メモ（任意）').fill('注文番号が別なので別々の取引');
      await page.getByRole('button', { name: '確認済みにする' }).click();

      await expect(page.getByText('「重複の疑い」を確認済みにしました。')).toBeVisible();
      await expect(page.getByText('すべて確認済みです。状態は「登録済み」になっています。')).toBeVisible();
      await expect(page.getByText('注文番号が別なので別々の取引')).toBeVisible();

      // 要確認は3件（重複2件＋科目未登録1件）から2件へ減る
      await expect(page.getByRole('tab', { name: '要確認（3）' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: '要確認（2）' })).toBeVisible();
    });

    test('確認済みは取り消して要確認に戻せる', async ({ page }) => {
      // FREQ-263-AC-05
      await openEntries(page);
      await openReviewPanel(page);
      await page.getByRole('button', { name: '確認済みにする' }).click();
      await expect(page.getByText('すべて確認済みです。状態は「登録済み」になっています。')).toBeVisible();

      await page.getByRole('button', { name: '確認を取り消す' }).click();
      await expect(page.getByText('「重複の疑い」の確認を取り消しました。')).toBeVisible();
      await expect(page.getByRole('tab', { name: '要確認（3）' })).toBeVisible();
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      // FREQ-263-AC-06
      await openEntries(page);
      await openReviewPanel(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
