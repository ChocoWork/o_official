import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import {
  DataTable,
  type TableColumn,
} from "@/components/ui/DataTable/DataTable";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { FileDropZone } from "@/components/ui/FileDropZone/FileDropZone";
import { Graph } from "@/components/ui/Graph/Graph";
import { PageControl } from "@/components/ui/PageControl/PageControl";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";
import { TaxReportSection } from "@/components/tax/TaxReportSection";
import type { TaxPage } from "@/components/tax/types";
import { clientFetch } from "@/lib/client-fetch";
import {
  ACCOUNTS,
  accountByCode,
  accountByName,
  expenseAccounts,
  incomeAccounts,
  type AccountType,
  type BusinessType,
} from "@/lib/finance/accounts";
import {
  buildCashFlow,
  CASH_FLOW_CATEGORY_LABELS,
  type CashFlowCategory,
} from "@/lib/finance/cash-flow";
import {
  buildCumulativeSummary,
  type CumulativeEntry,
} from "@/lib/finance/cumulative";
import {
  DEPRECIATION_METHOD_LABELS,
  depreciationForYear,
  depreciationSchedule,
  straightLineRate,
  type DepreciationForYear,
  type DepreciationMethod,
  type FixedAsset,
} from "@/lib/finance/depreciation";
import {
  currentSeasonKey,
  formatSeasonLabel,
  seasonOptionsDescending,
} from "@/lib/kpi/monthly-metrics";
import { fiscalYearOf } from "@/lib/finance/fiscal-year";
import {
  buildDepreciationEntries,
  buildGeneralLedger,
  buildJournal,
  buildTrialBalance,
  type EntryType,
  type FinanceEntry,
  type JournalEntry,
  type LedgerAccount,
} from "@/lib/finance/journal";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
} from "@/lib/finance/statements";
import {
  BREAKDOWN_ACCOUNT_CODES,
  buildBalanceSheetComparison,
  buildBlueReturnDeduction,
  buildMonthlySummary,
  buildPartnerBreakdown,
} from "@/lib/finance/blue-return";
import {
  buildAllowanceEntries,
  buildClosingBalances,
  buildInventoryEntries,
  EMPTY_YEAR_END_ADJUSTMENT,
  verifyOpeningBalances,
  type YearEndAdjustment,
} from "@/lib/finance/year-end";
import {
  activeConditionCount,
  EMPTY_ENTRY_FILTER,
  filterEntries,
  isFilterActive,
  type EntryFilter,
} from "@/lib/finance/entry-filter";
import {
  addDays,
  buildCashSchedule,
  buildCashTargetLine,
  buildCostOfSalesComposition,
  buildMonthlyCashTrend,
  buildOverviewActions,
  buildSalesComposition,
  buildSgaComposition,
  cashSafetyLevel,
  countReceivableEntries,
  type CompositionItem,
} from "@/lib/finance/overview";

type CostProfitTab = "summary" | "expenses" | "journal" | "products" | "tax";

// 帳簿タブ内のサブビュー。
// 仕訳帳と総勘定元帳は「同じ仕訳を科目で切って見る」だけの違いなので1枚に畳み、
// 合計残高試算表は決算の検算そのものなので決算と1枚にする。
type LedgerTab = "ledger" | "assets" | "closing";

const LEDGER_TABS: Array<{ key: LedgerTab; label: string }> = [
  { key: "ledger", label: "仕訳・元帳" },
  { key: "assets", label: "固定資産" },
  { key: "closing", label: "決算・試算表" },
];

/** 決算・試算表の表示切替。前3枚が財務3表、後2枚が検算と締めの作業面。 */
type StatementTab = "bs" | "pl" | "cf" | "trial" | "closing";

const STATEMENT_TABS: Array<{ key: StatementTab; label: string }> = [
  { key: "bs", label: "貸借対照表" },
  { key: "pl", label: "損益計算書" },
  { key: "cf", label: "キャッシュフロー計算書" },
  { key: "trial", label: "合計残高試算表" },
  { key: "closing", label: "決算整理" },
];

/**
 * 貸借対照表の比較列の基準。
 * 前年同月・予算は元データ（前年度の月次仕訳・科目別予算）を持たないため置かない。
 * 期首＝前年度末残高なので、実質「前年度末比」として使える。
 */
type ComparisonBasis = "previousMonth" | "opening";

const COMPARISON_TABS: Array<{ key: ComparisonBasis; label: string }> = [
  { key: "previousMonth", label: "前月比" },
  { key: "opening", label: "期首比" },
];

const COMPARISON_COLUMN_LABELS: Record<ComparisonBasis, string> = {
  previousMonth: "前月残高",
  opening: "期首残高",
};

/**
 * 貸借対照表の大区分。固定側の決算書区分（section）だけを列挙し、
 * 残りはすべて流動側に寄せる。列挙漏れで合計が合わなくなるのを防ぐ。
 */
const NON_CURRENT_ASSET_SECTIONS = [
  "有形固定資産",
  "無形固定資産",
  "投資その他の資産",
  "繰延資産",
] as const;
const NON_CURRENT_LIABILITY_SECTIONS = ["固定負債"] as const;
/** 純資産の決算書区分。事業形態で科目が変わるのでマスタから引く。 */
const EQUITY_SECTIONS: readonly string[] = [
  ...new Set(
    ACCOUNTS.filter((account) => account.type === "equity").map(
      (account) => account.section,
    ),
  ),
];

/** 貸借対照表の構成図・推移グラフの色。資産＝青、負債＝橙、純資産＝緑。 */
const BS_ASSET_COLOR = "#2f6fdb";
const BS_LIABILITY_COLOR = "#d98324";
const BS_EQUITY_COLOR = "#16844b";
const BS_ASSET_FILL = "#e8f0fd";
const BS_LIABILITY_FILL = "#fdf3e6";
const BS_EQUITY_FILL = "#e8f4ec";

/** 減価償却推移の色。実績は濃い青、予測は同色の破線・ハッチで示す。 */
const DEPRECIATION_LINE_COLOR = "#2f6fdb";
const DEPRECIATION_BAR_COLOR = "#c3d5f2";

/** 残高推移の色。当期は黒の実線、前期末は灰の破線、異常値は橙の点。 */
const LEDGER_TREND_COLOR = "#111111";
const LEDGER_OPENING_COLOR = "#909090";
const LEDGER_ANOMALY_COLOR = "#e9a23b";

/** 元帳の月ラベル。残高推移の横軸に使う。 */
const LEDGER_MONTH_LABELS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
] as const;

/** 仕訳一覧の1ページあたりの表示件数の選択肢。 */
const LEDGER_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/** 資産一覧の1ページあたりの表示件数。 */
const ASSET_PAGE_SIZE = 10;

/** 減価償却予定表に出す年度の幅（実績3年＋予測4年）。 */
const DEPRECIATION_PAST_YEARS = 2;
const DEPRECIATION_FUTURE_YEARS = 4;

// 固定資産に使う勘定科目（有形・無形固定資産）。
const FIXED_ASSET_ACCOUNT_SECTIONS = [
  "有形固定資産",
  "無形固定資産",
] as const;

const EMPTY_ASSET_FORM = {
  name: "",
  account: "工具器具備品",
  acquiredOn: new Date().toLocaleDateString("sv-SE"),
  acquisitionCost: "",
  method: "straightLine" as DepreciationMethod,
  usefulLife: "6",
  businessUseRatio: "100",
  disposedOn: "",
};

const REVISION_OPERATION_LABELS: Record<EntryRevision["operation"], string> = {
  insert: "登録",
  update: "訂正",
  delete: "削除",
};

// --- 取引管理の一覧（状態・タブ・確認キュー）------------------------------
//
// 取引1件の「状態」は次の優先順で1つに決める。証憑の有無は別軸（証憑列）で示す。
//   訂正あり ＞ 要確認 ＞ 登録済み
type EntryState = "registered" | "review" | "revised";

const ENTRY_STATE_LABELS: Record<EntryState, string> = {
  registered: "登録済み",
  review: "要確認",
  revised: "訂正あり",
};

// 状態色は StatusBadge の accent と同じトークン（正常＝黒・要対応＝橙・訂正＝赤）。
const ENTRY_STATE_TONES: Record<EntryState, "neutral" | "warning" | "danger"> = {
  registered: "neutral",
  review: "warning",
  revised: "danger",
};

const ENTRY_STATE_COLORS: Record<EntryState, string> = {
  registered: "#111111",
  review: "#b45309",
  revised: "#b91c1c",
};

/** 証憑の有無。ドーナツと凡例で共有する色。 */
const RECEIPT_ATTACHED_COLOR = "#111111";
const RECEIPT_MISSING_COLOR = "#b45309";

/** 収支バーの色。収入＝黒、支出＝グレー、収支＝緑（プラス）／赤（マイナス）。 */
const BALANCE_INCOME_COLOR = "#111111";
const BALANCE_EXPENSE_COLOR = "#8a8a8a";
const BALANCE_POSITIVE_COLOR = "#16844b";
const BALANCE_NEGATIVE_COLOR = "#b91c1c";

/** 一覧の絞り込みタブ。件数はタブ内で表示する。 */
type EntryListTab = "all" | "noReceipt" | "review" | "revised";

/** 1ページあたりの表示件数。 */
const ENTRY_PAGE_SIZE = 20;

/** 確認キューの1グループ。優先順に並べて右カラムへ出す。 */
type ReviewQueueKey = "noReceipt" | "amount" | "account" | "revised";

const REVIEW_QUEUE_DEFS: Array<{
  key: ReviewQueueKey;
  label: string;
  icon: string;
  tone: "warning" | "danger";
  tab: EntryListTab;
}> = [
  {
    key: "noReceipt",
    label: "証憑未添付",
    icon: "ri-attachment-2",
    tone: "warning",
    tab: "noReceipt",
  },
  {
    key: "amount",
    label: "金額確認",
    icon: "ri-error-warning-line",
    tone: "warning",
    tab: "review",
  },
  {
    key: "account",
    label: "勘定科目確認",
    icon: "ri-file-list-3-line",
    tone: "warning",
    tab: "review",
  },
  {
    key: "revised",
    label: "訂正内容確認",
    icon: "ri-pencil-line",
    tone: "danger",
    tab: "revised",
  },
];

// 電子帳簿保存法の検索要件に対する対応状況。実装済みの機能だけを並べる。
const DENCHOHO_CHECKLIST: Array<{ label: string; note: string }> = [
  { label: "日付検索", note: "対応済み" },
  { label: "金額検索", note: "対応済み" },
  { label: "取引先検索", note: "対応済み" },
  { label: "訂正履歴", note: "対応済み" },
];

/** 証憑に受け付けるファイル形式（Storage 側の検証と揃える）。 */
const RECEIPT_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/webp,image/heic";

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "資産",
  liability: "負債",
  equity: "純資産",
  revenue: "収益",
  expense: "費用",
};


/** 証憑（電子取引データ）。ファイル本体は非公開バケットにある。 */
type Receipt = {
  id: number;
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
};

/** 訂正削除履歴の1件（電子帳簿保存法の真実性の要件）。 */
type RevisionSnapshot = {
  date: string | null;
  category: string | null;
  item: string | null;
  partner: string | null;
  amount: string | null;
};

type EntryRevision = {
  id: number;
  entryId: number;
  operation: "insert" | "update" | "delete";
  changedAt: string;
  before: RevisionSnapshot;
  after: RevisionSnapshot;
};

// 取引1件。仕訳エンジン（src/lib/finance/journal.ts）と同じ形＋証憑。
type Expense = FinanceEntry & { receipts?: Receipt[] };

type ExpenseTemplate = {
  name: string;
  entryType: EntryType;
  category: string;
  item: string;
  amount: number;
  paymentMethod: string;
  memo: string;
};

type ProductCostKey =
  | "material"
  | "sewing"
  | "pattern"
  | "accessories"
  | "processing"
  | "finishing";

type Product = {
  id: string;
  name: string;
  category: string;
  productionMethod: string;
  plannedQuantity: number;
  sellingPrice: number;
  costs: Record<ProductCostKey, number>;
};

type FinancePlan = {
  salesRevenue: number;
  openingCash: number;
  accountsReceivable: number;
  fixedAssets: number;
  accountsPayable: number;
  openingCapital: number;
};

type CostProfitResponse = {
  data: {
    fiscalYear: number;
    seasonKey: string | null;
    businessType: BusinessType;
    plan: FinancePlan;
    expenses: Expense[];
    incomes: Expense[];
    products: Product[];
    partners: string[];
    fixedAssets: FixedAsset[];
    closing: {
      closingInventoryGoods: number;
      closingInventoryMaterials: number;
      allowanceForDoubtful: number;
      closingBalances: Record<string, number>;
      closedAt: string | null;
    };
    previousClosingBalances: Record<string, number> | null;
    revisions: EntryRevision[];
    cumulativeEntries: CumulativeEntry[];
    templates: ExpenseTemplate[];
  };
};

const COST_PROFIT_TABS: Array<{ key: CostProfitTab; label: string }> = [
  { key: "summary", label: "財務概要" },
  { key: "expenses", label: "取引管理" },
  { key: "journal", label: "帳簿" },
  { key: "products", label: "商品原価" },
  { key: "tax", label: "税務レポート" },
];

const COST_LABELS: Array<{
  key: ProductCostKey;
  label: string;
  color: string;
}> = [
  { key: "material", label: "生地・材料費", color: "#111111" },
  { key: "sewing", label: "縫製工賃", color: "#464646" },
  { key: "pattern", label: "パターン・企画費", color: "#707070" },
  { key: "accessories", label: "附属・副資材費", color: "#929292" },
  { key: "processing", label: "加工費", color: "#b5b5b5" },
  { key: "finishing", label: "検品・仕上げ費", color: "#d7d7d7" },
];

// 事業形態。勘定科目の適用形態（共通/個人/法人）の絞り込みに使う。
const BUSINESS_TYPE_OPTIONS: Array<{ value: BusinessType; label: string }> = [
  { value: "soleProprietor", label: "個人事業主" },
  { value: "corporation", label: "法人" },
];
// — 支出用の固定リスト
const SHIYOU_OPTIONS = [
  "生地・材料仕入",
  "サンプル制作",
  "縫製外注",
  "副資材・附属購入",
  "広告出稿",
  "撮影・制作",
  "展示会・イベント",
  "梱包・発送",
  "打合せ・交通",
  "システム・ツール利用料",
  "その他",
];
// — 収入用の固定リスト
const INCOME_SHIYOU_OPTIONS = [
  "オンライン販売",
  "卸売",
  "展示会・イベント販売",
  "受託・別注",
  "その他",
];
// 入金方法（収入用）
const INCOME_PAYMENT_OPTIONS = [
  "現金",
  "プライベート",
  "銀行",
  "前払金",
  "売掛金",
  "受取手形",
  "未収賃貸料",
  "貸付金",
  "立替金",
  "未収金",
  "仮払金",
  "仮払消費税",
];
// 出金方法（支出用）
const EXPENSE_PAYMENT_OPTIONS = [
  "現金",
  "プライベート",
  "クレジットカード",
  "銀行",
  "支払手形",
  "買掛金",
  "借入金",
  "未払金",
  "前受金",
  "預り金",
  "賃倒引当金",
  "借受金",
  "未払消費税",
  "保証金・敷金",
  "商品券",
  "仮受消費税",
];

// 取引フォームの初期値。新規登録と訂正の取消でリセットに使う。
const emptyEntryForm = {
  entryType: "expense" as EntryType,
  date: new Date().toLocaleDateString("sv-SE"),
  // 勘定科目は選択肢が多いため既定値を置かず、明示的に選ばせる。
  category: "",
  item: SHIYOU_OPTIONS[0],
  partner: "",
  amount: "",
  paymentMethod: EXPENSE_PAYMENT_OPTIONS[0],
  memo: "",
  // コレクション別分析用の任意タグ（空文字＝未設定）。会計期間には影響しない。
  seasonTag: "",
};

// 勘定科目の選択肢。種別（出金/入金）と事業形態（個人/法人）の両方で絞り込む。
// ラベルは決算書区分を前置きして、長いリストでも探しやすくする。
function accountOptionsFor(
  entryType: EntryType,
  businessType: BusinessType,
): Array<{ value: string; label: string }> {
  const accounts =
    entryType === "income"
      ? incomeAccounts(businessType)
      : expenseAccounts(businessType);
  return accounts.map((account) => ({
    value: account.name,
    label: `${account.section} / ${account.name}`,
  }));
}
// 種別ごとの選択肢を返す。
function shiyouOptionsFor(entryType: EntryType): string[] {
  return entryType === "income" ? INCOME_SHIYOU_OPTIONS : SHIYOU_OPTIONS;
}
function paymentOptionsFor(entryType: EntryType): string[] {
  return entryType === "income"
    ? INCOME_PAYMENT_OPTIONS
    : EXPENSE_PAYMENT_OPTIONS;
}
// 取引先セレクトの「＋新規登録」を表す番兵値
const NEW_PARTNER_SENTINEL = "__new_partner__";
// テンプレートセレクトの「＋現在の入力を保存」を表す番兵値
const SAVE_TEMPLATE_SENTINEL = "__save_template__";
const EMPTY_PLAN: FinancePlan = {
  salesRevenue: 0,
  openingCash: 0,
  accountsReceivable: 0,
  fixedAssets: 0,
  accountsPayable: 0,
  openingCapital: 0,
};

const currency = (value: number) =>
  `¥${Math.round(value).toLocaleString("ja-JP")}`;
// 資金の流れ（キャッシュブリッジ・利益構造）はマイナスを▲で示す。会計書類の慣行。
const signedCurrency = (value: number) =>
  value < 0
    ? `▲¥${Math.round(-value).toLocaleString("ja-JP")}`
    : `¥${Math.round(value).toLocaleString("ja-JP")}`;
const percent = (value: number) => `${value.toFixed(1)}%`;
// 財務3表は決算書の見た目に合わせ、マイナスを「-」で示す（▲は資金の流れ用）。
const statementCurrency = (value: number) =>
  value < 0
    ? `-¥${Math.round(-value).toLocaleString("ja-JP")}`
    : `¥${Math.round(value).toLocaleString("ja-JP")}`;
// 増減は符号を明示する。C/F の各活動・現金増減額に使う。
const deltaCurrency = (value: number) =>
  value > 0
    ? `+¥${Math.round(value).toLocaleString("ja-JP")}`
    : statementCurrency(value);
// 構成比は分母が 0 なら比率を出さない（0除算で NaN を表示しない）。
const ratioOf = (value: number, base: number) =>
  base === 0 ? undefined : (value / base) * 100;
const inputClassName =
  "h-10 w-full border border-[#d4d4d4] bg-white px-3 font-acumin text-sm text-black outline-none transition-colors focus:border-black";
const panelClassName = "border border-[#d4d4d4] bg-white p-4 sm:p-5";
// 財務概要は角丸で統一する。面は Panel（--radius-md 8px）、
// 内側の枠は一段小さい --radius-sm（6px）で入れ子の階層を作る。
const boxRadiusClassName = "rounded-sm";
const panelTitleClassName =
  "font-acumin text-sm font-medium tracking-widest text-black";
// 財務3表は3カラムに収めるため、見出しを一段詰める。入りきらない場合は
// 見出しが2行に折り返し、CSV ボタンは右端に留まる（headerWrap={false}）。
const statementTitleClassName =
  "font-acumin text-[13px] font-medium leading-tight tracking-wider text-black";

function sumProductUnitCost(product: Product): number {
  return Object.values(product.costs).reduce((sum, value) => sum + value, 0);
}

function exportCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricCard({
  label,
  value,
  note,
  positive,
}: {
  label: string;
  value: string;
  note: string;
  positive?: boolean;
}) {
  return (
    <div className="border border-[#d4d4d4] bg-white p-4">
      <p className="font-acumin text-[11px] tracking-wider text-[#474747]">
        {label}
      </p>
      <p className="mt-2 font-acumin text-xl font-medium tracking-wide text-black tabular-nums">
        {value}
      </p>
      <p
        className={`mt-2 font-acumin text-[11px] ${positive ? "text-[#16844b]" : "text-[#707070]"}`}
      >
        {note}
      </p>
    </div>
  );
}

type StatementRow = {
  label: string;
  value: number;
  /** 構成比（%）。undefined の行は構成比欄を空ける。 */
  ratio?: number;
  /** 小計・利益行。上に区切り線を引いて太字にする。 */
  emphasis?: boolean;
  /** 増減として符号と色を付ける（C/F の各活動）。 */
  delta?: boolean;
};

/**
 * 財務3表の1枚。見出しの右に CSV 出力、本体は 科目 / 金額 /（任意で）構成比。
 * aside はグラフ、children は表の下の検算・バランス表示を差し込む枠。
 */
