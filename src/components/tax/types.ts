// 税務レポートの5タブが受け取るデータ。
// 集計はすべて呼び出し元（CostProfitSection）で済ませ、ここでは描画だけを行う。

import type {
  BalanceSheetSideRow,
  BlueReturnDeduction,
  MonthlySummary,
  PartnerBreakdownRow,
} from "@/lib/finance/blue-return";
import type {
  DepreciationSchedule,
  FixedAsset,
} from "@/lib/finance/depreciation";
import type { JournalEntry } from "@/lib/finance/journal";
import type {
  BalanceSheet,
  ProfitAndLoss,
  StatementLine,
} from "@/lib/finance/statements";

/** 青色申告決算書（一般用）のページ。 */
export type TaxPage = "page1" | "page2" | "page3" | "page4";

/** 4ページ 貸借対照表の期首・期末比較。 */
export type BalanceSheetComparison = {
  assets: BalanceSheetSideRow[];
  liabilitiesAndEquity: BalanceSheetSideRow[];
  openingAssetTotal: number;
  closingAssetTotal: number;
  openingLiabilityEquityTotal: number;
  closingLiabilityEquityTotal: number;
};

/** 1ページ 損益計算書の1行。 */
export type Page1Row = {
  label: string;
  value: number;
  indent?: boolean;
  emphasis?: boolean;
};

/** 取引の件数。証憑の充足と資料の状態を決めるのに使う。 */
export type EntryCounts = {
  total: number;
  withReceipt: number;
  withoutReceipt: number;
  unavailableRecorded: number;
  expense: number;
  income: number;
};

export type TaxReportProps = {
  fiscalYear: number;
  fiscalYearLabel: string;
  journal: readonly JournalEntry[];
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  balanceSheetComparison: BalanceSheetComparison;
  monthlySummary: MonthlySummary;
  depreciation: DepreciationSchedule;
  deduction: BlueReturnDeduction;
  page1Rows: Page1Row[];
  expenseDetailRows: StatementLine[];
  breakdowns: {
    wages: PartnerBreakdownRow[];
    familyWages: PartnerBreakdownRow[];
    interest: PartnerBreakdownRow[];
    rent: PartnerBreakdownRow[];
    professionalFees: PartnerBreakdownRow[];
  };
  fixedAssets: readonly FixedAsset[];
  closedAt: string | null;
  entryCounts: EntryCounts;
  usesEtax: boolean;
  onUsesEtaxChange: (value: boolean) => void;
  /** 青色申告決算書のページCSV出力。 */
  onExportPage: (page: TaxPage) => void;
  /** 仕訳帳CSVの出力。 */
  onExportJournal: () => void;
  /** 帳簿・取引管理タブへの遷移。 */
  onNavigate: (target: "summary" | "expenses" | "journal") => void;
};
