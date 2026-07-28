import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/Button/Button";
import { Panel } from "@/components/ui/Panel/Panel";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";
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
  depreciationSchedule,
  straightLineRate,
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

// 帳簿タブ内のサブビュー。主要簿（仕訳帳・総勘定元帳）＋補助簿＋検証用の試算表。
type LedgerTab = "journal" | "general" | "trial" | "assets" | "closing";

const LEDGER_TABS: Array<{ key: LedgerTab; label: string }> = [
  { key: "journal", label: "仕訳帳" },
  { key: "general", label: "総勘定元帳" },
  { key: "assets", label: "固定資産台帳" },
  { key: "trial", label: "合計残高試算表" },
  { key: "closing", label: "決算" },
];

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

// 税務レポート内のページ。青色申告決算書（一般用）の様式に対応させる。
type TaxPage = "page1" | "page2" | "page3" | "page4";

const BLUE_RETURN_PAGES: Array<{ key: TaxPage; label: string }> = [
  { key: "page1", label: "1P 損益計算書" },
  { key: "page2", label: "2P 月別・内訳" },
  { key: "page3", label: "3P 減価償却" },
  { key: "page4", label: "4P 貸借対照表" },
];

const REVISION_OPERATION_LABELS: Record<EntryRevision["operation"], string> = {
  insert: "登録",
  update: "訂正",
  delete: "削除",
};

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
  const [ledgerTab, setLedgerTab] = useState<LedgerTab>("journal");
  const [taxPage, setTaxPage] = useState<TaxPage>("page1");
  // e-Tax申告（または優良な電子帳簿保存）の有無で青色申告特別控除の上限が変わる。
  const [usesEtax, setUsesEtax] = useState(true);
  // 取引管理の検索条件（電子帳簿保存法の検索要件）。
  const [filter, setFilter] = useState<EntryFilter>(EMPTY_ENTRY_FILTER);
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
      await postMutation(
        isEditing
          ? {
            operation: "expense.update",
            fiscalYear,
            expenseId: editingEntryId,
            expense,
          }
          : { operation: "expense.create", fiscalYear, expense },
      );
      await loadFinanceData();
      if (isEditing) {
        setEditingEntryId(null);
        setForm(emptyEntryForm);
        setFormMessage(`${typeLabel}を訂正しました。履歴に記録されます。`);
      } else {
        setForm((current) => ({
          ...current,
          item: shiyouOptionsFor(current.entryType)[0],
          amount: "",
          memo: "",
        }));
        setFormMessage(
          `${typeLabel}を保存し、仕訳帳と財務概要へ反映しました。`,
        );
      }
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

  /** 一覧の行を訂正フォームへ読み込む。 */
  const handleStartEdit = (entry: Expense) => {
    setEditingEntryId(entry.id);
    setSelectedTemplateName("");
    setFormMessage(null);
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

  const renderEntryTable = (
    title: string,
    rows: Expense[],
    summaryHeading: string,
    paymentHeading: string,
  ) => (
    <div className={`${panelClassName} min-w-0`}>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          {title}（{rows.length}件）
        </h4>
        <span className="font-acumin text-xs text-[#474747]">
          合計 {currency(rows.reduce((sum, row) => sum + row.amount, 0))}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-[#d4d4d4]">
              {[
                "日付",
                "勘定科目",
                summaryHeading,
                "取引先",
                "金額",
                paymentHeading,
                "シーズン",
                "証憑",
                "メモ",
                "操作",
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
            {rows.map((entry) => (
              <tr key={entry.id} className="border-b border-[#ededed]">
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.date.replaceAll("-", "/")}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.category}
                </td>
                <td className="px-2 py-3 font-acumin text-xs text-black">
                  {entry.item}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.partner || "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                  {currency(entry.amount)}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                  {entry.paymentMethod}
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-[#474747]">
                  {entry.seasonTag ? formatSeasonLabel(entry.seasonTag) : "—"}
                </td>
                {/* 電子取引データは紙で保存できないため、ファイルを取引行へ紐付ける。 */}
                <td className="whitespace-nowrap px-2 py-3">
                  <div className="flex items-center gap-1.5">
                    {(entry.receipts ?? []).map((receipt) => (
                      <span
                        key={receipt.id}
                        className="inline-flex items-center gap-0.5"
                      >
                        <button
                          type="button"
                          className="font-acumin text-[11px] text-black underline underline-offset-4"
                          aria-label={`${receipt.fileName}を開く`}
                          onClick={() => void handleOpenReceipt(receipt)}
                        >
                          <i
                            className="ri-attachment-2 mr-0.5"
                            aria-hidden="true"
                          />
                          {receipt.mimeType === "application/pdf"
                            ? "PDF"
                            : "画像"}
                        </button>
                        <button
                          type="button"
                          className="text-[#888888] hover:text-black"
                          aria-label={`${receipt.fileName}を削除`}
                          onClick={() => void handleDeleteReceipt(receipt)}
                          disabled={isSaving}
                        >
                          <i
                            className="ri-close-line text-[13px]"
                            aria-hidden="true"
                          />
                        </button>
                      </span>
                    ))}
                    <label className="cursor-pointer font-acumin text-[11px] text-[#474747] underline underline-offset-4 hover:text-black">
                      {uploadingEntryId === entry.id ? "添付中..." : "＋添付"}
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                        className="hidden"
                        aria-label={`${entry.item}に証憑を添付`}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) void handleAttachReceipt(entry, file);
                        }}
                        disabled={uploadingEntryId !== null}
                      />
                    </label>
                  </div>
                </td>
                <td className="max-w-36 truncate px-2 py-3 font-acumin text-xs text-[#474747]">
                  {entry.memo || "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-center">
                  {/* 訂正は削除＋再登録にしない（履歴が途切れるため）。 */}
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-[#474747] hover:border-[#d4d4d4] hover:text-black"
                    aria-label={`${entry.item}を訂正`}
                    onClick={() => handleStartEdit(entry)}
                    disabled={isSaving}
                  >
                    <EmptyIcon icon="ri-pencil-line" />
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-[#474747] hover:border-[#d4d4d4] hover:text-black"
                    aria-label={`${entry.item}を削除`}
                    onClick={() => void handleDeleteExpense(entry)}
                    disabled={isSaving}
                  >
                    <EmptyIcon icon="ri-delete-bin-line" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

  // 電子帳簿保存法の検索要件（日付・金額・取引先／範囲指定／条件の組み合わせ）を満たす検索パネル。
  const searchPanel = (
    <section className={panelClassName} aria-label="取引の検索">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
          取引を検索
        </h4>
        <div className="flex items-center gap-3">
          <span className="font-acumin text-[11px] text-[#707070]">
            {filterActive
              ? `${filterConditionCount}条件で絞り込み中：支出${filteredExpenses.length}件 / 収入${filteredIncomes.length}件`
              : `全${allEntries.length}件`}
          </span>
          {filterActive ? (
            <Button
              variant="secondary"
              size="2xs"
              className="font-acumin"
              onClick={() => setFilter(EMPTY_ENTRY_FILTER)}
            >
              条件をクリア
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              onChange={(event) =>
                updateFilter({ amountFrom: event.target.value })
              }
              className={filterFieldClassName}
            />
            <span className="font-acumin text-[11px] text-[#707070]">〜</span>
            <input
              type="number"
              min="0"
              placeholder="上限"
              aria-label="取引金額（上限）"
              value={filter.amountTo}
              onChange={(event) =>
                updateFilter({ amountTo: event.target.value })
              }
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

        <div className="sm:col-span-2">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            キーワード（概要・メモ・取引先）
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
      </div>

      <p className="mt-3 font-acumin text-[10px] leading-relaxed text-[#707070]">
        ※
        電子帳簿保存法の検索要件（取引年月日・取引金額・取引先／日付と金額の範囲指定／2以上の条件の組み合わせ）に対応しています。
      </p>
    </section>
  );

  const expensesView = (
    <div className="space-y-5">
      {searchPanel}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {renderEntryTable(
            "支出一覧",
            filteredExpenses,
            "支出概要",
            "出金方法",
          )}
          {renderEntryTable("収入一覧", filteredIncomes, "収入概要", "入金方法")}

          {/* 電子帳簿保存法の真実性の要件：訂正・削除の履歴を確認できるようにする。
              履歴はDBトリガーが記録し、アプリからは書き換えられない。 */}
          <details className={panelClassName}>
            <summary className="cursor-pointer font-acumin text-sm font-medium tracking-widest text-black">
              訂正・削除の履歴（{revisions.length}件）
            </summary>
            <p className="mt-2 font-acumin text-[10px] leading-relaxed text-[#707070]">
              電子帳簿保存法の真実性の要件により、取引の削除は論理削除として記録し、訂正の前後を保持します。
            </p>
            {revisions.length === 0 ? (
              <p className="mt-3 font-acumin text-xs text-[#707070]">
                履歴はまだありません。
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#d4d4d4]">
                      {[
                        "変更日時",
                        "区分",
                        "取引ID",
                        "変更前",
                        "変更後",
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
                    {revisions.map((revision) => (
                      <tr
                        key={revision.id}
                        className="border-b border-[#ededed]"
                      >
                        <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                          {new Date(revision.changedAt).toLocaleString("ja-JP")}
                        </td>
                        <td
                          className={`whitespace-nowrap px-2 py-3 font-acumin text-xs ${revision.operation === "delete" ? "text-red-700" : revision.operation === "update" ? "text-[#a16600]" : "text-[#474747]"}`}
                        >
                          {REVISION_OPERATION_LABELS[revision.operation]}
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                          #{revision.entryId}
                        </td>
                        <td className="px-2 py-3 font-acumin text-[11px] text-[#474747]">
                          {revision.operation === "insert"
                            ? "—"
                            : `${revision.before.date ?? ""} ${revision.before.category ?? ""} ${revision.before.item ?? ""} ${revision.before.amount ? currency(Number(revision.before.amount)) : ""}`.trim()}
                        </td>
                        <td className="px-2 py-3 font-acumin text-[11px] text-black">
                          {revision.operation === "delete"
                            ? "（削除）"
                            : `${revision.after.date ?? ""} ${revision.after.category ?? ""} ${revision.after.item ?? ""} ${revision.after.amount ? currency(Number(revision.after.amount)) : ""}`.trim()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>

        <aside className={`${panelClassName} h-fit`}>
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
          {receiptMessage ? (
            <p
              className={`mt-2 font-acumin text-xs ${/失敗|ください/.test(receiptMessage) ? "text-red-700" : "text-[#16844b]"}`}
              role="status"
            >
              {receiptMessage}
            </p>
          ) : null}
          <div className="mt-4 space-y-3">
            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                種別 <span className="text-red-700">*</span>
              </span>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label="種別"
              >
                {(["expense", "income"] as EntryType[]).map((type) => {
                  const active = form.entryType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleEntryTypeChange(type)}
                      className={`h-10 border font-acumin text-sm transition-colors ${active ? "border-black bg-black text-white" : "border-[#d4d4d4] bg-white text-[#474747] hover:border-black"}`}
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
                  {
                    value: SAVE_TEMPLATE_SENTINEL,
                    label: "＋ 現在の入力を保存",
                  },
                ]}
                value={
                  isSavingTemplate
                    ? SAVE_TEMPLATE_SENTINEL
                    : selectedTemplateName
                }
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
                  setForm((current) => ({
                    ...current,
                    date: event.target.value,
                  }))
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
                  ...partners.map((option) => ({
                    value: option,
                    label: option,
                  })),
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
                  setForm((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
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
                  setForm((current) => ({
                    ...current,
                    memo: event.target.value,
                  }))
                }
                className={`${inputClassName} h-20 py-2`}
                placeholder="任意のメモを入力"
              />
            </label>
            {formMessage ? (
              <p
                className={`font-acumin text-xs ${/失敗|ください/.test(formMessage) ? "text-red-700" : "text-[#16844b]"}`}
                role="status"
              >
                {formMessage}
              </p>
            ) : null}
            {editingEntryId !== null ? (
              <Button
                variant="secondary"
                size="sm"
                className="w-full font-acumin"
                onClick={handleCancelEdit}
                disabled={isSaving}
              >
                訂正を取消
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              className="w-full font-acumin"
              onClick={() => void handleAddExpense()}
              disabled={isSaving}
            >
              {isSaving
                ? "保存中..."
                : editingEntryId === null
                  ? "保存"
                  : "訂正を保存"}
            </Button>
          </div>
        </aside>
      </div>
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
  const handleAttachReceipt = async (entry: Expense, file: File) => {
    try {
      setUploadingEntryId(entry.id);
      setReceiptMessage(null);
      const formData = new FormData();
      formData.append("entryId", String(entry.id));
      formData.append("file", file);

      const response = await clientFetch(
        "/api/admin/kpi/cost-profit/receipt",
        { method: "POST", body: formData },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "証憑のアップロードに失敗しました。");
      }
      await loadFinanceData();
      setReceiptMessage(`${file.name} を添付しました。`);
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

  const renderBreakdownPanel = (
    title: string,
    rows: ReturnType<typeof buildPartnerBreakdown>,
  ) => (
    <div className={panelClassName}>
      <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="mt-3 font-acumin text-xs text-[#707070]">
          該当する取引がありません。
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[320px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {["支払先", "件数", "金額"].map((heading) => (
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
              {rows.map((row) => (
                <tr key={row.partner} className="border-b border-[#ededed]">
                  <td className="px-2 py-2 font-acumin text-xs text-black">
                    {row.partner}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                    {row.count}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(row.amount)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-black">
                <td
                  colSpan={2}
                  className="px-2 py-2 font-acumin text-xs font-medium text-black"
                >
                  計
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(rows.reduce((sum, row) => sum + row.amount, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
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

  const generalLedgerView = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56">
          <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
            勘定科目
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="元帳の勘定科目"
            className="font-acumin"
            options={ledger.map((row) => ({
              value: row.account.code,
              label: `${row.account.code} ${row.account.name}`,
            }))}
            value={selectedLedger?.account.code ?? ""}
            onValueChange={setLedgerAccountCode}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="font-acumin"
          onClick={handleGeneralLedgerExport}
          disabled={!selectedLedger}
        >
          <i className="ri-download-line mr-1.5" aria-hidden="true" />
          総勘定元帳CSV
        </Button>
      </div>

      {!selectedLedger ? (
        <p className="font-acumin text-xs text-[#707070]">
          取引管理に取引を入力すると、科目ごとの元帳が作成されます。
        </p>
      ) : (
        <div className={`${panelClassName} min-w-0`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              {selectedLedger.account.name}
              <span className="ml-2 font-normal text-[11px] text-[#707070]">
                {selectedLedger.account.section} /{" "}
                {ACCOUNT_TYPE_LABELS[selectedLedger.account.type]} /{" "}
                {selectedLedger.account.normalSide === "debit"
                  ? "借方残"
                  : "貸方残"}
              </span>
            </h4>
            <span className="font-acumin text-xs text-black">
              期末残高 {currency(selectedLedger.closingBalance)}
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[780px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    "日付",
                    "仕訳番号",
                    "相手科目",
                    "摘要",
                    "取引先",
                    "借方",
                    "貸方",
                    "残高",
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
                <tr className="border-b border-[#ededed] bg-[#fafafa]">
                  <td
                    colSpan={7}
                    className="px-2 py-2 font-acumin text-[11px] text-[#474747]"
                  >
                    前期繰越
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(selectedLedger.openingBalance)}
                  </td>
                </tr>
                {selectedLedger.rows.map((row, index) => (
                  <tr
                    key={`${row.number}-${index}`}
                    className="border-b border-[#ededed]"
                  >
                    <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                      {row.date.replaceAll("-", "/")}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                      {row.number}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                      {row.counterAccount}
                    </td>
                    <td className="px-2 py-3 font-acumin text-xs text-black">
                      {row.description}
                    </td>
                    <td className="px-2 py-3 font-acumin text-xs text-[#474747]">
                      {row.partner || "—"}
                    </td>
                    <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                      {row.debit > 0 ? currency(row.debit) : "—"}
                    </td>
                    <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                      {row.credit > 0 ? currency(row.credit) : "—"}
                    </td>
                    <td className="px-2 py-3 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(row.balance)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-black">
                  <td
                    colSpan={5}
                    className="px-2 py-2 font-acumin text-xs font-medium text-black"
                  >
                    合計
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(selectedLedger.debitTotal)}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(selectedLedger.creditTotal)}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(selectedLedger.closingBalance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  const fixedAssetsView = (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="当期減価償却費"
          value={currency(depreciation.depreciationTotal)}
          note={`${depreciation.rows.length}件`}
        />
        <MetricCard
          label="必要経費算入額"
          value={currency(depreciation.businessExpenseTotal)}
          note="家事按分後"
        />
        <MetricCard
          label="期末帳簿価額"
          value={currency(depreciation.closingBookValueTotal)}
          note="貸借対照表の固定資産"
        />
        <MetricCard
          label="減価償却累計額"
          value={currency(depreciation.accumulatedTotal)}
          note="取得以来の累計"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className={`${panelClassName} min-w-0`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              減価償却費の計算（{fiscalYearLabel}）
            </h4>
            <Button
              variant="secondary"
              size="2xs"
              className="font-acumin"
              onClick={handleFixedAssetExport}
            >
              <i className="ri-download-line mr-1" aria-hidden="true" />
              台帳CSV
            </Button>
          </div>
          {depreciation.rows.length === 0 ? (
            <p className="mt-4 font-acumin text-xs text-[#707070]">
              固定資産を登録すると、取得日と耐用年数から当期の減価償却費が自動計算されます。
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[1020px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {[
                      "資産名",
                      "勘定科目",
                      "取得日",
                      "取得価額",
                      "償却方法",
                      "耐用年数",
                      "期首簿価",
                      "月数",
                      "当期償却費",
                      "事業割合",
                      "必要経費",
                      "期末簿価",
                      "操作",
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
                  {depreciation.rows.map((row) => (
                    <tr
                      key={row.asset.id}
                      className="border-b border-[#ededed]"
                    >
                      <td className="px-2 py-3 font-acumin text-xs text-black">
                        {row.asset.name}
                        {row.asset.disposedOn ? (
                          <span className="ml-1 font-acumin text-[10px] text-[#a16600]">
                            （{row.asset.disposedOn.replaceAll("-", "/")}除却）
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-[#474747]">
                        {row.asset.account}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                        {row.asset.acquiredOn.replaceAll("-", "/")}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.asset.acquisitionCost)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                        {DEPRECIATION_METHOD_LABELS[row.asset.method]}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                        {row.asset.method === "straightLine"
                          ? `${row.asset.usefulLife}年`
                          : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.openingBookValue)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                        {row.asset.method === "straightLine"
                          ? `${row.months}/12`
                          : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs font-medium text-black tabular-nums">
                        {currency(row.depreciation)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                        {row.asset.businessUseRatio}%
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.businessExpense)}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.closingBookValue)}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center border border-transparent text-[#474747] hover:border-[#d4d4d4] hover:text-black"
                          aria-label={`${row.asset.name}を削除`}
                          onClick={() => void handleDeleteFixedAsset(row.asset)}
                          disabled={isSaving}
                        >
                          <EmptyIcon icon="ri-delete-bin-line" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-black">
                    <td
                      colSpan={8}
                      className="px-2 py-2 font-acumin text-xs font-medium text-black"
                    >
                      合計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(depreciation.depreciationTotal)}
                    </td>
                    <td />
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(depreciation.businessExpenseTotal)}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(depreciation.closingBookValueTotal)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 font-acumin text-[10px] leading-relaxed text-[#707070]">
            ※
            定額法は「取得価額×償却率×使用月数/12」で計算し、残存簿価1円まで償却します。
            一括償却資産（10万円以上20万円未満）は月割せず3年均等、即時償却は取得年に全額を計上します。
          </p>
        </div>

        <aside className={`${panelClassName} h-fit`}>
          <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
            固定資産を登録
          </h4>
          <div className="mt-4 space-y-3">
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
                size="md"
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
                取得価額 <span className="text-red-700">*</span>
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

            <div className="block">
              <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                償却方法
              </span>
              <SingleSelect
                variant="dropdown"
                block
                size="md"
                aria-label="償却方法"
                className="font-acumin"
                options={(
                  Object.keys(
                    DEPRECIATION_METHOD_LABELS,
                  ) as DepreciationMethod[]
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

            {assetForm.method === "straightLine" ? (
              <label className="block">
                <span className="mb-1 block font-acumin text-[11px] text-[#474747]">
                  耐用年数（償却率{" "}
                  {straightLineRate(Number(assetForm.usefulLife) || 1).toFixed(
                    3,
                  )}
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
        </aside>
      </div>
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

  const journalView = (
    <div className="space-y-5">
      {/* 主要簿（仕訳帳・総勘定元帳）と検証用の合計残高試算表。入力は取引管理に一本化する。 */}
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={LEDGER_TABS}
          activeKey={ledgerTab}
          onChange={(key) => setLedgerTab(key as LedgerTab)}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="仕訳件数"
          value={`${journal.length}件`}
          note={`${fiscalYearLabel} 集計`}
        />
        <MetricCard
          label="借方合計"
          value={currency(trialBalance.debitTotal)}
          note="複式簿記"
        />
        <MetricCard
          label="貸方合計"
          value={currency(trialBalance.creditTotal)}
          note={
            trialBalance.isBalanced
              ? "差額 ¥0（一致）"
              : `差額 ${currency(trialBalance.difference)}（不一致）`
          }
          positive={trialBalance.isBalanced}
        />
      </div>

      {ledgerTab === "general" ? generalLedgerView : null}
      {ledgerTab === "assets" ? fixedAssetsView : null}
      {ledgerTab === "trial" ? trialBalanceView : null}
      {ledgerTab === "closing" ? closingView : null}
      {ledgerTab !== "journal" ? null : (
      <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Button
          variant="secondary"
          size="sm"
          className="font-acumin"
          onClick={handleJournalExport}
        >
          <i className="ri-download-line mr-1.5" aria-hidden="true" />
          仕訳帳CSV
        </Button>
      </div>
      <div className={`${panelClassName} min-w-0`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {[
                  "取引日",
                  "仕訳番号",
                  "借方勘定科目",
                  "借方金額",
                  "貸方勘定科目",
                  "貸方金額",
                  "支出概要",
                  "取引先・補助科目",
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
              {journalRows.map((row) => (
                <tr key={row.number} className="border-b border-[#ededed]">
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-black">
                    {row.date.replaceAll("-", "/")}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                    {row.number}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.debit}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(row.amount)}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.credit}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                    {currency(row.amount)}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-black">
                    {row.description}
                  </td>
                  <td className="px-2 py-3 font-acumin text-xs text-[#474747]">
                    {row.partner}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}
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

  const taxView = (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="font-acumin"
            onClick={handleJournalExport}
          >
            仕訳帳CSV
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="font-acumin"
            onClick={() =>
              exportCsv(`${fiscalYearLabel}_青色申告_損益計算書.csv`, [
                ["科目", "金額"],
                ["売上（収入）金額", profitAndLoss.sales],
                ["期首商品（製品）棚卸高", profitAndLoss.openingInventory],
                ["当期仕入高", profitAndLoss.purchases],
                ["期末商品（製品）棚卸高", profitAndLoss.closingInventory],
                ["差引原価", profitAndLoss.costOfSales],
                ["差引金額（売上総利益）", profitAndLoss.grossProfit],
                ["経費", profitAndLoss.operatingExpenses],
                ["差引金額", profitAndLoss.operatingProfit],
                ["営業外損益", profitAndLoss.nonOperatingBalance],
                ["特別損益", profitAndLoss.extraordinaryBalance],
                ["繰入・繰戻額等", profitAndLoss.provisionBalance],
                ["当期純利益", profitAndLoss.netIncome],
              ])
            }
          >
            決算書CSV
          </Button>
        </div>
      </div>

      {/* すべて当年度の仕訳残高から算出。税額は所得控除前の概算であることを明記する。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="事業所得"
          value={currency(profitAndLoss.netIncome)}
          note="青色申告特別控除前"
          positive={profitAndLoss.netIncome >= 0}
        />
        <MetricCard
          label="売上（収入）金額"
          value={currency(profitAndLoss.sales)}
          note="売上値引・返品控除後"
        />
        <MetricCard
          label="売上原価"
          value={currency(profitAndLoss.costOfSales)}
          note="期首棚卸＋仕入−期末棚卸"
        />
        <MetricCard
          label="必要経費"
          value={currency(profitAndLoss.operatingExpenses)}
          note={`減価償却費 ${currency(depreciation.businessExpenseTotal)}を含む`}
        />
        <MetricCard
          label="青色申告特別控除後"
          value={currency(deductionCalc.incomeAfterDeduction)}
          note={`控除 ${currency(deductionCalc.deduction)}（上限 ${currency(deductionCalc.limit)}）`}
          positive
        />
        <MetricCard
          label="帳簿貸借差額"
          value={currency(balanceSheet.difference)}
          note={
            balanceSheet.isBalanced
              ? "資産 = 負債 + 純資産"
              : "不一致：帳簿タブで確認"
          }
          positive={balanceSheet.isBalanced}
        />
      </div>

      {/* 青色申告決算書（一般用）の様式に1:1対応させる。 */}
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={BLUE_RETURN_PAGES}
          activeKey={taxPage}
          onChange={(key) => setTaxPage(key as TaxPage)}
        />
      </div>

      {taxPage === "page1" ? (
        <div className={panelClassName}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              1ページ 損益計算書
            </h4>
            <Button
              variant="secondary"
              size="2xs"
              className="font-acumin"
              onClick={() => handleBlueReturnExport("page1")}
            >
              <i className="ri-download-line mr-1" aria-hidden="true" />
              CSV
            </Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse">
              <tbody>
                {page1Rows.map((row) => (
                  <tr
                    key={row.label}
                    className={
                      row.emphasis
                        ? "border-t border-black"
                        : "border-b border-[#ededed]"
                    }
                  >
                    <td
                      className={`px-2 py-2.5 font-acumin text-xs ${row.emphasis ? "font-medium text-black" : "text-[#474747]"} ${row.indent ? "pl-6" : ""}`}
                    >
                      {row.label}
                    </td>
                    <td
                      className={`px-2 py-2.5 text-right font-acumin text-xs tabular-nums ${row.emphasis ? "font-medium text-black" : "text-black"}`}
                    >
                      {currency(row.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 border-t border-[#d4d4d4] pt-3">
            <p className="font-acumin text-[11px] text-[#474747]">
              経費の内訳
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[360px] border-collapse">
                <tbody>
                  {expenseDetailRows.length === 0 ? (
                    <tr>
                      <td className="px-2 py-2 font-acumin text-xs text-[#707070]">
                        経費の登録がありません。
                      </td>
                    </tr>
                  ) : (
                    expenseDetailRows.map((row) => (
                      <tr
                        key={row.account.code}
                        className="border-b border-[#ededed]"
                      >
                        <td className="px-2 py-2 font-acumin text-xs text-[#474747]">
                          {row.account.name}
                        </td>
                        <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.amount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {taxPage === "page2" ? (
        <div className="space-y-5">
          <div className={panelClassName}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
                2ページ 月別売上（収入）金額及び仕入金額
              </h4>
              <Button
                variant="secondary"
                size="2xs"
                className="font-acumin"
                onClick={() => handleBlueReturnExport("page2")}
              >
                <i className="ri-download-line mr-1" aria-hidden="true" />
                CSV
              </Button>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[360px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["月", "売上（収入）金額", "仕入金額"].map((heading) => (
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
                  {monthlySummary.rows.map((row) => (
                    <tr key={row.month} className="border-b border-[#ededed]">
                      <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs text-[#474747]">
                        {row.month}月
                      </td>
                      <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.sales)}
                      </td>
                      <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                        {currency(row.purchases)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-b border-[#ededed]">
                    <td className="px-2 py-2 font-acumin text-xs text-[#474747]">
                      雑収入
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                      {currency(monthlySummary.miscIncome)}
                    </td>
                    <td className="px-2 py-2" />
                  </tr>
                  <tr className="border-t border-black">
                    <td className="px-2 py-2 font-acumin text-xs font-medium text-black">
                      計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(
                        monthlySummary.salesTotal + monthlySummary.miscIncome,
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(monthlySummary.purchasesTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {renderBreakdownPanel("給料賃金の内訳", wagesBreakdown)}
          {renderBreakdownPanel("専従者給与の内訳", familyWagesBreakdown)}

          <div className={panelClassName}>
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              青色申告特別控除額の計算
            </h4>
            <label className="mt-3 flex items-center gap-2">
              <input
                type="checkbox"
                checked={usesEtax}
                onChange={(event) => setUsesEtax(event.target.checked)}
                className="h-4 w-4 accent-black"
              />
              <span className="font-acumin text-xs text-black">
                e-Taxで申告する（または優良な電子帳簿保存を行う）
              </span>
            </label>
            <div className="mt-3">
              {[
                ["青色申告特別控除前の所得金額", deductionCalc.incomeBeforeDeduction],
                ["控除限度額", deductionCalc.limit],
                ["青色申告特別控除額", deductionCalc.deduction],
                ["所得金額", deductionCalc.incomeAfterDeduction],
              ].map(([label, value], index) => (
                <div
                  key={String(label)}
                  className={`flex items-center justify-between py-2 ${index === 3 ? "border-t border-black font-medium" : "border-b border-[#ededed]"}`}
                >
                  <span className="font-acumin text-xs text-black">{label}</span>
                  <span className="font-acumin text-xs text-black tabular-nums">
                    {currency(Number(value))}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 font-acumin text-[10px] leading-relaxed text-[#707070]">
              ※
              65万円控除には 複式簿記による記帳・貸借対照表と損益計算書の添付・期限内申告 に加えて
              e-Tax申告または優良な電子帳簿保存が必要です（国税庁 No.2070）。
            </p>
          </div>
        </div>
      ) : null}

      {taxPage === "page3" ? (
        <div className="space-y-5">
          <div className={panelClassName}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
                3ページ 減価償却費の計算
              </h4>
              <Button
                variant="secondary"
                size="2xs"
                className="font-acumin"
                onClick={() => handleBlueReturnExport("page3")}
              >
                <i className="ri-download-line mr-1" aria-hidden="true" />
                CSV
              </Button>
            </div>
            {depreciation.rows.length === 0 ? (
              <p className="mt-3 font-acumin text-xs text-[#707070]">
                固定資産台帳に資産を登録すると、この欄が自動作成されます。
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#d4d4d4]">
                      {[
                        "減価償却資産の名称",
                        "取得年月",
                        "取得価額",
                        "償却の基礎になる金額",
                        "償却方法",
                        "耐用年数",
                        "償却率",
                        "本年中の償却期間",
                        "本年分の償却費",
                        "事業専用割合",
                        "本年分の必要経費算入額",
                        "未償却残高",
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
                    {depreciation.rows.map((row) => (
                      <tr
                        key={row.asset.id}
                        className="border-b border-[#ededed]"
                      >
                        <td className="px-2 py-3 font-acumin text-xs text-black">
                          {row.asset.name}
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 font-acumin text-xs text-[#474747]">
                          {row.asset.acquiredOn.slice(0, 7).replace("-", "/")}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.asset.acquisitionCost)}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.asset.acquisitionCost)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 font-acumin text-[11px] text-[#474747]">
                          {DEPRECIATION_METHOD_LABELS[row.asset.method]}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.method === "straightLine"
                            ? `${row.asset.usefulLife}年`
                            : "—"}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.method === "straightLine"
                            ? straightLineRate(row.asset.usefulLife).toFixed(3)
                            : "—"}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.method === "straightLine"
                            ? `${row.months}/12`
                            : "—"}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.depreciation)}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.businessUseRatio}%
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(row.businessExpense)}
                        </td>
                        <td className="px-2 py-3 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.closingBookValue)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-black">
                      <td
                        colSpan={8}
                        className="px-2 py-2 font-acumin text-xs font-medium text-black"
                      >
                        計
                      </td>
                      <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                        {currency(depreciation.depreciationTotal)}
                      </td>
                      <td />
                      <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                        {currency(depreciation.businessExpenseTotal)}
                      </td>
                      <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                        {currency(depreciation.closingBookValueTotal)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {renderBreakdownPanel("利子割引料の内訳", interestBreakdown)}
          {renderBreakdownPanel("地代家賃の内訳", rentBreakdown)}
          {renderBreakdownPanel(
            "税理士・弁護士等の報酬・料金の内訳",
            professionalFeesBreakdown,
          )}
        </div>
      ) : null}

      {taxPage === "page4" ? (
        <div className={panelClassName}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-acumin text-sm font-medium tracking-widest text-black">
              4ページ 貸借対照表（{fiscalYear}/12/31時点）
            </h4>
            <Button
              variant="secondary"
              size="2xs"
              className="font-acumin"
              onClick={() => handleBlueReturnExport("page4")}
            >
              <i className="ri-download-line mr-1" aria-hidden="true" />
              CSV
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-5 lg:grid-cols-2">
            {(
              [
                ["資産", balanceSheetComparison.assets],
                ["負債・資本", balanceSheetComparison.liabilitiesAndEquity],
              ] as const
            ).map(([side, rows]) => (
              <div key={side} className="min-w-0">
                <p className="font-acumin text-[11px] text-[#474747]">{side}</p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[300px] border-collapse">
                    <thead>
                      <tr className="border-b border-[#d4d4d4]">
                        {["科目", "期首", "期末"].map((heading) => (
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
                      {rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={3}
                            className="px-2 py-3 font-acumin text-xs text-[#707070]"
                          >
                            残高がありません。
                          </td>
                        </tr>
                      ) : (
                        rows.map((row) => (
                          <tr
                            key={row.code}
                            className="border-b border-[#ededed]"
                          >
                            <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs text-black">
                              {row.name}
                            </td>
                            <td className="px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                              {currency(row.opening)}
                            </td>
                            <td className="px-2 py-2 text-right font-acumin text-xs text-black tabular-nums">
                              {currency(row.closing)}
                            </td>
                          </tr>
                        ))
                      )}
                      <tr className="border-t border-black">
                        <td className="px-2 py-2 font-acumin text-xs font-medium text-black">
                          合計
                        </td>
                        <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(
                            side === "資産"
                              ? balanceSheetComparison.openingAssetTotal
                              : balanceSheetComparison.openingLiabilityEquityTotal,
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(
                            side === "資産"
                              ? balanceSheetComparison.closingAssetTotal
                              : balanceSheetComparison.closingLiabilityEquityTotal,
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 font-acumin text-[10px] leading-relaxed text-[#707070]">
            ※
            期末の負債・資本には当期純利益（元入金への振替前）を含みます。製造原価の計算欄は原価計算を行う場合のみ記入が必要です。
          </p>
        </div>
      ) : null}

      <p className="font-acumin text-[11px] leading-relaxed text-[#707070]">
        ※
        本画面の数値は帳簿から自動集計した参考値です。実際の申告内容は税理士または所轄税務署へご確認ください。
      </p>
    </div>
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
