// 税務レポートの数値。すべて帳簿（仕訳）と固定資産台帳から導出する。
//
// 扱う範囲は個人事業主（青色申告・暦年 1/1〜12/31）の事業所得まで。
// 所得控除（基礎控除・社会保険料控除など）は帳簿の外にあるため扱わず、
// 「事業所得に対する概算税額」であることを画面側で明示する。

import type { Account } from "@/lib/finance/accounts";
import type { DepreciationSchedule } from "@/lib/finance/depreciation";
import type { JournalEntry } from "@/lib/finance/journal";
import type { ProfitAndLoss } from "@/lib/finance/statements";

/** 会計区分の正常側を正とする符号。決算書の金額はこの向きで載せる。 */
function naturalSign(account: Account): 1 | -1 {
  const naturalSide =
    account.type === "asset" || account.type === "expense" ? "debit" : "credit";
  return naturalSide === account.normalSide ? 1 : -1;
}

/** 仕訳行の、決算書に載せる向きの金額。 */
function statementAmountOfLine(
  account: Account,
  debit: number,
  credit: number,
): number {
  const net = account.normalSide === "debit" ? debit - credit : credit - debit;
  return naturalSign(account) * net;
}

/* ── 所得税の速算表 ──────────────────────────────────────────────── */

/** 所得税の速算表（国税庁 No.2260）。課税所得金額の上限・税率・控除額。 */
const INCOME_TAX_BRACKETS: ReadonlyArray<{
  upTo: number;
  rate: number;
  deduction: number;
}> = [
  { upTo: 1_950_000, rate: 0.05, deduction: 0 },
  { upTo: 3_300_000, rate: 0.1, deduction: 97_500 },
  { upTo: 6_950_000, rate: 0.2, deduction: 427_500 },
  { upTo: 9_000_000, rate: 0.23, deduction: 636_000 },
  { upTo: 18_000_000, rate: 0.33, deduction: 1_536_000 },
  { upTo: 40_000_000, rate: 0.4, deduction: 2_796_000 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.45, deduction: 4_796_000 },
];

/** 復興特別所得税の税率（基準所得税額の2.1%）。 */
export const RECONSTRUCTION_SURTAX_RATE = 0.021;

export type IncomeTaxEstimate = {
  /** 課税所得金額（1,000円未満切り捨て） */
  taxableIncome: number;
  rate: number;
  bracketDeduction: number;
  /** 基準所得税額 */
  incomeTax: number;
  /** 復興特別所得税 */
  reconstructionSurtax: number;
  /** 所得税＋復興特別所得税（100円未満切り捨て） */
  total: number;
  /** 実効税率（税額合計 ÷ 課税所得） */
  effectiveRate: number;
};

/**
 * 事業所得に対する概算の所得税額。
 * 所得控除は帳簿の外にあるため差し引かない（過大に出る方向の概算）。
 */
export function estimateIncomeTax(income: number): IncomeTaxEstimate {
  // 課税所得金額は1,000円未満を切り捨てる。
  const taxableIncome = Math.max(0, Math.floor(income / 1000) * 1000);
  const bracket =
    INCOME_TAX_BRACKETS.find((item) => taxableIncome <= item.upTo) ??
    INCOME_TAX_BRACKETS[INCOME_TAX_BRACKETS.length - 1];

  const incomeTax = Math.max(
    0,
    Math.floor(taxableIncome * bracket.rate - bracket.deduction),
  );
  const reconstructionSurtax = Math.floor(
    incomeTax * RECONSTRUCTION_SURTAX_RATE,
  );
  // 納付税額は100円未満切り捨て。
  const total = Math.floor((incomeTax + reconstructionSurtax) / 100) * 100;

  return {
    taxableIncome,
    rate: bracket.rate,
    bracketDeduction: bracket.deduction,
    incomeTax,
    reconstructionSurtax,
    total,
    effectiveRate: taxableIncome === 0 ? 0 : (total / taxableIncome) * 100,
  };
}

