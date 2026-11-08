// 会計画面（CostProfitSection）の定数・型・小さな関数。
import {
  ACCOUNTS,
  expenseAccounts,
  incomeAccounts,
  type AccountType,
  type BusinessType,
} from "@/lib/finance/accounts";
import type { EntryReviewReasonId } from "@/lib/finance/entry-review";
import type { TransactionStatus } from "@/lib/finance/transaction-status";
import type {
  DepreciationMethod,
  FixedAsset,
} from "@/lib/finance/depreciation";
import type { FixedAssetLinkStatus } from "@/lib/finance/fixed-asset-link";
import type { EvidenceStatus } from "@/lib/finance/evidence-status";
import type { EntryType, FinanceEntry } from "@/lib/finance/journal";

export type CostProfitTab =
  | "summary"
  | "expenses"
  | "journal"
  | "products"
  | "tax"
  | "settings"
  | "pending"
  | "reconciliation";

// 帳簿タブ内のサブビュー。
// 仕訳帳と総勘定元帳は「同じ仕訳を科目で切って見る」だけの違いなので1枚に畳み、
// 合計残高試算表は決算の検算そのものなので決算と1枚にする。
export type LedgerTab = "ledger" | "assets" | "closing";

export const LEDGER_TABS: Array<{ key: LedgerTab; label: string }> = [
  { key: "ledger", label: "仕訳・元帳" },
  { key: "assets", label: "固定資産" },
  { key: "closing", label: "決算・試算表" },
];

/** 決算・試算表の表示切替。前3枚が財務3表、後2枚が検算と締めの作業面。 */
export type StatementTab = "bs" | "pl" | "cf" | "trial" | "closing";