function StatementTable({
  title,
  exportLabel,
  onExport,
  rows,
  showRatio,
  aside,
  children,
}: {
  title: string;
  exportLabel: string;
  onExport: () => void;
  rows: StatementRow[];
  showRatio?: boolean;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const columns = showRatio
    ? "grid-cols-[minmax(0,1fr)_auto_auto]"
    : "grid-cols-[minmax(0,1fr)_auto]";

  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label={title}
      headingLevel={4}
      headerWrap={false}
      title={<span className={statementTitleClassName}>{title}</span>}
      actions={
        <Button
          variant="outline"
          size="3xs"
          shape="rounded"
          onClick={onExport}
          aria-label={exportLabel}
          className="font-acumin tracking-wider"
        >
          CSV
        </Button>
      }
    >
      <div className="flex items-stretch gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={`grid ${columns} items-baseline gap-x-3 border-b border-[#d4d4d4] pb-1.5 font-acumin text-[10px] text-[#707070]`}
          >
            <span>（単位：円）</span>
            <span className="text-right">金額</span>
            {showRatio ? <span className="text-right">構成比</span> : null}
          </div>
          {rows.map((row) => (
            <div
              key={row.label}
              className={`grid ${columns} items-baseline gap-x-3 py-2 ${
                row.emphasis
                  ? "border-t border-[#d4d4d4]"
                  : "border-b border-[#ededed]"
              }`}
            >
              <span
                className={`min-w-0 truncate font-acumin text-xs ${row.emphasis ? "font-medium text-black" : "text-[#474747]"}`}
              >
                {row.label}
              </span>
              <span
                className={`whitespace-nowrap text-right font-acumin text-xs tabular-nums ${
                  row.delta && row.value > 0
                    ? "text-[#16844b]"
                    : row.value < 0
                      ? "text-red-700"
                      : "text-black"
                } ${row.emphasis ? "font-medium" : ""}`}
              >
                {row.delta
                  ? deltaCurrency(row.value)
                  : statementCurrency(row.value)}
              </span>
              {showRatio ? (
                <span className="whitespace-nowrap text-right font-acumin text-xs text-[#474747] tabular-nums">
                  {row.ratio === undefined ? "—" : percent(row.ratio)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

// 利益の残り方の帯。売上高100%から段階的に細くなる様子を濃さで示す。
const PROFIT_LADDER_COLORS = ["#ffffff", "#dcdcdc", "#565656", "#111111"];

/** P/L 脇の縦帯。売上高100%のうち各段階でいくら残るかを高さで示す。 */
function ProfitLadderBar({
  steps,
}: {
  steps: Array<{ label: string; ratio: number }>;
}) {
  const total = steps.reduce((sum, step) => sum + Math.max(step.ratio, 0), 0);
  if (total <= 0) return null;

  return (
    <div
      className={`hidden w-11 shrink-0 flex-col overflow-hidden border border-[#ededed] sm:flex ${boxRadiusClassName}`}
      role="img"
      aria-label={steps
        .map((step) => `${step.label} ${percent(step.ratio)}`)
        .join("、")}
    >
      {steps.map((step, index) => (
        <div
          key={step.label}
          className="flex items-center justify-center"
          style={{
            flexGrow: Math.max(step.ratio, 0),
            flexBasis: 0,
            minHeight: 22,
            backgroundColor:
              PROFIT_LADDER_COLORS[index % PROFIT_LADDER_COLORS.length],
            color: index >= 2 ? "#ffffff" : "#111111",
          }}
        >
          <span className="font-acumin text-[10px] tabular-nums">
            {percent(step.ratio)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** B/S の下の帯。資産と「負債＋純資産」を同じ尺度で並べ、差額を示す。 */
function BalanceBars({
  assetTotal,
  liabilityAndEquityTotal,
  difference,
}: {
  assetTotal: number;
  liabilityAndEquityTotal: number;
  difference: number;
}) {
  const scale = Math.max(assetTotal, liabilityAndEquityTotal, 1);

  return (
    <div className="mt-4 border-t border-[#ededed] pt-3">
      <p className="font-acumin text-[11px] text-[#474747]">財政状態のバランス</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {(
          [
            ["資産", assetTotal],
            ["負債＋純資産", liabilityAndEquityTotal],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="min-w-0">
            <span className="block truncate font-acumin text-[10px] text-[#707070]">
              {label}
            </span>
            <span className="block font-acumin text-[11px] text-black tabular-nums">
              {statementCurrency(amount)}
            </span>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[#ededed]">
              <div
                className="h-full rounded-full bg-black"
                style={{
                  width: `${Math.min(100, (Math.max(amount, 0) / scale) * 100)}%`,
                }}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}
      </div>
      <p
        className={`mt-2 text-center font-acumin text-[11px] tabular-nums ${difference === 0 ? "text-[#707070]" : "text-red-700"}`}
      >
        貸借差額 {statementCurrency(difference)}
      </p>
    </div>
  );
}

// 目盛りの刻み。1・2・2.5・5・10 の系列に丸めて読みやすい軸にする。
function niceStep(raw: number): number {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (raw <= multiple * exponent) return multiple * exponent;
  }
  return 10 * exponent;
}

// 資金は赤字（マイナス残高）もあり得るので、0 起点に固定せず上下とも丸める。
function niceAxis(min: number, max: number) {
  const lowest = Math.min(min, 0);
  const highest = Math.max(max, 0);
  const step = niceStep((highest - lowest || 1) / 4);
  const lo = Math.floor(lowest / step) * step;
  const hi = Math.ceil(highest / step) * step || step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step / 2; value += step) {
    ticks.push(Math.round(value));
  }
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

const AXIS_FORMAT = new Intl.NumberFormat("ja-JP");

/**
 * 資金推移の折れ線。実績は実線、目標は破線、安全水準は薄いグリーンの帯。
 * 目標が無い（財務前提の売上見込み未入力）ときは破線を描かない。
 */
function CashTrendChart({
  points,
  targets,
  safetyLevel,
  ariaLabel,
}: {
  points: Array<{ label: string; value: number }>;
  targets: number[] | null;
  safetyLevel: number;
  ariaLabel: string;
}) {
  const width = 660;
  const height = 240;
  const padL = 78;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = [
    ...points.map((point) => point.value),
    ...(targets ?? []),
    safetyLevel,
  ];
  const { lo, hi, ticks } = niceAxis(Math.min(...values), Math.max(...values));
  const xOf = (index: number) =>
    padL + (plotW * index) / Math.max(points.length - 1, 1);
  const yOf = (value: number) => padT + (1 - (value - lo) / (hi - lo)) * plotH;
  const line = (series: number[]) =>
    series
      .map((value, index) => `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`)
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <text x={4} y={padT} fill="#888888" fontSize="9">
        （円）
      </text>
      {safetyLevel > 0 ? (
        <rect
          x={padL}
          y={yOf(safetyLevel)}
          width={plotW}
          height={Math.max(yOf(0) - yOf(safetyLevel), 0)}
          fill="#e8f1e9"
        />
      ) : null}
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={padL}
            x2={width - padR}
            y1={yOf(tick)}
            y2={yOf(tick)}
            stroke={tick === 0 ? "#d4d4d4" : "#ededed"}
            strokeWidth={1}
          />
          <text
            x={padL - 8}
            y={yOf(tick) + 3}
            textAnchor="end"
            fill="#888888"
            fontSize="9"
          >
            {AXIS_FORMAT.format(tick)}
          </text>
        </g>
      ))}
      {targets ? (
        <polyline
          fill="none"
          stroke="#707070"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          points={line(targets)}
        />
      ) : null}
      <polyline
        fill="none"
        stroke="#111111"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={line(points.map((point) => point.value))}
      />
      {points.map((point, index) => (
        <circle
          key={`dot-${point.label}`}
          cx={xOf(index)}
          cy={yOf(point.value)}
          r={2.5}
          fill="#111111"
        />
      ))}
      {points.map((point, index) => (
        <text
          key={`x-${point.label}`}
          x={xOf(index)}
          y={height - 8}
          textAnchor="middle"
          fill="#888888"
          fontSize="9"
        >
          {point.label}
        </text>
      ))}
    </svg>
  );
}

// 構成比のグレースケール。色数を増やさず、濃さの順で大きい項目から並べる。
const COMPOSITION_COLORS = [
  "#111111",
  "#565656",
  "#8a8a8a",
  "#b5b5b5",
  "#dcdcdc",
];

function DonutChart({
  items,
  ariaLabel,
}: {
  items: CompositionItem[];
  ariaLabel: string;
}) {
  const radius = 42;
  const strokeWidth = 16;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  return (
    <svg
      viewBox="0 0 120 120"
      className="h-24 w-24 shrink-0"
      role="img"
      aria-label={ariaLabel}
    >
      <g transform="rotate(-90 60 60)">
        <circle
          cx={60}
          cy={60}
          r={radius}
          fill="none"
          stroke="#ededed"
          strokeWidth={strokeWidth}
        />
        {items.map((item, index) => {
          const length = (item.ratio / 100) * circumference;
          const offset = consumed;
          consumed += length;
          return (
            <circle
              key={item.label}
              cx={60}
              cy={60}
              r={radius}
              fill="none"
              stroke={COMPOSITION_COLORS[index % COMPOSITION_COLORS.length]}
              strokeWidth={strokeWidth}
              strokeDasharray={`${length.toFixed(2)} ${(circumference - length).toFixed(2)}`}
              strokeDashoffset={-offset}
            />
          );
        })}
      </g>
      <text
        x={60}
        y={65}
        textAnchor="middle"
        fill="#111111"
        fontSize="16"
        className="tabular-nums"
      >
        100%
      </text>
    </svg>
  );
}

/** 売上高・売上原価・販管費の構成比カード。ドーナツと項目名・金額・構成比。 */
function CompositionCard({
  title,
  total,
  items,
  emptyMessage,
}: {
  title: string;
  total: number;
  items: CompositionItem[];
  emptyMessage: string;
}) {
  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label={title}
      title={<span className={panelTitleClassName}>{title}</span>}
      actions={
        <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
          合計 {currency(total)}
        </span>
      }
    >
      {items.length === 0 ? (
        <p className="font-acumin text-xs text-[#707070]">{emptyMessage}</p>
      ) : (
        <div className="flex items-center gap-4">
          <DonutChart items={items} ariaLabel={`${title}のドーナツグラフ`} />
          <ul className="min-w-0 flex-1 space-y-2">
            {items.map((item, index) => (
              <li key={item.label} className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        COMPOSITION_COLORS[index % COMPOSITION_COLORS.length],
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-acumin text-xs text-black">
                    {item.label}
                  </span>
                  <span className="shrink-0 font-acumin text-xs text-black tabular-nums">
                    {percent(item.ratio)}
                  </span>
                </div>
                <span className="ml-4 block font-acumin text-[10px] text-[#707070] tabular-nums">
                  {currency(item.amount)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/** 利益構造・キャッシュブリッジの1ブロック。項目名と金額を縦に並べる。 */
function FlowBlock({
  label,
  value,
  emphasis,
  size = "md",
  display,
  positive,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  size?: "sm" | "md";
  /** 既定の▲表記ではなく符号付きで見せたいときの上書き。 */
  display?: string;
  /** 増加を緑で示す（C/F の現金増減額）。 */
  positive?: boolean;
}) {
  return (
    <div
      className={`min-w-0 flex-1 border py-2.5 text-center ${
        size === "sm" ? "px-1.5" : "px-3"
      } ${boxRadiusClassName} bg-white ${
        emphasis ? "border-black" : "border-[#d4d4d4]"
      }`}
    >
      <p className="font-acumin text-[11px] leading-tight text-[#474747]">
        {label}
      </p>
      <p
        className={`mt-1 font-acumin font-medium tabular-nums ${
          size === "sm" ? "text-sm" : "text-lg"
        } ${
          value < 0
            ? "text-red-700"
            : positive && value > 0
              ? "text-[#16844b]"
              : "text-black"
        }`}
      >
        {display ?? signedCurrency(value)}
      </p>
    </div>
  );
}

function FlowOperator({ symbol }: { symbol: string }) {
  return (
    <span
      className="shrink-0 self-center text-center font-acumin text-xl text-[#474747]"
      aria-hidden="true"
    >
      {symbol}
    </span>
  );
}

function EmptyIcon({ icon }: { icon: string }) {
  return (
    <i className={`${icon} text-base text-[#474747]`} aria-hidden="true" />
  );
}

export default function CostProfitSection({
  fiscalYear,
  fiscalYearLabel,
  fiscalYearOptions,
  onFiscalYearChange,
}: {
  fiscalYear: number;
  fiscalYearLabel: string;
  /** 年度選択の選択肢。渡されたときだけタブ行に年度セレクトを出す。 */
  fiscalYearOptions?: ReadonlyArray<{ year: number; label: string }>;
  onFiscalYearChange?: (year: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<CostProfitTab>("summary");
  // 財務概要の資金推移グラフの表示単位。
  const [cashTrendMode, setCashTrendMode] = useState<"monthly" | "cumulative">(
    "monthly",
  );
  // 利益構造の集計期間。年度＝選択中の会計期間、累計＝開業以来。
  const [profitScopeMode, setProfitScopeMode] = useState<
    "fiscalYear" | "cumulative"
  >("fiscalYear");
  // 資金予定の起点。描画中に日付が変わらないよう初回だけ決める。
  const today = useMemo(() => new Date().toLocaleDateString("sv-SE"), []);
  const [ledgerTab, setLedgerTab] = useState<LedgerTab>("ledger");
  // 仕訳・元帳。左の科目ツリーで科目を選び、中央の仕訳一覧と右の明細を切り替える。
  const [accountTreeKeyword, setAccountTreeKeyword] = useState("");
  const [collapsedAccountGroups, setCollapsedAccountGroups] = useState<string[]>([]);
  const [ledgerRowKeyword, setLedgerRowKeyword] = useState("");
  const [ledgerPeriod, setLedgerPeriod] = useState("full");
  const [ledgerSideFilter, setLedgerSideFilter] = useState("all");
  const [ledgerRowPage, setLedgerRowPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState<number>(
    LEDGER_PAGE_SIZE_OPTIONS[0],
  );
  const [selectedLedgerRowKey, setSelectedLedgerRowKey] = useState<string | null>(
    null,
  );
  // 固定資産。カテゴリ・償却方法・キーワードで台帳を絞り、右で償却を試算する。
  const [assetSectionFilter, setAssetSectionFilter] = useState("all");
  const [assetMethodFilter, setAssetMethodFilter] = useState<string>("all");
  const [assetKeyword, setAssetKeyword] = useState("");
  const [assetPage, setAssetPage] = useState(1);
  // 決算・試算表。財務3表／試算表／決算整理の切替と、貸借対照表の比較基準。
  const [statementTab, setStatementTab] = useState<StatementTab>("bs");
  const [comparisonBasis, setComparisonBasis] =
    useState<ComparisonBasis>("previousMonth");
  const [balanceSheetKeyword, setBalanceSheetKeyword] = useState("");
  const [collapsedBsGroups, setCollapsedBsGroups] = useState<string[]>([]);
  // 会計データを読み込んだ時刻。照合結果の「最終更新」に出す。
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  // e-Tax申告（または優良な電子帳簿保存）の有無で青色申告特別控除の上限が変わる。
  const [usesEtax, setUsesEtax] = useState(true);
  // 取引管理の検索条件（電子帳簿保存法の検索要件）。
  // キーワードだけは一覧上の検索欄に常設し、それ以外は「詳細条件」Drawer で編集する。
  const [filter, setFilter] = useState<EntryFilter>(EMPTY_ENTRY_FILTER);
  // 一覧の絞り込みタブ・ページ・選択行。
  const [entryListTab, setEntryListTab] = useState<EntryListTab>("all");
  const [entryPage, setEntryPage] = useState(1);
  const [selectedEntryIds, setSelectedEntryIds] = useState<number[]>([]);
  // 取引の登録・訂正は Drawer で行う。一覧の文脈を残したまま入力できるようにする。
  const [isEntryDrawerOpen, setIsEntryDrawerOpen] = useState(false);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  // 証憑 Drawer の対象取引ID。新規登録時は保存前のファイルを pendingReceipts に溜める。
  const [receiptDrawerEntryIds, setReceiptDrawerEntryIds] = useState<number[]>([]);
  const [pendingReceipts, setPendingReceipts] = useState<File[]>([]);
  const [isRevisionHistoryOpen, setIsRevisionHistoryOpen] = useState(true);
  // 総勘定元帳で表示中の科目コード（未選択なら残高のある先頭科目）。
  const [ledgerAccountCode, setLedgerAccountCode] = useState("");
  // 商品原価タブ専用のシーズン軸。会計期間（暦年）とは独立して切り替える。
  const seasonOptions = useMemo(
    () => seasonOptionsDescending(currentSeasonKey()),
    [],
  );
  const [seasonKey, setSeasonKey] = useState(
    () => seasonOptions[0]?.key ?? currentSeasonKey(),
  );
  const seasonLabel = formatSeasonLabel(seasonKey);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [incomes, setIncomes] = useState<Expense[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [partners, setPartners] = useState<string[]>([]);
  const [fixedAssets, setFixedAssets] = useState<FixedAsset[]>([]);
  // 決算整理の入力値と締め状態。前年度のスナップショットが当年度の期首残高になる。
  const [adjustment, setAdjustment] = useState<YearEndAdjustment>(
    EMPTY_YEAR_END_ADJUSTMENT,
  );
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [previousClosingBalances, setPreviousClosingBalances] = useState<
    Record<string, number> | null
  >(null);
  const [closingMessage, setClosingMessage] = useState<string | null>(null);
  // 訂正削除履歴（電子帳簿保存法の真実性の要件）。
  const [revisions, setRevisions] = useState<EntryRevision[]>([]);
  // 開業以来累計の集計元（当年度末までの全取引の最小データ）。
  const [cumulativeEntries, setCumulativeEntries] = useState<CumulativeEntry[]>(
    [],
  );
  // 証憑の添付中の取引ID・メッセージ。
  const [uploadingEntryId, setUploadingEntryId] = useState<number | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ExpenseTemplate[]>([]);
  const [plan, setPlan] = useState<FinancePlan>(EMPTY_PLAN);
  const [businessType, setBusinessType] =
    useState<BusinessType>("soleProprietor");
  const [selectedProductId, setSelectedProductId] = useState(
    `${seasonKey}-ITEM-001`,
  );
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // dataMessage はエラー専用（null = 正常）。ヘッダーには「同期済み」等の短い状態だけを出し、
  // 詳細な文言は右下の Toast へ回す。成功メッセージも Toast のみ。
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);

  const notifySuccess = useCallback((message: string) => {
    setDataMessage(null);
    setToast({ message, variant: "success" });
  }, []);

  const notifyError = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    setDataMessage(message);
    setToast({ message, variant: "error" });
  }, []);

  // 成功は放置しても消えるようにする。エラーは読み切れるよう残し、閉じる操作に任せる。
  useEffect(() => {
    if (toast?.variant !== "success") {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const [form, setForm] = useState(emptyEntryForm);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  // 訂正中の取引ID。null なら新規登録モード。
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  // 固定資産の登録フォーム
  const [assetForm, setAssetForm] = useState(EMPTY_ASSET_FORM);
  const [assetMessage, setAssetMessage] = useState<string | null>(null);
  // 取引先の新規登録用の一時状態
  const [isAddingPartner, setIsAddingPartner] = useState(false);
  const [newPartnerName, setNewPartnerName] = useState("");
  // テンプレートの選択・保存用の一時状態
  const [selectedTemplateName, setSelectedTemplateName] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  const loadFinanceData = useCallback(async () => {
    try {
      setIsDataLoading(true);
      setDataMessage(null);
      // 会計データは年度で、商品原価だけシーズンで取得する。
      const response = await clientFetch(
        `/api/admin/kpi/cost-profit?year=${fiscalYear}&season=${encodeURIComponent(seasonKey)}`,
        {
          cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | CostProfitResponse
        | { error?: string; details?: string }
        | null;
      if (!response.ok || !payload || !("data" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "会計データの取得に失敗しました。",
        );
      }

      setPlan(payload.data.plan);
      setBusinessType(payload.data.businessType ?? "soleProprietor");
      setExpenses(payload.data.expenses);
      setIncomes(payload.data.incomes ?? []);
      setProducts(payload.data.products);
      setPartners(payload.data.partners ?? []);
      setFixedAssets(payload.data.fixedAssets ?? []);
      const loadedClosing = payload.data.closing;
      setAdjustment(
        loadedClosing
          ? {
              closingInventoryGoods: loadedClosing.closingInventoryGoods,
              closingInventoryMaterials: loadedClosing.closingInventoryMaterials,
              allowanceForDoubtful: loadedClosing.allowanceForDoubtful,
            }
          : EMPTY_YEAR_END_ADJUSTMENT,
      );
      setClosedAt(loadedClosing?.closedAt ?? null);
      setPreviousClosingBalances(payload.data.previousClosingBalances ?? null);
      setRevisions(payload.data.revisions ?? []);
      setCumulativeEntries(payload.data.cumulativeEntries ?? []);
      setTemplates(payload.data.templates ?? []);
      setSelectedProductId(
        payload.data.products[0]?.id ?? `${seasonKey}-ITEM-001`,
      );
      setSyncedAt(new Date().toISOString());
    } catch (error) {
      // DB取得に失敗した場合、削除できないサンプル行を残さない。
      // 画面上のデータがSupabase由来であることを保証する。
      setPlan(EMPTY_PLAN);
      setExpenses([]);
      setIncomes([]);
      setProducts([]);
      setPartners([]);
      setFixedAssets([]);
      setAdjustment(EMPTY_YEAR_END_ADJUSTMENT);
      setClosedAt(null);
      setPreviousClosingBalances(null);
      setRevisions([]);
      setCumulativeEntries([]);
      setTemplates([]);
      setSelectedProductId(`${seasonKey}-ITEM-001`);
      notifyError(error, "会計データの取得に失敗しました。");
    } finally {
      setIsDataLoading(false);
    }
  }, [fiscalYear, seasonKey, notifyError]);

  useEffect(() => {
    void loadFinanceData();
  }, [loadFinanceData]);

  const postMutation = useCallback(async (body: Record<string, unknown>) => {
    const response = await clientFetch("/api/admin/kpi/cost-profit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      reason?: string;
      resourceId?: string;
    } | null;
    if (!response.ok) {
      if (response.status === 403 && payload?.reason === "MFA required") {
        throw new Error(
          "保存には2要素認証が必要です。認証画面で2FAを完了してから、もう一度保存してください。",
        );
      }
      if (response.status === 403) {
        throw new Error(
          "セキュリティ確認に失敗しました。ページを再読み込みして、もう一度保存してください。",
        );
      }
      throw new Error(payload?.error ?? "会計データの保存に失敗しました。");
    }
    return payload;
  }, []);

  // 財務3表はすべて仕訳の実残高から導出する（架空の係数は使わない）。
  // 期首残高は「前年度の決算スナップショット」が最優先。無ければ手入力の期首残高を使う。
  // これで 翌年期首BS = 当年期末BS が保たれる。
  const openingBalances = useMemo(() => {
    if (previousClosingBalances) {
      return new Map<string, number>(
        Object.entries(previousClosingBalances).filter(
          ([, amount]) => amount !== 0,
        ),
      );
    }
    return new Map<string, number>(
      (
        [
          ["1010", plan.openingCash],
          ["1120", plan.accountsReceivable],
          ["1535", plan.fixedAssets],
          ["2020", plan.accountsPayable],
          ["2910", plan.openingCapital],
        ] as Array<[string, number]>
      ).filter(([, amount]) => amount > 0),
    );
  }, [plan, previousClosingBalances]);

  const seasonForecast = useMemo(() => {
    const sales = products.reduce(
      (sum, product) => sum + product.sellingPrice * product.plannedQuantity,
      0,
    );
    const manufacturingCost = products.reduce(
      (sum, product) =>
        sum + sumProductUnitCost(product) * product.plannedQuantity,
      0,
    );
    const grossProfit = sales - manufacturingCost;
    return {
      sales,
      manufacturingCost,
      grossProfit,
      grossMargin: sales > 0 ? (grossProfit / sales) * 100 : 0,
    };
  }, [products]);


  const emptyProduct = useMemo<Product>(
    () => ({
      id: `${seasonKey}-ITEM-001`,
      name: "新規商品",
      category: "未設定",
      productionMethod: "未設定",
      plannedQuantity: 0,
      sellingPrice: 0,
      costs: {
        material: 0,
        sewing: 0,
        pattern: 0,
        accessories: 0,
        processing: 0,
        finishing: 0,
      },
    }),
    [seasonKey],
  );
  const selectedProduct =
    products.find((product) => product.id === selectedProductId) ??
    products[0] ??
    emptyProduct;
  const selectedUnitCost = sumProductUnitCost(selectedProduct);
  const selectedGrossProfit = selectedProduct.sellingPrice - selectedUnitCost;
  const selectedGrossMargin =
    selectedProduct.sellingPrice > 0
      ? (selectedGrossProfit / selectedProduct.sellingPrice) * 100
      : 0;

  // 固定資産は年度をまたいで償却する。当年度分の明細を台帳から算出する。
  const depreciation = useMemo(
    () => depreciationSchedule(fixedAssets, fiscalYear),
    [fixedAssets, fiscalYear],
  );

  // 帳簿・財務3表は取引管理に入力された実データと決算整理仕訳だけから作る。
  // 仕訳 → 総勘定元帳 → 合計残高試算表 → 損益計算書・貸借対照表 の順に導出する。
  const journal = useMemo(
    () => [
      ...buildJournal([...expenses, ...incomes], businessType),
      // 決算整理仕訳（減価償却・棚卸・引当金）。
      ...buildDepreciationEntries(depreciation.rows, fiscalYear),
      ...buildInventoryEntries(adjustment, openingBalances, fiscalYear),
      ...buildAllowanceEntries(adjustment, fiscalYear),
    ],
    [
      expenses,
      incomes,
      businessType,
      depreciation.rows,
      fiscalYear,
      adjustment,
      openingBalances,
    ],
  );
  const ledger = useMemo(
    () => buildGeneralLedger(journal, openingBalances),
    [journal, openingBalances],
  );
  const trialBalance = useMemo(() => buildTrialBalance(ledger), [ledger]);
  const profitAndLoss = useMemo(
    () => buildProfitAndLoss(trialBalance),
    [trialBalance],
  );
  const balanceSheet = useMemo(
    () => buildBalanceSheet(trialBalance),
    [trialBalance],
  );
  // C/F は直接法。現金・預金元帳の動きを相手科目で営業/投資/財務に分類する。
  const cashFlow = useMemo(
    () => buildCashFlow(ledger, accountByName),
    [ledger],
  );
  // 翌年度へ繰り越す期首残高。決算サブビューと財務概要の元入金表示で使う。
  const carryForward = useMemo(
    () => buildClosingBalances(trialBalance, businessType),
    [trialBalance, businessType],
  );

  // 開業以来累計。BSは時点なので累積が期末残高に現れるが、損益は期間なので
  // 年度で切ると積み上げが見えない。ブランドの体力を別枠の指標として出す。
  const cumulative = useMemo(
    () => buildCumulativeSummary(cumulativeEntries, fixedAssets, fiscalYear),
    [cumulativeEntries, fixedAssets, fiscalYear],
  );

  // ここから財務概要の派生値。すべて上の仕訳・元帳・試算表から導く。
  // 資金推移。月次＝月末の資金残高、通期＝期首からの累積増減。
  const cashTrend = useMemo(
    () => buildMonthlyCashTrend(ledger, fiscalYear),
    [ledger, fiscalYear],
  );
  // 安全水準は3ヶ月分の固定費（経費の月平均×3）。
  const safetyLevel = useMemo(
    () => cashSafetyLevel(profitAndLoss.operatingExpenses),
    [profitAndLoss.operatingExpenses],
  );
  // 目標線は財務前提の売上見込みが入っているときだけ引く（架空の目標は置かない）。
  const cashTargets = useMemo(
    () =>
      buildCashTargetLine(
        cashTrend.openingCash,
        plan.salesRevenue,
        profitAndLoss.expenseTotal,
      ),
    [cashTrend.openingCash, plan.salesRevenue, profitAndLoss.expenseTotal],
  );
  const isMonthlyTrend = cashTrendMode === "monthly";
  const trendPoints = useMemo(
    () =>
      cashTrend.points.map((point) => ({
        label: point.label,
        value: isMonthlyTrend ? point.balance : point.cumulativeNet,
      })),
    [cashTrend.points, isMonthlyTrend],
  );
  const trendTargets = useMemo(() => {
    if (!cashTargets) return null;
    return isMonthlyTrend
      ? cashTargets
      : cashTargets.map((value) => value - cashTrend.openingCash);
  }, [cashTargets, isMonthlyTrend, cashTrend.openingCash]);

  // 資金予定は「日付が今後30日以内の登録済み取引」。予定表の別テーブルは持たない。
  const cashSchedule = useMemo(
    () => buildCashSchedule([...expenses, ...incomes], today, 30),
    [expenses, incomes, today],
  );
  const dueSoon = useMemo(
    () => cashSchedule.outgoing.filter((row) => row.date <= addDays(today, 7)),
    [cashSchedule.outgoing, today],
  );
  const overviewActions = useMemo(
    () =>
      buildOverviewActions({
        trial: trialBalance,
        receivableEntryCount: countReceivableEntries(incomes, businessType),
        dueSoon,
        closingCash: cashFlow.closingCash,
        safetyLevel,
        isBalanced: trialBalance.isBalanced && cashFlow.difference === 0,
      }),
    [
      trialBalance,
      incomes,
      businessType,
      dueSoon,
      cashFlow.closingCash,
      cashFlow.difference,
      safetyLevel,
    ],
  );

  // 構成比。売上高は収入概要別、売上原価と販管費は勘定科目別に集計する。
  const salesComposition = useMemo(
    () => buildSalesComposition(incomes),
    [incomes],
  );
  const costOfSalesComposition = useMemo(
    () => buildCostOfSalesComposition(trialBalance),
    [trialBalance],
  );
  const sgaComposition = useMemo(
    () => buildSgaComposition(trialBalance),
    [trialBalance],
  );
  const compositionTotal = (items: CompositionItem[]) =>
    items.reduce((sum, item) => sum + item.amount, 0);
  // 現金増減額＝営業CF＋投資CF＋財務CF。期首に足すと期末残高になる。
  const cashFlowNet =
    cashFlow.operating + cashFlow.investing + cashFlow.financing;
  // 自己資本比率＝（純資産＋当期純利益）÷ 総資産。
  const equityRatio =
    balanceSheet.assetTotal > 0
      ? ((balanceSheet.equityTotal + balanceSheet.netIncome)
          / balanceSheet.assetTotal)
        * 100
      : 0;

  // 利益構造に流す値。年度は損益計算書、累計は開業以来の集計から取る。
  // 右下の指標も切り替える：年度＝当期の結果、累計＝開業以来の投下資本。
  const isCumulativeScope = profitScopeMode === "cumulative";
  const profitScope = isCumulativeScope
    ? {
        salesLabel: "累計売上高",
        sales: cumulative.sales,
        costOfSalesLabel: "累計売上原価",
        costOfSales: cumulative.costOfSales,
        operatingExpensesLabel: "累計販売費及び一般管理費",
        operatingExpenses: cumulative.operatingExpenses,
        profitLabel: "累計利益",
        profit: cumulative.netIncome,
        metrics: [
          {
            icon: "ri-building-line",
            label: "累計設備投資",
            value: currency(cumulative.capitalInvestment),
            negative: false,
          },
          {
            icon: "ri-safe-line",
            label: "元入金（期末）",
            value: currency(carryForward.get("2910") ?? 0),
            negative: false,
          },
        ],
      }
    : {
        salesLabel: "売上高",
        sales: profitAndLoss.sales,
        costOfSalesLabel: "売上原価",
        costOfSales: profitAndLoss.costOfSales,
        operatingExpensesLabel: "販売費及び一般管理費",
        operatingExpenses: profitAndLoss.operatingExpenses,
        profitLabel: "営業利益",
        profit: profitAndLoss.operatingProfit,
        metrics: [
          {
            icon: "ri-money-cny-circle-line",
            label: "当期純利益",
            value: signedCurrency(profitAndLoss.netIncome),
            negative: profitAndLoss.netIncome < 0,
          },
          {
            icon: "ri-pie-chart-line",
            label: "自己資本比率",
            value: percent(equityRatio),
            negative: false,
          },
        ],
      };

  // 仕訳帳の表示行（借方1行・貸方1行を1行に畳んだ形）。新しい順に並べる。
  const journalRows = useMemo(
    () =>
      journal
        .map((entry) => {
          const debitLine = entry.lines.find((line) => line.debit > 0);
          const creditLine = entry.lines.find((line) => line.credit > 0);
          return {
            date: entry.date,
            number: entry.number,
            debit: debitLine?.account.name ?? "—",
            credit: creditLine?.account.name ?? "—",
            amount: debitLine?.debit ?? 0,
            description: entry.description,
            partner: entry.partner || "—",
          };
        })
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) || b.number.localeCompare(a.number),
        ),
    [journal],
  );

  const handleAddExpense = async () => {
    const amount = Number(form.amount);
    if (
      !form.date ||
      !form.item.trim() ||
      !form.category.trim() ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      const summaryLabel =
        form.entryType === "income" ? "収入概要" : "支出概要";
      setFormMessage(
        `日付・${summaryLabel}・勘定科目・1円以上の金額を入力してください。`,
      );
      return;
    }
    // 会計期間は日付から決まる。選択中の年度外の日付は保存しても一覧に出ないため弾く。
    if (fiscalYearOf(form.date) !== fiscalYear) {
      setFormMessage(
        `日付は選択中の会計期間（${fiscalYear}/01/01〜${fiscalYear}/12/31）の範囲で入力してください。`,
      );
      return;
    }
    const typeLabel = form.entryType === "income" ? "収入" : "支出";
    // 訂正は削除＋再登録にしない。expense.update で履歴を1本につなぐ
    // （電子帳簿保存法の真実性の要件）。
    const isEditing = editingEntryId !== null;
    const expense = {
      entryType: form.entryType,
      date: form.date,
      category: form.category,
      item: form.item.trim(),
      partner: form.partner.trim(),
      amount: Math.round(amount),
      paymentMethod: form.paymentMethod,
      memo: form.memo.trim(),
      seasonTag: form.seasonTag || null,
    };

    try {
      setIsSaving(true);
      setFormMessage(null);
      const result = await postMutation(
        isEditing
          ? {
            operation: "expense.update",
            fiscalYear,
            expenseId: editingEntryId,
            expense,
          }
          : { operation: "expense.create", fiscalYear, expense },
      );
      // 新規登録では取引IDが保存後に決まるため、Drawer で受けた証憑はここでまとめて送る。
      const createdId = Number(result?.resourceId);
      if (!isEditing && Number.isFinite(createdId) && pendingReceipts.length > 0) {
        for (const file of pendingReceipts) {
          await uploadReceiptFile(createdId, file);
        }
        setPendingReceipts([]);
      }
      await loadFinanceData();
      // 保存が通ったら Drawer を閉じるので、完了の知らせは画面右下の Toast に出す。
      // Drawer 内の formMessage は入力を直させたいエラー専用にする。
      setFormMessage(null);
      if (isEditing) {
        setEditingEntryId(null);
        setForm(emptyEntryForm);
        notifySuccess(`${typeLabel}を訂正しました。履歴に記録されます。`);
      } else {
        setForm((current) => ({
          ...current,
          item: shiyouOptionsFor(current.entryType)[0],
          amount: "",
          memo: "",
        }));
        notifySuccess(`${typeLabel}を保存し、仕訳帳と財務概要へ反映しました。`);
      }
      setIsEntryDrawerOpen(false);
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : `${typeLabel}の${isEditing ? "訂正" : "保存"}に失敗しました。`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  /** 一覧の行を訂正フォームへ読み込み、入力用の Drawer を開く。 */
  const handleStartEdit = (entry: Expense) => {
    setEditingEntryId(entry.id);
    setSelectedTemplateName("");
    setFormMessage(null);
    setPendingReceipts([]);
    setIsEntryDrawerOpen(true);
    setForm({
      entryType: entry.entryType,
      date: entry.date,
      category: entry.category,
      item: entry.item,
      partner: entry.partner,
      amount: String(entry.amount),
      paymentMethod: entry.paymentMethod,
      memo: entry.memo,
      seasonTag: entry.seasonTag ?? "",
    });
  };

  const handleCancelEdit = () => {
    setEditingEntryId(null);
    setForm(emptyEntryForm);
    setFormMessage(null);
    setPendingReceipts([]);
    setIsEntryDrawerOpen(false);
  };

  /** 新規登録の Drawer を開く。訂正中だった内容は破棄する。 */
  const handleOpenNewEntry = () => {
    setEditingEntryId(null);
    setForm(emptyEntryForm);
    setFormMessage(null);
    setSelectedTemplateName("");
    setPendingReceipts([]);
    setIsEntryDrawerOpen(true);
  };

  // 種別（支出/収入）切替。勘定科目は種別で選択肢が変わるため未選択に戻し、
  // 概要・入出金方法はその種別の先頭にリセットする。
  // テンプレートは種別ごとに別管理のため選択状態も解除する。
  const handleEntryTypeChange = (entryType: EntryType) => {
    setForm((current) => ({
      ...current,
      entryType,
      category: "",
      item: shiyouOptionsFor(entryType)[0],
      paymentMethod: paymentOptionsFor(entryType)[0],
    }));
    setSelectedTemplateName("");
    setIsSavingTemplate(false);
    setNewTemplateName("");
  };

  // 事業形態切替。勘定科目の選択肢が変わるため、選択済みの科目が
  // 新しい選択肢に無ければ未選択へ戻す。
  const handleBusinessTypeChange = async (next: BusinessType) => {
    setBusinessType(next);
    setForm((current) => {
      const stillAvailable = accountOptionsFor(current.entryType, next).some(
        (option) => option.value === current.category,
      );
      return stillAvailable ? current : { ...current, category: "" };
    });
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "businessType.update",
        fiscalYear,
        businessType: next,
      });
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "事業形態の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddPartner = async () => {
    const name = newPartnerName.trim();
    if (!name) {
      setFormMessage("取引先名を入力してください。");
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "partner.create",
        partnerName: name,
      });
      await loadFinanceData();
      // 登録した取引先を選択済みにする。
      setForm((current) => ({ ...current, partner: name }));
      setNewPartnerName("");
      setIsAddingPartner(false);
      setFormMessage("取引先を登録しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error ? error.message : "取引先の登録に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // テンプレート選択：勘定科目・支出概要・金額・支払い方法・メモをフォームへ反映する。
  const handleTemplateSelect = (value: string) => {
    if (value === SAVE_TEMPLATE_SENTINEL) {
      // 保存時の名前の初期値は「支出概要 / 金額」。保存前に変更可能。
      setNewTemplateName(
        `${form.item} / ${currency(Number(form.amount) || 0)}`,
      );
      setIsSavingTemplate(true);
      return;
    }
    setIsSavingTemplate(false);
    if (value === "") {
      setSelectedTemplateName("");
      return;
    }
    const template = templates.find((item) => item.name === value);
    if (template) {
      // テンプレートの種別（支出/収入）もフォームへ反映する。
      setForm((current) => ({
        ...current,
        entryType: template.entryType,
        category: template.category,
        item: template.item,
        amount: template.amount > 0 ? String(template.amount) : "",
        paymentMethod: template.paymentMethod,
        memo: template.memo,
      }));
    }
    setSelectedTemplateName(value);
  };

  const handleSaveTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      setFormMessage("テンプレート名を入力してください。");
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "template.create",
        template: {
          name,
          entryType: form.entryType,
          category: form.category,
          item: form.item,
          amount: Math.max(0, Math.round(Number(form.amount) || 0)),
          paymentMethod: form.paymentMethod,
          memo: form.memo.trim(),
        },
      });
      await loadFinanceData();
      setSelectedTemplateName(name);
      setNewTemplateName("");
      setIsSavingTemplate(false);
      setFormMessage("テンプレートを保存しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "テンプレートの保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplateName) {
      return;
    }
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "template.delete",
        templateName: selectedTemplateName,
      });
      await loadFinanceData();
      setSelectedTemplateName("");
      setFormMessage("テンプレートを削除しました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "テンプレートの削除に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const updateProduct = (
    productId: string,
    updater: (product: Product) => Product,
  ) => {
    setProducts((current) => {
      const exists = current.some((product) => product.id === productId);
      return exists
        ? current.map((product) =>
            product.id === productId ? updater(product) : product,
          )
        : [...current, updater(emptyProduct)];
    });
  };

  const handleDeleteExpense = async (expense: Expense) => {
    const previousExpenses = expenses;
    const previousIncomes = incomes;
    const typeLabel = expense.entryType === "income" ? "収入" : "支出";
    try {
      setIsSaving(true);
      setDataMessage(null);
      // クリック直後に行を消し、API失敗時だけ元に戻す。支出・収入どちらの行でも同じ処理。
      setExpenses((current) =>
        current.filter((item) => item.id !== expense.id),
      );
      setIncomes((current) => current.filter((item) => item.id !== expense.id));
      await postMutation({
        operation: "expense.delete",
        fiscalYear,
        expenseId: expense.id,
      });
      await loadFinanceData();
      notifySuccess(`${typeLabel}をSupabaseから削除しました。`);
    } catch (error) {
      setExpenses(previousExpenses);
      setIncomes(previousIncomes);
      notifyError(error, `${typeLabel}の削除に失敗しました。`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveProduct = async () => {
    try {
      setIsSaving(true);
      setDataMessage(null);
      await postMutation({
        operation: "product.upsert",
        seasonKey,
        product: selectedProduct,
      });
      await loadFinanceData();
      notifySuccess(`${selectedProduct.name}の原価・売価を保存しました。`);
    } catch (error) {
      notifyError(error, "商品原価の保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePlan = async () => {
    try {
      setIsSaving(true);
      setDataMessage(null);
      await postMutation({ operation: "plan.update", fiscalYear, plan });
      notifySuccess("財務前提を保存しました。");
    } catch (error) {
      notifyError(error, "財務前提の保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  };

  const handleJournalExport = () => {
    exportCsv(`${fiscalYearLabel}_仕訳帳.csv`, [
      [
        "取引日",
        "仕訳番号",
        "借方勘定科目",
        "借方金額",
        "貸方勘定科目",
        "貸方金額",
        "支出概要",
        "取引先・補助科目",
      ],
      ...journalRows.map((row) => [
        row.date,
        row.number,
        row.debit,
        row.amount,
        row.credit,
        row.amount,
        row.description,
        row.partner,
      ]),
    ]);
  };

  const handleGeneralLedgerExport = () => {
    if (!selectedLedger) return;
    exportCsv(
      `${fiscalYearLabel}_総勘定元帳_${selectedLedger.account.name}.csv`,
      [
        ["日付", "仕訳番号", "相手科目", "摘要", "取引先", "借方", "貸方", "残高"],
        ["", "", "", "前期繰越", "", "", "", selectedLedger.openingBalance],
        ...selectedLedger.rows.map((row) => [
          row.date,
          row.number,
          row.counterAccount,
          row.description,
          row.partner,
          row.debit,
          row.credit,
          row.balance,
        ]),
        [
          "",
          "",
          "",
          "合計",
          "",
          selectedLedger.debitTotal,
          selectedLedger.creditTotal,
          selectedLedger.closingBalance,
        ],
      ],
    );
  };

  const handleTrialBalanceExport = () => {
    exportCsv(`${fiscalYearLabel}_合計残高試算表.csv`, [
      [
        "コード",
        "勘定科目",
        "会計区分",
        "借方合計",
        "貸方合計",
        "借方残高",
        "貸方残高",
      ],
      ...trialBalance.rows.map((row) => [
        row.account.code,
        row.account.name,
        ACCOUNT_TYPE_LABELS[row.account.type],
        row.debitTotal,
        row.creditTotal,
        row.debitBalance,
        row.creditBalance,
      ]),
      [
        "",
        "合計",
        "",
        trialBalance.debitTotal,
        trialBalance.creditTotal,
        trialBalance.debitBalanceTotal,
        trialBalance.creditBalanceTotal,
      ],
    ]);
  };

  // 財務3表のエクスポート。すべて仕訳の実残高から出力する。
  const handleStatementExport = (statement: "pl" | "bs" | "cf") => {
    if (statement === "pl") {
      exportCsv(`${fiscalYearLabel}_損益計算書.csv`, [
        ["区分", "科目", "金額"],
        ...profitAndLoss.sections.flatMap((section) => [
          ...section.lines.map((line) => [
            section.section,
            line.account.name,
            line.amount,
          ]),
          [section.section, "小計", section.total],
        ]),
        ["", "", ""],
        ["集計", "売上（収入）金額", profitAndLoss.sales],
        ["集計", "差引原価", profitAndLoss.costOfSales],
        ["集計", "差引金額（売上総利益）", profitAndLoss.grossProfit],
        ["集計", "経費", profitAndLoss.operatingExpenses],
        ["集計", "差引金額", profitAndLoss.operatingProfit],
        ["集計", "当期純利益", profitAndLoss.netIncome],
      ]);
      return;
    }
    if (statement === "bs") {
      exportCsv(`${fiscalYearLabel}_貸借対照表.csv`, [
        ["区分", "決算書区分", "科目", "金額"],
        ...balanceSheet.assetSections.flatMap((section) =>
          section.lines.map((line) => [
            "資産",
            section.section,
            line.account.name,
            line.amount,
          ]),
        ),
        ["資産", "", "資産合計", balanceSheet.assetTotal],
        ...balanceSheet.liabilitySections.flatMap((section) =>
          section.lines.map((line) => [
            "負債",
            section.section,
            line.account.name,
            line.amount,
          ]),
        ),
        ["負債", "", "負債合計", balanceSheet.liabilityTotal],
        ...balanceSheet.equitySections.flatMap((section) =>
          section.lines.map((line) => [
            "純資産",
            section.section,
            line.account.name,
            line.amount,
          ]),
        ),
        ["純資産", "", "当期純利益", balanceSheet.netIncome],
        [
          "純資産",
          "",
          "負債・純資産合計",
          balanceSheet.liabilityAndEquityTotal,
        ],
        ["検算", "", "貸借差額", balanceSheet.difference],
      ]);
      return;
    }
    exportCsv(`${fiscalYearLabel}_キャッシュフロー計算書.csv`, [
      ["活動区分", "相手科目", "金額"],
      ["", "期首現金・預金", cashFlow.openingCash],
      ...(["operating", "investing", "financing"] as CashFlowCategory[]).flatMap(
        (category) => [
          ...cashFlow.lines
            .filter((line) => line.category === category)
            .map((line) => [
              CASH_FLOW_CATEGORY_LABELS[category],
              line.account,
              line.amount,
            ]),
          [CASH_FLOW_CATEGORY_LABELS[category], "小計", cashFlow[category]],
        ],
      ),
      ["", "期末現金・預金", cashFlow.closingCash],
      ["検算", "差額", cashFlow.difference],
    ]);
  };

  const summaryView = (
    <div className="space-y-4">
      {/* 上段：左に資金の現在地（推移・キャッシュブリッジ）、右に直近の予定と要対応。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="資金推移"
            title={<span className={panelTitleClassName}>資金推移</span>}
            actions={
              <div
                className="flex rounded-sm bg-[#f2f2f2] p-0.5"
                role="group"
                aria-label="資金推移の表示単位"
              >
                {(
                  [
                    ["monthly", "月次"],
                    ["cumulative", "通期"],
                  ] as const
                ).map(([mode, label]) => {
                  const active = cashTrendMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCashTrendMode(mode)}
                      className={`h-6 rounded-sm px-3 font-acumin text-[11px] transition-colors ${
                        active
                          ? "bg-black text-white"
                          : "bg-transparent text-[#474747] hover:text-black"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-acumin text-[10px] text-[#474747]">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-px w-5 bg-black"
                  aria-hidden="true"
                />
                実績（{isMonthlyTrend ? "手元資金" : "期首からの累積増減"}）
              </span>
              {trendTargets ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-px w-5 border-t border-dashed border-[#707070]"
                    aria-hidden="true"
                  />
                  目標
                </span>
              ) : null}
              {isMonthlyTrend && safetyLevel > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-5 bg-[#e8f1e9]"
                    aria-hidden="true"
                  />
                  安全水準（3ヶ月分固定費）
                </span>
              ) : null}
            </div>
            {/* 画面が狭いときはパネル内だけを横スクロールさせ、グラフを潰さない。 */}
            <div className="mt-2 overflow-x-auto">
              <div className="min-w-[520px]">
                <CashTrendChart
                  points={trendPoints}
                  targets={trendTargets}
                  safetyLevel={isMonthlyTrend ? safetyLevel : 0}
                  ariaLabel={`${fiscalYearLabel}の資金推移グラフ（${isMonthlyTrend ? "月次" : "通期"}）`}
                />
              </div>
            </div>
            <p className="mt-2 font-acumin text-[10px] leading-relaxed text-[#707070]">
              {trendTargets
                ? "目標＝期首資金＋（財務前提の売上見込み − 当期費用）÷12×経過月。"
                : "目標線は財務前提の売上見込みを入力すると表示されます。"}
              安全水準＝経費の月平均×3ヶ月。
            </p>
          </Panel>

          {/* 期首 + 営業CF + 投資CF + 財務CF = 期末。直接法なので必ず一致する。 */}
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="キャッシュブリッジ"
            title={
              <span className={panelTitleClassName}>キャッシュブリッジ</span>
            }
            actions={
              <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
                会計期間 {fiscalYear}/01/01〜{fiscalYear}/12/31
              </span>
            }
          >
            <div className="overflow-x-auto">
              <div className="flex flex-col gap-1.5 lg:min-w-[460px] lg:flex-row lg:items-stretch">
                <FlowBlock
                  size="sm"
                  label="期首残高"
                  value={cashFlow.openingCash}
                />
                <FlowOperator symbol="＋" />
                <FlowBlock size="sm" label="営業CF" value={cashFlow.operating} />
                <FlowOperator symbol="＋" />
                <FlowBlock size="sm" label="投資CF" value={cashFlow.investing} />
                <FlowOperator symbol="＋" />
                <FlowBlock size="sm" label="財務CF" value={cashFlow.financing} />
                <FlowOperator symbol="＝" />
                <FlowBlock
                  size="sm"
                  label="期末残高"
                  value={cashFlow.closingCash}
                  emphasis
                />
              </div>
            </div>
            <p
              className={`mt-2 text-right font-acumin text-[11px] ${cashFlow.difference === 0 ? "text-[#16844b]" : "text-red-700"}`}
              role="status"
            >
              <i
                className={`mr-1 ${cashFlow.difference === 0 ? "ri-checkbox-circle-line" : "ri-error-warning-line"}`}
                aria-hidden="true"
              />
              {cashFlow.difference === 0
                ? "検算一致"
                : `検算差額 ${currency(cashFlow.difference)}`}
            </p>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="今後30日の資金予定"
            title={
              <span className={panelTitleClassName}>今後30日の資金予定</span>
            }
            actions={
              <span className="font-acumin text-[10px] text-[#707070] tabular-nums">
                {cashSchedule.from.replaceAll("-", "/")}〜
                {cashSchedule.to.replaceAll("-", "/")}
              </span>
            }
          >
            {[
              {
                title: "入金予定",
                rows: cashSchedule.incoming,
                total: cashSchedule.incomingTotal,
              },
              {
                title: "支払予定",
                rows: cashSchedule.outgoing,
                total: cashSchedule.outgoingTotal,
              },
            ].map((group) => (
              <div key={group.title} className="mt-4">
                <div className="flex items-baseline justify-between gap-2 border-b border-[#d4d4d4] pb-1.5">
                  <span className="font-acumin text-xs font-medium text-black">
                    {group.title}
                  </span>
                  <span className="font-acumin text-xs text-black tabular-nums">
                    {currency(group.total)}
                  </span>
                </div>
                {group.rows.length === 0 ? (
                  <p className="mt-2 font-acumin text-[11px] text-[#707070]">
                    予定なし
                  </p>
                ) : (
                  group.rows.map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-[#ededed] py-1.5"
                    >
                      <span className="font-acumin text-[11px] text-[#474747] tabular-nums">
                        {row.date.replaceAll("-", "/")}
                      </span>
                      <span className="truncate font-acumin text-[11px] text-black">
                        {row.partner || "—"}
                      </span>
                      <span className="truncate font-acumin text-[11px] text-[#474747]">
                        {row.item}
                      </span>
                      <span className="whitespace-nowrap font-acumin text-[11px] text-black tabular-nums">
                        {currency(row.amount)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ))}
            <p className="mt-3 font-acumin text-[10px] leading-relaxed text-[#707070]">
              ※
              取引管理に登録済みで、日付が今後30日以内の取引を予定として集計しています。
            </p>
          </Panel>

          {/* 要対応は実データで条件を満たしたものだけを出す。空＝対応不要。 */}
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="アクション"
            title={<span className={panelTitleClassName}>アクション</span>}
          >
            {overviewActions.length === 0 ? (
              <p className="flex items-center gap-1.5 font-acumin text-xs text-[#16844b]">
                <i className="ri-checkbox-circle-line" aria-hidden="true" />
                要対応の項目はありません。
              </p>
            ) : (
              <ul className="-mt-1">
                {overviewActions.map((action) => (
                  <li key={action.key}>
                    <button
                      type="button"
                      onClick={() => setActiveTab(action.target)}
                      className={`flex w-full items-center gap-2 border-b border-[#ededed] px-1 py-2.5 text-left transition-colors hover:bg-[#faf7f2] ${boxRadiusClassName}`}
                    >
                      <i
                        className="ri-error-warning-line shrink-0 text-[#b45309]"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 font-acumin text-xs text-black">
                        {action.message}
                      </span>
                      <StatusBadge
                        tone="warning"
                        shape="rounded"
                        accent
                        size="3xs"
                        className="shrink-0 font-acumin"
                      >
                        要対応
                      </StatusBadge>
                      <i
                        className="ri-arrow-right-s-line shrink-0 text-[#707070]"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* 中段：財務3表。すべて仕訳の実残高から導出する（架空の係数は使わない）。 */}
      <Panel
        radius="rounded"
        tone="muted"
        aria-label="財務3表"
        title={
          <span className="flex items-center gap-2">
            <span className={panelTitleClassName}>財務3表</span>
            <StatusBadge
              tone="neutral"
              shape="pill"
              size="3xs"
              className="bg-[#ededed] font-acumin tracking-wider text-[#707070]"
            >
              自動連動
            </StatusBadge>
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* 構成比は売上高を100%とする。売上原価は期首棚卸＋当期仕入−期末棚卸。 */}
          <StatementTable
            title="損益計算書（P/L）"
            exportLabel="損益計算書CSV"
            onExport={() => handleStatementExport("pl")}
            showRatio
            rows={[
              {
                label: "売上高",
                value: profitAndLoss.sales,
                ratio: ratioOf(profitAndLoss.sales, profitAndLoss.sales),
              },
              {
                label: "売上原価",
                value: -profitAndLoss.costOfSales,
                ratio: ratioOf(-profitAndLoss.costOfSales, profitAndLoss.sales),
              },
              {
                label: "売上総利益",
                value: profitAndLoss.grossProfit,
                ratio: ratioOf(profitAndLoss.grossProfit, profitAndLoss.sales),
                emphasis: true,
              },
              {
                label: "販売費及び一般管理費",
                value: -profitAndLoss.operatingExpenses,
                ratio: ratioOf(
                  -profitAndLoss.operatingExpenses,
                  profitAndLoss.sales,
                ),
              },
              {
                label: "営業利益",
                value: profitAndLoss.operatingProfit,
                ratio: ratioOf(
                  profitAndLoss.operatingProfit,
                  profitAndLoss.sales,
                ),
                emphasis: true,
              },
              {
                label: "当期純利益",
                value: profitAndLoss.netIncome,
                ratio: ratioOf(profitAndLoss.netIncome, profitAndLoss.sales),
                emphasis: true,
              },
            ]}
            aside={
              profitAndLoss.sales > 0 ? (
                <ProfitLadderBar
                  steps={[
                    { label: "売上高", ratio: 100 },
                    {
                      label: "売上総利益",
                      ratio:
                        (profitAndLoss.grossProfit / profitAndLoss.sales) * 100,
                    },
                    {
                      label: "営業利益",
                      ratio:
                        (profitAndLoss.operatingProfit / profitAndLoss.sales)
                        * 100,
                    },
                    {
                      label: "当期純利益",
                      ratio:
                        (profitAndLoss.netIncome / profitAndLoss.sales) * 100,
                    },
                  ]}
                />
              ) : undefined
            }
          />
          {/* 構成比は資産合計を100%とする。当期純利益は決算振替前なので純資産に足す。 */}
          <StatementTable
            title="貸借対照表（B/S）"
            exportLabel="貸借対照表CSV"
            onExport={() => handleStatementExport("bs")}
            showRatio
            rows={[
              {
                label: "資産",
                value: balanceSheet.assetTotal,
                ratio: ratioOf(
                  balanceSheet.assetTotal,
                  balanceSheet.assetTotal,
                ),
              },
              {
                label: "負債",
                value: balanceSheet.liabilityTotal,
                ratio: ratioOf(
                  balanceSheet.liabilityTotal,
                  balanceSheet.assetTotal,
                ),
              },
              {
                label: "純資産",
                value: balanceSheet.equityTotal + balanceSheet.netIncome,
                ratio: ratioOf(
                  balanceSheet.equityTotal + balanceSheet.netIncome,
                  balanceSheet.assetTotal,
                ),
              },
            ]}
          >
            <BalanceBars
              assetTotal={balanceSheet.assetTotal}
              liabilityAndEquityTotal={balanceSheet.liabilityAndEquityTotal}
              difference={balanceSheet.difference}
            />
          </StatementTable>
          {/* 直接法なので期首＋増減＝期末が必ず一致する。ずれたら資金科目の判定漏れ。 */}
          <StatementTable
            title="キャッシュ・フロー計算書（C/F）"
            exportLabel="キャッシュフローCSV"
            onExport={() => handleStatementExport("cf")}
            rows={[
              {
                label: "営業キャッシュ・フロー",
                value: cashFlow.operating,
                delta: true,
              },
              {
                label: "投資キャッシュ・フロー",
                value: cashFlow.investing,
                delta: true,
              },
              {
                label: "財務キャッシュ・フロー",
                value: cashFlow.financing,
                delta: true,
              },
              {
                label: "現金増減額",
                value: cashFlowNet,
                delta: true,
                emphasis: true,
              },
            ]}
          >
            <div className="mt-4 border-t border-[#ededed] pt-3">
              <div className="flex items-stretch gap-2">
                <FlowBlock
                  size="sm"
                  label="期首残高"
                  value={cashFlow.openingCash}
                />
                <FlowOperator symbol="→" />
                <FlowBlock
                  size="sm"
                  label="増減額"
                  value={cashFlowNet}
                  display={deltaCurrency(cashFlowNet)}
                  positive
                />
                <FlowOperator symbol="→" />
                <FlowBlock
                  size="sm"
                  label="期末残高"
                  value={cashFlow.closingCash}
                  emphasis
                />
              </div>
              <p
                className={`mt-2 text-center font-acumin text-[11px] ${cashFlow.difference === 0 ? "text-[#16844b]" : "text-red-700"}`}
                role="status"
              >
                <i
                  className={`mr-1 ${cashFlow.difference === 0 ? "ri-checkbox-circle-line" : "ri-error-warning-line"}`}
                  aria-hidden="true"
                />
                {cashFlow.difference === 0
                  ? "検算一致"
                  : `検算差額 ${currency(cashFlow.difference)}`}
              </p>
            </div>
          </StatementTable>
        </div>
        <p
          className={`mt-2 font-acumin text-[10px] ${cashFlow.difference === 0 ? "text-[#707070]" : "text-red-700"}`}
        >
          {cashFlow.difference === 0
            ? "C/F 検算：期首 + 営業CF + 投資CF + 財務CF = 期末（一致）"
            : `C/F 検算：差額 ${currency(cashFlow.difference)}（不一致）`}
        </p>
      </Panel>

      {/*
        利益がどう積み上がっているかを式のまま見せる。
        年度＝選択中の会計期間の実績、累計＝開業以来（選択年の年末まで）の積み上げ。
        損益計算書は「期間」の表なので年度で切ると開業以来の体力が見えない。
      */}
      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="利益構造"
        title={<span className={panelTitleClassName}>利益構造</span>}
        actions={
          <div
            className="flex rounded-sm bg-[#f2f2f2] p-0.5"
            role="group"
            aria-label="利益構造の集計期間"
          >
            {(
              [
                ["fiscalYear", "年度"],
                ["cumulative", "累計"],
              ] as const
            ).map(([mode, label]) => {
              const active = profitScopeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setProfitScopeMode(mode)}
                  className={`h-6 rounded-sm px-3 font-acumin text-[11px] transition-colors ${
                    active
                      ? "bg-black text-white"
                      : "bg-transparent text-[#474747] hover:text-black"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        }
      >
        <p className="font-acumin text-[11px] text-[#707070]">
          {isCumulativeScope
            ? cumulative.firstYear
              ? `${cumulative.firstYear}年〜${fiscalYear}年（${fiscalYear - cumulative.firstYear + 1}期）・${cumulative.entryCount}件の積み上げ`
              : "取引がまだありません"
            : `${fiscalYear}年1月〜12月の実績`}
        </p>
        <div className="mt-3 overflow-x-auto">
          <div className="flex flex-col gap-2 lg:min-w-[720px] lg:flex-row lg:items-stretch">
            <FlowBlock
              label={profitScope.salesLabel}
              value={profitScope.sales}
            />
            <FlowOperator symbol="−" />
            <FlowBlock
              label={profitScope.costOfSalesLabel}
              value={profitScope.costOfSales}
            />
            <FlowOperator symbol="−" />
            <FlowBlock
              label={profitScope.operatingExpensesLabel}
              value={profitScope.operatingExpenses}
            />
            <FlowOperator symbol="＝" />
            <FlowBlock
              label={profitScope.profitLabel}
              value={profitScope.profit}
              emphasis
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-10 gap-y-3 border-t border-[#ededed] pt-4">
          {profitScope.metrics.map((metric) => (
            <div key={metric.label} className="flex items-center gap-2">
              <i
                className={`${metric.icon} text-xl text-[#474747]`}
                aria-hidden="true"
              />
              <div>
                <span className="block font-acumin text-[11px] text-[#474747]">
                  {metric.label}
                </span>
                <span
                  className={`block font-acumin text-base font-medium tabular-nums ${metric.negative ? "text-red-700" : "text-black"}`}
                >
                  {metric.value}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 下段：何で稼ぎ、何に使っているかの構成比。 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <CompositionCard
          title="売上高構成"
          total={compositionTotal(salesComposition)}
          items={salesComposition}
          emptyMessage="収入がまだ登録されていません。"
        />
        <CompositionCard
          title="売上原価構成"
          total={compositionTotal(costOfSalesComposition)}
          items={costOfSalesComposition}
          emptyMessage="仕入・棚卸がまだ登録されていません。"
        />
        <CompositionCard
          title="販売費及び一般管理費構成"
          total={compositionTotal(sgaComposition)}
          items={sgaComposition}
          emptyMessage="経費がまだ登録されていません。"
        />
      </div>

      {/*
        開業時の持ち込み残高と売上見込み。どちらも取引履歴からは導けない。
        期首残高は前年の決算が済めば繰越が優先されるので、開業初年度だけ効く。
      */}
      <details className={`${panelClassName} ${boxRadiusClassName}`}>
        <summary className="cursor-pointer font-acumin text-sm font-medium tracking-widest text-black">
          財務前提を編集
        </summary>
        <p className="mt-3 font-acumin text-[11px] leading-relaxed text-[#707070]">
          {previousClosingBalances
            ? "期首残高は前年の決算から繰り越し済みです。ここでの入力は使われません。売上見込みは資金推移の目標線にだけ使います。"
            : "開業初年度は帳簿に前年がないため、持ち込んだ残高をここで入力します。翌年以降は前年の決算から自動で繰り越します。売上見込みは資金推移の目標線に使います。"}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["salesRevenue", "売上見込み"],
            ["openingCash", "期首現金"],
            ["accountsReceivable", "売掛金"],
            ["fixedAssets", "固定資産"],
            ["accountsPayable", "買掛金・未払金"],
            ["openingCapital", "元入金"],
          ].map(([key, label]) => (
            <label key={key}>
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                {label}
              </span>
              <input
                type="number"
                min="0"
                value={plan[key as keyof FinancePlan]}
                onChange={(event) =>
                  setPlan((current) => ({
                    ...current,
                    [key]: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                className={inputClassName}
                aria-label={label}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            className="font-acumin"
            onClick={() => void handleSavePlan()}
            disabled={isSaving}
          >
            {isSaving ? "保存中..." : "財務前提を保存"}
          </Button>
        </div>
      </details>

      {/* 資金の増減内訳（直接法）。相手科目ごとの実際の入出金。 */}
      <Panel
        radius="rounded"
        aria-label="資金の増減内訳"
        title={<span className={panelTitleClassName}>資金の増減内訳</span>}
        actions={
          <span className="font-acumin text-[11px] text-[#707070]">直接法</span>
        }
      >
        {cashFlow.lines.length === 0 ? (
          <p className="font-acumin text-xs text-[#707070]">
            現金・預金の入出金がまだありません。
          </p>
        ) : (
          <div className="space-y-4">
            {(
              ["operating", "investing", "financing"] as CashFlowCategory[]
            ).map((category) => {
              const lines = cashFlow.lines.filter(
                (line) => line.category === category,
              );
              if (lines.length === 0) return null;
              return (
                <div key={category}>
                  <p className="font-acumin text-[11px] text-[#474747]">
                    {CASH_FLOW_CATEGORY_LABELS[category]}
                  </p>
                  {lines.map((line) => (
                    <div
                      key={`${category}-${line.account}`}
                      className="flex items-center justify-between border-b border-[#ededed] py-2"
                    >
                      <span className="truncate font-acumin text-xs text-black">
                        {line.account}
                      </span>
                      <span
                        className={`font-acumin text-xs tabular-nums ${line.amount >= 0 ? "text-[#16844b]" : "text-black"}`}
                      >
                        {currency(line.amount)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-1.5">
                    <span className="font-acumin text-[11px] text-[#707070]">
                      小計
                    </span>
                    <span className="font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(cashFlow[category])}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );

  const isIncomeForm = form.entryType === "income";
  const entryTypeLabel = isIncomeForm ? "収入" : "支出";
  const paymentFieldLabel = isIncomeForm ? "入金方法" : "出金方法";
  const summaryFieldLabel = isIncomeForm ? "収入概要" : "支出概要";
  // 種別ごとに別管理するテンプレート。
  const visibleTemplates = templates.filter(
    (template) => template.entryType === form.entryType,
  );

  // 検索は取引管理の一覧表示にだけ効かせる。帳簿・財務概要・税務レポートは
  // 年度の全件で集計しないと決算書として成立しないため、絞り込みを反映しない。
  const filteredExpenses = useMemo(
    () => filterEntries(expenses, filter),
    [expenses, filter],
  );
  const filteredIncomes = useMemo(
    () => filterEntries(incomes, filter),
    [incomes, filter],
  );
  const filterActive = isFilterActive(filter);
  const filterConditionCount = activeConditionCount(filter);
  const updateFilter = (patch: Partial<EntryFilter>) =>
    setFilter((current) => ({ ...current, ...patch }));

  // 絞り込みの選択肢は当年度の実データから作る（使われていない科目を出さない）。
  const allEntries = useMemo(() => [...expenses, ...incomes], [
    expenses,
    incomes,
  ]);
  const filterAccountOptions = useMemo(
    () =>
      [...new Set(allEntries.map((entry) => entry.category))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "ja")),
    [allEntries],
  );
  const filterPartnerOptions = useMemo(
    () =>
      [...new Set(allEntries.map((entry) => entry.partner))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "ja")),
    [allEntries],
  );

  const filterFieldClassName =
    "h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin text-xs text-black outline-none transition-colors focus:border-black";

  // ── 取引管理 ───────────────────────────────────────────────────────────
  // 支出・収入を1つの表に統合する。会計上どちらも「取引」で、状態・証憑・
  // 訂正履歴の運用も同じなので、2つの表に割ると確認漏れの原因になる。

  // 訂正履歴のある取引（電子帳簿保存法の真実性の要件で残る update 履歴）。
  const revisedEntryIds = useMemo(
    () =>
      new Set(
        revisions
          .filter((revision) => revision.operation === "update")
          .map((revision) => revision.entryId),
      ),
    [revisions],
  );

  // 同一日付・同一取引先・同一金額は二重入力の疑いがあるため金額の確認対象にする。
  const duplicateEntryIds = useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const entry of allEntries) {
      const key = `${entry.date}|${entry.partner}|${entry.amount}`;
      groups.set(key, [...(groups.get(key) ?? []), entry.id]);
    }
    return new Set(
      [...groups.values()].filter((ids) => ids.length > 1).flat(),
    );
  }, [allEntries]);

  // 勘定科目マスタに無い科目は決算書の区分が決まらないので確認対象にする。
  const unknownAccountEntryIds = useMemo(
    () =>
      new Set(
        allEntries
          .filter((entry) => !accountByName(entry.category))
          .map((entry) => entry.id),
      ),
    [allEntries],
  );

  const entryStateOf = useCallback(
    (entry: Expense): EntryState => {
      if (revisedEntryIds.has(entry.id)) return "revised";
      if (duplicateEntryIds.has(entry.id) || unknownAccountEntryIds.has(entry.id)) {
        return "review";
      }
      return "registered";
    },
    [revisedEntryIds, duplicateEntryIds, unknownAccountEntryIds],
  );

  const hasReceipt = (entry: Expense) => (entry.receipts ?? []).length > 0;

  // 一覧は日付の新しい順。同日は登録の新しい順（id 降順）で並べる。
  const entryRows = useMemo<Expense[]>(
    () =>
      [...filteredExpenses, ...filteredIncomes].sort((a, b) =>
        a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
      ),
    [filteredExpenses, filteredIncomes],
  );

  const entryTabCounts = useMemo(
    () => ({
      all: entryRows.length,
      noReceipt: entryRows.filter((entry) => !hasReceipt(entry)).length,
      review: entryRows.filter((entry) => entryStateOf(entry) === "review").length,
      revised: entryRows.filter((entry) => entryStateOf(entry) === "revised").length,
    }),
    [entryRows, entryStateOf],
  );

  const tabbedEntryRows = useMemo(() => {
    if (entryListTab === "noReceipt") {
      return entryRows.filter((entry) => !hasReceipt(entry));
    }
    if (entryListTab === "review") {
      return entryRows.filter((entry) => entryStateOf(entry) === "review");
    }
    if (entryListTab === "revised") {
      return entryRows.filter((entry) => entryStateOf(entry) === "revised");
    }
    return entryRows;
  }, [entryRows, entryListTab, entryStateOf]);

  const entryTotalPages = Math.max(
    1,
    Math.ceil(tabbedEntryRows.length / ENTRY_PAGE_SIZE),
  );
  // 絞り込みで件数が減ってもページ番号が範囲外に残らないようにする。
  const currentEntryPage = Math.min(entryPage, entryTotalPages);
  const pagedEntryRows = tabbedEntryRows.slice(
    (currentEntryPage - 1) * ENTRY_PAGE_SIZE,
    currentEntryPage * ENTRY_PAGE_SIZE,
  );
  const entryRangeStart =
    tabbedEntryRows.length === 0 ? 0 : (currentEntryPage - 1) * ENTRY_PAGE_SIZE + 1;
  const entryRangeEnd = Math.min(
    currentEntryPage * ENTRY_PAGE_SIZE,
    tabbedEntryRows.length,
  );

  // 取引ステータス（ドーナツ）。合計は一覧に出ている件数と一致させる。
  const entryStatusCounts = useMemo(() => {
    let review = 0;
    let revised = 0;
    for (const entry of entryRows) {
      const state = entryStateOf(entry);
      if (state === "review") review += 1;
      else if (state === "revised") revised += 1;
    }
    return {
      registered: entryRows.length - review - revised,
      review,
      revised,
      total: entryRows.length,
    };
  }, [entryRows, entryStateOf]);

  // 証憑ステータス（ドーナツ）。電子取引データの保存漏れを一目で出す。
  const receiptStatusCounts = useMemo(() => {
    const attached = entryRows.filter(hasReceipt).length;
    return {
      attached,
      missing: entryRows.length - attached,
      total: entryRows.length,
    };
  }, [entryRows]);

  // 今月の収支。選択中の会計年が当年でなければ、その年の12月を対象にする。
  const monthlyBalance = useMemo(() => {
    const now = new Date();
    const month = now.getFullYear() === fiscalYear ? now.getMonth() + 1 : 12;
    const prefix = `${fiscalYear}-${String(month).padStart(2, "0")}`;
    const sum = (rows: Expense[]) =>
      rows
        .filter((entry) => entry.date.startsWith(prefix))
        .reduce((total, entry) => total + entry.amount, 0);
    const income = sum(incomes);
    const expense = sum(expenses);
    return { month, income, expense, balance: income - expense };
  }, [expenses, incomes, fiscalYear]);

  // 確認キュー。優先順（証憑 → 金額 → 科目 → 訂正）に並べ、空のグループは出さない。
  const reviewQueue = useMemo(() => {
    const rowsFor = (key: ReviewQueueKey) => {
      if (key === "noReceipt") return entryRows.filter((entry) => !hasReceipt(entry));
      if (key === "amount") return entryRows.filter((entry) => duplicateEntryIds.has(entry.id));
      if (key === "account") {
        return entryRows.filter((entry) => unknownAccountEntryIds.has(entry.id));
      }
      return entryRows.filter((entry) => revisedEntryIds.has(entry.id));
    };
    return REVIEW_QUEUE_DEFS.map((def) => ({ ...def, rows: rowsFor(def.key) })).filter(
      (group) => group.rows.length > 0,
    );
  }, [entryRows, duplicateEntryIds, unknownAccountEntryIds, revisedEntryIds]);

  const selectedEntries = entryRows.filter((entry) =>
    selectedEntryIds.includes(entry.id),
  );
  const pageAllSelected =
    pagedEntryRows.length > 0
    && pagedEntryRows.every((entry) => selectedEntryIds.includes(entry.id));

  const toggleEntrySelection = (entryId: number) =>
    setSelectedEntryIds((current) =>
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId],
    );

  const togglePageSelection = () =>
    setSelectedEntryIds((current) => {
      const pageIds = pagedEntryRows.map((entry) => entry.id);
      return pageAllSelected
        ? current.filter((id) => !pageIds.includes(id))
        : [...new Set([...current, ...pageIds])];
    });

  const changeEntryListTab = (tab: EntryListTab) => {
    setEntryListTab(tab);
    setEntryPage(1);
  };

  const handleEntryCsvExport = (rows: Expense[], filename: string) => {
    exportCsv(filename, [
      [
        "取引ID",
        "日付",
        "種別",
        "勘定科目",
        "摘要",
        "取引先",
        "金額",
        "入出金方法",
        "シーズン",
        "証憑",
        "状態",
        "メモ",
      ],
      ...rows.map((entry) => [
        entry.id,
        entry.date,
        entry.entryType === "income" ? "収入" : "支出",
        entry.category,
        entry.item,
        entry.partner,
        entry.amount,
        entry.paymentMethod,
        entry.seasonTag ? formatSeasonLabel(entry.seasonTag) : "",
        hasReceipt(entry) ? "添付済み" : "未添付",
        ENTRY_STATE_LABELS[entryStateOf(entry)],
        entry.memo,
      ]),
    ]);
  };

  /** 証憑 Drawer を開く。複数IDなら選択中の取引をまとめて扱う。 */
  const openReceiptDrawer = (entryIds: number[]) => {
    setReceiptMessage(null);
    setReceiptDrawerEntryIds(entryIds);
  };

  const receiptDrawerEntries = entryRows.filter((entry) =>
    receiptDrawerEntryIds.includes(entry.id),
  );

  // 取引ごとの最終更新（訂正履歴の最新1件）。一覧の「更新履歴」列に出す。
  const latestRevisionOf = (entryId: number) =>
    revisions
      .filter((revision) => revision.entryId === entryId)
      .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))[0];

  const entryColumns: Array<TableColumn<Expense>> = [
    {
      key: "select",
      header: "",
      className: "w-10",
      align: "center",
      render: (entry) => (
        <Checkbox
          size="2xs"
          label=""
          aria-label={`${entry.item}を選択`}
          checked={selectedEntryIds.includes(entry.id)}
          onChange={() => toggleEntrySelection(entry.id)}
        />
      ),
    },
    {
      key: "date",
      header: "日付",
      cellClassName: "whitespace-nowrap tabular-nums",
      render: (entry) => entry.date.replaceAll("-", "/"),
    },
    {
      key: "entryType",
      header: "種別",
      cellClassName: "whitespace-nowrap",
      render: (entry) => (entry.entryType === "income" ? "収入" : "支出"),
    },
    {
      key: "category",
      header: "勘定科目",
      cellClassName: "whitespace-nowrap",
      render: (entry) => entry.category,
    },
    {
      key: "item",
      header: "摘要・取引先",
      render: (entry) => (
        // 行の入口。クリックで訂正 Drawer を開き、削除もその中に置く。
        <button
          type="button"
          className="block max-w-[12rem] truncate text-left underline-offset-4 hover:underline"
          aria-label={`${entry.item}を訂正`}
          onClick={() => handleStartEdit(entry)}
          disabled={isSaving}
        >
          {entry.partner ? `${entry.item} / ${entry.partner}` : entry.item}
        </button>
      ),
    },
    {
      key: "amount",
      header: "金額",
      align: "right",
      cellClassName: "whitespace-nowrap tabular-nums",
      render: (entry) => currency(entry.amount),
    },
    {
      key: "receipt",
      header: "証憑",
      align: "center",
      render: (entry) => {
        const attached = hasReceipt(entry);
        return (
          <button
            type="button"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-[#f0f0f0] ${attached ? "text-black" : "text-[#b45309]"}`}
            aria-label={`${entry.item}の証憑`}
            data-receipt-state={attached ? "attached" : "missing"}
            onClick={() => openReceiptDrawer([entry.id])}
          >
            <i
              className={attached ? "ri-attachment-2" : "ri-file-warning-line"}
              aria-hidden="true"
            />
          </button>
        );
      },
    },
    {
      key: "revision",
      header: "更新履歴",
      cellClassName: "whitespace-nowrap",
      render: (entry) => {
        const revision = latestRevisionOf(entry.id);
        if (!revision) {
          return <span className="text-[#909090]">—</span>;
        }
        const changedAt = new Date(revision.changedAt);
        return (
          <span className="block font-acumin text-[11px] leading-tight text-[#474747] tabular-nums">
            <span className="block">
              {changedAt.toLocaleDateString("ja-JP", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              })}
            </span>
            <span className="block">
              {changedAt.toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </span>
        );
      },
    },
    {
      key: "state",
      header: "状態",
      align: "center",
      render: (entry) => {
        const state = entryStateOf(entry);
        return (
          <StatusBadge
            variant="text"
            shape="pill"
            size="3xs"
            tone={ENTRY_STATE_TONES[state]}
            accent
            className="font-acumin"
          >
            {ENTRY_STATE_LABELS[state]}
          </StatusBadge>
        );
      },
    },
  ];

  /** サマリー3枚の間に置く流れの矢印。狭い画面では出さない。 */
  const summaryChevron = (
    <div
      className="hidden items-center justify-center text-[#b5b5b5] xl:flex"
      aria-hidden="true"
    >
      <i className="ri-arrow-right-s-line text-lg" />
    </div>
  );

  const donutLegendRow = (
    label: string,
    count: number,
    color: string,
    accent: boolean,
  ) => (
    <div key={label} className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        <StatusBadge
          variant="dot"
          size="4xs"
          tone={accent ? "warning" : "neutral"}
          className="shrink-0"
          // 凡例の色はドーナツの扇と1対1で対応させる。
          style={{ background: color }}
        />
        <span className="font-acumin text-xs text-[#474747]">{label}</span>
      </span>
      <span
        className="font-acumin text-xs tabular-nums"
        style={{ color: accent ? color : "#111111" }}
      >
        {count}件
      </span>
    </div>
  );

  // 電子帳簿保存法の検索要件（日付・金額・取引先／範囲指定／条件の組み合わせ）は
  // 「詳細条件」Drawer に集約する。一覧上には常設のキーワード検索だけを置く。
  const filterDrawer = (
    <Drawer
      open={isFilterDrawerOpen}
      onClose={() => setIsFilterDrawerOpen(false)}
      side="right"
      size="md"
      shape="square"
      className="flex w-[min(92vw,420px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          詳細条件
        </h4>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="詳細条件を閉じる"
          onClick={() => setIsFilterDrawerOpen(false)}
        >
          <i className="ri-close-line text-lg" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            取引年月日（範囲）
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="取引年月日（開始）"
              value={filter.dateFrom}
              onChange={(event) => updateFilter({ dateFrom: event.target.value })}
              className={filterFieldClassName}
            />
            <span className="font-acumin text-[11px] text-[#707070]">〜</span>
            <input
              type="date"
              aria-label="取引年月日（終了）"
              value={filter.dateTo}
              onChange={(event) => updateFilter({ dateTo: event.target.value })}
              className={filterFieldClassName}
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            取引金額（範囲）
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              placeholder="下限"
              aria-label="取引金額（下限）"
              value={filter.amountFrom}
              onChange={(event) => updateFilter({ amountFrom: event.target.value })}
              className={filterFieldClassName}
            />
            <span className="font-acumin text-[11px] text-[#707070]">〜</span>
            <input
              type="number"
              min="0"
              placeholder="上限"
              aria-label="取引金額（上限）"
              value={filter.amountTo}
              onChange={(event) => updateFilter({ amountTo: event.target.value })}
              className={filterFieldClassName}
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            取引先
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="sm"
            aria-label="絞り込み：相手先"
            className="font-acumin"
            placeholder="すべて"
            options={[
              { value: "", label: "すべて" },
              ...filterPartnerOptions.map((partner) => ({
                value: partner,
                label: partner,
              })),
            ]}
            value={filter.partner}
            onValueChange={(value) => updateFilter({ partner: value })}
          />
        </div>

        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            勘定科目
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="sm"
            aria-label="絞り込み：科目"
            className="font-acumin"
            placeholder="すべて"
            options={[
              { value: "", label: "すべて" },
              ...filterAccountOptions.map((account) => ({
                value: account,
                label: account,
              })),
            ]}
            value={filter.account}
            onValueChange={(value) => updateFilter({ account: value })}
          />
        </div>

        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            種別
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="sm"
            aria-label="絞り込み：収支区分"
            className="font-acumin"
            placeholder="支出・収入"
            options={[
              { value: "", label: "支出・収入" },
              { value: "expense", label: "支出のみ" },
              { value: "income", label: "収入のみ" },
            ]}
            value={filter.entryType}
            onValueChange={(value) =>
              updateFilter({ entryType: value as EntryFilter["entryType"] })
            }
          />
        </div>

        <div>
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            キーワード（取引ID・概要・メモ・取引先）
          </span>
          <input
            type="search"
            placeholder="部分一致で検索"
            aria-label="絞り込み：キーワード"
            value={filter.keyword}
            onChange={(event) => updateFilter({ keyword: event.target.value })}
            className={filterFieldClassName}
          />
        </div>

        <p className="font-acumin text-[10px] leading-relaxed text-[#707070]">
          ※
          電子帳簿保存法の検索要件（取引年月日・取引金額・取引先／日付と金額の範囲指定／2以上の条件の組み合わせ）に対応しています。
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[#d4d4d4] px-5 py-4">
        <span className="font-acumin text-[11px] text-[#707070]">
          {filterActive ? `${filterConditionCount}条件で絞り込み中` : "条件なし"}
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => {
              setFilter(EMPTY_ENTRY_FILTER);
              setEntryPage(1);
            }}
          >
            条件をクリア
          </Button>
          <Button
            variant="primary"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => setIsFilterDrawerOpen(false)}
          >
            適用して閉じる
          </Button>
        </div>
      </div>
    </Drawer>
  );

  // 証憑（電子取引データ）の追加。ドラッグ＆ドロップとクリック選択の両方を受ける。
  const receiptDrawer = (
    <Drawer
      open={receiptDrawerEntries.length > 0}
      onClose={() => setReceiptDrawerEntryIds([])}
      side="right"
      size="md"
      shape="square"
      className="flex w-[min(92vw,460px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          証憑を追加
        </h4>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="証憑の追加を閉じる"
          onClick={() => setReceiptDrawerEntryIds([])}
        >
          <i className="ri-close-line text-lg" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {receiptMessage ? (
          <p
            className={`font-acumin text-xs ${/失敗|ください/.test(receiptMessage) ? "text-red-700" : "text-[#16844b]"}`}
            role="status"
          >
            {receiptMessage}
          </p>
        ) : null}
        {receiptDrawerEntries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-sm border border-[#ededed] p-3"
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-acumin text-xs text-black">
                {entry.date.replaceAll("-", "/")} / {entry.category} /{" "}
                {entry.item}
              </span>
              <span className="shrink-0 font-acumin text-xs tabular-nums text-black">
                {currency(entry.amount)}
              </span>
            </div>
            {(entry.receipts ?? []).length > 0 ? (
              <ul className="mb-2 space-y-1">
                {(entry.receipts ?? []).map((receipt) => (
                  <li
                    key={receipt.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <button
                      type="button"
                      className="truncate font-acumin text-[11px] text-black underline underline-offset-4"
                      aria-label={`${receipt.fileName}を開く`}
                      onClick={() => void handleOpenReceipt(receipt)}
                    >
                      <i className="ri-attachment-2 mr-1" aria-hidden="true" />
                      {receipt.fileName}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-[#888888] hover:text-black"
                      aria-label={`${receipt.fileName}を削除`}
                      onClick={() => void handleDeleteReceipt(receipt)}
                      disabled={isSaving}
                    >
                      <i className="ri-close-line text-[13px]" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <FileDropZone
              size="2xs"
              shape="rounded"
              accept={RECEIPT_ACCEPT}
              multiple
              busy={uploadingEntryId === entry.id}
              busyLabel="添付中..."
              disabled={uploadingEntryId !== null && uploadingEntryId !== entry.id}
              aria-label={`${entry.item}に証憑を添付`}
              label="ドラッグ＆ドロップ／クリックで選択"
              hint="PDF・JPEG・PNG・WebP・HEIC（20MBまで）"
              onFiles={(files) => void handleAttachReceipts(entry, files)}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end border-t border-[#d4d4d4] px-5 py-4">
        <Button
          variant="secondary"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          onClick={() => setReceiptDrawerEntryIds([])}
        >
          閉じる
        </Button>
      </div>
    </Drawer>
  );

  // 取引の登録・訂正。一覧の文脈を残すため右からの Drawer に入れる。
  const entryDrawer = (
    <Drawer
      open={isEntryDrawerOpen}
      onClose={handleCancelEdit}
      side="right"
      size="md"
      shape="square"
      className="flex w-[min(92vw,460px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <div>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            {editingEntryId === null
              ? `新規${entryTypeLabel}を登録`
              : `${entryTypeLabel}を訂正（#${editingEntryId}）`}
          </h4>
          {editingEntryId !== null ? (
            <p className="mt-1 font-acumin text-[10px] leading-relaxed text-[#707070]">
              訂正内容は変更前後が履歴に記録されます（削除・再登録はしません）。
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="取引の入力を閉じる"
          onClick={handleCancelEdit}
        >
          <i className="ri-close-line text-lg" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            種別 <span className="text-red-700">*</span>
          </span>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="種別">
            {(["expense", "income"] as EntryType[]).map((type) => {
              const active = form.entryType === type;
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleEntryTypeChange(type)}
                  className={`h-10 rounded-sm border font-acumin text-sm transition-colors ${active ? "border-black bg-black text-white" : "border-[#d4d4d4] bg-white text-[#474747] hover:border-black"}`}
                >
                  {type === "income" ? "収入" : "支出"}
                </button>
              );
            })}
          </div>
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            事業形態 <span className="text-red-700">*</span>
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="事業形態"
            className="font-acumin"
            options={BUSINESS_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            value={businessType}
            onValueChange={(value) =>
              void handleBusinessTypeChange(value as BusinessType)
            }
          />
          <p className="mt-1 font-acumin text-[11px] text-[#707070]">
            選んだ事業形態で使える勘定科目だけを表示します。
          </p>
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            テンプレート
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="テンプレート"
            className="font-acumin"
            placeholder="（テンプレートを選択）"
            options={[
              { value: "", label: "（テンプレートを選択）" },
              ...visibleTemplates.map((template) => ({
                value: template.name,
                label: template.name,
              })),
              { value: SAVE_TEMPLATE_SENTINEL, label: "＋ 現在の入力を保存" },
            ]}
            value={isSavingTemplate ? SAVE_TEMPLATE_SENTINEL : selectedTemplateName}
            onValueChange={handleTemplateSelect}
          />
          {selectedTemplateName && !isSavingTemplate ? (
            <div className="mt-2 flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 font-acumin"
                aria-label="選択中のテンプレートを削除"
                onClick={() => void handleDeleteTemplate()}
                disabled={isSaving}
              >
                削除
              </Button>
            </div>
          ) : null}
          {isSavingTemplate ? (
            <div className="mt-2 flex gap-2">
              <input
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                className={inputClassName}
                placeholder="テンプレート名"
                aria-label="テンプレート名"
              />
              <Button
                variant="primary"
                size="sm"
                className="shrink-0 font-acumin"
                aria-label="テンプレートを保存"
                onClick={() => void handleSaveTemplate()}
                disabled={isSaving}
              >
                保存
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 font-acumin"
                onClick={() => {
                  setIsSavingTemplate(false);
                  setNewTemplateName("");
                }}
                disabled={isSaving}
              >
                取消
              </Button>
            </div>
          ) : null}
        </div>
        <label className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            日付 <span className="text-red-700">*</span>
          </span>
          <input
            type="date"
            aria-label="取引日"
            value={form.date}
            onChange={(event) =>
              setForm((current) => ({ ...current, date: event.target.value }))
            }
            className={inputClassName}
          />
        </label>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            {summaryFieldLabel} <span className="text-red-700">*</span>
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label={summaryFieldLabel}
            className="font-acumin"
            options={shiyouOptionsFor(form.entryType).map((option) => ({
              value: option,
              label: option,
            }))}
            value={form.item}
            onValueChange={(value) =>
              setForm((current) => ({ ...current, item: value }))
            }
          />
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            勘定科目 <span className="text-red-700">*</span>
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="勘定科目"
            className="font-acumin"
            placeholder="（勘定科目を選択）"
            options={[
              { value: "", label: "（勘定科目を選択）" },
              ...accountOptionsFor(form.entryType, businessType),
            ]}
            value={form.category}
            onValueChange={(value) =>
              setForm((current) => ({ ...current, category: value }))
            }
          />
        </div>

        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            取引先
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="取引先"
            className="font-acumin"
            placeholder="（指定なし）"
            options={[
              { value: "", label: "（指定なし）" },
              ...partners.map((option) => ({ value: option, label: option })),
              { value: NEW_PARTNER_SENTINEL, label: "＋ 新規登録" },
            ]}
            value={isAddingPartner ? NEW_PARTNER_SENTINEL : form.partner}
            onValueChange={(value) => {
              if (value === NEW_PARTNER_SENTINEL) {
                setIsAddingPartner(true);
                return;
              }
              setIsAddingPartner(false);
              setForm((current) => ({ ...current, partner: value }));
            }}
          />
          {isAddingPartner ? (
            <div className="mt-2 flex gap-2">
              <input
                value={newPartnerName}
                onChange={(event) => setNewPartnerName(event.target.value)}
                className={inputClassName}
                placeholder="取引先名を入力"
                aria-label="新規取引先名"
              />
              <Button
                variant="primary"
                size="sm"
                className="shrink-0 font-acumin"
                onClick={() => void handleAddPartner()}
                disabled={isSaving}
              >
                登録
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 font-acumin"
                onClick={() => {
                  setIsAddingPartner(false);
                  setNewPartnerName("");
                }}
                disabled={isSaving}
              >
                取消
              </Button>
            </div>
          ) : null}
        </div>
        <label className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            金額 <span className="text-red-700">*</span>
          </span>
          <input
            type="number"
            min="1"
            value={form.amount}
            onChange={(event) =>
              setForm((current) => ({ ...current, amount: event.target.value }))
            }
            className={inputClassName}
            placeholder="0"
          />
        </label>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            {paymentFieldLabel}
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label={paymentFieldLabel}
            className="font-acumin"
            options={paymentOptionsFor(form.entryType).map((option) => ({
              value: option,
              label: option,
            }))}
            value={form.paymentMethod}
            onValueChange={(value) =>
              setForm((current) => ({ ...current, paymentMethod: value }))
            }
          />
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            シーズンタグ（任意）
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="シーズンタグ"
            className="font-acumin"
            placeholder="（なし）"
            options={[
              { value: "", label: "（なし）" },
              ...seasonOptions.map((season) => ({
                value: season.key,
                label: season.label,
              })),
            ]}
            value={form.seasonTag}
            onValueChange={(value) =>
              setForm((current) => ({ ...current, seasonTag: value }))
            }
          />
          <span className="mt-1 block font-acumin text-[10px] text-[#707070]">
            コレクション別の採算分析にのみ使用。会計期間は日付で決まる。
          </span>
        </div>
        <label className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            メモ
          </span>
          <textarea
            value={form.memo}
            onChange={(event) =>
              setForm((current) => ({ ...current, memo: event.target.value }))
            }
            className={`${inputClassName} h-20 py-2`}
            placeholder="任意のメモを入力"
          />
        </label>

        {/* 証憑。新規登録では取引IDが未確定なので、保存時にまとめて送る。 */}
        <div className="block">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            証憑（電子取引データ）
          </span>
          {editingEntryId === null ? (
            <>
              <FileDropZone
                size="2xs"
                shape="rounded"
                accept={RECEIPT_ACCEPT}
                multiple
                aria-label="新規取引に証憑を添付"
                label="ドラッグ＆ドロップ／クリックで選択"
                hint="PDF・JPEG・PNG・WebP・HEIC（20MBまで）"
                onFiles={(files) =>
                  setPendingReceipts((current) => [...current, ...files])
                }
              />
              {pendingReceipts.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {pendingReceipts.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate font-acumin text-[11px] text-black">
                        <i className="ri-attachment-2 mr-1" aria-hidden="true" />
                        {file.name}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-[#888888] hover:text-black"
                        aria-label={`${file.name}を添付から外す`}
                        onClick={() =>
                          setPendingReceipts((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <i className="ri-close-line text-[13px]" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 font-acumin text-[10px] text-[#707070]">
                  保存と同時に添付します。
                </p>
              )}
            </>
          ) : (
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              className="w-full font-acumin"
              onClick={() => openReceiptDrawer([editingEntryId])}
            >
              <i className="ri-attachment-2 mr-1" aria-hidden="true" />
              証憑を管理
            </Button>
          )}
        </div>

        {formMessage ? (
          <p
            className={`font-acumin text-xs ${/失敗|ください/.test(formMessage) ? "text-red-700" : "text-[#16844b]"}`}
            role="status"
          >
            {formMessage}
          </p>
        ) : null}
      </div>

      <div className="flex gap-2 border-t border-[#d4d4d4] px-5 py-4">
        {editingEntryId !== null ? (
          <Button
            variant="secondary"
            size="sm"
            iconOnly
            className="shrink-0 font-acumin"
            aria-label={`${form.item}を削除`}
            onClick={() => {
              const target = entryRows.find((entry) => entry.id === editingEntryId);
              if (target) {
                setIsEntryDrawerOpen(false);
                setEditingEntryId(null);
                void handleDeleteExpense(target);
              }
            }}
            disabled={isSaving}
          >
            <EmptyIcon icon="ri-delete-bin-line" />
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 font-acumin"
          onClick={handleCancelEdit}
          disabled={isSaving}
        >
          {editingEntryId === null ? "取消" : "訂正を取消"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1 font-acumin"
          onClick={() => void handleAddExpense()}
          disabled={isSaving}
        >
          {isSaving ? "保存中..." : editingEntryId === null ? "保存" : "訂正を保存"}
        </Button>
      </div>
    </Drawer>
  );

  const expensesView = (
    <div className="space-y-5">
      {/* 見出し＋常設のキーワード検索と主要操作。詳細な条件は Drawer へ。 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-acumin text-base font-medium tracking-widest text-black">
            取引管理
          </h3>
          <span className="font-acumin text-xs text-[#707070]">
            {entryRows.length}件
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            size="2xs"
            aria-label="取引を検索"
            placeholder="取引ID・取引先・摘要で検索"
            className="w-full font-acumin sm:w-[280px]"
            value={filter.keyword}
            showClearButton
            onClear={() => {
              updateFilter({ keyword: "" });
              setEntryPage(1);
            }}
            onChange={(event) => {
              updateFilter({ keyword: event.target.value });
              setEntryPage(1);
            }}
          />
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => setIsFilterDrawerOpen(true)}
          >
            <i className="ri-equalizer-line mr-1" aria-hidden="true" />
            詳細条件
            {filterConditionCount > 0 ? (
              <StatusBadge
                variant="count"
                size="4xs"
                count={filterConditionCount}
                className="ml-1.5"
              />
            ) : null}
          </Button>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            aria-label="表示中の取引をCSV出力"
            onClick={() =>
              handleEntryCsvExport(entryRows, `取引管理_${fiscalYear}.csv`)
            }
          >
            <i className="ri-download-2-line mr-1" aria-hidden="true" />
            CSV出力
          </Button>
          <Button
            variant="primary"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={handleOpenNewEntry}
          >
            <i className="ri-add-line mr-1" aria-hidden="true" />
            新規取引
          </Button>
        </div>
      </div>

      {/* 取引 → 証憑 → 収支。左から右へ確認が進む並びにする。 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="取引ステータス"
          title={<span className={panelTitleClassName}>取引ステータス</span>}
        >
          <div className="flex items-center gap-4">
            <Graph
              variant="donut"
              size={120}
              showLegend={false}
              className="shrink-0"
              centerLabel={
                <>
                  <span className="font-acumin text-[10px] text-[#707070]">
                    合計
                  </span>
                  <span className="font-acumin text-xs text-black tabular-nums">
                    {entryStatusCounts.total}件
                  </span>
                </>
              }
              data={[
                {
                  label: "登録済み",
                  value: entryStatusCounts.registered,
                  color: ENTRY_STATE_COLORS.registered,
                },
                {
                  label: "要確認",
                  value: entryStatusCounts.review,
                  color: ENTRY_STATE_COLORS.review,
                },
                {
                  label: "訂正",
                  value: entryStatusCounts.revised,
                  color: ENTRY_STATE_COLORS.revised,
                },
              ]}
            />
            <div className="min-w-0 flex-1 space-y-2">
              {donutLegendRow(
                "登録済み",
                entryStatusCounts.registered,
                ENTRY_STATE_COLORS.registered,
                false,
              )}
              {donutLegendRow(
                "要確認",
                entryStatusCounts.review,
                ENTRY_STATE_COLORS.review,
                true,
              )}
              {donutLegendRow(
                "訂正",
                entryStatusCounts.revised,
                ENTRY_STATE_COLORS.revised,
                true,
              )}
            </div>
          </div>
        </Panel>

        {summaryChevron}

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="証憑ステータス"
          title={<span className={panelTitleClassName}>証憑ステータス</span>}
        >
          <div className="flex items-center gap-4">
            <Graph
              variant="donut"
              size={120}
              showLegend={false}
              className="shrink-0"
              centerLabel={
                <>
                  <span className="font-acumin text-[10px] text-[#707070]">
                    合計
                  </span>
                  <span className="font-acumin text-xs text-black tabular-nums">
                    {receiptStatusCounts.total}件
                  </span>
                </>
              }
              data={[
                {
                  label: "添付済み",
                  value: receiptStatusCounts.attached,
                  color: RECEIPT_ATTACHED_COLOR,
                },
                {
                  label: "未添付",
                  value: receiptStatusCounts.missing,
                  color: RECEIPT_MISSING_COLOR,
                },
              ]}
            />
            <div className="min-w-0 flex-1 space-y-2">
              {donutLegendRow(
                "添付済み",
                receiptStatusCounts.attached,
                RECEIPT_ATTACHED_COLOR,
                false,
              )}
              {donutLegendRow(
                "未添付",
                receiptStatusCounts.missing,
                RECEIPT_MISSING_COLOR,
                true,
              )}
            </div>
          </div>
        </Panel>

        {summaryChevron}

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="今月の収支"
          title={<span className={panelTitleClassName}>今月の収支</span>}
          actions={
            <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
              {fiscalYear}/{String(monthlyBalance.month).padStart(2, "0")}
            </span>
          }
        >
          <Graph
            variant="progress"
            layout="inline"
            size="xs"
            className="font-acumin"
            data={[
              {
                label: "収入",
                value: monthlyBalance.income,
                formattedValue: currency(monthlyBalance.income),
                color: BALANCE_INCOME_COLOR,
              },
              {
                label: "支出",
                value: monthlyBalance.expense,
                formattedValue: currency(monthlyBalance.expense),
                color: BALANCE_EXPENSE_COLOR,
              },
              {
                label: "収支",
                value: monthlyBalance.balance,
                magnitude: Math.abs(monthlyBalance.balance),
                formattedValue: deltaCurrency(monthlyBalance.balance),
                color:
                  monthlyBalance.balance >= 0
                    ? BALANCE_POSITIVE_COLOR
                    : BALANCE_NEGATIVE_COLOR,
              },
            ]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <Panel radius="rounded" aria-label="取引一覧">
            {/* 状態で束ねたタブ。件数を出して、確認すべき塊の大きさを先に見せる。 */}
            <div className="border-b border-[#d4d4d4]">
              <TabSegmentControl
                variant="tabs-standard"
                size="2xs"
                activeKey={entryListTab}
                onChange={(key) => changeEntryListTab(key as EntryListTab)}
                items={[
                  { key: "all", label: "すべて" },
                  { key: "noReceipt", label: `証憑未添付（${entryTabCounts.noReceipt}）` },
                  { key: "review", label: `要確認（${entryTabCounts.review}）` },
                  { key: "revised", label: `訂正あり（${entryTabCounts.revised}）` },
                ]}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  size="2xs"
                  className="font-acumin"
                  label={
                    selectedEntryIds.length > 0
                      ? `${selectedEntryIds.length}件選択中`
                      : "すべて選択"
                  }
                  aria-label="表示中の取引をすべて選択"
                  checked={pageAllSelected}
                  onChange={togglePageSelection}
                />
                <Button
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  className="font-acumin"
                  disabled={selectedEntries.length === 0}
                  onClick={() => openReceiptDrawer(selectedEntryIds)}
                >
                  <i className="ri-attachment-2 mr-1" aria-hidden="true" />
                  証憑を追加
                </Button>
                <Button
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  className="font-acumin"
                  aria-label="選択中の取引をCSV出力"
                  disabled={selectedEntries.length === 0}
                  onClick={() =>
                    handleEntryCsvExport(
                      selectedEntries,
                      `取引管理_選択_${fiscalYear}.csv`,
                    )
                  }
                >
                  <i className="ri-download-2-line mr-1" aria-hidden="true" />
                  CSV出力
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
                  {entryRangeStart}-{entryRangeEnd} / {tabbedEntryRows.length}件
                </span>
                <PageControl
                  size="3xs"
                  page={currentEntryPage}
                  totalPages={entryTotalPages}
                  maxVisiblePages={6}
                  previousAriaLabel="前のページ"
                  nextAriaLabel="次のページ"
                  onPageChange={setEntryPage}
                />
              </div>
            </div>

            <div className="mt-3">
              <DataTable
                size="2xs"
                shape="rounded"
                hoverableRows
                columns={entryColumns}
                rows={pagedEntryRows}
                rowKey={(entry) => String(entry.id)}
                emptyLabel="該当する取引がありません。"
                tableClassName="min-w-[640px]"
                containerClassName="font-acumin"
              />
            </div>
          </Panel>

          {/* 電子帳簿保存法の真実性の要件：訂正・削除の履歴を確認できるようにする。
              履歴はDBトリガーが記録し、アプリからは書き換えられない。 */}
          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="訂正・削除の履歴"
            title={
              <button
                type="button"
                className="flex items-center gap-1.5 font-acumin text-sm font-medium tracking-widest text-black"
                aria-expanded={isRevisionHistoryOpen}
                onClick={() => setIsRevisionHistoryOpen((current) => !current)}
              >
                <i
                  className={
                    isRevisionHistoryOpen
                      ? "ri-arrow-down-s-line"
                      : "ri-arrow-right-s-line"
                  }
                  aria-hidden="true"
                />
                訂正・削除の履歴（{revisions.length}件）
              </button>
            }
            actions={
              revisions.length > 0 ? (
                <Button
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  className="font-acumin"
                  onClick={() => setIsRevisionHistoryOpen(true)}
                >
                  すべて表示
                </Button>
              ) : undefined
            }
          >
            <p className="font-acumin text-[10px] leading-relaxed text-[#707070]">
              電子帳簿保存法の真実性の要件により、取引の削除は論理削除として記録し、訂正の前後を保持します。
            </p>
            {!isRevisionHistoryOpen ? null : revisions.length === 0 ? (
              <p className="mt-3 font-acumin text-xs text-[#707070]">
                履歴はまだありません。
              </p>
            ) : (
              <div className="mt-3">
                <DataTable
                  size="2xs"
                  shape="rounded"
                  columns={[
                    {
                      key: "changedAt",
                      header: "変更日時",
                      cellClassName: "whitespace-nowrap tabular-nums",
                      render: (revision: EntryRevision) =>
                        new Date(revision.changedAt).toLocaleString("ja-JP"),
                    },
                    {
                      key: "operation",
                      header: "操作",
                      cellClassName: "whitespace-nowrap",
                      render: (revision: EntryRevision) => (
                        <span
                          style={{
                            color:
                              revision.operation === "delete"
                                ? ENTRY_STATE_COLORS.revised
                                : revision.operation === "update"
                                  ? ENTRY_STATE_COLORS.review
                                  : "#474747",
                          }}
                        >
                          {REVISION_OPERATION_LABELS[revision.operation]}
                        </span>
                      ),
                    },
                    {
                      key: "entryId",
                      header: "取引ID",
                      cellClassName: "whitespace-nowrap",
                      render: (revision: EntryRevision) => `#${revision.entryId}`,
                    },
                    {
                      key: "before",
                      header: "変更前",
                      render: (revision: EntryRevision) =>
                        revision.operation === "insert"
                          ? "—"
                          : `${revision.before.date ?? ""} ${revision.before.category ?? ""} ${revision.before.item ?? ""} ${revision.before.amount ? currency(Number(revision.before.amount)) : ""}`.trim(),
                    },
                    {
                      key: "after",
                      header: "変更後",
                      render: (revision: EntryRevision) =>
                        revision.operation === "delete"
                          ? "（削除）"
                          : `${revision.after.date ?? ""} ${revision.after.category ?? ""} ${revision.after.item ?? ""} ${revision.after.amount ? currency(Number(revision.after.amount)) : ""}`.trim(),
                    },
                  ]}
                  rows={revisions}
                  rowKey={(revision) => String(revision.id)}
                  tableClassName="min-w-[720px]"
                  containerClassName="font-acumin"
                />
              </div>
            )}
          </Panel>
        </div>

        <aside className="space-y-5">
          {/* 確認キュー。件数の多い作業ではなく、優先順に片付ける導線を出す。 */}
          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="確認キュー"
            title={<span className={panelTitleClassName}>確認キュー（優先順）</span>}
          >
            {reviewQueue.length === 0 ? (
              <p className="font-acumin text-xs text-[#707070]">
                確認が必要な取引はありません。
              </p>
            ) : (
              <ul className="space-y-2">
                {reviewQueue.map((group) => {
                  const head = group.rows[0];
                  const color =
                    group.tone === "danger"
                      ? ENTRY_STATE_COLORS.revised
                      : ENTRY_STATE_COLORS.review;
                  return (
                    <li key={group.key}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-sm border border-[#ededed] px-3 py-2.5 text-left transition-colors hover:border-[#d4d4d4] hover:bg-[#fafafa]"
                        aria-label={`${group.label}の取引を一覧で絞り込む`}
                        onClick={() => changeEntryListTab(group.tab)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <i
                              className={group.icon}
                              aria-hidden="true"
                              style={{ color }}
                            />
                            <span
                              className="font-acumin text-xs"
                              style={{ color }}
                            >
                              {group.label}
                            </span>
                          </span>
                          {head ? (
                            <span className="mt-1 flex items-baseline gap-2 font-acumin text-[11px] text-[#474747]">
                              <span className="tabular-nums">
                                {head.date.replaceAll("-", "/")}
                              </span>
                              <span className="min-w-0 truncate">
                                {head.category} / {head.item}
                              </span>
                              <span className="ml-auto shrink-0 tabular-nums text-black">
                                {currency(head.amount)}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        <StatusBadge
                          variant="text"
                          shape="pill"
                          size="4xs"
                          tone={group.tone}
                          accent
                          className="shrink-0 font-acumin"
                        >
                          {group.rows.length}件
                        </StatusBadge>
                        <i
                          className="ri-arrow-right-s-line shrink-0 text-[#909090]"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="電子帳簿保存法 チェックリスト"
            title={
              <span className={panelTitleClassName}>
                電子帳簿保存法 チェックリスト
              </span>
            }
          >
            <ul className="space-y-2">
              {DENCHOHO_CHECKLIST.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2">
                    <i
                      className="ri-checkbox-circle-fill text-[#16844b]"
                      aria-hidden="true"
                    />
                    <span className="font-acumin text-xs text-black">
                      {item.label}
                    </span>
                  </span>
                  <span className="font-acumin text-[11px] text-[#707070]">
                    {item.note}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>

      {filterDrawer}
      {entryDrawer}
      {receiptDrawer}
    </div>
  );

  const selectedLedger =
    ledger.find((row) => row.account.code === ledgerAccountCode) ?? ledger[0];

  const fixedAssetAccountOptions = useMemo(
    () =>
      ACCOUNTS.filter(
        (account) =>
          (
            FIXED_ASSET_ACCOUNT_SECTIONS as readonly string[]
          ).includes(account.section)
          && (account.scope === "common" || account.scope === businessType),
      ).map((account) => ({
        value: account.name,
        label: `${account.section} / ${account.name}`,
      })),
    [businessType],
  );

  const handleSaveFixedAsset = async () => {
    const cost = Number(assetForm.acquisitionCost);
    if (!assetForm.name.trim() || !assetForm.account || !assetForm.acquiredOn) {
      setAssetMessage("資産名・勘定科目・取得日を入力してください。");
      return;
    }
    if (!Number.isFinite(cost) || cost <= 0) {
      setAssetMessage("取得価額は1円以上で入力してください。");
      return;
    }
    try {
      setIsSaving(true);
      setAssetMessage(null);
      await postMutation({
        operation: "fixedAsset.upsert",
        asset: {
          id: 0,
          name: assetForm.name.trim(),
          account: assetForm.account,
          acquiredOn: assetForm.acquiredOn,
          acquisitionCost: Math.round(cost),
          usefulLife: Math.max(1, Number(assetForm.usefulLife) || 1),
          method: assetForm.method,
          businessUseRatio: Math.min(
            100,
            Math.max(1, Number(assetForm.businessUseRatio) || 100),
          ),
          disposedOn: assetForm.disposedOn || null,
          memo: "",
        },
      });
      await loadFinanceData();
      setAssetForm(EMPTY_ASSET_FORM);
      setAssetMessage("固定資産を登録し、減価償却費へ反映しました。");
    } catch (error) {
      setAssetMessage(
        error instanceof Error
          ? error.message
          : "固定資産の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteFixedAsset = async (asset: FixedAsset) => {
    try {
      setIsSaving(true);
      setAssetMessage(null);
      await postMutation({
        operation: "fixedAsset.delete",
        assetId: asset.id,
      });
      await loadFinanceData();
      setAssetMessage(`${asset.name}を台帳から削除しました。`);
    } catch (error) {
      setAssetMessage(
        error instanceof Error
          ? error.message
          : "固定資産の削除に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // 決算整理仕訳（自動生成分）。伝票番号の D/I/A サフィックスで判別する。
  const closingEntries = useMemo(
    () => journal.filter((entry) => entry.entryId < 0),
    [journal],
  );

  // 翌年度へ繰り越す期首残高。
  const carryForwardCheck = useMemo(
    () => verifyOpeningBalances(carryForward),
    [carryForward],
  );
  const carryForwardRows = useMemo(
    () =>
      [...carryForward.entries()]
        .map(([code, amount]) => {
          const account = accountByCode(code);
          const onDebitSide = account?.normalSide === "debit";
          return {
            code,
            name: account?.name ?? code,
            debit: onDebitSide
              ? Math.max(amount, 0)
              : Math.max(-amount, 0),
            credit: onDebitSide
              ? Math.max(-amount, 0)
              : Math.max(amount, 0),
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code)),
    [carryForward],
  );

  const handleSaveClosing = async () => {
    try {
      setIsSaving(true);
      setClosingMessage(null);
      await postMutation({
        operation: "closing.update",
        fiscalYear,
        adjustment,
      });
      await loadFinanceData();
      setClosingMessage("決算整理を保存しました。");
    } catch (error) {
      setClosingMessage(
        error instanceof Error
          ? error.message
          : "決算整理の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleFinalizeClosing = async () => {
    // 貸借が一致しない状態で締めると翌年度の期首が壊れる。
    if (!carryForwardCheck.isBalanced) {
      setClosingMessage(
        "翌年度期首の貸借が一致していません。試算表を確認してください。",
      );
      return;
    }
    try {
      setIsSaving(true);
      setClosingMessage(null);
      await postMutation({
        operation: "closing.finalize",
        fiscalYear,
        adjustment,
        closingBalances: Object.fromEntries(carryForward),
      });
      await loadFinanceData();
      setClosingMessage(
        `${fiscalYearLabel}を締めました。期末残高が${fiscalYear + 1}年の期首残高になります。`,
      );
    } catch (error) {
      setClosingMessage(
        error instanceof Error ? error.message : "決算の確定に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleReopenClosing = async () => {
    try {
      setIsSaving(true);
      setClosingMessage(null);
      await postMutation({ operation: "closing.reopen", fiscalYear });
      await loadFinanceData();
      setClosingMessage("決算を解除しました。取引の修正が反映されます。");
    } catch (error) {
      setClosingMessage(
        error instanceof Error ? error.message : "決算の解除に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // --- 証憑（電子取引データ）---
  // 1ファイル分のアップロード。取引IDだけを取るので、保存直後の新規取引にも使える。
  const uploadReceiptFile = async (entryId: number, file: File) => {
    const formData = new FormData();
    formData.append("entryId", String(entryId));
    formData.append("file", file);

    const response = await clientFetch("/api/admin/kpi/cost-profit/receipt", {
      method: "POST",
      body: formData,
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? "証憑のアップロードに失敗しました。");
    }
  };

  /** ドロップ／選択された証憑をまとめて添付する。 */
  const handleAttachReceipts = async (entry: Expense, files: File[]) => {
    if (files.length === 0) return;
    try {
      setUploadingEntryId(entry.id);
      setReceiptMessage(null);
      for (const file of files) {
        await uploadReceiptFile(entry.id, file);
      }
      await loadFinanceData();
      setReceiptMessage(
        files.length === 1
          ? `${files[0].name} を添付しました。`
          : `${files.length}件の証憑を添付しました。`,
      );
    } catch (error) {
      setReceiptMessage(
        error instanceof Error
          ? error.message
          : "証憑のアップロードに失敗しました。",
      );
    } finally {
      setUploadingEntryId(null);
    }
  };

  const handleOpenReceipt = async (receipt: Receipt) => {
    try {
      setReceiptMessage(null);
      const response = await clientFetch(
        `/api/admin/kpi/cost-profit/receipt?path=${encodeURIComponent(receipt.storagePath)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as
        | { data?: { url: string }; error?: string }
        | null;
      if (!response.ok || !payload?.data?.url) {
        throw new Error(payload?.error ?? "証憑の取得に失敗しました。");
      }
      window.open(payload.data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setReceiptMessage(
        error instanceof Error ? error.message : "証憑の取得に失敗しました。",
      );
    }
  };

  const handleDeleteReceipt = async (receipt: Receipt) => {
    try {
      setIsSaving(true);
      setReceiptMessage(null);
      await postMutation({
        operation: "receipt.delete",
        receiptId: receipt.id,
      });
      await loadFinanceData();
      setReceiptMessage(`${receipt.fileName} を削除しました。`);
    } catch (error) {
      setReceiptMessage(
        error instanceof Error ? error.message : "証憑の削除に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // --- 青色申告決算書（一般用）1〜4ページ ---
  const monthlySummary = useMemo(
    () => buildMonthlySummary(journal, fiscalYear),
    [journal, fiscalYear],
  );
  const deductionCalc = useMemo(
    () => buildBlueReturnDeduction(profitAndLoss.netIncome, usesEtax),
    [profitAndLoss.netIncome, usesEtax],
  );
  const breakdownOf = useCallback(
    (codes: readonly string[]) => buildPartnerBreakdown(journal, codes),
    [journal],
  );
  const wagesBreakdown = useMemo(
    () => breakdownOf(BREAKDOWN_ACCOUNT_CODES.wages),
    [breakdownOf],
  );
  const familyWagesBreakdown = useMemo(
    () => breakdownOf(BREAKDOWN_ACCOUNT_CODES.familyWages),
    [breakdownOf],
  );
  const interestBreakdown = useMemo(
    () => breakdownOf(BREAKDOWN_ACCOUNT_CODES.interest),
    [breakdownOf],
  );
  const rentBreakdown = useMemo(
    () => breakdownOf(BREAKDOWN_ACCOUNT_CODES.rent),
    [breakdownOf],
  );
  const professionalFeesBreakdown = useMemo(
    () => breakdownOf(BREAKDOWN_ACCOUNT_CODES.professionalFees),
    [breakdownOf],
  );
  // 4ページの貸借対照表は期首（前年末）と期末の2時点。
  // 期末は決算振替の「前」の残高（事業主貸・事業主借を残し、所得は別行で示す）。
  const closingBalanceSheetBalances = useMemo(() => {
    const balances = new Map<string, number>();
    for (const row of trialBalance.rows) {
      if (row.account.type === "revenue" || row.account.type === "expense") {
        continue;
      }
      const balance =
        row.account.normalSide === "debit"
          ? row.debitBalance - row.creditBalance
          : row.creditBalance - row.debitBalance;
      if (balance !== 0) balances.set(row.account.code, balance);
    }
    return balances;
  }, [trialBalance]);

  const balanceSheetComparison = useMemo(() => {
    const base = buildBalanceSheetComparison(
      openingBalances,
      closingBalanceSheetBalances,
    );
    // 決算書の資本の部には「青色申告特別控除前の所得金額」が独立した行で載る。
    // 期首の所得は前年度の締めで元入金へ振り替わっているため0。
    return {
      ...base,
      liabilitiesAndEquity: [
        ...base.liabilitiesAndEquity,
        {
          code: "9999",
          name: "青色申告特別控除前の所得金額",
          opening: 0,
          closing: profitAndLoss.netIncome,
        },
      ],
      closingLiabilityEquityTotal:
        base.closingLiabilityEquityTotal + profitAndLoss.netIncome,
    };
  }, [openingBalances, closingBalanceSheetBalances, profitAndLoss.netIncome]);

  // 1ページ 損益計算書の行。決算書の並び順に合わせる。
  const page1Rows = useMemo(
    () => [
      { label: "売上（収入）金額", value: profitAndLoss.sales },
      {
        label: "期首商品（製品）棚卸高",
        value: profitAndLoss.openingInventory,
        indent: true,
      },
      { label: "当期仕入高", value: profitAndLoss.purchases, indent: true },
      {
        label: "期末商品（製品）棚卸高",
        value: profitAndLoss.closingInventory,
        indent: true,
      },
      { label: "差引原価", value: profitAndLoss.costOfSales },
      { label: "差引金額（売上総利益）", value: profitAndLoss.grossProfit },
      { label: "経費", value: profitAndLoss.operatingExpenses },
      { label: "差引金額", value: profitAndLoss.operatingProfit },
      { label: "営業外損益", value: profitAndLoss.nonOperatingBalance },
      { label: "特別損益", value: profitAndLoss.extraordinaryBalance },
      { label: "繰入・繰戻額等", value: profitAndLoss.provisionBalance },
      {
        label: "青色申告特別控除前の所得金額",
        value: profitAndLoss.netIncome,
        emphasis: true,
      },
      {
        label: "青色申告特別控除額",
        value: -deductionCalc.deduction,
      },
      {
        label: "所得金額",
        value: deductionCalc.incomeAfterDeduction,
        emphasis: true,
      },
    ] as Array<{
      label: string;
      value: number;
      indent?: boolean;
      emphasis?: boolean;
    }>,
    [profitAndLoss, deductionCalc],
  );

  // 1ページの経費内訳。経費区分の科目だけを金額降順で並べる。
  const expenseDetailRows = useMemo(
    () =>
      (
        profitAndLoss.sections.find((section) => section.section === "経費")
          ?.lines ?? []
      )
        .slice()
        .sort((a, b) => b.amount - a.amount),
    [profitAndLoss.sections],
  );

  const handleBlueReturnExport = (page: TaxPage) => {
    const prefix = `${fiscalYearLabel}_青色申告決算書`;
    if (page === "page1") {
      exportCsv(`${prefix}1P_損益計算書.csv`, [
        ["科目", "金額"],
        ...page1Rows.map((row) => [row.label, row.value]),
        ["", ""],
        ["経費の内訳", ""],
        ...expenseDetailRows.map((row) => [row.account.name, row.amount]),
      ]);
      return;
    }
    if (page === "page2") {
      exportCsv(`${prefix}2P_月別売上仕入.csv`, [
        ["月", "売上（収入）金額", "仕入金額"],
        ...monthlySummary.rows.map((row) => [
          `${row.month}月`,
          row.sales,
          row.purchases,
        ]),
        ["雑収入", monthlySummary.miscIncome, ""],
        [
          "計",
          monthlySummary.salesTotal + monthlySummary.miscIncome,
          monthlySummary.purchasesTotal,
        ],
        ["", "", ""],
        ["給料賃金の内訳", "件数", "金額"],
        ...wagesBreakdown.map((row) => [row.partner, row.count, row.amount]),
        ["専従者給与の内訳", "件数", "金額"],
        ...familyWagesBreakdown.map((row) => [
          row.partner,
          row.count,
          row.amount,
        ]),
        ["", "", ""],
        ["青色申告特別控除額の計算", "", ""],
        ["青色申告特別控除前の所得金額", deductionCalc.incomeBeforeDeduction, ""],
        ["控除限度額", deductionCalc.limit, ""],
        ["青色申告特別控除額", deductionCalc.deduction, ""],
        ["所得金額", deductionCalc.incomeAfterDeduction, ""],
      ]);
      return;
    }
    if (page === "page3") {
      exportCsv(`${prefix}3P_減価償却費.csv`, [
        [
          "減価償却資産の名称",
          "取得年月",
          "取得価額",
          "償却方法",
          "耐用年数",
          "償却率",
          "本年中の償却期間",
          "本年分の償却費",
          "事業専用割合",
          "本年分の必要経費算入額",
          "未償却残高",
        ],
        ...depreciation.rows.map((row) => [
          row.asset.name,
          row.asset.acquiredOn.slice(0, 7),
          row.asset.acquisitionCost,
          DEPRECIATION_METHOD_LABELS[row.asset.method],
          row.asset.method === "straightLine" ? row.asset.usefulLife : "",
          row.asset.method === "straightLine"
            ? straightLineRate(row.asset.usefulLife).toFixed(3)
            : "",
          row.asset.method === "straightLine" ? `${row.months}/12` : "",
          row.depreciation,
          `${row.asset.businessUseRatio}%`,
          row.businessExpense,
          row.closingBookValue,
        ]),
        [
          "計",
          "",
          "",
          "",
          "",
          "",
          "",
          depreciation.depreciationTotal,
          "",
          depreciation.businessExpenseTotal,
          depreciation.closingBookValueTotal,
        ],
        ["", "", "", "", "", "", "", "", "", "", ""],
        ["利子割引料の内訳", "件数", "金額"],
        ...interestBreakdown.map((row) => [row.partner, row.count, row.amount]),
        ["地代家賃の内訳", "件数", "金額"],
        ...rentBreakdown.map((row) => [row.partner, row.count, row.amount]),
        ["税理士・弁護士等の報酬・料金の内訳", "件数", "金額"],
        ...professionalFeesBreakdown.map((row) => [
          row.partner,
          row.count,
          row.amount,
        ]),
      ]);
      return;
    }
    exportCsv(`${prefix}4P_貸借対照表.csv`, [
      ["区分", "科目", "期首", "期末"],
      ...balanceSheetComparison.assets.map((row) => [
        "資産",
        row.name,
        row.opening,
        row.closing,
      ]),
      [
        "資産",
        "合計",
        balanceSheetComparison.openingAssetTotal,
        balanceSheetComparison.closingAssetTotal,
      ],
      ...balanceSheetComparison.liabilitiesAndEquity.map((row) => [
        "負債・資本",
        row.name,
        row.opening,
        row.closing,
      ]),
      [
        "負債・資本",
        "合計",
        balanceSheetComparison.openingLiabilityEquityTotal,
        balanceSheetComparison.closingLiabilityEquityTotal,
      ],
    ]);
  };

  const handleFixedAssetExport = () => {
    exportCsv(`${fiscalYearLabel}_固定資産台帳.csv`, [
      [
        "資産名",
        "勘定科目",
        "取得日",
        "取得価額",
        "償却方法",
        "耐用年数",
        "期首簿価",
        "使用月数",
        "当期償却費",
        "事業専用割合",
        "必要経費算入額",
        "期末簿価",
        "減価償却累計額",
        "除却日",
      ],
      ...depreciation.rows.map((row) => [
        row.asset.name,
        row.asset.account,
        row.asset.acquiredOn,
        row.asset.acquisitionCost,
        DEPRECIATION_METHOD_LABELS[row.asset.method],
        row.asset.method === "straightLine" ? row.asset.usefulLife : "",
        row.openingBookValue,
        row.asset.method === "straightLine" ? row.months : "",
        row.depreciation,
        `${row.asset.businessUseRatio}%`,
        row.businessExpense,
        row.closingBookValue,
        row.accumulated,
        row.asset.disposedOn ?? "",
      ]),
      [
        "合計",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        depreciation.depreciationTotal,
        "",
        depreciation.businessExpenseTotal,
        depreciation.closingBookValueTotal,
        depreciation.accumulatedTotal,
        "",
      ],
    ]);
  };

  // ── 仕訳・元帳 ─────────────────────────────────────────────────────────
  // 左の科目ツリーは「会計区分 → 決算書区分 → 勘定科目」の3階層。
  // 勘定科目マスタ全件ではなく、元帳に現れた科目だけを出す（選べない行を並べない）。
  const accountTree = useMemo(() => {
    const byType = new Map<AccountType, Map<string, LedgerAccount[]>>();
    for (const row of ledger) {
      const sections =
        byType.get(row.account.type) ?? new Map<string, LedgerAccount[]>();
      sections.set(row.account.section, [
        ...(sections.get(row.account.section) ?? []),
        row,
      ]);
      byType.set(row.account.type, sections);
    }

    return (Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[])
      .filter((type) => byType.has(type))
      .map((type) => {
        const sections = [
          ...(byType.get(type) ?? new Map<string, LedgerAccount[]>()).entries(),
        ]
          .map(([section, accounts]) => {
            const sorted = [...accounts].sort((a, b) =>
              a.account.code.localeCompare(b.account.code),
            );
            return {
              key: `${type}-${section}`,
              section,
              accounts: sorted,
              total: sorted.reduce((sum, item) => sum + item.closingBalance, 0),
            };
          })
          .sort((a, b) =>
            (a.accounts[0]?.account.code ?? "").localeCompare(
              b.accounts[0]?.account.code ?? "",
            ),
          );
        return {
          key: type,
          label: ACCOUNT_TYPE_LABELS[type],
          sections,
          total: sections.reduce((sum, item) => sum + item.total, 0),
        };
      });
  }, [ledger]);

  const filteredAccountTree = useMemo(() => {
    const keyword = accountTreeKeyword.trim().toLowerCase();
    if (!keyword) return accountTree;
    return accountTree
      .map((group) => ({
        ...group,
        sections: group.sections
          .map((section) => ({
            ...section,
            accounts: section.accounts.filter((row) =>
              `${row.account.code} ${row.account.name} ${row.account.section}`
                .toLowerCase()
                .includes(keyword),
            ),
          }))
          .filter((section) => section.accounts.length > 0),
      }))
      .filter((group) => group.sections.length > 0);
  }, [accountTree, accountTreeKeyword]);

  const toggleAccountGroup = (key: string) =>
    setCollapsedAccountGroups((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );

  // 選択中の科目の月末残高。期首残高から各月の増減を積む。
  const ledgerMonthlyPoints = useMemo(() => {
    if (!selectedLedger) return [];
    const sign = selectedLedger.account.normalSide === "debit" ? 1 : -1;
    const net = new Array<number>(12).fill(0);
    for (const row of selectedLedger.rows) {
      if (Number.parseInt(row.date.slice(0, 4), 10) !== fiscalYear) continue;
      const month = Number.parseInt(row.date.slice(5, 7), 10);
      if (!Number.isFinite(month) || month < 1 || month > 12) continue;
      net[month - 1] += sign * (row.debit - row.credit);
    }
    let balance = selectedLedger.openingBalance;
    return net.map((value) => {
      balance += value;
      return { balance, net: value };
    });
  }, [selectedLedger, fiscalYear]);

  // 異常値＝月次増減の絶対値が、動きのあった月の平均の2倍を超えた月。
  // 閾値は係数ではなく実データの平均から決めるので、規模に依らず効く。
  const ledgerAnomalyMonths = useMemo(() => {
    const moves = ledgerMonthlyPoints
      .map((point) => Math.abs(point.net))
      .filter((value) => value > 0);
    if (moves.length < 3) return [];
    const average = moves.reduce((sum, value) => sum + value, 0) / moves.length;
    return ledgerMonthlyPoints
      .map((point, index) => ({ index, move: Math.abs(point.net) }))
      .filter((point) => point.move > average * 2)
      .map((point) => point.index);
  }, [ledgerMonthlyPoints]);

  const ledgerClosingBalance = selectedLedger?.closingBalance ?? 0;
  const ledgerOpeningBalance = selectedLedger?.openingBalance ?? 0;

  // 取引・仕訳を id / 伝票番号で引く索引。元帳行から証憑と明細へ辿る。
  const entriesById = useMemo(() => {
    const map = new Map<number, Expense>();
    for (const entry of allEntries) map.set(entry.id, entry);
    return map;
  }, [allEntries]);

  const journalByNumber = useMemo(() => {
    const map = new Map<string, JournalEntry>();
    for (const entry of journal) map.set(entry.number, entry);
    return map;
  }, [journal]);

  /** 四半期の絞り込み。会計期間は暦年なので 1-3 / 4-6 / 7-9 / 10-12 で切る。 */
  const ledgerPeriodOptions = [
    { value: "full", label: `期間：${fiscalYear}/01/01 〜 ${fiscalYear}/12/31` },
    { value: "q1", label: `期間：${fiscalYear}/01/01 〜 ${fiscalYear}/03/31` },
    { value: "q2", label: `期間：${fiscalYear}/04/01 〜 ${fiscalYear}/06/30` },
    { value: "q3", label: `期間：${fiscalYear}/07/01 〜 ${fiscalYear}/09/30` },
    { value: "q4", label: `期間：${fiscalYear}/10/01 〜 ${fiscalYear}/12/31` },
  ];

  const LEDGER_SIDE_OPTIONS = [
    { value: "all", label: "すべての取引" },
    { value: "debit", label: "借方のみ" },
    { value: "credit", label: "貸方のみ" },
    { value: "closing", label: "決算整理のみ" },
  ];

  // 中央の仕訳一覧。選択中の科目の元帳行を新しい順に並べ、期間・貸借・語で絞る。
  const filteredLedgerRows = useMemo(() => {
    if (!selectedLedger) return [];
    const keyword = ledgerRowKeyword.trim().toLowerCase();
    const quarter = ledgerPeriod === "full" ? null : Number(ledgerPeriod.slice(1));
    return selectedLedger.rows
      .map((row, index) => ({ ...row, key: `${row.number}-${index}` }))
      .filter((row) => {
        if (quarter !== null) {
          const month = Number.parseInt(row.date.slice(5, 7), 10);
          if (Math.ceil(month / 3) !== quarter) return false;
        }
        if (ledgerSideFilter === "debit" && row.debit <= 0) return false;
        if (ledgerSideFilter === "credit" && row.credit <= 0) return false;
        if (ledgerSideFilter === "closing" && row.entryId >= 0) return false;
        if (!keyword) return true;
        return `${row.description} ${row.partner} ${row.number} ${row.counterAccount}`
          .toLowerCase()
          .includes(keyword);
      })
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) || b.number.localeCompare(a.number),
      );
  }, [selectedLedger, ledgerRowKeyword, ledgerPeriod, ledgerSideFilter]);

  const ledgerTotalPages = Math.max(
    1,
    Math.ceil(filteredLedgerRows.length / ledgerPageSize),
  );
  const currentLedgerPage = Math.min(ledgerRowPage, ledgerTotalPages);
  const pagedLedgerRows = filteredLedgerRows.slice(
    (currentLedgerPage - 1) * ledgerPageSize,
    currentLedgerPage * ledgerPageSize,
  );
  const ledgerRangeStart =
    filteredLedgerRows.length === 0
      ? 0
      : (currentLedgerPage - 1) * ledgerPageSize + 1;
  const ledgerRangeEnd = Math.min(
    currentLedgerPage * ledgerPageSize,
    filteredLedgerRows.length,
  );

  // 明細に出す行。未選択・選択が絞り込みで消えた場合はページ先頭を見せる。
  const selectedLedgerRow =
    pagedLedgerRows.find((row) => row.key === selectedLedgerRowKey)
    ?? pagedLedgerRows[0]
    ?? null;
  const selectedJournalEntry = selectedLedgerRow
    ? journalByNumber.get(selectedLedgerRow.number) ?? null
    : null;
  const selectedLedgerEntry = selectedLedgerRow
    ? entriesById.get(selectedLedgerRow.entryId) ?? null
    : null;
  const selectedLedgerReceipts = selectedLedgerEntry?.receipts ?? [];

  // 関連仕訳＝同日・同取引先の別伝票。資金移動の相手側を辿る導線。
  const relatedJournalEntries = useMemo(() => {
    if (!selectedLedgerRow) return [];
    return journal
      .filter(
        (entry) =>
          entry.number !== selectedLedgerRow.number
          && entry.date === selectedLedgerRow.date
          && (selectedLedgerRow.partner
            ? entry.partner === selectedLedgerRow.partner
            : true),
      )
      .slice(0, 4);
  }, [journal, selectedLedgerRow]);

  // 更新履歴＝訂正削除履歴（DBトリガーが記録する。アプリからは書き換えられない）。
  const selectedLedgerRevisions = useMemo(() => {
    if (!selectedLedgerRow) return [];
    return revisions
      .filter((revision) => revision.entryId === selectedLedgerRow.entryId)
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  }, [revisions, selectedLedgerRow]);

  // 照合結果。元帳の最終残高と試算表の残高は同じ元データから導くので必ず一致する。
  // 一致しないときは仕訳の変換か期首残高が壊れている。
  const selectedTrialRow = selectedLedger
    ? trialBalance.rows.find(
        (row) => row.account.code === selectedLedger.account.code,
      ) ?? null
    : null;
  const selectedTrialAmount = !selectedTrialRow
    ? 0
    : selectedLedger?.account.normalSide === "debit"
      ? selectedTrialRow.debitBalance - selectedTrialRow.creditBalance
      : selectedTrialRow.creditBalance - selectedTrialRow.debitBalance;
  const ledgerReconcileDifference = ledgerClosingBalance - selectedTrialAmount;

  const selectAccount = (code: string) => {
    setLedgerAccountCode(code);
    setLedgerRowPage(1);
    setSelectedLedgerRowKey(null);
  };

  /** 元帳行から取引管理へ渡る。証憑・訂正の入力面は取引管理に一本化する。 */
  const openEntryFromLedger = (entryId: number, mode: "edit" | "receipt") => {
    const entry = entriesById.get(entryId);
    if (!entry) return;
    setActiveTab("expenses");
    if (mode === "edit") {
      handleStartEdit(entry);
      return;
    }
    openReceiptDrawer([entry.id]);
  };

  const ledgerHeaderActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="2xs"
        shape="rounded"
        className="font-acumin"
        aria-label="仕訳帳CSV"
        onClick={handleJournalExport}
      >
        CSV出力
        <i className="ri-download-2-line ml-1" aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        size="2xs"
        shape="rounded"
        className="font-acumin"
        aria-label="総勘定元帳CSV"
        disabled={!selectedLedger}
        onClick={handleGeneralLedgerExport}
      >
        帳簿出力
        <i className="ri-download-2-line ml-1" aria-hidden="true" />
      </Button>
    </div>
  );

  const ledgerDetailRow = (label: string, value: ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 font-acumin text-[11px] text-[#707070]">
        {label}
      </span>
      <span className="min-w-0 text-right font-acumin text-xs text-black">
        {value}
      </span>
    </div>
  );

  const ledgerView = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-acumin text-base font-medium tracking-widest text-black">
          仕訳・元帳
        </h3>
        {ledgerHeaderActions}
      </div>

      {/* 科目 → 残高推移と仕訳 → 明細。左から右へ絞り込みが進む並びにする。 */}
      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[240px_minmax(0,1fr)_230px]">
        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="勘定科目"
          title={<span className={panelTitleClassName}>勘定科目</span>}
        >
          <SearchField
            size="2xs"
            aria-label="勘定科目を検索"
            placeholder="科目を検索"
            className="w-full font-acumin"
            value={accountTreeKeyword}
            showClearButton
            onClear={() => setAccountTreeKeyword("")}
            onChange={(event) => setAccountTreeKeyword(event.target.value)}
          />
          {filteredAccountTree.length === 0 ? (
            <p className="mt-3 font-acumin text-xs text-[#707070]">
              取引管理に取引を入力すると、科目ごとの元帳が作成されます。
            </p>
          ) : (
            <ul className="mt-3 space-y-0.5">
              {filteredAccountTree.map((group) => {
                const groupOpen = !collapsedAccountGroups.includes(group.key);
                return (
                  <li key={group.key}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 py-1.5 text-left"
                      aria-expanded={groupOpen}
                      onClick={() => toggleAccountGroup(group.key)}
                    >
                      <i
                        className={`shrink-0 text-[#707070] ${groupOpen ? "ri-arrow-down-s-line" : "ri-arrow-right-s-line"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate font-acumin text-xs font-medium text-black">
                        {group.label}
                      </span>
                      <span className="shrink-0 font-acumin text-xs text-black tabular-nums">
                        {currency(group.total)}
                      </span>
                    </button>
                    {!groupOpen
                      ? null
                      : group.sections.map((section) => {
                          const sectionOpen = !collapsedAccountGroups.includes(
                            section.key,
                          );
                          return (
                            <div key={section.key}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-1 py-1.5 pl-3 text-left"
                                aria-expanded={sectionOpen}
                                onClick={() => toggleAccountGroup(section.key)}
                              >
                                <i
                                  className={`shrink-0 text-[#909090] ${sectionOpen ? "ri-arrow-down-s-line" : "ri-arrow-right-s-line"}`}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate font-acumin text-[11px] text-[#474747]">
                                  {section.section}
                                </span>
                                <span className="shrink-0 font-acumin text-[11px] text-[#474747] tabular-nums">
                                  {currency(section.total)}
                                </span>
                              </button>
                              {!sectionOpen
                                ? null
                                : section.accounts.map((row) => {
                                    const active =
                                      selectedLedger?.account.code
                                      === row.account.code;
                                    return (
                                      <button
                                        key={row.account.code}
                                        type="button"
                                        aria-current={active ? "true" : undefined}
                                        className={`flex w-full items-center gap-2 rounded-sm py-1.5 pl-8 pr-1.5 text-left transition-colors ${
                                          active
                                            ? "bg-[#f0f0f0]"
                                            : "hover:bg-[#fafafa]"
                                        }`}
                                        onClick={() =>
                                          selectAccount(row.account.code)
                                        }
                                      >
                                        <span className="shrink-0 font-acumin text-[10px] text-[#909090] tabular-nums">
                                          {row.account.code}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate font-acumin text-[11px] text-black">
                                          {row.account.name}
                                        </span>
                                        <span className="shrink-0 font-acumin text-[11px] text-black tabular-nums">
                                          {currency(row.closingBalance)}
                                        </span>
                                      </button>
                                    );
                                  })}
                            </div>
                          );
                        })}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="残高推移"
            title={
              <span className={panelTitleClassName}>
                {selectedLedger
                  ? `${selectedLedger.account.code} ${selectedLedger.account.name}　残高推移`
                  : "残高推移"}
              </span>
            }
          >
            {!selectedLedger ? (
              <p className="font-acumin text-xs text-[#707070]">
                科目を選ぶと、月末残高の推移が表示されます。
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_180px]">
                <div className="min-w-0">
                  <Graph
                    variant="line"
                    size="2xs"
                    plotHeight={220}
                    unitLabel="（円）"
                    className="font-acumin"
                    ariaLabel={`${selectedLedger.account.name}の月末残高推移`}
                    categories={LEDGER_MONTH_LABELS}
                    referenceLine={{
                      value: ledgerOpeningBalance,
                      color: LEDGER_OPENING_COLOR,
                    }}
                    markers={ledgerAnomalyMonths.map((index) => ({
                      seriesIndex: 0,
                      index,
                      color: LEDGER_ANOMALY_COLOR,
                    }))}
                    series={[
                      {
                        label: "当期残高",
                        color: LEDGER_TREND_COLOR,
                        values: ledgerMonthlyPoints.map((point) => point.balance),
                      },
                    ]}
                    extraLegend={[
                      {
                        label: "前期末残高",
                        color: LEDGER_OPENING_COLOR,
                        kind: "line",
                        dashed: true,
                      },
                      {
                        label: "異常値",
                        color: LEDGER_ANOMALY_COLOR,
                        kind: "dot",
                      },
                    ]}
                  />
                </div>
                <div className={`${boxRadiusClassName} border border-[#ededed] p-3`}>
                  <p className="font-acumin text-[11px] text-[#707070]">
                    当期末残高
                  </p>
                  <p className="font-acumin text-lg font-medium text-black tabular-nums">
                    {currency(ledgerClosingBalance)}
                  </p>
                  <p className="mt-3 font-acumin text-[11px] text-[#707070]">
                    前期末残高
                  </p>
                  <p className="font-acumin text-base text-black tabular-nums">
                    {currency(ledgerOpeningBalance)}
                  </p>
                  <p className="mt-3 border-t border-[#ededed] pt-2 font-acumin text-[11px] text-[#707070]">
                    差額
                  </p>
                  <p
                    className={`font-acumin text-base font-medium tabular-nums ${
                      ledgerClosingBalance - ledgerOpeningBalance >= 0
                        ? "text-[#16844b]"
                        : "text-red-700"
                    }`}
                  >
                    {deltaCurrency(ledgerClosingBalance - ledgerOpeningBalance)}
                  </p>
                </div>
              </div>
            )}
          </Panel>

          <Panel
            radius="rounded"
            headingLevel={4}
            size="2xs"
            aria-label="仕訳一覧"
            title={
              <span className={panelTitleClassName}>
                {selectedLedger
                  ? `仕訳一覧（${selectedLedger.account.code} ${selectedLedger.account.name}）`
                  : "仕訳一覧"}
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <SearchField
                size="2xs"
                aria-label="仕訳を検索"
                placeholder="摘要・取引先・伝票No.で検索"
                className="w-full font-acumin sm:w-[200px]"
                value={ledgerRowKeyword}
                showClearButton
                onClear={() => {
                  setLedgerRowKeyword("");
                  setLedgerRowPage(1);
                }}
                onChange={(event) => {
                  setLedgerRowKeyword(event.target.value);
                  setLedgerRowPage(1);
                }}
              />
              <SingleSelect
                variant="dropdown"
                size="2xs"
                aria-label="集計期間"
                className="font-acumin"
                options={ledgerPeriodOptions}
                value={ledgerPeriod}
                onValueChange={(value) => {
                  setLedgerPeriod(value);
                  setLedgerRowPage(1);
                }}
              />
              <SingleSelect
                variant="dropdown"
                size="2xs"
                aria-label="取引の絞り込み"
                className="font-acumin"
                options={LEDGER_SIDE_OPTIONS}
                value={ledgerSideFilter}
                onValueChange={(value) => {
                  setLedgerSideFilter(value);
                  setLedgerRowPage(1);
                }}
              />
              <Button
                variant="outline"
                size="2xs"
                shape="rounded"
                className="font-acumin"
                onClick={() => {
                  setActiveTab("expenses");
                  setIsFilterDrawerOpen(true);
                }}
              >
                詳細絞り込み
                <i className="ri-equalizer-line ml-1" aria-hidden="true" />
              </Button>
            </div>

            <p className="mt-3 font-acumin text-[10px] text-[#707070]">
              （単位：円）
            </p>
            <div className="mt-1">
              <DataTable
                size="3xs"
                shape="rounded"
                hoverableRows
                rows={pagedLedgerRows}
                rowKey={(row) => row.key}
                emptyLabel="該当する仕訳がありません。"
                tableClassName="min-w-[620px]"
                containerClassName="font-acumin"
                rowClassName={(row) =>
                  selectedLedgerRow?.key === row.key ? "bg-[#f5f5f5]" : ""
                }
                columns={[
                  {
                    key: "date",
                    header: "日付",
                    cellClassName: "whitespace-nowrap tabular-nums",
                    render: (row) => (
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-left"
                        aria-label={`${row.number}の明細を表示`}
                        aria-pressed={selectedLedgerRow?.key === row.key}
                        onClick={() => setSelectedLedgerRowKey(row.key)}
                      >
                        <i
                          className={
                            selectedLedgerRow?.key === row.key
                              ? "ri-checkbox-circle-fill text-black"
                              : "ri-circle-line text-[#c4c4c4]"
                          }
                          aria-hidden="true"
                        />
                        {row.date.replaceAll("-", "/")}
                      </button>
                    ),
                  },
                  {
                    key: "number",
                    header: "伝票No.",
                    cellClassName: "whitespace-nowrap text-[#474747]",
                    render: (row) => row.number,
                  },
                  {
                    key: "counter",
                    header: "相手勘定科目",
                    render: (row) => (
                      <span className="block max-w-[64px] truncate">
                        {row.counterAccount}
                      </span>
                    ),
                  },
                  {
                    key: "partner",
                    header: "取引先",
                    render: (row) => (
                      <span className="block max-w-[64px] truncate">
                        {row.partner || "—"}
                      </span>
                    ),
                  },
                  {
                    key: "description",
                    header: "摘要",
                    render: (row) => (
                      <span className="block max-w-[76px] truncate">
                        {row.description}
                      </span>
                    ),
                  },
                  {
                    key: "debit",
                    header: "借方",
                    align: "right",
                    cellClassName: "whitespace-nowrap tabular-nums",
                    render: (row) =>
                      row.debit > 0 ? row.debit.toLocaleString("ja-JP") : "—",
                  },
                  {
                    key: "credit",
                    header: "貸方",
                    align: "right",
                    cellClassName: "whitespace-nowrap tabular-nums",
                    render: (row) =>
                      row.credit > 0 ? row.credit.toLocaleString("ja-JP") : "—",
                  },
                  {
                    key: "balance",
                    header: "残高",
                    align: "right",
                    cellClassName: "whitespace-nowrap tabular-nums",
                    render: (row) => row.balance.toLocaleString("ja-JP"),
                  },
                  {
                    key: "receipt",
                    header: "証憑",
                    align: "center",
                    cellClassName: "whitespace-nowrap",
                    render: (row) => {
                      // 決算整理仕訳は取引ではないので証憑の対象外。
                      if (row.entryId < 0) return "—";
                      return (entriesById.get(row.entryId)?.receipts ?? [])
                        .length > 0
                        ? "有"
                        : "無";
                    },
                  },
                ]}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-acumin text-[11px] text-[#707070]">
                  表示件数
                </span>
                <SingleSelect
                  variant="dropdown"
                  size="3xs"
                  aria-label="表示件数"
                  className="font-acumin"
                  options={LEDGER_PAGE_SIZE_OPTIONS.map((option) => ({
                    value: String(option),
                    label: `${option}件`,
                  }))}
                  value={String(ledgerPageSize)}
                  onValueChange={(value) => {
                    setLedgerPageSize(Number(value));
                    setLedgerRowPage(1);
                  }}
                />
              </div>
              <PageControl
                size="3xs"
                page={currentLedgerPage}
                totalPages={ledgerTotalPages}
                maxVisiblePages={6}
                previousAriaLabel="前のページ"
                nextAriaLabel="次のページ"
                onPageChange={setLedgerRowPage}
              />
              <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
                {ledgerRangeStart}-{ledgerRangeEnd} / {filteredLedgerRows.length}件
              </span>
            </div>
          </Panel>
        </div>

        <Panel
          radius="rounded"
          headingLevel={4}
          className="h-fit"
          aria-label="仕訳詳細"
          title={<span className={panelTitleClassName}>仕訳詳細</span>}
        >
          {!selectedLedgerRow ? (
            <p className="font-acumin text-xs text-[#707070]">
              仕訳一覧の行を選ぶと、借方・貸方と更新履歴が表示されます。
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                {ledgerDetailRow(
                  "日付",
                  <span className="tabular-nums">
                    {selectedLedgerRow.date.replaceAll("-", "/")}
                  </span>,
                )}
                {ledgerDetailRow("伝票No.", selectedLedgerRow.number)}
                {ledgerDetailRow(
                  "証憑",
                  selectedLedgerReceipts.length > 0
                    ? selectedLedgerReceipts[0].fileName
                    : selectedLedgerRow.entryId < 0
                      ? "決算整理（対象外）"
                      : "未添付",
                )}
                {ledgerDetailRow(
                  "取引区分",
                  selectedLedgerRow.entryId < 0
                    ? "決算整理"
                    : selectedLedgerEntry?.entryType === "income"
                      ? "収入"
                      : "支出",
                )}
                {ledgerDetailRow("取引先", selectedLedgerRow.partner || "—")}
                {ledgerDetailRow("摘要", selectedLedgerRow.description)}
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-[#ededed] pt-3">
                {(["debit", "credit"] as const).map((side) => {
                  const lines = (selectedJournalEntry?.lines ?? []).filter(
                    (line) => (side === "debit" ? line.debit : line.credit) > 0,
                  );
                  return (
                    <div key={side} className="min-w-0">
                      <p className="font-acumin text-[11px] font-medium text-black">
                        {side === "debit" ? "借方" : "貸方"}
                      </p>
                      {lines.length === 0 ? (
                        <p className="mt-1 font-acumin text-[11px] text-[#909090]">
                          —
                        </p>
                      ) : (
                        lines.map((line) => (
                          <div
                            key={`${side}-${line.account.code}`}
                            className="mt-1"
                          >
                            <p className="font-acumin text-[11px] text-[#707070]">
                              科目
                              <span className="ml-2 text-black">
                                {line.account.name}
                              </span>
                            </p>
                            <p className="font-acumin text-[11px] text-[#707070]">
                              金額
                              <span className="ml-2 text-black tabular-nums">
                                {currency(
                                  side === "debit" ? line.debit : line.credit,
                                )}
                              </span>
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-[#ededed] pt-3">
                <p className="font-acumin text-[11px] font-medium text-black">
                  関連仕訳
                </p>
                {relatedJournalEntries.length === 0 ? (
                  <p className="mt-1 font-acumin text-[11px] text-[#909090]">
                    同日・同取引先の別仕訳はありません。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {relatedJournalEntries.map((entry) => (
                      <li key={entry.number}>
                        <span className="font-acumin text-[11px] text-black underline">
                          {entry.number}
                        </span>
                        <span className="ml-1 font-acumin text-[11px] text-[#707070]">
                          （{entry.description}）
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="border-t border-[#ededed] pt-3">
                <p className="font-acumin text-[11px] font-medium text-black">
                  更新履歴
                </p>
                {selectedLedgerRevisions.length === 0 ? (
                  <p className="mt-1 font-acumin text-[11px] text-[#909090]">
                    訂正・削除の履歴はありません。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {selectedLedgerRevisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="font-acumin text-[11px] text-[#474747] tabular-nums">
                          {new Date(revision.changedAt).toLocaleString("ja-JP")}
                        </span>
                        <span className="font-acumin text-[11px] text-black">
                          {REVISION_OPERATION_LABELS[revision.operation]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex gap-2 border-t border-[#ededed] pt-3">
                <Button
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  className="flex-1 font-acumin"
                  disabled={selectedLedgerRow.entryId < 0}
                  onClick={() =>
                    openEntryFromLedger(selectedLedgerRow.entryId, "receipt")
                  }
                >
                  証憑を表示
                </Button>
                <Button
                  variant="primary"
                  size="2xs"
                  shape="rounded"
                  className="flex-1 font-acumin"
                  disabled={selectedLedgerRow.entryId < 0}
                  onClick={() =>
                    openEntryFromLedger(selectedLedgerRow.entryId, "edit")
                  }
                >
                  <i className="ri-pencil-line mr-1" aria-hidden="true" />
                  修正
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* 元帳と試算表の突き合わせ。同じ仕訳から導くので一致が既定の状態。 */}
      <Panel
        radius="rounded"
        headingLevel={4}
        aria-label="照合結果"
        title={
          <span className={panelTitleClassName}>
            {selectedLedger
              ? `照合結果（${selectedLedger.account.code} ${selectedLedger.account.name}）`
              : "照合結果"}
          </span>
        }
        actions={
          <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
            {syncedAt
              ? `最終更新：${new Date(syncedAt).toLocaleString("ja-JP")}（自動照合）`
              : "（自動照合）"}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <p className="font-acumin text-[11px] text-[#707070]">
              元帳残高（最終残高）
            </p>
            <p className="flex items-center gap-2 font-acumin text-xl font-medium text-[#16844b] tabular-nums">
              {currency(ledgerClosingBalance)}
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
            </p>
          </div>
          <FlowOperator symbol="=" />
          <div>
            <p className="font-acumin text-[11px] text-[#707070]">
              試算表残高
              {selectedLedger ? `（${selectedLedger.account.name}）` : ""}
            </p>
            <p className="flex items-center gap-2 font-acumin text-xl font-medium text-[#16844b] tabular-nums">
              {currency(selectedTrialAmount)}
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
            </p>
          </div>
          <div className="border-l border-[#ededed] pl-8">
            <p className="font-acumin text-[11px] text-[#707070]">差額</p>
            <p
              className={`font-acumin text-xl font-medium tabular-nums ${
                ledgerReconcileDifference === 0 ? "text-black" : "text-red-700"
              }`}
            >
              {currency(ledgerReconcileDifference)}
            </p>
          </div>
          <p
            className={`ml-auto flex items-center gap-2 font-acumin text-base font-medium tracking-widest ${
              trialBalance.isBalanced && ledgerReconcileDifference === 0
                ? "text-[#16844b]"
                : "text-red-700"
            }`}
            role="status"
          >
            <i
              className={
                trialBalance.isBalanced && ledgerReconcileDifference === 0
                  ? "ri-checkbox-circle-line text-xl"
                  : "ri-error-warning-line text-xl"
              }
              aria-hidden="true"
            />
            {trialBalance.isBalanced && ledgerReconcileDifference === 0
              ? "貸借一致"
              : `貸借不一致：差額 ${currency(trialBalance.difference)}`}
          </p>
        </div>
      </Panel>
    </div>
  );


  // ── 固定資産 ───────────────────────────────────────────────────────────
  const assetSectionOptions = useMemo(() => {
    const sections = new Set<string>();
    for (const asset of fixedAssets) {
      const account = accountByName(asset.account);
      if (account) sections.add(account.section);
    }
    return [
      { value: "all", label: "全ての資産" },
      ...[...sections]
        .sort((a, b) => a.localeCompare(b, "ja"))
        .map((section) => ({ value: section, label: section })),
    ];
  }, [fixedAssets]);

  const assetMethodOptions = useMemo(
    () => [
      { value: "all", label: "全て" },
      ...(Object.keys(DEPRECIATION_METHOD_LABELS) as DepreciationMethod[])
        .filter((method) =>
          fixedAssets.some((asset) => asset.method === method),
        )
        .map((method) => ({
          value: method,
          label: DEPRECIATION_METHOD_LABELS[method],
        })),
    ],
    [fixedAssets],
  );

  // 台帳の絞り込み。カテゴリ（決算書区分）・償却方法・キーワードの3条件。
  const filteredDepreciationRows = useMemo(() => {
    const keyword = assetKeyword.trim().toLowerCase();
    return depreciation.rows.filter((row) => {
      if (assetMethodFilter !== "all" && row.asset.method !== assetMethodFilter) {
        return false;
      }
      if (assetSectionFilter !== "all") {
        if (accountByName(row.asset.account)?.section !== assetSectionFilter) {
          return false;
        }
      }
      if (!keyword) return true;
      return `${row.asset.name} ${row.asset.account} #${row.asset.id}`
        .toLowerCase()
        .includes(keyword);
    });
  }, [depreciation.rows, assetMethodFilter, assetSectionFilter, assetKeyword]);

  const assetTotals = useMemo(() => {
    const sum = (pick: (row: DepreciationForYear) => number) =>
      filteredDepreciationRows.reduce((total, row) => total + pick(row), 0);
    return {
      depreciation: sum((row) => row.depreciation),
      businessExpense: sum((row) => row.businessExpense),
      closingBookValue: sum((row) => row.closingBookValue),
      accumulated: sum((row) => row.accumulated),
      acquisitionCost: sum((row) => row.asset.acquisitionCost),
    };
  }, [filteredDepreciationRows]);

  // 償却予定表の年度列。実績（当年度まで）と予測（翌年度以降）を並べる。
  const depreciationYears = useMemo(() => {
    const years: Array<{ year: number; isForecast: boolean }> = [];
    for (
      let offset = -DEPRECIATION_PAST_YEARS;
      offset <= DEPRECIATION_FUTURE_YEARS;
      offset += 1
    ) {
      years.push({ year: fiscalYear + offset, isForecast: offset > 0 });
    }
    return years;
  }, [fiscalYear]);

  // 資産×年度の償却費。予測は当期と同じ計算式を将来年に適用するだけで、
  // 別の係数は置かない（予測が実績と地続きであることを保証する）。
  const depreciationPlanRows = useMemo(
    () =>
      filteredDepreciationRows.map((row) => {
        const byYear = depreciationYears.map(
          ({ year }) => depreciationForYear(row.asset, year).depreciation,
        );
        const acquiredYear = Number.parseInt(row.asset.acquiredOn.slice(0, 4), 10);
        // 償却完了年＝簿価が残存価額まで落ちる最初の年。
        let completedYear: number | null = null;
        for (
          let year = acquiredYear;
          year <= acquiredYear + row.asset.usefulLife + 60;
          year += 1
        ) {
          if (depreciationForYear(row.asset, year).isFinalYear) {
            completedYear = year;
            break;
          }
        }
        return { row, byYear, completedYear };
      }),
    [filteredDepreciationRows, depreciationYears],
  );

  const depreciationYearTotals = useMemo(
    () =>
      depreciationYears.map((_, index) =>
        depreciationPlanRows.reduce(
          (sum, plan) => sum + (plan.byYear[index] ?? 0),
          0,
        ),
      ),
    [depreciationYears, depreciationPlanRows],
  );

  // 必要経費算入額（事業按分後）の年度別。グラフの棒に使う。
  const businessExpenseYearTotals = useMemo(
    () =>
      depreciationYears.map(({ year }) =>
        filteredDepreciationRows.reduce(
          (sum, row) =>
            sum + depreciationForYear(row.asset, year).businessExpense,
          0,
        ),
      ),
    [depreciationYears, filteredDepreciationRows],
  );

  const assetsCompletingThisYear = depreciationPlanRows.filter(
    (plan) => plan.completedYear === fiscalYear,
  ).length;

  /** 減価償却予定表（資産別・年度別）。予測年度も同じ計算式の値をそのまま出す。 */
  const handleDepreciationPlanExport = () => {
    exportCsv(`${fiscalYearLabel}_減価償却予定表.csv`, [
      [
        "資産名",
        "管理番号",
        "取得日",
        "取得金額",
        "償却方法",
        "耐用年数",
        "残存価額",
        "月数",
        "事業割合",
        "必要経費算入額",
        "未償却残高",
        ...depreciationYears.map(
          ({ year, isForecast }) =>
            `${year}年度（${isForecast ? "予測" : "実績"}）`,
        ),
        "償却完了予定",
      ],
      ...depreciationPlanRows.map((plan) => [
        plan.row.asset.name,
        `#${plan.row.asset.id}`,
        plan.row.asset.acquiredOn,
        plan.row.asset.acquisitionCost,
        DEPRECIATION_METHOD_LABELS[plan.row.asset.method],
        plan.row.asset.method === "straightLine"
          ? plan.row.asset.usefulLife
          : "",
        plan.row.asset.method === "straightLine" ? 1 : 0,
        plan.row.asset.method === "straightLine" ? plan.row.months : "",
        `${plan.row.asset.businessUseRatio}%`,
        plan.row.businessExpense,
        plan.row.closingBookValue,
        ...plan.byYear,
        plan.completedYear ? `${plan.completedYear}年度` : "",
      ]),
      [
        "合計",
        "",
        "",
        assetTotals.acquisitionCost,
        "",
        "",
        "",
        "",
        "",
        assetTotals.businessExpense,
        assetTotals.closingBookValue,
        ...depreciationYearTotals,
        `${assetsCompletingThisYear}件`,
      ],
    ]);
  };

  const assetTotalPages = Math.max(
    1,
    Math.ceil(filteredDepreciationRows.length / ASSET_PAGE_SIZE),
  );
  const currentAssetPage = Math.min(assetPage, assetTotalPages);
  const pagedAssetRows = filteredDepreciationRows.slice(
    (currentAssetPage - 1) * ASSET_PAGE_SIZE,
    currentAssetPage * ASSET_PAGE_SIZE,
  );
  const assetRangeStart =
    filteredDepreciationRows.length === 0
      ? 0
      : (currentAssetPage - 1) * ASSET_PAGE_SIZE + 1;
  const assetRangeEnd = Math.min(
    currentAssetPage * ASSET_PAGE_SIZE,
    filteredDepreciationRows.length,
  );

  // 償却シミュレーション。入力中のフォームをそのまま1件の資産として試算する。
  const assetSimulation = useMemo(() => {
    const cost = Math.max(0, Math.round(Number(assetForm.acquisitionCost) || 0));
    const usefulLife = Math.max(1, Number(assetForm.usefulLife) || 1);
    const ratio = Math.min(
      100,
      Math.max(1, Number(assetForm.businessUseRatio) || 100),
    );
    if (cost <= 0 || !assetForm.acquiredOn) {
      return { annual: 0, currentYear: 0, residual: 0 };
    }
    const draft: FixedAsset = {
      id: 0,
      name: assetForm.name || "（試算）",
      account: assetForm.account,
      acquiredOn: assetForm.acquiredOn,
      acquisitionCost: cost,
      usefulLife,
      method: assetForm.method,
      businessUseRatio: ratio,
      disposedOn: null,
      memo: "",
    };
    const acquiredYear = Number.parseInt(assetForm.acquiredOn.slice(0, 4), 10);
    return {
      // 年間償却額（概算）は月割の影響を受けない満年ベース＝取得翌年の額。
      annual: depreciationForYear(draft, acquiredYear + 1).depreciation,
      currentYear: depreciationForYear(draft, fiscalYear).depreciation,
      residual: assetForm.method === "straightLine" ? 1 : 0,
    };
  }, [assetForm, fiscalYear]);

  const assetsView = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-acumin text-base font-medium tracking-widest text-black">
            固定資産
          </h3>
          <div className="mt-2 flex items-center gap-2">
            <span className="font-acumin text-[11px] text-[#474747]">
              資産カテゴリ
            </span>
            <SingleSelect
              variant="dropdown"
              size="2xs"
              aria-label="資産カテゴリ"
              className="font-acumin"
              options={assetSectionOptions}
              value={assetSectionFilter}
              onValueChange={(value) => {
                setAssetSectionFilter(value);
                setAssetPage(1);
              }}
            />
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-3 xl:w-auto xl:min-w-[640px] xl:flex-1 xl:grid-cols-5">
          <MetricCard
            label={`当期償却（${fiscalYear}年度）`}
            value={currency(assetTotals.depreciation)}
            note={`${filteredDepreciationRows.length}件`}
          />
          <MetricCard
            label={`来期予測（${fiscalYear + 1}年度）`}
            value={currency(
              depreciationYearTotals[DEPRECIATION_PAST_YEARS + 1] ?? 0,
            )}
            note="同じ償却率で試算"
          />
          <MetricCard
            label="必要経費算入額"
            value={currency(assetTotals.businessExpense)}
            note="家事按分後"
          />
          <MetricCard
            label="未償却残高"
            value={currency(assetTotals.closingBookValue)}
            note="貸借対照表の固定資産"
          />
          <MetricCard
            label={`償却完了予定（${fiscalYear}年度内）`}
            value={`${assetsCompletingThisYear}件`}
            note="残存価額に到達"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[320px_minmax(0,1fr)_280px]">
        <Panel
          radius="rounded"
          headingLevel={4}
          className="h-fit"
          aria-label="資産一覧"
          title={<span className={panelTitleClassName}>資産一覧</span>}
        >
          <SearchField
            size="2xs"
            aria-label="資産を検索"
            placeholder="資産名・管理番号で検索"
            className="w-full font-acumin"
            value={assetKeyword}
            showClearButton
            onClear={() => {
              setAssetKeyword("");
              setAssetPage(1);
            }}
            onChange={(event) => {
              setAssetKeyword(event.target.value);
              setAssetPage(1);
            }}
          />
          <div className="mt-3">
            <DataTable
              size="2xs"
              shape="rounded"
              hoverableRows
              rows={pagedAssetRows}
              rowKey={(row) => String(row.asset.id)}
              emptyLabel="固定資産がまだありません。"
              containerClassName="font-acumin"
              columns={[
                {
                  key: "name",
                  header: "資産名",
                  cellClassName: "whitespace-nowrap",
                  render: (row) => row.asset.name,
                },
                {
                  key: "usefulLife",
                  header: "耐用年数",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) =>
                    row.asset.method === "straightLine"
                      ? `${row.asset.usefulLife}年`
                      : "—",
                },
                {
                  key: "bookValue",
                  header: "未償却残高",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => currency(row.closingBookValue),
                },
                {
                  key: "actions",
                  header: "",
                  align: "center",
                  className: "w-10",
                  render: (row) => (
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 items-center justify-center border border-transparent text-[#474747] hover:border-[#d4d4d4] hover:text-black"
                      aria-label={`${row.asset.name}を削除`}
                      disabled={isSaving}
                      onClick={() => void handleDeleteFixedAsset(row.asset)}
                    >
                      <EmptyIcon icon="ri-delete-bin-line" />
                    </button>
                  ),
                },
              ]}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
              全{filteredDepreciationRows.length}件中 {assetRangeStart}-
              {assetRangeEnd}件を表示
            </span>
            <PageControl
              size="3xs"
              page={currentAssetPage}
              totalPages={assetTotalPages}
              maxVisiblePages={5}
              previousAriaLabel="前のページ"
              nextAriaLabel="次のページ"
              onPageChange={setAssetPage}
            />
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="減価償却推移"
            title={<span className={panelTitleClassName}>減価償却推移</span>}
          >
            {filteredDepreciationRows.length === 0 ? (
              <p className="font-acumin text-xs text-[#707070]">
                固定資産を登録すると、取得日と耐用年数から償却の推移が描かれます。
              </p>
            ) : (
              <Graph
                variant="line"
                size="2xs"
                plotHeight={280}
                unitLabel="（円）"
                className="font-acumin"
                ariaLabel="減価償却費の年度別推移"
                categories={depreciationYears.map(({ year }) => `${year}年度`)}
                forecastFrom={DEPRECIATION_PAST_YEARS + 1}
                forecastLabels={{ past: "実績 →", future: "← 予測" }}
                series={[
                  {
                    label: "償却額",
                    color: DEPRECIATION_LINE_COLOR,
                    values: depreciationYearTotals,
                  },
                  {
                    label: "必要経費算入額",
                    kind: "bar",
                    color: DEPRECIATION_BAR_COLOR,
                    values: businessExpenseYearTotals,
                  },
                ]}
              />
            )}
          </Panel>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-acumin text-[11px] text-[#474747]">
                償却方法フィルター
              </span>
              {assetMethodOptions.map((option) => (
                <Button
                  key={option.value}
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  selected={assetMethodFilter === option.value}
                  className="font-acumin"
                  onClick={() => {
                    setAssetMethodFilter(option.value);
                    setAssetPage(1);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="2xs"
                shape="rounded"
                className="font-acumin"
                aria-label="台帳CSV"
                onClick={handleFixedAssetExport}
              >
                CSV出力
                <i className="ri-download-2-line ml-1" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="2xs"
                shape="rounded"
                className="font-acumin"
                aria-label="減価償却予定表CSV"
                onClick={handleDepreciationPlanExport}
              >
                台帳出力
                <i className="ri-file-list-3-line ml-1" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>

        <Panel
          radius="rounded"
          headingLevel={4}
          className="h-fit"
          aria-label="償却シミュレーション"
          title={
            <span className={panelTitleClassName}>償却シミュレーション</span>
          }
        >
          <div className="space-y-2.5">
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                資産名 <span className="text-red-700">*</span>
              </span>
              <input
                type="text"
                value={assetForm.name}
                onChange={(event) =>
                  setAssetForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                className={inputClassName}
                placeholder="工業用ミシン"
              />
            </label>

            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                勘定科目 <span className="text-red-700">*</span>
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="sm"
                aria-label="固定資産の勘定科目"
                className="font-acumin"
                options={fixedAssetAccountOptions}
                value={assetForm.account}
                onValueChange={(value) =>
                  setAssetForm((current) => ({ ...current, account: value }))
                }
              />
            </div>

            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                取得金額 <span className="text-red-700">*</span>
              </span>
              <input
                type="number"
                min="1"
                value={assetForm.acquisitionCost}
                onChange={(event) =>
                  setAssetForm((current) => ({
                    ...current,
                    acquisitionCost: event.target.value,
                  }))
                }
                className={inputClassName}
                placeholder="0"
              />
            </label>

            <div className="space-y-2.5">
              <label className="block">
                <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                  取得日 <span className="text-red-700">*</span>
                </span>
                <input
                  type="date"
                  value={assetForm.acquiredOn}
                  onChange={(event) =>
                    setAssetForm((current) => ({
                      ...current,
                      acquiredOn: event.target.value,
                    }))
                  }
                  className={inputClassName}
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                  除却日（任意）
                </span>
                <input
                  type="date"
                  value={assetForm.disposedOn}
                  onChange={(event) =>
                    setAssetForm((current) => ({
                      ...current,
                      disposedOn: event.target.value,
                    }))
                  }
                  className={inputClassName}
                />
              </label>
            </div>

            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                償却方法
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="sm"
                aria-label="償却方法"
                className="font-acumin"
                options={(
                  Object.keys(DEPRECIATION_METHOD_LABELS) as DepreciationMethod[]
                ).map((method) => ({
                  value: method,
                  label: DEPRECIATION_METHOD_LABELS[method],
                }))}
                value={assetForm.method}
                onValueChange={(value) =>
                  setAssetForm((current) => ({
                    ...current,
                    method: value as DepreciationMethod,
                  }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              {assetForm.method === "straightLine" ? (
                <label className="block">
                  <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                    耐用年数（率{" "}
                    {straightLineRate(Number(assetForm.usefulLife) || 1).toFixed(3)}
                    ）
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={assetForm.usefulLife}
                    onChange={(event) =>
                      setAssetForm((current) => ({
                        ...current,
                        usefulLife: event.target.value,
                      }))
                    }
                    className={inputClassName}
                  />
                </label>
              ) : null}
              <label className="block">
                <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                  事業専用割合（%）
                </span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={assetForm.businessUseRatio}
                  onChange={(event) =>
                    setAssetForm((current) => ({
                      ...current,
                      businessUseRatio: event.target.value,
                    }))
                  }
                  className={inputClassName}
                />
              </label>
            </div>

            <div className="border-t border-[#d4d4d4] pt-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-acumin text-[11px] text-[#474747]">
                  残存価額（期末）
                </span>
                <span className="font-acumin text-xs text-black tabular-nums">
                  {currency(assetSimulation.residual)}
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span className="font-acumin text-[11px] text-[#474747]">
                  年間償却額（概算）
                </span>
                <span className="font-acumin text-sm font-medium text-black tabular-nums">
                  {currency(assetSimulation.annual)}
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span className="font-acumin text-[11px] text-[#474747]">
                  当期影響額（{fiscalYear}年度）
                </span>
                <span className="font-acumin text-sm font-medium text-black tabular-nums">
                  {currency(assetSimulation.currentYear)}
                </span>
              </div>
            </div>

            {assetMessage ? (
              <p
                className={`font-acumin text-xs ${/失敗|ください/.test(assetMessage) ? "text-red-700" : "text-[#16844b]"}`}
                role="status"
              >
                {assetMessage}
              </p>
            ) : null}

            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              onClick={() => void handleSaveFixedAsset()}
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : "固定資産を保存"}
            </Button>
          </div>
        </Panel>
      </div>

      <Panel
        radius="rounded"
        headingLevel={4}
        aria-label="減価償却予定表"
        title={
          <span className={panelTitleClassName}>
            減価償却予定表（資産別・年度別）
          </span>
        }
      >
        {depreciationPlanRows.length === 0 ? (
          <p className="font-acumin text-xs text-[#707070]">
            固定資産を登録すると、年度別の償却予定が自動計算されます。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1520px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    "資産名",
                    "管理番号",
                    "取得日",
                    "取得金額",
                    "償却方法",
                    "耐用年数",
                    "残存価額",
                    "月数",
                    "事業割合",
                    "必要経費",
                    "未償却残高",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                    >
                      {heading}
                    </th>
                  ))}
                  {depreciationYears.map(({ year, isForecast }) => (
                    <th
                      key={year}
                      className={`px-2 py-2 text-right font-acumin text-[11px] font-normal ${
                        isForecast
                          ? "bg-[#f4f8fe] text-[#2f6fdb]"
                          : "text-[#474747]"
                      }`}
                    >
                      {year}年度
                      <br />
                      （{isForecast ? "予測" : "実績"}）
                    </th>
                  ))}
                  <th className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]">
                    償却完了予定
                  </th>
                </tr>
              </thead>
              <tbody>
                {depreciationPlanRows.map((plan) => (
                  <tr
                    key={plan.row.asset.id}
                    className="border-b border-[#ededed]"
                  >
                    <td className="px-2 py-2.5 font-acumin text-xs text-black">
                      {plan.row.asset.name}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747] tabular-nums">
                      #{plan.row.asset.id}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-xs text-black tabular-nums">
                      {plan.row.asset.acquiredOn.replaceAll("-", "/")}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                      {currency(plan.row.asset.acquisitionCost)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747]">
                      {DEPRECIATION_METHOD_LABELS[plan.row.asset.method]}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                      {plan.row.asset.method === "straightLine"
                        ? `${plan.row.asset.usefulLife}年`
                        : "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                      {currency(
                        plan.row.asset.method === "straightLine" ? 1 : 0,
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                      {plan.row.asset.method === "straightLine"
                        ? `${plan.row.months}/12`
                        : "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                      {plan.row.asset.businessUseRatio}%
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                      {currency(plan.row.businessExpense)}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                      {currency(plan.row.closingBookValue)}
                    </td>
                    {depreciationYears.map(({ year, isForecast }, index) => (
                      <td
                        key={year}
                        className={`px-2 py-2.5 text-right font-acumin text-xs tabular-nums ${
                          isForecast
                            ? "bg-[#f4f8fe] text-[#2f6fdb]"
                            : "text-black"
                        }`}
                      >
                        {currency(plan.byYear[index] ?? 0)}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-xs text-[#474747] tabular-nums">
                      {plan.completedYear ? `${plan.completedYear}年度` : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-black">
                  <td className="px-2 py-2 font-acumin text-xs font-medium text-black">
                    合計
                  </td>
                  <td />
                  <td />
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(assetTotals.acquisitionCost)}
                  </td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(assetTotals.businessExpense)}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(assetTotals.closingBookValue)}
                  </td>
                  {depreciationYears.map(({ year, isForecast }, index) => (
                    <td
                      key={year}
                      className={`px-2 py-2 text-right font-acumin text-xs font-medium tabular-nums ${
                        isForecast ? "bg-[#f4f8fe] text-[#2f6fdb]" : "text-black"
                      }`}
                    >
                      {currency(depreciationYearTotals[index] ?? 0)}
                    </td>
                  ))}
                  <td className="px-2 py-2 font-acumin text-xs font-medium text-black tabular-nums">
                    {assetsCompletingThisYear}件
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 font-acumin text-[10px] leading-relaxed text-[#707070]">
          ※
          予測は当期と同じ計算式（定額法は「取得価額×償却率×使用月数/12」）を将来年度に適用した値です。
          一括償却資産は3年均等、即時償却は取得年に全額を計上します。
        </p>
      </Panel>
    </div>
  );

  const closingView = (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <div className={panelClassName}>
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              決算整理の内訳（{fiscalYearLabel}）
            </h4>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["決算整理", "借方", "貸方", "金額"].map((heading) => (
                      <th
                        key={heading}
                        className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {closingEntries.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-2 py-4 font-acumin text-xs text-[#707070]"
                      >
                        決算整理仕訳はまだありません。固定資産の登録と実地棚卸の入力で自動生成されます。
                      </td>
                    </tr>
                  ) : (
                    closingEntries.map((entry) => {
                      const debitLine = entry.lines.find(
                        (line) => line.debit > 0,
                      );
                      const creditLine = entry.lines.find(
                        (line) => line.credit > 0,
                      );
                      return (
                        <tr
                          key={entry.number}
                          className="border-b border-[#ededed]"
                        >
                          <td className="px-2 py-3 font-acumin text-xs text-black">
                            {entry.description}
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                            {debitLine?.account.name ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                            {creditLine?.account.name ?? "—"}
                          </td>
                          <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                            {currency(creditLine?.credit ?? 0)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={panelClassName}>
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              翌年度（{fiscalYear + 1}年）へ繰り越す期首残高
            </h4>
            <p className="mt-1 font-acumin text-[10px] leading-relaxed text-[#707070]">
              損益科目は0にし、
              {businessType === "soleProprietor"
                ? "元入金 = 当年元入金 + 当期純利益 + 事業主借 − 事業主貸 として事業主貸借を精算します。"
                : "当期純利益を繰越利益剰余金へ振り替えます。"}
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["コード", "勘定科目", "借方", "貸方"].map((heading) => (
                      <th
                        key={heading}
                        className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {carryForwardRows.map((row) => (
                    <tr key={row.code} className="border-b border-[#ededed]">
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                        {row.code}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {row.name}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {row.debit > 0 ? currency(row.debit) : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {row.credit > 0 ? currency(row.credit) : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-black">
                    <td
                      colSpan={2}
                      className="px-2 py-2 font-acumin text-xs font-medium text-black"
                    >
                      合計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(carryForwardCheck.debitTotal)}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(carryForwardCheck.creditTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p
              className={`mt-3 font-acumin text-xs ${carryForwardCheck.isBalanced ? "text-[#16844b]" : "text-red-700"}`}
              role="status"
            >
              <i
                className={`mr-1.5 ${carryForwardCheck.isBalanced ? "ri-checkbox-circle-fill" : "ri-error-warning-fill"}`}
                aria-hidden="true"
              />
              {carryForwardCheck.isBalanced
                ? "翌年度期首の貸借が一致（翌年期首BS = 当年期末BS）"
                : `翌年度期首の貸借が不一致：差額 ${currency(carryForwardCheck.debitTotal - carryForwardCheck.creditTotal)}`}
            </p>
          </div>
        </div>

        <aside className={`${panelClassName} h-fit`}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            決算整理を入力
          </h4>
          <p className="mt-1 font-acumin text-[10px] text-[#707070]">
            期首棚卸高は前年度の期末棚卸高が自動で引き継がれます。
          </p>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                期末商品（製品）棚卸高
              </span>
              <input
                type="number"
                min="0"
                aria-label="期末商品棚卸高"
                value={adjustment.closingInventoryGoods || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    closingInventoryGoods: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                期末材料棚卸高
              </span>
              <input
                type="number"
                min="0"
                aria-label="期末材料棚卸高"
                value={adjustment.closingInventoryMaterials || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    closingInventoryMaterials: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                貸倒引当金繰入額
              </span>
              <input
                type="number"
                min="0"
                aria-label="貸倒引当金繰入額"
                value={adjustment.allowanceForDoubtful || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    allowanceForDoubtful: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>

            <div className="border-t border-[#d4d4d4] pt-3">
              <div className="flex items-center justify-between">
                <span className="font-acumin text-[11px] text-[#474747]">
                  減価償却費（自動）
                </span>
                <span className="font-acumin text-xs text-black tabular-nums">
                  {currency(depreciation.businessExpenseTotal)}
                </span>
              </div>
              <p className="mt-1 font-acumin text-[10px] text-[#707070]">
                固定資産台帳から自動計算されます。
              </p>
            </div>

            {closingMessage ? (
              <p
                className={`font-acumin text-xs ${/失敗|ください|一致し/.test(closingMessage) ? "text-red-700" : "text-[#16844b]"}`}
                role="status"
              >
                {closingMessage}
              </p>
            ) : null}

            {closedAt ? (
              <>
                <p className="font-acumin text-xs text-[#16844b]">
                  <i
                    className="ri-lock-line mr-1.5"
                    aria-hidden="true"
                  />
                  {new Date(closedAt).toLocaleDateString("ja-JP")}
                  に決算を確定済み
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-acumin"
                  onClick={() => void handleReopenClosing()}
                  disabled={isSaving}
                >
                  決算を解除して修正する
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-acumin"
                  onClick={() => void handleSaveClosing()}
                  disabled={isSaving}
                >
                  決算整理を保存
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full font-acumin"
                  onClick={() => void handleFinalizeClosing()}
                  disabled={isSaving || !carryForwardCheck.isBalanced}
                >
                  {isSaving ? "処理中..." : `${fiscalYearLabel}を締める`}
                </Button>
                <p className="font-acumin text-[10px] leading-relaxed text-[#707070]">
                  締めると期末残高が確定し、翌年度の期首残高になります。以後は取引の変更が決算書へ反映されません。
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );

  const trialBalanceView = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className={`font-acumin text-xs ${trialBalance.isBalanced ? "text-[#16844b]" : "text-red-700"}`}
          role="status"
        >
          <i
            className={`mr-1.5 ${trialBalance.isBalanced ? "ri-checkbox-circle-fill" : "ri-error-warning-fill"}`}
            aria-hidden="true"
          />
          {trialBalance.isBalanced
            ? "貸借一致（借方合計 = 貸方合計）"
            : `貸借不一致：差額 ${currency(trialBalance.difference)}`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="font-acumin"
          onClick={handleTrialBalanceExport}
        >
          <i className="ri-download-line mr-1.5" aria-hidden="true" />
          試算表CSV
        </Button>
      </div>
      <div className={`${panelClassName} min-w-0`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {[
                  "コード",
                  "勘定科目",
                  "会計区分",
                  "借方合計",
                  "貸方合計",
                  "借方残高",
                  "貸方残高",
                ].map((heading) => (
                  <th
                    key={heading}
                    className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trialBalance.rows.map((row) => (
                <tr
                  key={row.account.code}
                  className="border-b border-[#ededed]"
                >
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                    {row.account.code}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                    {row.account.name}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                    {ACCOUNT_TYPE_LABELS[row.account.type]}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {row.debitTotal > 0 ? currency(row.debitTotal) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {row.creditTotal > 0 ? currency(row.creditTotal) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {row.debitBalance > 0 ? currency(row.debitBalance) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {row.creditBalance > 0 ? currency(row.creditBalance) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-black">
                <td
                  colSpan={3}
                  className="px-2 py-2 font-acumin text-xs font-medium text-black"
                >
                  合計
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(trialBalance.debitTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(trialBalance.creditTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(trialBalance.debitBalanceTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(trialBalance.creditBalanceTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  // ── 決算・試算表 ───────────────────────────────────────────────────────
  // 科目ごとの月末残高（決算書の正常側を正）。比較列・推移・増減要因の元になる。
  const monthlyAccountBalances = useMemo(() => {
    const opening = new Map<string, number>();
    const monthly = new Map<string, number[]>();

    for (const account of ledger) {
      const naturalSign =
        account.account.type === "asset" || account.account.type === "expense"
          ? 1
          : -1;
      const normalSign = account.account.normalSide === "debit" ? 1 : -1;
      const net = new Array<number>(12).fill(0);
      for (const row of account.rows) {
        if (Number.parseInt(row.date.slice(0, 4), 10) !== fiscalYear) continue;
        const month = Number.parseInt(row.date.slice(5, 7), 10);
        if (!Number.isFinite(month) || month < 1 || month > 12) continue;
        net[month - 1] += (row.debit - row.credit) * naturalSign;
      }
      let balance = account.openingBalance * normalSign * naturalSign;
      opening.set(account.account.code, balance);
      monthly.set(
        account.account.code,
        net.map((value) => (balance += value)),
      );
    }

    return { opening, monthly };
  }, [ledger, fiscalYear]);

  // 基準月＝当年度に仕訳のある最後の月。決算整理は12/31なので締め後は12月になる。
  const currentMonthIndex = useMemo(() => {
    let last = 0;
    for (const account of ledger) {
      for (const row of account.rows) {
        if (Number.parseInt(row.date.slice(0, 4), 10) !== fiscalYear) continue;
        const month = Number.parseInt(row.date.slice(5, 7), 10);
        if (Number.isFinite(month)) last = Math.max(last, month - 1);
      }
    }
    return last;
  }, [ledger, fiscalYear]);

  const comparisonMonthIndex =
    comparisonBasis === "opening" ? null : currentMonthIndex - 1;

  // 流動／固定の区分。固定側だけを列挙し、残りはすべて流動側に寄せる。
  // こうしないと事業主貸・諸口のような区分が構成図と詳細から落ち、合計が合わなくなる。
  const bsSectionGroups = useMemo(() => {
    const sectionsOf = (type: AccountType) => [
      ...new Set(
        ledger
          .filter((account) => account.account.type === type)
          .map((account) => account.account.section),
      ),
    ];
    const assetSections = sectionsOf("asset");
    const liabilitySections = sectionsOf("liability");
    return {
      currentAssets: assetSections.filter(
        (section) =>
          !(NON_CURRENT_ASSET_SECTIONS as readonly string[]).includes(section),
      ),
      fixedAssets: assetSections.filter((section) =>
        (NON_CURRENT_ASSET_SECTIONS as readonly string[]).includes(section),
      ),
      currentLiabilities: liabilitySections.filter(
        (section) =>
          !(NON_CURRENT_LIABILITY_SECTIONS as readonly string[]).includes(
            section,
          ),
      ),
      fixedLiabilities: liabilitySections.filter((section) =>
        (NON_CURRENT_LIABILITY_SECTIONS as readonly string[]).includes(section),
      ),
      assetSections,
    };
  }, [ledger]);

  const amountOfAccountAt = useCallback(
    (code: string, monthIndex: number | null) =>
      monthIndex === null || monthIndex < 0
        ? monthlyAccountBalances.opening.get(code) ?? 0
        : monthlyAccountBalances.monthly.get(code)?.[monthIndex] ?? 0,
    [monthlyAccountBalances],
  );

  const amountOfSectionsAt = useCallback(
    (sections: readonly string[], monthIndex: number | null) =>
      ledger
        .filter((account) => sections.includes(account.account.section))
        .reduce(
          (sum, account) =>
            sum + amountOfAccountAt(account.account.code, monthIndex),
          0,
        ),
    [ledger, amountOfAccountAt],
  );

  const amountOfTypesAt = useCallback(
    (types: readonly AccountType[], monthIndex: number | null) =>
      ledger
        .filter((account) => types.includes(account.account.type))
        .reduce(
          (sum, account) =>
            sum + amountOfAccountAt(account.account.code, monthIndex),
          0,
        ),
    [ledger, amountOfAccountAt],
  );

  /** 当期純利益（決算振替前）。収益 − 費用。純資産の部に別行で足す。 */
  const netIncomeAt = useCallback(
    (monthIndex: number | null) =>
      amountOfTypesAt(["revenue"], monthIndex)
      - amountOfTypesAt(["expense"], monthIndex),
    [amountOfTypesAt],
  );

  // 貸借対照表 詳細の行。資産・負債は「部 → 流動/固定 → 決算書区分」の3階層、
  // 純資産は科目数が少ないので「部 → 決算書区分」の2階層で畳む。
  const balanceSheetDetailRows = useMemo(() => {
    type DetailRow = {
      key: string;
      depth: 0 | 1 | 2;
      label: string;
      current: number;
      comparison: number;
      /** 折りたたみの対象になる行（子を持つ行）。 */
      collapsible: boolean;
      /** 親の key。折りたたみ判定に使う。 */
      ancestors: string[];
      tone: "asset" | "liability" | "equity";
    };

    const usedSections = new Set(
      ledger.map((account) => account.account.section),
    );
    const rows: DetailRow[] = [];

    const pushSections = (
      sections: readonly string[],
      tone: DetailRow["tone"],
      ancestors: string[],
      depth: 1 | 2,
    ) => {
      for (const section of sections) {
        if (!usedSections.has(section)) continue;
        rows.push({
          key: `${ancestors.join("/")}/${section}`,
          depth,
          label: section,
          current: amountOfSectionsAt([section], currentMonthIndex),
          comparison: amountOfSectionsAt([section], comparisonMonthIndex),
          collapsible: false,
          ancestors,
          tone,
        });
      }
    };

    const pushMiddle = (
      key: string,
      label: string,
      sections: readonly string[],
      tone: DetailRow["tone"],
      parentKey: string,
    ) => {
      if (!sections.some((section) => usedSections.has(section))) return;
      rows.push({
        key,
        depth: 1,
        label,
        current: amountOfSectionsAt(sections, currentMonthIndex),
        comparison: amountOfSectionsAt(sections, comparisonMonthIndex),
        collapsible: true,
        ancestors: [parentKey],
        tone,
      });
      pushSections(sections, tone, [parentKey, key], 2);
    };

    rows.push({
      key: "asset",
      depth: 0,
      label: "資産の部",
      current: amountOfTypesAt(["asset"], currentMonthIndex),
      comparison: amountOfTypesAt(["asset"], comparisonMonthIndex),
      collapsible: true,
      ancestors: [],
      tone: "asset",
    });
    pushMiddle(
      "asset-current",
      "流動資産",
      bsSectionGroups.currentAssets,
      "asset",
      "asset",
    );
    pushMiddle(
      "asset-fixed",
      "固定資産",
      bsSectionGroups.fixedAssets,
      "asset",
      "asset",
    );

    rows.push({
      key: "liability",
      depth: 0,
      label: "負債の部",
      current: amountOfTypesAt(["liability"], currentMonthIndex),
      comparison: amountOfTypesAt(["liability"], comparisonMonthIndex),
      collapsible: true,
      ancestors: [],
      tone: "liability",
    });
    pushMiddle(
      "liability-current",
      "流動負債",
      bsSectionGroups.currentLiabilities,
      "liability",
      "liability",
    );
    pushMiddle(
      "liability-fixed",
      "固定負債",
      bsSectionGroups.fixedLiabilities,
      "liability",
      "liability",
    );

    rows.push({
      key: "equity",
      depth: 0,
      label: "純資産の部",
      current:
        amountOfTypesAt(["equity"], currentMonthIndex)
        + netIncomeAt(currentMonthIndex),
      comparison:
        amountOfTypesAt(["equity"], comparisonMonthIndex)
        + netIncomeAt(comparisonMonthIndex),
      collapsible: true,
      ancestors: [],
      tone: "equity",
    });
    pushSections(EQUITY_SECTIONS, "equity", ["equity"], 1);
    rows.push({
      key: "equity/net-income",
      depth: 1,
      label: "当期純利益（決算振替前）",
      current: netIncomeAt(currentMonthIndex),
      comparison: netIncomeAt(comparisonMonthIndex),
      collapsible: false,
      ancestors: ["equity"],
      tone: "equity",
    });

    return rows;
  }, [
    ledger,
    bsSectionGroups,
    currentMonthIndex,
    comparisonMonthIndex,
    amountOfSectionsAt,
    amountOfTypesAt,
    netIncomeAt,
  ]);

  const visibleBalanceSheetRows = useMemo(() => {
    const keyword = balanceSheetKeyword.trim().toLowerCase();
    return balanceSheetDetailRows.filter((row) => {
      if (row.ancestors.some((key) => collapsedBsGroups.includes(key))) {
        return false;
      }
      if (!keyword) return true;
      return row.label.toLowerCase().includes(keyword) || row.depth === 0;
    });
  }, [balanceSheetDetailRows, collapsedBsGroups, balanceSheetKeyword]);

  const bsAssetTotal = amountOfTypesAt(["asset"], currentMonthIndex);
  const bsCurrentAssets = amountOfSectionsAt(
    bsSectionGroups.currentAssets,
    currentMonthIndex,
  );
  const bsFixedAssets = amountOfSectionsAt(
    bsSectionGroups.fixedAssets,
    currentMonthIndex,
  );
  const bsCurrentLiabilities = amountOfSectionsAt(
    bsSectionGroups.currentLiabilities,
    currentMonthIndex,
  );
  const bsFixedLiabilities = amountOfSectionsAt(
    bsSectionGroups.fixedLiabilities,
    currentMonthIndex,
  );
  const bsLiabilityTotal = amountOfTypesAt(["liability"], currentMonthIndex);
  const bsEquityTotal =
    amountOfTypesAt(["equity"], currentMonthIndex)
    + netIncomeAt(currentMonthIndex);
  const bsRightTotal = bsLiabilityTotal + bsEquityTotal;

  // 構成図の高さ配分。金額が0でも枠が潰れないよう最小値を持たせる。
  const bsShare = (value: number) =>
    bsAssetTotal === 0 ? 50 : Math.max(12, (Math.abs(value) / bsAssetTotal) * 100);

  // 資産・負債・純資産の推移（12か月）。積み上げ高＝負債＋純資産＝資産合計。
  const balanceSheetTrend = useMemo(() => {
    const equityWithoutProfit = LEDGER_MONTH_LABELS.map((_, index) =>
      amountOfTypesAt(["equity"], index),
    );
    return {
      equity: equityWithoutProfit,
      liability: LEDGER_MONTH_LABELS.map((_, index) =>
        amountOfTypesAt(["liability"], index),
      ),
      netIncome: LEDGER_MONTH_LABELS.map((_, index) => netIncomeAt(index)),
    };
  }, [amountOfTypesAt, netIncomeAt]);

  // 増減要因。資産の決算書区分ごとの差を大きい順に並べ、残りを「その他」へ寄せる。
  const balanceSheetVariance = useMemo(() => {
    const deltas = bsSectionGroups.assetSections
      .map((section) => ({
        section,
        delta:
          amountOfSectionsAt([section], currentMonthIndex)
          - amountOfSectionsAt([section], comparisonMonthIndex),
      }))
      .filter((row) => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const top = deltas.slice(0, 4);
    const rest = deltas.slice(4).reduce((sum, row) => sum + row.delta, 0);
    return { top, rest };
  }, [
    bsSectionGroups,
    currentMonthIndex,
    comparisonMonthIndex,
    amountOfSectionsAt,
  ]);

  const bsComparisonTotal = amountOfTypesAt(["asset"], comparisonMonthIndex);

  const varianceWaterfallData = useMemo(
    () => [
      {
        label: COMPARISON_COLUMN_LABELS[comparisonBasis],
        value: bsComparisonTotal,
        total: true,
        formattedValue: bsComparisonTotal.toLocaleString("ja-JP"),
      },
      ...balanceSheetVariance.top.map((row) => ({
        label: `${row.section}の${row.delta >= 0 ? "増加" : "減少"}`,
        value: row.delta,
        formattedValue: deltaCurrency(row.delta).replace("¥", ""),
      })),
      ...(balanceSheetVariance.rest !== 0
        ? [
            {
              label: "その他の増減",
              value: balanceSheetVariance.rest,
              formattedValue: deltaCurrency(balanceSheetVariance.rest).replace(
                "¥",
                "",
              ),
            },
          ]
        : []),
      {
        label: "当月残高",
        value: bsAssetTotal,
        total: true,
        formattedValue: bsAssetTotal.toLocaleString("ja-JP"),
      },
    ],
    [comparisonBasis, bsComparisonTotal, balanceSheetVariance, bsAssetTotal],
  );

  // 重要差異。差が大きい決算書区分を並べ、主な相手科目と証憑の状況を添える。
  const significantVariances = useMemo(() => {
    const sectionsOf = (types: readonly AccountType[]) => [
      ...new Set(
        ledger
          .filter((account) => types.includes(account.account.type))
          .map((account) => account.account.section),
      ),
    ];
    const targetSections = sectionsOf(["asset", "liability", "equity"]);

    return targetSections
      .map((section) => {
        const current = amountOfSectionsAt([section], currentMonthIndex);
        const comparison = amountOfSectionsAt([section], comparisonMonthIndex);
        const accounts = ledger.filter(
          (account) => account.account.section === section,
        );
        // 当月に動いた行だけを見る。差の主因になった相手科目を1つ選ぶ。
        const monthRows = accounts.flatMap((account) =>
          account.rows.filter(
            (row) =>
              Number.parseInt(row.date.slice(0, 4), 10) === fiscalYear
              && Number.parseInt(row.date.slice(5, 7), 10) - 1
                === currentMonthIndex,
          ),
        );
        const byCounter = new Map<string, number>();
        for (const row of monthRows) {
          byCounter.set(
            row.counterAccount,
            (byCounter.get(row.counterAccount) ?? 0)
              + Math.abs(row.debit - row.credit),
          );
        }
        const mainCounter =
          [...byCounter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        // 証憑が全て揃っていれば確認済み。決算整理仕訳は証憑の対象外。
        const pending = monthRows.filter(
          (row) =>
            row.entryId >= 0
            && (entriesById.get(row.entryId)?.receipts ?? []).length === 0,
        ).length;

        return {
          section,
          current,
          comparison,
          delta: current - comparison,
          mainCounter,
          confirmed: pending === 0,
        };
      })
      .filter((row) => row.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 6);
  }, [
    ledger,
    fiscalYear,
    currentMonthIndex,
    comparisonMonthIndex,
    amountOfSectionsAt,
    entriesById,
  ]);

  const toggleBsGroup = (key: string) =>
    setCollapsedBsGroups((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );

  const bsToneColor: Record<"asset" | "liability" | "equity", string> = {
    asset: BS_ASSET_COLOR,
    liability: BS_LIABILITY_COLOR,
    equity: BS_EQUITY_COLOR,
  };

  /** 構成図の1ブロック。金額と構成比を面の中に収める。 */
  const bsCompositionBox = (
    label: string,
    value: number,
    tone: "asset" | "liability" | "equity",
  ) => (
    <div
      className={`${boxRadiusClassName} flex flex-col items-center justify-center overflow-hidden border px-2 py-2 text-center`}
      style={{
        flexGrow: bsShare(value),
        flexBasis: 0,
        minHeight: 56,
        borderColor: bsToneColor[tone],
        background:
          tone === "asset"
            ? BS_ASSET_FILL
            : tone === "liability"
              ? BS_LIABILITY_FILL
              : BS_EQUITY_FILL,
      }}
    >
      <span
        className="font-acumin text-[11px] font-medium"
        style={{ color: bsToneColor[tone] }}
      >
        {label}
      </span>
      <span
        className="font-acumin text-sm font-medium tabular-nums"
        style={{ color: bsToneColor[tone] }}
      >
        {currency(value)}
      </span>
      <span className="font-acumin text-[10px] text-[#707070] tabular-nums">
        （{bsAssetTotal === 0 ? "—" : percent((value / bsAssetTotal) * 100)}）
      </span>
    </div>
  );

  const balanceSheetView = (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="貸借対照表の構成"
          title={
            <span className={panelTitleClassName}>貸借対照表の構成</span>
          }
        >
          <div className="grid grid-cols-2 gap-2" style={{ minHeight: 220 }}>
            <div className="flex min-w-0 flex-col gap-2">
              {bsCompositionBox("流動資産", bsCurrentAssets, "asset")}
              {bsCompositionBox("固定資産", bsFixedAssets, "asset")}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              {bsCompositionBox("流動負債", bsCurrentLiabilities, "liability")}
              {bsCompositionBox("固定負債", bsFixedLiabilities, "liability")}
              {bsCompositionBox("純資産", bsEquityTotal, "equity")}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-center">
            <p className="font-acumin text-[11px] text-[#474747]">
              資産合計
              <span className="ml-1 text-black tabular-nums">
                {currency(bsAssetTotal)}
              </span>
            </p>
            <p className="font-acumin text-[11px] text-[#474747]">
              負債・純資産合計
              <span className="ml-1 text-black tabular-nums">
                {currency(bsRightTotal)}
              </span>
            </p>
          </div>
          <div className="mt-3 flex items-stretch gap-2">
            <FlowBlock size="sm" label="資産" value={bsAssetTotal} />
            <FlowOperator symbol="=" />
            <FlowBlock size="sm" label="負債" value={bsLiabilityTotal} />
            <FlowOperator symbol="+" />
            <FlowBlock size="sm" label="純資産" value={bsEquityTotal} />
          </div>
          <p
            className={`${boxRadiusClassName} mt-3 flex flex-wrap items-center justify-center gap-3 border px-3 py-2 font-acumin text-xs ${
              bsAssetTotal === bsRightTotal
                ? "border-[#16844b] text-[#16844b]"
                : "border-red-700 text-red-700"
            }`}
            role="status"
          >
            <span className="flex items-center gap-1.5">
              <i
                className={
                  bsAssetTotal === bsRightTotal
                    ? "ri-checkbox-circle-fill"
                    : "ri-error-warning-fill"
                }
                aria-hidden="true"
              />
              {bsAssetTotal === bsRightTotal ? "貸借一致" : "貸借不一致"}
            </span>
            <span className="text-[#707070]">
              差額：{currency(bsAssetTotal - bsRightTotal)}
            </span>
          </p>
        </Panel>

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="資産・負債・純資産の推移"
          title={
            <span className={panelTitleClassName}>
              資産・負債・純資産の推移（12か月）
            </span>
          }
        >
          <Graph
            variant="stacked-bars"
            size="2xs"
            plotHeight={200}
            plotWidth={430}
            unitLabel="（円）"
            className="font-acumin"
            ariaLabel="資産・負債・純資産の12か月推移"
            categories={LEDGER_MONTH_LABELS}
            series={[
              {
                label: "純資産",
                color: BS_EQUITY_COLOR,
                values: balanceSheetTrend.equity,
              },
              {
                label: "負債",
                color: BS_LIABILITY_COLOR,
                values: balanceSheetTrend.liability,
              },
              {
                label: "当期純利益",
                color: BS_ASSET_COLOR,
                values: balanceSheetTrend.netIncome,
              },
            ]}
          />
          <p className="mt-2 font-acumin text-[10px] text-[#707070]">
            ※ 積み上げ高＝負債＋純資産＝資産合計（会計恒等式）。
          </p>
        </Panel>

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="増減要因"
          title={
            <span className={panelTitleClassName}>
              増減要因（対{COMPARISON_COLUMN_LABELS[comparisonBasis]}の主な内訳）
            </span>
          }
        >
          {balanceSheetVariance.top.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              比較期間との差はありません。
            </p>
          ) : (
            <Graph
              variant="waterfall"
              size="2xs"
              plotHeight={230}
              plotWidth={430}
              unitLabel="（円）"
              className="font-acumin"
              ariaLabel="資産合計の増減要因"
              data={varianceWaterfallData}
            />
          )}
        </Panel>
      </div>

      <div className="min-w-0 space-y-4">
        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="貸借対照表 詳細"
          title={<span className={panelTitleClassName}>貸借対照表 詳細</span>}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="2xs"
                shape="rounded"
                className="font-acumin"
                onClick={() => setCollapsedBsGroups([])}
              >
                すべて展開
              </Button>
              <Button
                variant="outline"
                size="2xs"
                shape="rounded"
                className="font-acumin"
                onClick={() => setStatementTab("trial")}
              >
                詳細を確認
              </Button>
            </div>
          }
        >
          <SearchField
            size="2xs"
            aria-label="科目を検索"
            placeholder="科目を検索"
            className="w-full font-acumin sm:w-[220px]"
            value={balanceSheetKeyword}
            showClearButton
            onClear={() => setBalanceSheetKeyword("")}
            onChange={(event) => setBalanceSheetKeyword(event.target.value)}
          />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    "科目",
                    "当月残高",
                    COMPARISON_COLUMN_LABELS[comparisonBasis],
                    "増減額",
                    "増減率",
                    "構成比",
                  ].map((heading, index) => (
                    <th
                      key={heading}
                      className={`px-2 py-2 font-acumin text-[11px] font-normal text-[#474747] ${
                        index === 0 ? "text-left" : "text-right"
                      }`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleBalanceSheetRows.map((row) => {
                  const delta = row.current - row.comparison;
                  const rate =
                    row.comparison === 0
                      ? null
                      : (delta / Math.abs(row.comparison)) * 100;
                  const collapsed = collapsedBsGroups.includes(row.key);
                  return (
                    <tr
                      key={row.key}
                      className={`border-b border-[#ededed] ${
                        row.depth === 0 ? "bg-[#fafafa]" : ""
                      }`}
                    >
                      <td className="px-2 py-2">
                        <span
                          className="flex items-center gap-1"
                          style={{ paddingLeft: row.depth * 14 }}
                        >
                          {row.collapsible ? (
                            <button
                              type="button"
                              aria-expanded={!collapsed}
                              aria-label={`${row.label}の内訳を切り替える`}
                              className="shrink-0 text-[#707070]"
                              onClick={() => toggleBsGroup(row.key)}
                            >
                              <i
                                className={
                                  collapsed
                                    ? "ri-arrow-right-s-line"
                                    : "ri-arrow-down-s-line"
                                }
                                aria-hidden="true"
                              />
                            </button>
                          ) : (
                            <i
                              className="ri-arrow-right-s-line shrink-0 text-[#c4c4c4]"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className={`min-w-0 truncate font-acumin text-xs ${
                              row.depth === 0
                                ? "font-medium text-black"
                                : row.depth === 1
                                  ? "font-medium"
                                  : "text-[#474747]"
                            }`}
                            style={
                              row.depth === 1
                                ? { color: bsToneColor[row.tone] }
                                : undefined
                            }
                          >
                            {row.label}
                          </span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                        {row.current.toLocaleString("ja-JP")}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                        {row.comparison.toLocaleString("ja-JP")}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin text-xs tabular-nums ${
                          delta > 0
                            ? "text-[#16844b]"
                            : delta < 0
                              ? "text-red-700"
                              : "text-black"
                        }`}
                      >
                        {delta === 0
                          ? "0"
                          : `${delta > 0 ? "+" : "-"}${Math.abs(delta).toLocaleString("ja-JP")}`}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin text-xs tabular-nums ${
                          rate === null
                            ? "text-[#909090]"
                            : rate > 0
                              ? "text-[#16844b]"
                              : rate < 0
                                ? "text-red-700"
                                : "text-black"
                        }`}
                      >
                        {rate === null
                          ? "—"
                          : `${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`}
                        {rate !== null && rate !== 0 ? (
                          <i
                            className={`ml-1 ${rate > 0 ? "ri-arrow-right-up-line" : "ri-arrow-right-down-line"}`}
                            aria-hidden="true"
                          />
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                        {bsAssetTotal === 0
                          ? "—"
                          : percent((row.current / bsAssetTotal) * 100)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="重要差異"
          title={
            <span className={panelTitleClassName}>
              重要差異（対{COMPARISON_COLUMN_LABELS[comparisonBasis]}の大きい科目）
            </span>
          }
        >
          {significantVariances.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              比較期間との差が大きい科目はありません。
            </p>
          ) : (
            <DataTable
              size="2xs"
              shape="rounded"
              rows={significantVariances}
              rowKey={(row) => row.section}
              containerClassName="font-acumin"
              tableClassName="min-w-[720px]"
              columns={[
                {
                  key: "section",
                  header: "科目",
                  render: (row) => row.section,
                },
                {
                  key: "current",
                  header: "当月残高（円）",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => row.current.toLocaleString("ja-JP"),
                },
                {
                  key: "comparison",
                  header: `${COMPARISON_COLUMN_LABELS[comparisonBasis]}（円）`,
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => row.comparison.toLocaleString("ja-JP"),
                },
                {
                  key: "delta",
                  header: "増減額（円）",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => (
                    <span
                      className={
                        row.delta > 0 ? "text-[#16844b]" : "text-red-700"
                      }
                    >
                      {row.delta > 0 ? "+" : "-"}
                      {Math.abs(row.delta).toLocaleString("ja-JP")}
                    </span>
                  ),
                },
                {
                  key: "rate",
                  header: "増減率",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) =>
                    row.comparison === 0
                      ? "—"
                      : `${row.delta > 0 ? "+" : ""}${((row.delta / Math.abs(row.comparison)) * 100).toFixed(1)}%`,
                },
                {
                  key: "cause",
                  header: "差異要因（主な相手科目）",
                  render: (row) =>
                    row.mainCounter
                      ? `${row.mainCounter}の${row.delta >= 0 ? "増加" : "減少"}`
                      : "期首残高の繰越",
                },
                {
                  key: "status",
                  header: "確認状況",
                  align: "center",
                  render: (row) => (
                    <StatusBadge
                      variant="text"
                      shape="pill"
                      size="4xs"
                      tone={row.confirmed ? "positive" : "warning"}
                      accent
                      className="font-acumin"
                    >
                      {row.confirmed ? "確認済み" : "確認中"}
                    </StatusBadge>
                  ),
                },
              ]}
            />
          )}
          <p className="mt-3 font-acumin text-[10px] text-[#707070]">
            ※
            構成比は四捨五入のため、合計が100%とならない場合があります。確認状況は当月の証憑添付の有無から判定します。
          </p>
        </Panel>
      </div>
    </div>
  );

  const profitAndLossView = (
    <Panel
      radius="rounded"
      headingLevel={4}
      aria-label="損益計算書 詳細"
      title={<span className={panelTitleClassName}>損益計算書 詳細</span>}
      actions={
        <span className="font-acumin text-[11px] text-[#707070]">
          {fiscalYearLabel} 累計 / 構成比は売上高を100%とする
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse">
          <thead>
            <tr className="border-b border-[#d4d4d4]">
              {["決算書区分", "科目", "金額（円）", "構成比"].map(
                (heading, index) => (
                  <th
                    key={heading}
                    className={`px-2 py-2 font-acumin text-[11px] font-normal text-[#474747] ${
                      index < 2 ? "text-left" : "text-right"
                    }`}
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {profitAndLoss.sections.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-2 py-4 font-acumin text-xs text-[#707070]"
                >
                  取引管理に取引を入力すると、損益計算書が作成されます。
                </td>
              </tr>
            ) : (
              profitAndLoss.sections.flatMap((section) => [
                ...section.lines.map((line) => (
                  <tr
                    key={`${section.section}-${line.account.code}`}
                    className="border-b border-[#ededed]"
                  >
                    <td className="whitespace-nowrap px-2 py-2 font-acumin text-[11px] text-[#707070]">
                      {section.section}
                    </td>
                    <td className="px-2 py-2 font-acumin text-xs text-black">
                      {line.account.name}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                      {line.amount.toLocaleString("ja-JP")}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                      {profitAndLoss.sales === 0
                        ? "—"
                        : percent((line.amount / profitAndLoss.sales) * 100)}
                    </td>
                  </tr>
                )),
                <tr
                  key={`${section.section}-total`}
                  className="border-b border-[#d4d4d4] bg-[#fafafa]"
                >
                  <td className="whitespace-nowrap px-2 py-2 font-acumin text-[11px] text-[#474747]">
                    {section.section}
                  </td>
                  <td className="px-2 py-2 font-acumin text-xs font-medium text-black">
                    小計
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {section.total.toLocaleString("ja-JP")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                    {profitAndLoss.sales === 0
                      ? "—"
                      : percent((section.total / profitAndLoss.sales) * 100)}
                  </td>
                </tr>,
              ])
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="売上（収入）金額"
          value={currency(profitAndLoss.sales)}
          note={fiscalYearLabel}
        />
        <MetricCard
          label="差引金額（売上総利益）"
          value={currency(profitAndLoss.grossProfit)}
          note="売上 − 売上原価"
        />
        <MetricCard
          label="経費"
          value={currency(profitAndLoss.operatingExpenses)}
          note="減価償却費を含む"
        />
        <MetricCard
          label="当期純利益"
          value={signedCurrency(profitAndLoss.netIncome)}
          note="決算振替前"
          positive={profitAndLoss.netIncome >= 0}
        />
      </div>
    </Panel>
  );

  const cashFlowView = (
    <Panel
      radius="rounded"
      headingLevel={4}
      aria-label="キャッシュフロー計算書 詳細"
      title={
        <span className={panelTitleClassName}>
          キャッシュフロー計算書 詳細（直接法）
        </span>
      }
      actions={
        <span
          className={`font-acumin text-[11px] ${cashFlow.difference === 0 ? "text-[#707070]" : "text-red-700"}`}
        >
          {cashFlow.difference === 0
            ? "検算：期首 + 各活動 = 期末（一致）"
            : `検算差額 ${currency(cashFlow.difference)}`}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {["区分", "科目", "金額（円）"].map((heading, index) => (
                  <th
                    key={heading}
                    className={`px-2 py-2 font-acumin text-[11px] font-normal text-[#474747] ${
                      index < 2 ? "text-left" : "text-right"
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                Object.keys(CASH_FLOW_CATEGORY_LABELS) as CashFlowCategory[]
              ).flatMap((category) => {
                const lines = cashFlow.lines.filter(
                  (line) => line.category === category,
                );
                if (lines.length === 0) return [];
                return [
                  ...lines.map((line) => (
                    <tr
                      key={`${category}-${line.account}`}
                      className="border-b border-[#ededed]"
                    >
                      <td className="whitespace-nowrap px-2 py-2 font-acumin text-[11px] text-[#707070]">
                        {CASH_FLOW_CATEGORY_LABELS[category]}
                      </td>
                      <td className="px-2 py-2 font-acumin text-xs text-black">
                        {line.account}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin text-xs tabular-nums ${
                          line.amount >= 0 ? "text-[#16844b]" : "text-red-700"
                        }`}
                      >
                        {deltaCurrency(line.amount).replace("¥", "")}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          <MetricCard
            label="営業キャッシュ・フロー"
            value={deltaCurrency(cashFlow.operating)}
            note="本業の資金"
            positive={cashFlow.operating >= 0}
          />
          <MetricCard
            label="投資キャッシュ・フロー"
            value={deltaCurrency(cashFlow.investing)}
            note="設備・資産"
            positive={cashFlow.investing >= 0}
          />
          <MetricCard
            label="財務キャッシュ・フロー"
            value={deltaCurrency(cashFlow.financing)}
            note="借入・元入"
            positive={cashFlow.financing >= 0}
          />
          <div className="flex items-stretch gap-2">
            <FlowBlock size="sm" label="期首残高" value={cashFlow.openingCash} />
            <FlowOperator symbol="→" />
            <FlowBlock
              size="sm"
              label="増減額"
              value={cashFlowNet}
              display={deltaCurrency(cashFlowNet)}
              positive
            />
            <FlowOperator symbol="→" />
            <FlowBlock
              size="sm"
              label="期末残高"
              value={cashFlow.closingCash}
              emphasis
            />
          </div>
        </div>
      </div>
    </Panel>
  );
  const statementsView = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-acumin text-base font-medium tracking-widest text-black">
          決算・試算表
        </h3>
        <span className="font-acumin text-[11px] text-[#707070] tabular-nums">
          {syncedAt
            ? `最終更新：${new Date(syncedAt).toLocaleString("ja-JP")}（自動照合）`
            : "（自動照合）"}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto">
          <TabSegmentControl
            variant="tabs-standard"
            size="2xs"
            items={STATEMENT_TABS}
            activeKey={statementTab}
            onChange={(key) => setStatementTab(key as StatementTab)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statementTab === "bs" ? (
            <TabSegmentControl
              variant="segment-pill"
              size="3xs"
              items={COMPARISON_TABS}
              activeKey={comparisonBasis}
              onChange={(key) => setComparisonBasis(key as ComparisonBasis)}
            />
          ) : null}
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            aria-label="表示中のCSV出力"
            onClick={() => {
              if (statementTab === "pl") handleStatementExport("pl");
              else if (statementTab === "cf") handleStatementExport("cf");
              else if (statementTab === "bs") handleStatementExport("bs");
              else handleTrialBalanceExport();
            }}
          >
            CSV出力
            <i className="ri-download-2-line ml-1" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            aria-label="財務諸表CSV"
            onClick={() =>
              handleStatementExport(
                statementTab === "pl" ? "pl" : statementTab === "cf" ? "cf" : "bs",
              )
            }
          >
            財務諸表出力
            <i className="ri-file-list-3-line ml-1" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {statementTab === "bs" ? balanceSheetView : null}
      {statementTab === "pl" ? profitAndLossView : null}
      {statementTab === "cf" ? cashFlowView : null}
      {statementTab === "trial" ? trialBalanceView : null}
      {statementTab === "closing" ? closingView : null}
    </div>
  );

  const journalView = (
    <div className="space-y-4">
      {/* 主要簿（仕訳・元帳）／固定資産／決算・試算表。入力は取引管理に一本化する。 */}
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={LEDGER_TABS}
          activeKey={ledgerTab}
          onChange={(key) => setLedgerTab(key as LedgerTab)}
        />
      </div>

      {ledgerTab === "ledger" ? ledgerView : null}
      {ledgerTab === "assets" ? assetsView : null}
      {ledgerTab === "closing" ? statementsView : null}
    </div>
  );

  const productView = (
    <div className="space-y-5">
      {/* 商品原価だけはコレクション単位（シーズン）で見る。会計期間とは独立した軸。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-acumin text-[11px] text-[#707070]">
          シーズン
        </span>
        {seasonOptions.map((season) => (
          <Button
            key={season.key}
            variant="outline"
            size="2xs"
            shape="rounded"
            selected={season.key === seasonKey}
            onClick={() => setSeasonKey(season.key)}
            className="font-acumin tracking-wider"
          >
            {season.label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="製造原価 合計"
          value={currency(seasonForecast.manufacturingCost)}
          note={seasonLabel}
        />
        <MetricCard
          label="平均原価（1点）"
          value={currency(
            seasonForecast.manufacturingCost /
              Math.max(
                1,
                products.reduce((sum, item) => sum + item.plannedQuantity, 0),
              ),
          )}
          note="予定数量で加重平均"
        />
        <MetricCard
          label="予定生産数"
          value={`${products.reduce((sum, item) => sum + item.plannedQuantity, 0)}点`}
          note={`${products.length}アイテム`}
        />
        <MetricCard
          label="原価率（平均）"
          value={percent(
            seasonForecast.sales > 0
              ? (seasonForecast.manufacturingCost / seasonForecast.sales) * 100
              : 0,
          )}
          note="売価シミュレーション連動"
        />
        <MetricCard
          label="粗利益（見込み）"
          value={currency(seasonForecast.grossProfit)}
          note="商品計画ベース"
          positive
        />
        <MetricCard
          label="粗利率（見込み）"
          value={percent(seasonForecast.grossMargin)}
          note="目安 55%以上"
          positive={seasonForecast.grossMargin >= 55}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className={`${panelClassName} min-w-0`}>
          <h4 className="mb-3 font-acumin text-sm font-medium tracking-widest text-black">
            アイテム別 原価一覧
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    "アイテム",
                    "カテゴリ",
                    "生産方式",
                    "予定数",
                    "製造原価（合計）",
                    "原価（1点）",
                    "売価",
                    "原価率",
                    "粗利益（1点）",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => {
                  const unitCost = sumProductUnitCost(product);
                  const isSelected = product.id === selectedProductId;
                  return (
                    <tr
                      key={product.id}
                      className={`cursor-pointer border-b border-[#ededed] ${isSelected ? "bg-[#f7f7f7]" : "hover:bg-[#fafafa]"}`}
                      onClick={() => setSelectedProductId(product.id)}
                    >
                      <td className="px-2 py-3">
                        <p className="font-acumin text-xs font-medium text-black">
                          {product.id}
                        </p>
                        <p className="mt-0.5 font-acumin text-[11px] text-[#707070]">
                          {product.name}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {product.category}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {product.productionMethod}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {product.plannedQuantity}点
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(unitCost * product.plannedQuantity)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(unitCost)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(product.sellingPrice)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {percent(
                          product.sellingPrice > 0
                            ? (unitCost / product.sellingPrice) * 100
                            : 0,
                        )}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black">
                        {currency(product.sellingPrice - unitCost)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className={`${panelClassName} h-fit`}>
          <p className="font-acumin text-[11px] text-[#707070]">
            原価内訳（1点あたり）
          </p>
          <h4 className="mt-1 font-acumin text-sm font-medium text-black">
            {selectedProduct.name}
          </h4>
          <p className="font-acumin text-[11px] text-[#707070]">
            {selectedProduct.id}
          </p>
          <div className="mt-4 grid grid-cols-[112px_1fr] items-center gap-5">
            <div
              className="relative h-28 w-28 rounded-full"
              style={{
                background: `conic-gradient(${COST_LABELS.map((item, index) => {
                  const before = COST_LABELS.slice(0, index).reduce(
                    (sum, line) => sum + selectedProduct.costs[line.key],
                    0,
                  );
                  const start =
                    selectedUnitCost > 0
                      ? (before / selectedUnitCost) * 100
                      : 0;
                  const end =
                    selectedUnitCost > 0
                      ? ((before + selectedProduct.costs[item.key]) /
                          selectedUnitCost) *
                        100
                      : 0;
                  return `${item.color} ${start}% ${end}%`;
                }).join(", ")})`,
              }}
              role="img"
              aria-label={`${selectedProduct.name}の原価構成`}
            >
              <div className="absolute inset-[22px] flex flex-col items-center justify-center rounded-full bg-white">
                <span className="font-acumin text-xs font-medium text-black">
                  {currency(selectedUnitCost)}
                </span>
                <span className="font-acumin text-[9px] text-[#707070]">
                  1点あたり
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {COST_LABELS.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-1.5 font-acumin text-[10px] text-[#474747]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: item.color }}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="font-acumin text-[10px] text-black tabular-nums">
                    {percent(
                      selectedUnitCost > 0
                        ? (selectedProduct.costs[item.key] / selectedUnitCost) *
                            100
                        : 0,
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-5 space-y-2 border-t border-[#d4d4d4] pt-4">
            {COST_LABELS.map((item) => (
              <label
                key={item.key}
                className="grid grid-cols-[1fr_112px] items-center gap-3"
              >
                <span className="font-acumin text-[11px] text-[#474747]">
                  {item.label}
                </span>
                <span className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-acumin text-xs text-[#888888]">
                    ¥
                  </span>
                  <input
                    type="number"
                    min="0"
                    value={selectedProduct.costs[item.key]}
                    onChange={(event) =>
                      updateProduct(selectedProduct.id, (product) => ({
                        ...product,
                        costs: {
                          ...product.costs,
                          [item.key]: Math.max(
                            0,
                            Number(event.target.value) || 0,
                          ),
                        },
                      }))
                    }
                    className={`${inputClassName} h-8 pl-7 text-right text-xs`}
                    aria-label={`${selectedProduct.name} ${item.label}`}
                  />
                </span>
              </label>
            ))}
            <Button
              variant="primary"
              size="sm"
              className="mt-4 w-full font-acumin"
              onClick={() => void handleSaveProduct()}
              disabled={isSaving}
            >
              {isSaving ? "保存中..." : "保存"}
            </Button>
          </div>
        </aside>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            売価シミュレーション
          </h4>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label>
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                売価（1点あたり）
              </span>
              <input
                type="number"
                min="0"
                step="100"
                value={selectedProduct.sellingPrice}
                onChange={(event) =>
                  updateProduct(selectedProduct.id, (product) => ({
                    ...product,
                    sellingPrice: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                className={inputClassName}
                aria-label="売価（1点あたり）"
              />
            </label>
            <label>
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                予定生産数
              </span>
              <input
                type="number"
                min="0"
                value={selectedProduct.plannedQuantity}
                onChange={(event) =>
                  updateProduct(selectedProduct.id, (product) => ({
                    ...product,
                    plannedQuantity: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                aria-label="予定生産数"
              />
            </label>
            <div>
              <span className="block font-acumin text-[11px] text-[#474747]">
                粗利益（1点あたり）
              </span>
              <p className="mt-2 font-acumin text-xl font-medium text-black">
                {currency(selectedGrossProfit)}
              </p>
            </div>
            <div>
              <span className="block font-acumin text-[11px] text-[#474747]">
                粗利率
              </span>
              <p
                className={`mt-2 font-acumin text-xl font-medium ${selectedGrossMargin >= 55 ? "text-[#16844b]" : "text-[#a16600]"}`}
              >
                {percent(selectedGrossMargin)}
              </p>
            </div>
          </div>
          <p className="mt-4 font-acumin text-[11px] text-[#707070]">
            売価・数量・原価内訳を変更すると、上部の一覧とシーズン全体の見込みが即時更新されます。
          </p>
        </div>
        <div className={panelClassName}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            選択商品の見込み
          </h4>
          {[
            [
              "売上",
              selectedProduct.sellingPrice * selectedProduct.plannedQuantity,
            ],
            ["製造原価", selectedUnitCost * selectedProduct.plannedQuantity],
            ["粗利益", selectedGrossProfit * selectedProduct.plannedQuantity],
          ].map(([label, value], index) => (
            <div
              key={String(label)}
              className={`flex items-center justify-between py-3 ${index < 2 ? "border-b border-[#ededed]" : "border-t border-black"}`}
            >
              <span className="font-acumin text-xs text-black">{label}</span>
              <span
                className={`font-acumin text-sm font-medium ${index === 2 ? "text-[#16844b]" : "text-black"}`}
              >
                {currency(Number(value))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // 取引の件数。証憑の充足と申告資料の状態は、この実データから決める。
  const taxEntryCounts = useMemo(() => {
    const all = [...expenses, ...incomes];
    const withReceipt = all.filter(
      (entry) => (entry.receipts?.length ?? 0) > 0,
    ).length;
    return {
      total: all.length,
      withReceipt,
      withoutReceipt: all.length - withReceipt,
      expense: expenses.length,
      income: incomes.length,
    };
  }, [expenses, incomes]);

  // 税務レポートは5枚（税務サマリー／青色申告決算書／税務調整／税務カレンダー／申告資料）。
  // 集計はここまでで済ませ、TaxReportSection は描画だけを受け持つ。
  const taxView = (
    <TaxReportSection
      fiscalYear={fiscalYear}
      fiscalYearLabel={fiscalYearLabel}
      journal={journal}
      profitAndLoss={profitAndLoss}
      balanceSheet={balanceSheet}
      balanceSheetComparison={balanceSheetComparison}
      monthlySummary={monthlySummary}
      depreciation={depreciation}
      deduction={deductionCalc}
      page1Rows={page1Rows}
      expenseDetailRows={expenseDetailRows}
      breakdowns={{
        wages: wagesBreakdown,
        familyWages: familyWagesBreakdown,
        interest: interestBreakdown,
        rent: rentBreakdown,
        professionalFees: professionalFeesBreakdown,
      }}
      fixedAssets={fixedAssets}
      closedAt={closedAt}
      entryCounts={taxEntryCounts}
      usesEtax={usesEtax}
      onUsesEtaxChange={setUsesEtax}
      onExportPage={handleBlueReturnExport}
      onExportJournal={handleJournalExport}
      onNavigate={setActiveTab}
    />
  );

  return (
    <div className="min-w-0">
      {/* タブ行の右端に同期ステータスと再読み込みを並べる。詳細な文言は右下の Toast へ。 */}
      <div className="mb-5 flex items-end gap-3 border-b border-[#d4d4d4]">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabSegmentControl
            variant="tabs-standard"
            size="sm"
            items={COST_PROFIT_TABS}
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as CostProfitTab)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pb-2">
          {/*
            年度選択。会計期間（暦年）はどのサブタブでもここから切り替える。
            期間が 1/1〜12/31 なので表記は「年度」ではなく「年」。
          */}
          {fiscalYearOptions && onFiscalYearChange ? (
            <SingleSelect
              variant="dropdown"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              aria-label="会計年"
              options={fiscalYearOptions.map((option) => ({
                value: String(option.year),
                label: option.label,
              }))}
              value={String(fiscalYear)}
              onValueChange={(value) => onFiscalYearChange(Number(value))}
            />
          ) : null}
          {/*
            状態は色の付いた小さな丸＋短いラベルだけ。詳細は右下の Toast へ。
            height="control" で年度選択・更新ボタンと同じ φ 式の高さに揃える。
          */}
          <StatusBadge
            shape="rounded"
            size="2xs"
            height="control"
            className={`font-acumin ${dataMessage ? "text-red-700" : "text-[#16844b]"}`}
          >
            <span className="inline-flex items-center gap-1.5" role="status">
              <StatusBadge
                variant="dot"
                tone={
                  isDataLoading
                    ? "neutral"
                    : dataMessage
                      ? "danger"
                      : "positive"
                }
                accent={!isDataLoading}
                size="4xs"
              />
              {isDataLoading
                ? "読み込み中"
                : dataMessage
                  ? "同期エラー"
                  : "同期済み"}
            </span>
          </StatusBadge>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => void loadFinanceData()}
            disabled={isDataLoading || isSaving}
          >
            <i className="ri-refresh-line mr-1" aria-hidden="true" />
            更新
          </Button>
        </div>
      </div>
      {activeTab === "summary" ? summaryView : null}
      {activeTab === "expenses" ? expensesView : null}
      {activeTab === "journal" ? journalView : null}
      {activeTab === "products" ? productView : null}
      {activeTab === "tax" ? taxView : null}

      {/* エラー・完了の詳細は画面右下の Toast に出す。成功は自動で消し、エラーは操作で閉じる。 */}
      {toast ? (
        <div
          className="fixed bottom-4 right-4 z-50 max-w-[min(92vw,420px)]"
          role={toast.variant === "error" ? "alert" : "status"}
          data-testid="finance-toast"
        >
          <ToastSnackbar
            message={toast.message}
            variant={toast.variant}
            actionLabel="閉じる"
            onAction={() => setToast(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
