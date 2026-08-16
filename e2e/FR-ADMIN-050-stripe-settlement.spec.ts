import { test, expect, Page } from '@playwright/test';
import { mockAdminApis } from './FR-ADMIN-044-ledger-three-views.spec';

// FREQ-259: Stripe決済・実額手数料・成功返金・Payout・銀行着金確認を ACCOUNTING に反映する。
// 財務概要に Stripe決済残高／Stripe入金途上／Payout一覧と銀行着金確認を出し、
// 仕訳・元帳には Stripe 原始記録から投影した仕訳を並べる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_INCOME = {
  id: -1, entryType: 'income', date: '2026-06-22', category: '売上高', item: 'オンライン注文',
  partner: '', amount: 10_000, paymentMethod: 'Stripe', memo: '', seasonTag: null,
  receipts: [], evidenceStatus: 'system_record', source: 'order', sourceId: 'order-1',
  paymentIntentId: 'pi_1', readOnly: true, grossAmount: 10_000, refundedAmount: 0,
};

const CHARGE_TRANSACTION = {
  id: 'txn_1', source_id: 'ch_1', payment_intent_id: 'pi_1', order_id: 'order-1',
  payout_id: null, type: 'charge', reporting_category: 'charge',
  amount: 10_000, fee: 360, net: 9_640, currency: 'jpy', status: 'available',
  available_on: '2026-06-25', stripe_created_at: '2026-06-22T01:00:00.000Z', fee_details: [],
};

const PAYOUT = {
  id: 'po_1', amount: 9_640, currency: 'jpy', status: 'paid', automatic: true,
  arrival_date: '2026-06-30', stripe_created_at: '2026-06-28T01:00:00.000Z',
  paid_at: '2026-06-28T01:00:00.000Z', reconciliation_status: 'matched',
  reconciled_net: 9_640, bank_arrival_date: null, bank_confirmed_at: null,
};

function costProfitPayload(confirmed: boolean) {
  return {
    data: {
      fiscalYear: 2026,
      seasonKey: '2026SS',
      businessType: 'soleProprietor',
      plan: { salesRevenue: 0, openingCash: 0, accountsReceivable: 0, fixedAssets: 0, accountsPayable: 0, openingCapital: 0 },
      expenses: [],
      incomes: [ORDER_INCOME],
      products: [],
      partners: [],
      templates: [],
      fixedAssets: [],
      closing: {
        closingInventoryGoods: 0, closingInventoryMaterials: 0,
        allowanceForDoubtful: 0, closingBalances: {}, closedAt: null,
      },
      previousClosingBalances: null,
      revisions: [],
      reviewAcks: [],
      cumulativeEntries: [],
      summaryOptions: [],
      stripeAccounting: {
        balanceTransactions: [CHARGE_TRANSACTION],
        refunds: [],
        payouts: [
          confirmed
            ? { ...PAYOUT, bank_arrival_date: '2026-07-01', bank_confirmed_at: '2026-07-01T00:00:00.000Z' }
            : PAYOUT,
        ],
        summary: {
          stripeBalance: 9_640,
          inTransitBalance: confirmed ? 0 : 9_640,
          unmatchedPayoutCount: 0,
        },
      },
    },
  };
}

async function mockStripeSettlement(page: Page): Promise<void> {
  let confirmed = false;

  await page.route('**/api/admin/kpi/cost-profit**', (route) => {
    if (route.request().method() !== 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(costProfitPayload(confirmed)),
    });
  });

  await page.route('**/api/admin/accounting/stripe-payouts/*/confirm', (route) => {
    confirmed = true;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          payoutId: 'po_1',
          bankArrivalDate: '2026-07-01',
          bankConfirmedAt: '2026-07-01T00:00:00.000Z',
          bankConfirmedBy: 'admin-1',
        },
      }),
    });
  });
}

async function openAccountingSummary(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ACCOUNTING' }).click();
  await expect(page.getByText('Stripe決済残高')).toBeVisible();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 stripe settlement (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
      await mockStripeSettlement(page);
    });

    test('Stripe決済残高と入金途上とPayoutを財務概要に表示する', async ({ page }) => {
      // FREQ-259-AC-01
      await openAccountingSummary(page);

      const settlement = page.getByLabel('Stripe精算');
      await expect(settlement.getByText('Stripe入金途上')).toBeVisible();
      await expect(settlement.getByText('po_1')).toBeVisible();
      await expect(settlement.getByText('¥9,640').first()).toBeVisible();
    });

    test('照合済みPayoutの銀行着金を確認できる', async ({ page }) => {
      // FREQ-259-AC-02
      await openAccountingSummary(page);

      await page.getByRole('button', { name: 'Payout po_1 の銀行着金を確認' }).click();
      await page.getByLabel('銀行着金日').fill('2026-07-01');
      await page.getByRole('button', { name: '着金を確定' }).click();

      await expect(page.getByRole('button', { name: 'Payout po_1 の銀行着金を確認' })).toBeDisabled();
      await expect(page.getByLabel('Stripe精算').getByText('2026-07-01')).toBeVisible();
    });

    test('Stripe仕訳を仕訳・元帳へ相手勘定つきで並べる', async ({ page }) => {
      // FREQ-259-AC-03
      await openAccountingSummary(page);
      await page.getByRole('tab', { name: '帳簿', exact: true }).click();
      await expect(page.getByRole('tab', { name: '仕訳・元帳', exact: true })).toBeVisible();

      await expect(page.getByText('クレジット売掛金').first()).toBeVisible();
      await expect(page.getByText('支払手数料').first()).toBeVisible();
    });
  });
}