/** 住民税の所得割（標準税率）。都道府県民税4%＋市町村民税6%。 */
export const RESIDENT_TAX_RATE = 0.1;
/** 個人事業税の標準税率（第一種事業）。 */
export const BUSINESS_TAX_RATE = 0.05;
/** 個人事業税の事業主控除（年額）。 */
export const BUSINESS_TAX_ALLOWANCE = 2_900_000;

export type TaxTotals = {
  income: IncomeTaxEstimate;
  /** 住民税（所得割の概算） */
  residentTax: number;
  /** 個人事業税 */
  businessTax: number;
  /** 消費税（仮受−仮払の差額。税抜経理をしていなければ0） */
  consumptionTax: number;
  /** 税額合計 */
  total: number;
  /** 実効税率（税額合計 ÷ 課税所得） */
  effectiveRate: number;
};

/**
 * 事業所得にかかる税の概算合計。
 * 住民税・個人事業税は所得控除前の事業所得を基礎にした概算で、
 * 実際の税額は他の所得・所得控除によって変わる。
 */
export function estimateTaxTotals(input: {
  /** 青色申告特別控除後の事業所得 */
  income: number;
  /** 仮受消費税の残高 */
  consumptionTaxReceived: number;
  /** 仮払消費税の残高 */
  consumptionTaxPaid: number;
}): TaxTotals {
  const income = estimateIncomeTax(input.income);
  const residentTax = Math.max(
    0,
    Math.floor((income.taxableIncome * RESIDENT_TAX_RATE) / 100) * 100,
  );
  const businessTax = Math.max(
    0,
    Math.floor(
      ((income.taxableIncome - BUSINESS_TAX_ALLOWANCE) * BUSINESS_TAX_RATE)
        / 100,
    ) * 100,
  );
  const consumptionTax = Math.max(
    0,
    Math.floor(
      (input.consumptionTaxReceived - input.consumptionTaxPaid) / 100,
    ) * 100,
  );
  const total = income.total + residentTax + businessTax + consumptionTax;

  return {
    income,
    residentTax,
    businessTax,
    consumptionTax,
    total,
    effectiveRate:
      income.taxableIncome === 0 ? 0 : (total / income.taxableIncome) * 100,
  };
}

/* ── 月次の課税売上・必要経費・所得 ─────────────────────────────── */

export type TaxTrendRow = {
  /** 1〜12 */
  month: number;
  sales: number;
  expenses: number;
  income: number;
};

export type TaxTrend = {
  rows: TaxTrendRow[];
  salesTotal: number;
  expensesTotal: number;
  incomeTotal: number;
};

/**
 * 棚卸高の決算書区分。12/31 の決算整理でまとめて立つため、
 * 月次の推移に混ぜると12月だけが跳ねて年間の形が読めなくなる。
 */
const INVENTORY_SECTIONS = [
  "期首商品（製品）棚卸高",
  "期末商品（製品）棚卸高",
];

/**
 * 月別の収入・必要経費・所得。税務サマリーの推移グラフに使う。
 * 棚卸高の決算整理は月次に配賦できないので除く（年間合計は決算書側で見る）。
 */
export function buildTaxTrend(
  journal: readonly JournalEntry[],
  fiscalYear: number,
): TaxTrend {
  const rows: TaxTrendRow[] = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    sales: 0,
    expenses: 0,
    income: 0,
  }));

  for (const entry of journal) {
    if (!entry.date.startsWith(`${fiscalYear}-`)) continue;
    const row = rows[Number.parseInt(entry.date.slice(5, 7), 10) - 1];
    if (!row) continue;

    for (const line of entry.lines) {
      if (INVENTORY_SECTIONS.includes(line.account.section)) continue;
      const amount = statementAmountOfLine(
        line.account,
        line.debit,
        line.credit,
      );
      if (amount === 0) continue;
      if (line.account.type === "revenue") row.sales += amount;
      else if (line.account.type === "expense") row.expenses += amount;
    }
  }

  for (const row of rows) row.income = row.sales - row.expenses;

  return {
    rows,
    salesTotal: rows.reduce((sum, row) => sum + row.sales, 0),
    expensesTotal: rows.reduce((sum, row) => sum + row.expenses, 0),
    incomeTotal: rows.reduce((sum, row) => sum + row.income, 0),
  };
}

