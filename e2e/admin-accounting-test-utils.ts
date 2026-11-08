import { expect, Page } from '@playwright/test';
import { mockAdminBackgroundApis } from './admin-test-utils';
import { accountByCode } from '@/lib/finance/accounts';
import { buildJournal, type FinanceEntry } from '@/lib/finance/journal';

/**
 * ACCOUNTING（会計）画面の E2E 用モックとナビゲーション。
 *
 * Playwright は spec ファイル同士の import を禁じており、spec から spec を読むと
 * 「should not import test file」でスイート全体の収集が失敗する。共有するヘルパーは
 * spec ではなくこのユーティリティに置くこと。
 *
 * フィクスチャは mockAdminApis の応答を組み立てるためだけのものなので公開しない。
 */

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
  await mockAdminBackgroundApis(page);
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
        data: buildCostProfitMock({
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
        }),
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

// ---------------------------------------------------------------------------------------------
// cost-profit GET の作り物（FREQ-557。期間で数える形）
//
// 画面の仕訳・元帳・試算表・財務3表は GET の `savedJournal`（保存した仕訳）と `opening`（期首）から作る。
// 手入力の取引は DB のトリガー（S4）、注文の支払い・出荷と Stripe の手数料・入金は計上係が保存した仕訳にするので、
// 作り物にも取引・注文・Stripe の記録ごとに同じ形の行を足す（画面は仕訳を合成しない。FREQ-570）。
// 以前の spec は expenses / incomes / plan / previousClosingBalances だけを渡していたので、
// それを渡すと期間・保存した仕訳・期首・知らせを足した応答の欄を返す。
// ---------------------------------------------------------------------------------------------

export type MockAccountingPeriod = {
  id: string;
  businessType: 'soleProprietor' | 'corporation';
  name: string;
  startsOn: string;
  endsOn: string;
  corporateTaxExtensionMonths: 0 | 1;
  consumptionTaxExtensionMonths: 0 | 1;
  consumptionTaxStatus: 'exempt' | 'taxable';
  consumptionTaxableFrom: string | null;
  version: string;
};

/** 個人の暦年の期間（1/1〜12/31）。法人は同じ日付の事業年度として作る（名前だけ違う）。 */
export function mockAccountingPeriod(
  year: number,
  businessType: 'soleProprietor' | 'corporation' = 'soleProprietor',
  overrides: Partial<MockAccountingPeriod> = {},
): MockAccountingPeriod {
  return {
    id: `00000000-0000-4000-8000-${businessType === 'corporation' ? 'c' : '0'}${String(year).padStart(11, '0')}`,
    businessType,
    name: businessType === 'soleProprietor' ? `${year}年（個人）` : `第${year - 2025}期`,
    startsOn: `${year}-01-01`,
    endsOn: `${year}-12-31`,
    corporateTaxExtensionMonths: 0,
    consumptionTaxExtensionMonths: 0,
    consumptionTaxStatus: 'exempt',
    consumptionTaxableFrom: null,
    version: '1',
    ...overrides,
  };
}

type MockEntry = Record<string, unknown> & {
  id: number;
  entryType?: string;
  date: string;
  category: string;
  item: string;
  partner?: string;
  amount: number;
  paymentMethod: string;
};

type MockStripeAccounting = {
  balanceTransactions?: Array<Record<string, unknown>>;
  payouts?: Array<Record<string, unknown>>;
};

type MockDraftLine = { accountCode: string; debit: number; credit: number; memo: string | null };

type MockDraft = {
  date: string;
  /** 同じ日の並び（手入力と注文は取引の番号、Stripe の物はそのあと）。 */
  order: number;
  eventKind: string;
  dedupeKey: string;
  description: string;
  counterparty: string | null;
  sourceTable: string;
  sourceId: string;
  lines: MockDraftLine[];
};

const jstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const pair = (debitCode: string, creditCode: string, amount: number): MockDraftLine[] => [
  { accountCode: debitCode, debit: amount, credit: 0, memo: null },
  { accountCode: creditCode, debit: 0, credit: amount, memo: null },
];