export const STATEMENT_TABS: Array<{ key: StatementTab; label: string }> = [
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
export type ComparisonBasis = "previousMonth" | "opening";

export const COMPARISON_TABS: Array<{ key: ComparisonBasis; label: string }> = [
  { key: "previousMonth", label: "前月比" },
  { key: "opening", label: "期首比" },
];

export const COMPARISON_COLUMN_LABELS: Record<ComparisonBasis, string> = {
  previousMonth: "前月残高",
  opening: "期首残高",
};

/**
 * 貸借対照表の大区分。固定側の決算書区分（section）だけを列挙し、
 * 残りはすべて流動側に寄せる。列挙漏れで合計が合わなくなるのを防ぐ。
 */
export const NON_CURRENT_ASSET_SECTIONS = [
  "有形固定資産",
  "無形固定資産",
  "投資その他の資産",
  "繰延資産",
] as const;
export const NON_CURRENT_LIABILITY_SECTIONS = ["固定負債"] as const;
/** 純資産の決算書区分。事業形態で科目が変わるのでマスタから引く。 */
export const EQUITY_SECTIONS: readonly string[] = [
  ...new Set(
    ACCOUNTS.filter((account) => account.type === "equity").map(
      (account) => account.section,
    ),
  ),
];

/** 貸借対照表の構成図・推移グラフの色。資産＝青、負債＝橙、純資産＝緑。 */
export const BS_ASSET_COLOR = "#2f6fdb";
export const BS_LIABILITY_COLOR = "#d98324";
export const BS_EQUITY_COLOR = "#16844b";
export const BS_ASSET_FILL = "#e8f0fd";
export const BS_LIABILITY_FILL = "#fdf3e6";
export const BS_EQUITY_FILL = "#e8f4ec";

/** 減価償却推移の色。実績は濃い青、予測は同色の破線・ハッチで示す。 */
export const DEPRECIATION_LINE_COLOR = "#2f6fdb";
export const DEPRECIATION_BAR_COLOR = "#c3d5f2";

/** 残高推移の色。当期は黒の実線、前期末は灰の破線、異常値は橙の点。 */
export const LEDGER_TREND_COLOR = "#111111";

/** 仕訳一覧の1ページあたりの表示件数の選択肢。 */
export const LEDGER_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/** 資産一覧の1ページあたりの表示件数。 */
export const ASSET_PAGE_SIZE = 10;

/** 減価償却予定表に出す年度の幅（実績3年＋予測4年）。 */
export const DEPRECIATION_PAST_YEARS = 2;
export const DEPRECIATION_FUTURE_YEARS = 4;

// 固定資産に使う勘定科目（有形・無形固定資産）。
export const EMPTY_ASSET_FORM = {
  name: "",
  account: "工具器具備品",
  acquiredOn: new Date().toLocaleDateString("sv-SE"),
  acquisitionCost: "",
  method: "straightLine" as DepreciationMethod,
  usefulLife: "6",
  businessUseRatio: "100",
  disposedOn: "",
  // 事業供用日。空文字は取得日と同じ扱い。
  serviceStartedOn: "",
  // 連携する購入取引。null は直接登録。
  entryId: null as number | null,
};

/**
 * 固定資産の登録方法。
 * 取引から登録が既定で、直接登録は期首残高の移行・過去資産・現物発見の例外用途。
 */
export const FIXED_ASSET_LINK_STATUS_TONES: Record<
  FixedAssetLinkStatus,
  "neutral" | "warning" | "danger"
> = {
  linked: "neutral",
  direct: "neutral",
  noReceipt: "warning",
  entryMissing: "danger",
};

export const REVISION_OPERATION_LABELS: Record<EntryRevision["operation"], string> = {
  insert: "登録",
  update: "訂正",
  delete: "削除",
};

// --- 取引管理の一覧（状態・タブ・確認キュー）------------------------------
//
// 取引の状態は未確認理由の有無で決める。訂正履歴は状態と分離して保持する。
export type EntryState = TransactionStatus;

export const ENTRY_STATE_LABELS: Record<EntryState, string> = {
  registered: "登録済み",
  review: "要確認",
};

// 状態色は StatusBadge の accent と同じトークン（正常＝黒・要対応＝橙・訂正＝赤）。
export const ENTRY_STATE_TONES: Record<EntryState, "neutral" | "warning" | "danger"> =
  {
    registered: "neutral",
    review: "warning",
  };

export const ENTRY_STATE_COLORS: Record<EntryState, string> = {
  registered: "#111111",
  review: "#b45309",
};
export const CORRECTION_HISTORY_COLOR = "#b91c1c";

/** 証憑の有無。ドーナツと凡例で共有する色。 */
export const RECEIPT_ATTACHED_COLOR = "#111111";
export const RECEIPT_UNAVAILABLE_COLOR = "#6b7280";
export const RECEIPT_MISSING_COLOR = "#b45309";

/** 収支バーの色。収入＝黒、支出＝グレー、収支＝緑（プラス）／赤（マイナス）。 */
export const BALANCE_INCOME_COLOR = "#111111";
export const BALANCE_EXPENSE_COLOR = "#8a8a8a";
export const BALANCE_POSITIVE_COLOR = "#16844b";
export const BALANCE_NEGATIVE_COLOR = "#b91c1c";

/** 一覧の絞り込みタブ。件数はタブ内で表示する。 */
export type EntryListTab = "all" | "noReceipt" | "review" | "revised";

/** 1ページあたりの表示件数。 */
export const ENTRY_PAGE_SIZE = 20;

/** 確認キューの1グループ。優先順に並べて右カラムへ出す。 */
export type ReviewQueueKey =
  | "noReceipt"
  | "fixedAsset"
  | "amount"
  | "account"
  | "revised";

export const REVIEW_QUEUE_DEFS: Array<{
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
  // 資産科目で計上済みなのに台帳が無い取引。放置すると永久に償却されない。
  {
    key: "fixedAsset",
    label: "固定資産の登録待ち",
    icon: "ri-building-line",
    tone: "warning",
    tab: "review",
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
export const DENCHOHO_CHECKLIST: Array<{ label: string; note: string }> = [
  { label: "日付検索", note: "対応済み" },
  { label: "金額検索", note: "対応済み" },
  { label: "取引先検索", note: "対応済み" },
  { label: "訂正履歴", note: "対応済み" },
];

/** 証憑に受け付けるファイル形式（Storage 側の検証と揃える）。 */
export const RECEIPT_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/webp,image/heic";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: "資産",
  liability: "負債",
  equity: "純資産",
  revenue: "収益",
  expense: "費用",
};

/** 証憑（電子取引データ）。ファイル本体は非公開バケットにある。 */
export type Receipt = {
  id: number;
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  /** 証憑の種類（FREQ-559）。unconfirmed は移行前の行だけ。 */
  evidenceKind?: "electronic" | "paper" | "unconfirmed";
  paperOriginalKept?: boolean | null;
};

/** 添付のときに選ぶ証憑の種類。紙は原本を残してあることの確かめが要る。 */
export type ReceiptEvidence =
  | { evidenceKind: "electronic" }
  | { evidenceKind: "paper"; paperOriginalKept: true };

export type EvidenceUnavailableReason =
  | "bank_history_expired"
  | "not_issued"
  | "paper_storage"
  | "external_electronic_storage"
  | "other";

export type EvidenceUnavailableRecord = {
  reason: EvidenceUnavailableReason;
  note: string;
  recordedAt: string;
  recordedBy?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
};

export const EVIDENCE_UNAVAILABLE_REASON_OPTIONS = [
  { value: "bank_history_expired", label: "銀行の閲覧期限超過" },
  { value: "not_issued", label: "証憑が発行されていない" },
  { value: "paper_storage", label: "紙で保管している" },
  { value: "external_electronic_storage", label: "外部で電子保存している" },
  { value: "other", label: "その他" },
];

export const evidenceUnavailableReasonRequiresNote = (reason: string) =>
  reason === "bank_history_expired" || reason === "other";

/** 訂正削除履歴の1件（電子帳簿保存法の真実性の要件）。 */
export type RevisionSnapshot = {
  date: string | null;
  category: string | null;
  item: string | null;
  partner: string | null;
  amount: string | null;
};

export type EntryRevision = {
  id: number;
  entryId: number;
  operation: "insert" | "update" | "delete";
  changedAt: string;
  before: RevisionSnapshot;
  after: RevisionSnapshot;
};

// 取引1件。仕訳エンジン（src/lib/finance/journal.ts）と同じ形＋証憑。
export type Expense = FinanceEntry & {
  receipts?: Receipt[];
  evidenceStatus?: EvidenceStatus;
  evidenceUnavailable?: EvidenceUnavailableRecord | null;
  source?: "manual" | "order";
  sourceId?: string;
  paymentIntentId?: string;
  readOnly?: boolean;
  grossAmount?: number;
  refundedAmount?: number;
  /** 固定資産候補の確認を済ませ、費用として処理すると判断した取引。 */
  fixedAssetExempt?: boolean;
  fixedAssetExemptReason?: string | null;
  fixedAssetReviewedAt?: string | null;
};

/** 要確認の理由を1件、担当者が確認済みにした記録（migration 082）。 */
export type EntryReviewAck = {
  entryRef: string;
  reason: EntryReviewReasonId;
  note: string;
  reviewedAt: string;
};

export type LegalArchiveHealth = {
  fiscalYear: number;
  lastArchiveAt: string | null;
  lastRestoreCheckAt: string | null;
  storageTargets: string[];
  externalStorageConfigured: boolean;
  delayed: boolean;
};

/**
 * 台帳の固定資産。購入取引への参照と事業供用日を持つ。
 * 償却計算に供用日は要るが取引の id は要らないので、連携キーは UI 側の型で足す。
 */
export type LedgerFixedAsset = FixedAsset & { entryId: number | null };

export type ExpenseTemplate = {
  name: string;
  entryType: EntryType;
  category: string;
  item: string;
  partner: string;
  amount: number;
  paymentMethod: string;
  memo: string;
};
export type SummaryOption = {
  id: number;
  entryType: EntryType;
  name: string;
  isCustom: true;
};

export type ProductCostKey =
  | "material"
  | "sewing"
  | "pattern"
  | "accessories"
  | "processing"
  | "finishing";

export type Product = {
  id: string;
  name: string;
  category: string;
  productionMethod: string;
  plannedQuantity: number;
  sellingPrice: number;
  costs: Record<ProductCostKey, number>;
};

export type FinancePlan = {
  salesRevenue: number;
  openingCash: number;
  accountsReceivable: number;
  fixedAssets: number;
  accountsPayable: number;
  openingCapital: number;
};

export type CostProfitResponse = {
  data: {
    fiscalYear: number;
    seasonKey: string | null;
    businessType: BusinessType;
    plan: FinancePlan;
    expenses: Expense[];
    incomes: Expense[];
    products: Product[];
    partners: string[];
    fixedAssets: LedgerFixedAsset[];
    closing: {
      closingInventoryGoods: number;
      closingInventoryMaterials: number;
      allowanceForDoubtful: number;
      closingBalances: Record<string, number>;
      closedAt: string | null;
    };
    previousClosingBalances: Record<string, number> | null;
    revisions: EntryRevision[];
    reviewAcks?: EntryReviewAck[];
    cumulativeEntries: FinanceEntry[];
    templates: ExpenseTemplate[];
    summaryOptions?: SummaryOption[];
    stripeAccounting?: StripeAccounting;
  };
};

/** Stripe原始記録はDB行のまま扱う。仕訳投影（buildStripeJournal）と同じ形を保つ。 */
export type StripePayoutRecord = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  automatic: boolean;
  arrival_date: string | null;
  reconciliation_status: string;
  bank_arrival_date: string | null;
  bank_confirmed_at: string | null;
};

export type StripeAccounting = {
  balanceTransactions: Array<Record<string, unknown>>;
  refunds: Array<Record<string, unknown>>;
  payouts: StripePayoutRecord[];
  summary: {
    stripeBalance: number;
    inTransitBalance: number;
    unmatchedPayoutCount: number;
  };
};

export const EMPTY_STRIPE_ACCOUNTING: StripeAccounting = {
  balanceTransactions: [],
  refunds: [],
  payouts: [],
  summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 },
};