/** 月次の値を期首からの累計に直す。推移グラフの「累計」表示に使う。 */
export function accumulateTrend(values: readonly number[]): number[] {
  let running = 0;
  return values.map((value) => {
    running += value;
    return running;
  });
}

/* ── 税務調整 ────────────────────────────────────────────────────── */

/** 調整の向き。加算＝会計利益に足す、減算＝差し引く。 */
export type TaxAdjustmentDirection = "add" | "subtract";

export type TaxAdjustmentRow = {
  key: string;
  /** 税務調整項目 */
  label: string;
  /** 根拠勘定科目 */
  account: string;
  /** ナビゲーターの分類 */
  group: string;
  direction: TaxAdjustmentDirection;
  /** 会計金額（A） */
  bookAmount: number;
  /** 加算（B） */
  addition: number;
  /** 減算（C） */
  subtraction: number;
  /** 税務金額（D = A + B − C） */
  taxAmount: number;
  /** 根拠となった仕訳の件数 */
  entryCount: number;
  /** 根拠の説明。証憑インスペクターに出す。 */
  basis: string;
};

export type TaxAdjustmentGroup = {
  direction: TaxAdjustmentDirection;
  label: string;
  count: number;
};

export type TaxAdjustmentSummary = {
  rows: TaxAdjustmentRow[];
  /** 会計上の利益（青色申告特別控除前の所得金額） */
  bookProfit: number;
  additionTotal: number;
  subtractionTotal: number;
  /** 課税所得 = 会計上の利益 ＋ 加算 − 減算 */
  taxableIncome: number;
  groups: TaxAdjustmentGroup[];
  addCount: number;
  subtractCount: number;
};

/** 勘定科目コードの当期発生額と、その根拠になった仕訳件数。 */
function amountOfAccounts(
  journal: readonly JournalEntry[],
  codes: readonly string[],
): { amount: number; entryCount: number } {
  let amount = 0;
  let entryCount = 0;

  for (const entry of journal) {
    let hit = false;
    for (const line of entry.lines) {
      if (!codes.includes(line.account.code)) continue;
      const value = statementAmountOfLine(
        line.account,
        line.debit,
        line.credit,
      );
      if (value === 0) continue;
      amount += value;
      hit = true;
    }
    if (hit) entryCount += 1;
  }

  return { amount, entryCount };
}

/** 寄附金。個人事業では必要経費にならず、寄附金控除（所得控除）へ回る。 */
const DONATION_CODES = ["6320"];
/** 接待交際費。金額の大きさから按分・私費混入の確認対象になりやすい。 */
const ENTERTAINMENT_CODES = ["6080"];

/**
 * 会計上の利益から課税所得までの調整。
 * 帳簿から機械的に導けるものだけを載せる（見積りや按分率の入力は行わない）。
 */