/**
 * 保存した仕訳の作り物。画面は仕訳を合成せず、保存した仕訳（計上係と S4 のトリガーが作る物）だけで数える（FREQ-570）。
 * - 手入力の取引 → S4 のトリガーが作る仕訳（日付昇順・同日は id 昇順で通し番号 1 から）。
 * - 注文の収入（source が order）→ 支払い（Stripe未収金 1160／前受金 2150）と出荷（前受金 2150／売上高 4010）の2本。
 * - Stripe の原始記録 → 手数料（支払手数料 6280／1160）、照合済みの入金（Stripe入金途上 1150／1160）、銀行着金（普通預金 1040／1150）。
 */
function mockSavedJournal(entries: readonly MockEntry[], period: MockAccountingPeriod, stripe?: MockStripeAccounting) {
  const drafts: MockDraft[] = [];
  for (const entry of entries) {
    if (entry.source === 'order') {
      const key = String(entry.sourceId ?? entry.id);
      drafts.push(
        {
          date: entry.date, order: entry.id, eventKind: 'payment_confirmed', dedupeKey: `payment_confirmed:${key}`,
          description: '支払いの受け取り（前受金）', counterparty: null, sourceTable: 'stripe_balance_transactions', sourceId: key,
          lines: pair('1160', '2150', entry.amount),
        },
        {
          date: entry.date, order: entry.id, eventKind: 'shipment_confirmed', dedupeKey: `shipment_confirmed:${key}`,
          description: entry.item, counterparty: null, sourceTable: 'shipment_slips', sourceId: key,
          lines: pair('2150', '4010', entry.amount),
        },
      );
      continue;
    }
    const [journal] = buildJournal([{ ...entry, entryType: entry.entryType ?? 'expense' } as unknown as FinanceEntry], period.businessType);
    drafts.push({
      date: entry.date, order: entry.id, eventKind: 'manual_entry', dedupeKey: `manual_entry:${entry.id}:0`,
      description: entry.item, counterparty: entry.partner || null, sourceTable: 'admin_finance_expenses', sourceId: String(entry.id),
      // S4 は未登録の科目（9999）の行に元の文を memo で残す。
      lines: journal.lines.map((line) => ({
        accountCode: line.account.code, debit: line.debit, credit: line.credit,
        memo: line.account.code === '9999' ? line.account.name : null,
      })),
    });
  }
  let stripeOrder = 1_000_000;
  for (const transaction of stripe?.balanceTransactions ?? []) {
    const fee = Number(transaction.fee ?? 0);
    if (fee === 0) continue;
    drafts.push({
      date: jstDate(String(transaction.stripe_created_at)), order: stripeOrder++, eventKind: 'stripe_fee',
      dedupeKey: `stripe_fee:${transaction.id}`, description: '決済の手数料', counterparty: 'ストライプジャパン株式会社',
      sourceTable: 'stripe_balance_transactions', sourceId: String(transaction.id),
      lines: fee > 0 ? pair('6280', '1160', fee) : pair('1160', '6280', -fee),
    });
  }
  for (const payout of stripe?.payouts ?? []) {
    if (payout.reconciliation_status !== 'matched' || !payout.paid_at) continue;
    const amount = Number(payout.amount);
    drafts.push({
      date: jstDate(String(payout.paid_at)), order: stripeOrder++, eventKind: 'payout_started',
      dedupeKey: `payout_started:${payout.id}`, description: '銀行への入金の開始', counterparty: null,
      sourceTable: 'stripe_payouts', sourceId: String(payout.id), lines: pair('1150', '1160', amount),
    });
    if (payout.bank_arrival_date && payout.bank_confirmed_at) {
      drafts.push({
        date: String(payout.bank_arrival_date), order: stripeOrder++, eventKind: 'bank_arrived',
        dedupeKey: `bank_arrived:${payout.id}`, description: '銀行への着金', counterparty: null,
        sourceTable: 'stripe_payouts', sourceId: String(payout.id), lines: pair('1040', '1150', amount),
      });
    }
  }
  return drafts
    .filter((draft) => draft.date >= period.startsOn && draft.date <= period.endsOn)
    .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
    .map((draft, index) => ({
      id: `00000000-0000-4000-8000-${String(900_000 + index).padStart(12, '0')}`,
      periodId: period.id,
      entryNo: index + 1,
      entryDate: draft.date,
      eventKind: draft.eventKind,
      dedupeKey: draft.dedupeKey,
      description: draft.description,
      recordedAt: `${draft.date}T01:00:00Z`,
      recordedBy: null,
      isLate: false,
      reversesEntryId: null,
      reason: null,
      sourceTable: draft.sourceTable,
      sourceId: draft.sourceId,
      migratedFrom: null,
      migratedAt: null,
      sourceRecordedAt: null,
      lines: draft.lines.map((line, lineIndex) => ({
        lineNo: lineIndex + 1,
        accountCode: line.accountCode,
        debit: line.debit,
        credit: line.credit,
        subAccount: null,
        counterparty: draft.counterparty,
        orderId: null,
        memo: line.memo,
      })),
    }));
}