/** 銀行着金を確認できるのは、送金済みかつ照合済みで未確認のPayoutだけ。 */
export function payoutConfirmBlockReason(payout: StripePayoutRecord): string | null {
  if (payout.bank_confirmed_at) return "確認済み";
  if (payout.status !== "paid") return "送金前";
  if (payout.reconciliation_status !== "matched") return "照合未完了";
  return null;
}

export const COST_PROFIT_TABS: Array<{ key: CostProfitTab; label: string }> = [
  { key: "summary", label: "財務概要" },
  { key: "expenses", label: "取引管理" },
  { key: "journal", label: "帳簿" },
  { key: "products", label: "商品原価" },
  { key: "tax", label: "税務レポート" },
  { key: "settings", label: "設定・期間" },
  { key: "pending", label: "計上待ち" },
  { key: "reconciliation", label: "照合" },
];

export const COST_LABELS: Array<{
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
export const BUSINESS_TYPE_OPTIONS: Array<{ value: BusinessType; label: string }> = [
  { value: "soleProprietor", label: "個人事業主" },
  { value: "corporation", label: "法人" },
];
// — 支出用の固定リスト
export const SHIYOU_OPTIONS = [
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
export const INCOME_SHIYOU_OPTIONS = [
  "オンライン販売",
  "卸売",
  "展示会・イベント販売",
  "受託・別注",
  "その他",
];
// 入金方法（収入用）
export const INCOME_PAYMENT_OPTIONS = [
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
export const EXPENSE_PAYMENT_OPTIONS = [
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
export const emptyEntryForm = {
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
export function accountOptionsFor(
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
export function shiyouOptionsFor(entryType: EntryType): string[] {
  return entryType === "income" ? INCOME_SHIYOU_OPTIONS : SHIYOU_OPTIONS;
}
export function paymentOptionsFor(entryType: EntryType): string[] {
  return entryType === "income"
    ? INCOME_PAYMENT_OPTIONS
    : EXPENSE_PAYMENT_OPTIONS;
}
// 取引先セレクトの「＋新規登録」を表す番兵値
export const NEW_PARTNER_SENTINEL = "__new_partner__";
// テンプレートセレクトの「＋現在の入力を保存」を表す番兵値
export const SAVE_TEMPLATE_SENTINEL = "__save_template__";
export const ADD_SUMMARY_OPTION_SENTINEL = "__add_summary_option__";
export const EMPTY_PLAN: FinancePlan = {
  salesRevenue: 0,
  openingCash: 0,
  accountsReceivable: 0,
  fixedAssets: 0,
  accountsPayable: 0,
  openingCapital: 0,
};

export const currency = (value: number) =>
  `¥${Math.round(value).toLocaleString("ja-JP")}`;
// 資金の流れ（キャッシュブリッジ・利益構造）はマイナスを▲で示す。会計書類の慣行。
export const signedCurrency = (value: number) =>
  value < 0
    ? `▲¥${Math.round(-value).toLocaleString("ja-JP")}`
    : `¥${Math.round(value).toLocaleString("ja-JP")}`;
export const percent = (value: number) => `${value.toFixed(1)}%`;
// 財務3表は決算書の見た目に合わせ、マイナスを「-」で示す（▲は資金の流れ用）。
export const statementCurrency = (value: number) =>
  value < 0
    ? `-¥${Math.round(-value).toLocaleString("ja-JP")}`
    : `¥${Math.round(value).toLocaleString("ja-JP")}`;
// 増減は符号を明示する。C/F の各活動・現金増減額に使う。
export const deltaCurrency = (value: number) =>
  value > 0
    ? `+¥${Math.round(value).toLocaleString("ja-JP")}`
    : statementCurrency(value);
// 構成比は分母が 0 なら比率を出さない（0除算で NaN を表示しない）。
export const ratioOf = (value: number, base: number) =>
  base === 0 ? undefined : (value / base) * 100;
export const inputClassName =
  "h-10 w-full border border-[#d4d4d4] bg-white px-3 font-acumin lk-text-sm text-black outline-none transition-colors focus:border-black";
export const panelClassName = "border border-[#d4d4d4] bg-white p-4 sm:p-5";
// 財務概要は角丸で統一する。面は Panel（--radius-md 8px）、
// 内側の枠は一段小さい --radius-sm（6px）で入れ子の階層を作る。
export const boxRadiusClassName = "rounded-sm";
export const panelTitleClassName =
  "font-acumin lk-text-sm font-medium tracking-widest text-black";
// 財務3表は3カラムに収めるため、見出しを一段詰める。入りきらない場合は
// 見出しが2行に折り返し、CSV ボタンは右端に留まる（headerWrap={false}）。
export const statementTitleClassName =
  "font-acumin lk-text-xs font-medium leading-tight tracking-wider text-black";

export function sumProductUnitCost(product: Product): number {
  return Object.values(product.costs).reduce((sum, value) => sum + value, 0);
}