export function buildTaxAdjustments(input: {
  journal: readonly JournalEntry[];
  profitAndLoss: ProfitAndLoss;
  depreciation: DepreciationSchedule;
  /** 青色申告特別控除額 */
  blueReturnDeduction: number;
}): TaxAdjustmentSummary {
  const { journal, profitAndLoss, depreciation, blueReturnDeduction } = input;
  const rows: TaxAdjustmentRow[] = [];

  // 減価償却費のうち事業専用割合で家事分になった額。必要経費にならないので加算。
  const privatePortion = depreciation.rows.reduce(
    (sum, row) => sum + row.privatePortion,
    0,
  );
  if (privatePortion > 0) {
    rows.push({
      key: "depreciationPrivate",
      label: "減価償却費の家事分",
      account: "減価償却費",
      group: "減価償却関連",
      direction: "add",
      bookAmount: depreciation.depreciationTotal,
      addition: privatePortion,
      subtraction: 0,
      taxAmount: depreciation.depreciationTotal - privatePortion,
      entryCount: depreciation.rows.filter((row) => row.privatePortion > 0)
        .length,
      basis: "固定資産台帳の事業専用割合から算出",
    });
  }

  // 寄附金。必要経費ではなく寄附金控除の対象なので加算して所得へ戻す。
  const donation = amountOfAccounts(journal, DONATION_CODES);
  if (donation.amount > 0) {
    rows.push({
      key: "donation",
      label: "寄附金の必要経費不算入",
      account: "寄附金",
      group: "寄附金関連",
      direction: "add",
      bookAmount: donation.amount,
      addition: donation.amount,
      subtraction: 0,
      taxAmount: 0,
      entryCount: donation.entryCount,
      basis: "寄附金（6320）の当期発生額",
    });
  }

  // 接待交際費は個人事業では原則全額が必要経費。調整は入れず確認対象として並べる。
  const entertainment = amountOfAccounts(journal, ENTERTAINMENT_CODES);
  if (entertainment.amount > 0) {
    rows.push({
      key: "entertainment",
      label: "交際費（要確認）",
      account: "接待交際費",
      group: "交際費関連",
      direction: "add",
      bookAmount: entertainment.amount,
      addition: 0,
      subtraction: 0,
      taxAmount: entertainment.amount,
      entryCount: entertainment.entryCount,
      basis: "個人事業は原則全額必要経費。私費混入の有無だけ確認する",
    });
  }

  // 青色申告特別控除は所得から差し引く。
  if (blueReturnDeduction > 0) {
    rows.push({
      key: "blueReturn",
      label: "青色申告特別控除",
      account: "—",
      group: "青色申告特別控除",
      direction: "subtract",
      bookAmount: 0,
      addition: 0,
      subtraction: blueReturnDeduction,
      taxAmount: -blueReturnDeduction,
      entryCount: 0,
      basis: "複式簿記・貸借対照表の添付・期限内申告を前提とした控除額",
    });
  }

  const additionTotal = rows.reduce((sum, row) => sum + row.addition, 0);
  const subtractionTotal = rows.reduce((sum, row) => sum + row.subtraction, 0);
  const bookProfit = profitAndLoss.netIncome;

  const groupMap = new Map<string, TaxAdjustmentGroup>();
  for (const row of rows) {
    const existing = groupMap.get(row.group);
    if (existing) existing.count += 1;
    else
      groupMap.set(row.group, {
        direction: row.direction,
        label: row.group,
        count: 1,
      });
  }

  return {
    rows,
    bookProfit,
    additionTotal,
    subtractionTotal,
    taxableIncome: bookProfit + additionTotal - subtractionTotal,
    groups: [...groupMap.values()],
    addCount: rows.filter((row) => row.direction === "add").length,
    subtractCount: rows.filter((row) => row.direction === "subtract").length,
  };
}

/* ── 申告期限・納付予定 ──────────────────────────────────────────── */

export type TaxDeadlineKind =
  | "incomeTax"
  | "consumptionTax"
  | "withholding"
  | "depreciableAsset"
  | "businessTax";

export const TAX_DEADLINE_KIND_LABELS: Record<TaxDeadlineKind, string> = {
  incomeTax: "所得税",
  consumptionTax: "消費税",
  withholding: "源泉所得税",
  depreciableAsset: "償却資産申告",
  businessTax: "個人事業税",
};

/** 税目ごとの色。スケジュール帯・期限一覧の点で共有する。 */
export const TAX_DEADLINE_KIND_COLORS: Record<TaxDeadlineKind, string> = {
  incomeTax: "#2f6fdb",
  consumptionTax: "#16844b",
  withholding: "#d98324",
  depreciableAsset: "#7c5cd6",
  businessTax: "#0f9aa8",
};

export type TaxUrgency = "high" | "medium" | "low";