/** 期首（借方−貸方）。前年度末の残高（previousClosingBalances。各科目の正常残高の向き）があればそれを、無ければ財務前提の期首の欄を使う。 */
function mockOpening(data: Record<string, unknown>) {
  const previous = data.previousClosingBalances as Record<string, number> | null | undefined;
  const plan = (data.plan ?? {}) as Record<string, number>;
  const pairs: Array<[string, number]> = previous
    ? Object.entries(previous)
    : [
        ['1010', plan.openingCash ?? 0],
        ['1120', plan.accountsReceivable ?? 0],
        ['1535', plan.fixedAssets ?? 0],
        ['2020', plan.accountsPayable ?? 0],
        ['2910', plan.openingCapital ?? 0],
      ];
  return pairs
    .filter(([, amount]) => amount !== 0)
    .map(([accountCode, amount]) => ({
      accountCode,
      signedAmount: accountByCode(accountCode)?.normalSide === 'credit' ? -amount : amount,
      basis: 'carryover' as const,
    }));
}

/**
 * cost-profit GET の `data` を作る。`data` には従来どおり expenses / incomes / plan / previousClosingBalances などを渡す。
 * 足す欄: `period`・`periods`・`savedJournal`・`opening`・`periodNotices`。`businessType` は期間の事業の形に合わせる。
 * `options.period` を渡すとその期間（既定は 2026 年の個人の暦年）、`options.periods` で選択肢の一覧を差し替える。
 * `data` が既に持つ `savedJournal`・`opening`・`periodNotices` は上書きしない。
 */
export function buildCostProfitMock<T extends Record<string, unknown>>(
  data: T,
  options: {
    period?: MockAccountingPeriod;
    periods?: MockAccountingPeriod[];
    periodNotices?: { filingDeadlinePassed: boolean; previousPeriodOpen: boolean };
  } = {},
) {
  const businessType = (data.businessType as 'soleProprietor' | 'corporation' | undefined) ?? 'soleProprietor';
  const period = options.period ?? mockAccountingPeriod(Number(data.fiscalYear ?? 2026), businessType);
  const entries = [
    ...((data.expenses as MockEntry[] | undefined) ?? []),
    ...((data.incomes as MockEntry[] | undefined) ?? []),
  ];
  return {
    ...data,
    businessType: period.businessType,
    period,
    periods: options.periods ?? [period],
    savedJournal: data.savedJournal ?? mockSavedJournal(entries, period, data.stripeAccounting as MockStripeAccounting | undefined),
    opening: data.opening ?? mockOpening(data),
    periodNotices: data.periodNotices ?? options.periodNotices ?? { filingDeadlinePassed: false, previousPeriodOpen: false },
  };
}