export type TaxDeadline = {
  key: string;
  kind: TaxDeadlineKind;
  /** 手続き名（確定申告・納付など） */
  label: string;
  dueOn: string;
  /** 今日からの残り日数。過ぎていれば負。 */
  daysLeft: number;
  urgency: TaxUrgency;
  /** 期限が過ぎているか */
  overdue: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

function urgencyOf(daysLeft: number): TaxUrgency {
  if (daysLeft <= 14) return "high";
  if (daysLeft <= 45) return "medium";
  return "low";
}

/**
 * 会計期間（暦年）に紐づく申告・納付の期限。
 * 個人事業主の法定期限をそのまま並べる（土日祝の繰り下げは行わない）。
 */
export function buildTaxDeadlines(
  fiscalYear: number,
  today: string,
): TaxDeadline[] {
  const next = fiscalYear + 1;
  const defs: Array<Omit<TaxDeadline, "daysLeft" | "urgency" | "overdue">> = [
    {
      key: "withholding-h1",
      kind: "withholding",
      label: "源泉所得税 納付（納期の特例・1〜6月分）",
      dueOn: `${fiscalYear}-07-10`,
    },
    {
      key: "incomeTax-prepay1",
      kind: "incomeTax",
      label: "所得税 予定納税 第1期",
      dueOn: `${fiscalYear}-07-31`,
    },
    {
      key: "businessTax-1",
      kind: "businessTax",
      label: "個人事業税 第1期 納付",
      dueOn: `${fiscalYear}-08-31`,
    },
    {
      key: "incomeTax-prepay2",
      kind: "incomeTax",
      label: "所得税 予定納税 第2期",
      dueOn: `${fiscalYear}-11-30`,
    },
    {
      key: "businessTax-2",
      kind: "businessTax",
      label: "個人事業税 第2期 納付",
      dueOn: `${fiscalYear}-11-30`,
    },
    {
      key: "withholding-h2",
      kind: "withholding",
      label: "源泉所得税 納付（納期の特例・7〜12月分）",
      dueOn: `${next}-01-20`,
    },
    {
      key: "depreciableAsset",
      kind: "depreciableAsset",
      label: "償却資産申告（1/1時点の所有分）",
      dueOn: `${next}-01-31`,
    },
    {
      key: "incomeTax-return",
      kind: "incomeTax",
      label: "確定申告期限（所得税・復興特別所得税）",
      dueOn: `${next}-03-15`,
    },
    {
      key: "incomeTax-pay",
      kind: "incomeTax",
      label: "納付期限（所得税・復興特別所得税）",
      dueOn: `${next}-03-15`,
    },
    {
      key: "consumptionTax-return",
      kind: "consumptionTax",
      label: "確定申告期限（消費税・地方消費税）",
      dueOn: `${next}-03-31`,
    },
    {
      key: "consumptionTax-pay",
      kind: "consumptionTax",
      label: "納付期限（消費税・地方消費税）",
      dueOn: `${next}-03-31`,
    },
  ];

  return defs
    .map((def) => {
      const daysLeft = daysBetween(today, def.dueOn);
      return {
        ...def,
        daysLeft,
        urgency: urgencyOf(daysLeft),
        overdue: daysLeft < 0,
      };
    })
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/** スケジュール帯の1本。横軸は会計期間の1月〜翌3月（15か月）。 */
export type TaxScheduleBand = {
  key: string;
  kind: TaxDeadlineKind;
  label: string;
  /** 0＝1月、11＝12月、12〜14＝翌1〜3月 */
  fromIndex: number;
  /** 帯の長さ（月数） */
  span: number;
};

/** スケジュール帯の横軸ラベル（1月〜翌3月）。 */
export const TAX_SCHEDULE_MONTHS: readonly string[] = [
  ...Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
  "翌1月",
  "翌2月",
  "翌3月",
];

/** 会計期間の月インデックス（1月＝0、翌3月＝14）。範囲外は null。 */
export function scheduleIndexOf(date: string, fiscalYear: number): number | null {
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  if (year === fiscalYear) return month - 1;
  if (year === fiscalYear + 1 && month <= 3) return 11 + month;
  return null;
}

/** 税目ごとの実施期間。期限（点）ではなく、作業が走る帯を示す。 */
export function buildTaxScheduleBands(fiscalYear: number): TaxScheduleBand[] {
  const bands: TaxScheduleBand[] = [
    {
      key: "consumption-1",
      kind: "consumptionTax",
      label: "1期（1〜3月）",
      fromIndex: 0,
      span: 3,
    },
    {
      key: "consumption-2",
      kind: "consumptionTax",
      label: "2期（4〜6月）",
      fromIndex: 3,
      span: 3,
    },
    {
      key: "consumption-3",
      kind: "consumptionTax",
      label: "3期（7〜9月）",
      fromIndex: 6,
      span: 3,
    },
    {
      key: "consumption-4",
      kind: "consumptionTax",
      label: "4期（10〜12月）",
      fromIndex: 9,
      span: 3,
    },
    {
      key: "consumption-return",
      kind: "consumptionTax",
      label: "確定申告",
      fromIndex: 13,
      span: 2,
    },
    {
      key: "income-prepay",
      kind: "incomeTax",
      label: "予定納税（第1期・第2期）",
      fromIndex: 6,
      span: 5,
    },
    {
      key: "income-return",
      kind: "incomeTax",
      label: "確定申告・納付",
      fromIndex: 13,
      span: 2,
    },
    {
      key: "withholding",
      kind: "withholding",
      label: "納期の特例（年2回）",
      fromIndex: 6,
      span: 7,
    },
    {
      key: "depreciable",
      kind: "depreciableAsset",
      label: "償却資産申告",
      fromIndex: 12,
      span: 1,
    },
    {
      key: "business-tax",
      kind: "businessTax",
      label: "第1期・第2期 納付",
      fromIndex: 7,
      span: 4,
    },
  ];
  // 会計期間が決まっていないときは帯を出さない。
  return fiscalYear > 0 ? bands : [];
}

/* ── 申告準備チェック ────────────────────────────────────────────── */

export type ChecklistStatus = "done" | "todo" | "notStarted";

export const CHECKLIST_STATUS_LABELS: Record<ChecklistStatus, string> = {
  done: "完了",
  todo: "要対応",
  notStarted: "未着手",
};

export type ChecklistItem = {
  key: string;
  /** チェックリストの分類（帳簿締め・証憑・控除・申告書） */
  group: string;
  label: string;
  description: string;
  status: ChecklistStatus;
};

export type FilingChecklist = {
  items: ChecklistItem[];
  doneCount: number;
  todoCount: number;
  notStartedCount: number;
  /** 準備完了率（%） */
  progress: number;
};

/** 申告準備の進み具合。すべて帳簿・台帳の実データから状態を決める。 */
export function buildFilingChecklist(input: {
  closedAt: string | null;
  /** 証憑が付いていない取引の件数 */
  missingReceiptCount: number;
  /** 固定資産の登録件数 */
  fixedAssetCount: number;
  /** 事業専用割合が100%未満の資産の件数（家事按分の確認対象） */
  privateUseAssetCount: number;
  usesEtax: boolean;
  /** 貸借が一致しているか */
  isBalanced: boolean;
  /** 期末棚卸が入力済みか */
  hasClosingInventory: boolean;
}): FilingChecklist {
  const items: ChecklistItem[] = [
    {
      key: "closing",
      group: "帳簿締め",
      label: "期末までの帳簿が締められていますか",
      description: "決算整理と年度締めの完了",
      status: input.closedAt ? "done" : "todo",
    },
    {
      key: "balanced",
      group: "帳簿締め",
      label: "貸借が一致していますか",
      description: "資産 = 負債 + 純資産 + 当期純利益",
      status: input.isBalanced ? "done" : "todo",
    },
    {
      key: "inventory",
      group: "帳簿締め",
      label: "棚卸資産の残高を確認しましたか",
      description: "期末商品（製品）棚卸高の計上",
      status: input.hasClosingInventory ? "done" : "notStarted",
    },
    {
      key: "receipts",
      group: "証憑",
      label: "必要な証憑が整理・保管されていますか",
      description:
        input.missingReceiptCount > 0
          ? `証憑未添付 ${input.missingReceiptCount} 件`
          : "すべての取引に証憑が添付されています",
      status: input.missingReceiptCount > 0 ? "todo" : "done",
    },
    {
      key: "depreciation",
      group: "控除",
      label: "減価償却費の計上が正しく行われていますか",
      description:
        input.fixedAssetCount > 0
          ? `固定資産 ${input.fixedAssetCount} 件から自動計算`
          : "固定資産の登録がありません",
      status: input.fixedAssetCount > 0 ? "done" : "notStarted",
    },
    {
      key: "privateUse",
      group: "控除",
      label: "事業・家事の按分が適切に行われていますか",
      description:
        input.privateUseAssetCount > 0
          ? `事業専用割合100%未満の資産 ${input.privateUseAssetCount} 件`
          : "按分が必要な資産はありません",
      status: input.privateUseAssetCount > 0 ? "todo" : "done",
    },
    {
      key: "etax",
      group: "申告書",
      label: "利用者識別番号の取得・動作確認",
      description: "e-Tax申告で青色申告特別控除65万円の要件を満たす",
      status: input.usesEtax ? "done" : "todo",
    },
    {
      key: "preview",
      group: "申告書",
      label: "決算書・申告書のプレビュー確認",
      description: "青色申告決算書の4ページを通しで確認する",
      status: input.closedAt ? "todo" : "notStarted",
    },
  ];

  const count = (status: ChecklistStatus) =>
    items.filter((item) => item.status === status).length;
  const doneCount = count("done");

  return {
    items,
    doneCount,
    todoCount: count("todo"),
    notStartedCount: count("notStarted"),
    progress: items.length === 0 ? 0 : (doneCount / items.length) * 100,
  };
}

/* ── 申告資料 ────────────────────────────────────────────────────── */

export type FilingDocumentStatus = "created" | "drafting" | "notCreated";

export const FILING_DOCUMENT_STATUS_LABELS: Record<
  FilingDocumentStatus,
  string
> = {
  created: "作成済み",
  drafting: "作成中",
  notCreated: "未作成",
};

/** 資料の作られ方。自動生成＝決算書エンジン、自動収集＝証憑、手入力＝利用者。 */
export type FilingDocumentSource = "auto" | "collected" | "manual";

export const FILING_DOCUMENT_SOURCE_LABELS: Record<
  FilingDocumentSource,
  string
> = {
  auto: "自動生成",
  collected: "自動収集",
  manual: "手入力",
};

export type FilingDocument = {
  key: string;
  /** 資料の分類（申告書・決算資料・売上仕入証憑・経費証憑・固定資産・控除証明） */
  category: string;
  name: string;
  /** 対象期間 */
  period: string;
  /** 関連する仕訳・証憑の件数 */
  entryCount: number;
  fileName: string;
  fileKind: "pdf" | "xlsx";
  source: FilingDocumentSource;
  status: FilingDocumentStatus;
  /** 証憑が不足している件数。0 なら OK。 */
  missingCount: number;
};

export type FilingDocumentInventory = {
  documents: FilingDocument[];
  requiredCount: number;
  readyCount: number;
  missingReceiptCount: number;
  reviewCount: number;
  /** 準備完了率（%） */
  progress: number;
};

/**
 * 申告に必要な資料の棚卸し。
 * この画面から出力できる資料だけを並べ、状態は帳簿の実データから決める。
 */
export function buildFilingDocuments(input: {
  fiscalYear: number;
  journalCount: number;
  /** 証憑が添付された取引の件数 */
  receiptCount: number;
  /** 証憑が付いていない取引の件数 */
  missingReceiptCount: number;
  expenseCount: number;
  incomeCount: number;
  fixedAssetCount: number;
  closedAt: string | null;
  isBalanced: boolean;
}): FilingDocumentInventory {
  const {
    fiscalYear,
    journalCount,
    receiptCount,
    missingReceiptCount,
    expenseCount,
    incomeCount,
    fixedAssetCount,
    closedAt,
    isBalanced,
  } = input;
  const fullYear = `${fiscalYear}/01/01 〜 ${fiscalYear}/12/31`;
  const yearEnd = `${fiscalYear}/12/31`;
  // 帳簿が締まっていれば作成済み、仕訳があれば作成中、なければ未作成。
  const statementStatus: FilingDocumentStatus = closedAt
    ? "created"
    : journalCount > 0
      ? "drafting"
      : "notCreated";

  const documents: FilingDocument[] = [
    {
      key: "blue-return",
      category: "申告書",
      name: "青色申告決算書（一般用）",
      period: fullYear,
      entryCount: journalCount,
      fileName: `決算書_${fiscalYear}.pdf`,
      fileKind: "pdf",
      source: "auto",
      status: statementStatus,
      missingCount: missingReceiptCount,
    },
    {
      key: "balance-sheet",
      category: "決算資料",
      name: "貸借対照表",
      period: yearEnd,
      entryCount: journalCount,
      fileName: `貸借対照表_${fiscalYear}.pdf`,
      fileKind: "pdf",
      source: "auto",
      status: isBalanced ? statementStatus : "drafting",
      missingCount: 0,
    },
    {
      key: "profit-and-loss",
      category: "決算資料",
      name: "損益計算書",
      period: fullYear,
      entryCount: journalCount,
      fileName: `損益計算書_${fiscalYear}.pdf`,
      fileKind: "pdf",
      source: "auto",
      status: statementStatus,
      missingCount: 0,
    },
    {
      key: "general-ledger",
      category: "決算資料",
      name: "総勘定元帳",
      period: fullYear,
      entryCount: journalCount,
      fileName: `総勘定元帳_${fiscalYear}.xlsx`,
      fileKind: "xlsx",
      source: "auto",
      status: journalCount > 0 ? "created" : "notCreated",
      missingCount: 0,
    },
    {
      key: "sales-receipts",
      category: "売上・仕入証憑",
      name: "領収書・請求書一覧",
      period: fullYear,
      entryCount: incomeCount,
      fileName: `領収書一覧_${fiscalYear}.xlsx`,
      fileKind: "xlsx",
      source: "collected",
      status: incomeCount > 0 ? "created" : "notCreated",
      missingCount: 0,
    },
    {
      key: "expense-receipts",
      category: "経費証憑",
      name: "経費証憑一覧",
      period: fullYear,
      entryCount: expenseCount,
      fileName: `経費証憑一覧_${fiscalYear}.xlsx`,
      fileKind: "xlsx",
      source: "collected",
      status: receiptCount > 0 ? "created" : "notCreated",
      missingCount: missingReceiptCount,
    },
    {
      key: "fixed-assets",
      category: "固定資産",
      name: "固定資産台帳",
      period: yearEnd,
      entryCount: fixedAssetCount,
      fileName: `固定資産台帳_${fiscalYear}.xlsx`,
      fileKind: "xlsx",
      source: "auto",
      status: fixedAssetCount > 0 ? "created" : "notCreated",
      missingCount: 0,
    },
    {
      key: "deduction-certificates",
      category: "控除証明",
      name: "控除証明書",
      period: fullYear,
      entryCount: 0,
      fileName: `控除証明書_${fiscalYear}.pdf`,
      fileKind: "pdf",
      source: "manual",
      status: "notCreated",
      missingCount: 0,
    },
  ];

  const readyCount = documents.filter(
    (document) => document.status === "created" && document.missingCount === 0,
  ).length;

  return {
    documents,
    requiredCount: documents.length,
    readyCount,
    missingReceiptCount: documents.filter((document) => document.missingCount > 0)
      .length,
    reviewCount: documents.filter((document) => document.status === "drafting")
      .length,
    progress:
      documents.length === 0 ? 0 : (readyCount / documents.length) * 100,
  };
}

/* ── 青色申告決算書のページ完成度 ────────────────────────────────── */

export type PageCompletion = {
  /** 入力済みの必須項目数 */
  filled: number;
  /** 要確認の項目数 */
  review: number;
  /** 未入力の項目数 */
  empty: number;
  /** 完成度（%） */
  progress: number;
};

/** 必須項目の入力状況から完成度を出す。金額が入っていれば入力済み。 */
export function pageCompletionOf(
  values: ReadonlyArray<{ value: number; required?: boolean; review?: boolean }>,
): PageCompletion {
  let filled = 0;
  let review = 0;
  let empty = 0;

  for (const item of values) {
    if (item.review) review += 1;
    else if (item.value !== 0) filled += 1;
    else if (item.required === false) filled += 1;
    else empty += 1;
  }

  const total = filled + review + empty;
  return {
    filled,
    review,
    empty,
    progress: total === 0 ? 0 : (filled / total) * 100,
  };
}
