// 会計画面（CostProfitSection）の状態と処理。hooks は元の画面の順のまま並べる。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaxPage } from "@/components/tax/types";
import { clientFetch } from "@/lib/client-fetch";
import {
  accountByCode,
  accountByName,
  resolveAccount,
  type Account,
  type AccountType,
  type BusinessType,
} from "@/lib/finance/accounts";
import type { OpeningBalanceRow } from "@/lib/accounting/accounting-types";
import {
  savedEntryToJournalEntry,
  type SavedJournalEntry,
} from "@/lib/accounting/journal-types";
import { toJstDate } from "@/lib/accounting/jst-date";
import type { AccountingPeriod } from "@/lib/accounting/period";
import {
  isDateInPeriod,
  periodMonthsOf,
  type PeriodBounds,
} from "@/lib/finance/period-range";
import {
  buildCashFlow,
  CASH_FLOW_CATEGORY_LABELS,
  type CashFlowCategory,
} from "@/lib/finance/cash-flow";
import { buildCumulativeSummary } from "@/lib/finance/cumulative";
import { buildCumulativeBalanceTrend } from "@/lib/finance/cumulative-balance-trend";
import { buildCounterpartyBalances } from "@/lib/finance/counterparty-balances";
import {
  ENTRY_REVIEW_REASONS,
  entryReviewRef,
  type EntryReviewReasonDef,
  type EntryReviewReasonId,
} from "@/lib/finance/entry-review";
import { resolveTransactionStatus } from "@/lib/finance/transaction-status";
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
  classifyAssetCandidate,
  fixedAssetCode,
  fixedAssetLinkStatus,
  pendingAssetCandidateEntries,
  suggestDepreciationMethod,
  unlinkedAssetEntries,
  type AssetCandidateClass,
  type FixedAssetLinkStatus,
} from "@/lib/finance/fixed-asset-link";
import {
  currentSeasonKey,
  formatSeasonLabel,
  seasonOptionsDescending,
} from "@/lib/kpi/monthly-metrics";
import {
  fiscalYearOf,
  fiscalYearRange,
  formatFiscalYearLabel,
} from "@/lib/finance/fiscal-year";
import { resolveEvidenceStatus } from "@/lib/finance/evidence-status";
import {
  buildDepreciationEntries,
  buildGeneralLedger,
  buildOrderSalesJournal,
  buildTrialBalance,
  type EntryType,
  type FinanceEntry,
  type JournalEntry,
  type LedgerAccount,
} from "@/lib/finance/journal";
import {
  buildStripeJournal,
  mergeJournalEntries,
} from "@/lib/finance/stripe-journal";
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
  checkPreDeductionIncome,
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
import { exportCsv } from "@/lib/finance/csv-export";
import {
  type CostProfitTab,
  type LedgerTab,
  type StatementTab,
  type ComparisonBasis,
  COMPARISON_COLUMN_LABELS,
  NON_CURRENT_ASSET_SECTIONS,
  NON_CURRENT_LIABILITY_SECTIONS,
  EQUITY_SECTIONS,
  BS_ASSET_COLOR,
  BS_LIABILITY_COLOR,
  BS_EQUITY_COLOR,
  LEDGER_MONTH_LABELS,
  LEDGER_PAGE_SIZE_OPTIONS,
  ASSET_PAGE_SIZE,
  DEPRECIATION_PAST_YEARS,
  DEPRECIATION_FUTURE_YEARS,
  EMPTY_ASSET_FORM,
  type EntryState,
  ENTRY_STATE_LABELS,
  type EntryListTab,
  ENTRY_PAGE_SIZE,
  type ReviewQueueKey,
  REVIEW_QUEUE_DEFS,
  ACCOUNT_TYPE_LABELS,
  type Receipt,
  type EvidenceUnavailableReason,
  evidenceUnavailableReasonRequiresNote,
  type EntryRevision,
  type Expense,
  type EntryReviewAck,
  type LegalArchiveHealth,
  type LedgerFixedAsset,
  type ExpenseTemplate,
  type SummaryOption,
  type Product,
  type FinancePlan,
  type CostProfitResponse,
  type StripePayoutRecord,
  type StripeAccounting,
  EMPTY_STRIPE_ACCOUNTING,
  emptyEntryForm,
  accountOptionsFor,
  shiyouOptionsFor,
  paymentOptionsFor,
  SAVE_TEMPLATE_SENTINEL,
  EMPTY_PLAN,
  currency,
  signedCurrency,
  percent,
  deltaCurrency,
  sumProductUnitCost,
} from "./constants";

/** cost-profit GET の期間の知らせ（設計 3-d）。 */
export type PeriodNotices = {
  filingDeadlinePassed: boolean;
  previousPeriodOpen: boolean;
};

const NO_PERIOD_NOTICES: PeriodNotices = {
  filingDeadlinePassed: false,
  previousPeriodOpen: false,
};

/** 期間で数える応答の欄（cost-profit GET が既存の欄に足す）。 */
type PeriodPayload = {
  period?: AccountingPeriod | null;
  periods?: AccountingPeriod[];
  savedJournal?: SavedJournalEntry[];
  opening?: OpeningBalanceRow[];
  periodNotices?: PeriodNotices;
};

/** 保存した仕訳を最後まで読めなかったときの GET の固定コード（FREQ-557-AC-06）。 */
const JOURNAL_INCOMPLETE_CODES = new Set(["JOURNAL_TOO_LARGE", "JOURNAL_INCOMPLETE"]);

/**
 * 未登録の科目（S4 が 9999 にした行）。memo に元の文（科目名・出金方法）が残るので、その名前の 9999 で出す
 * （手入力から合成していた時の resolveAccount と同じ見え方）。
 */
const UNREGISTERED_ACCOUNT_NAME = "未登録の科目";
function unregisteredAccount(memo: string | null): Account {
  const name = memo?.trim() || UNREGISTERED_ACCOUNT_NAME;
  const account = resolveAccount(name);
  return account.code === "9999"
    ? account
    : resolveAccount(`${name}（未登録）`);
}

/** Stripe の日時を日本時間の日へ直す（buildStripeJournal は先頭の10文字を仕訳の日にする）。 */
function stripeRowsInJst<T extends Record<string, unknown>>(
  rows: readonly T[],
  fields: readonly string[],
): T[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const field of fields) {
      const value = copy[field];
      if (
        typeof value === "string" &&
        value.length > 10 &&
        Number.isFinite(Date.parse(value))
      ) {
        copy[field] = toJstDate(value);
      }
    }
    return copy as T;
  });
}

const slashDate = (date: string) => date.replaceAll("-", "/");

export type CostProfitProps = {
  /** 選んだ会計期間。null は未選択で、旧の fiscalYear を個人の暦年の期間に結ぶ（GET が既定の期間を選ぶ）。 */
  periodId: string | null;
  /** 期間の選択。渡されたときだけタブ行に期間のセレクトを出す（一覧は GET の periods）。 */
  onPeriodChange?: (periodId: string) => void;
  /** 旧の年の入口（Task 11 まで残す）。 */
  fiscalYear: number;
  fiscalYearLabel: string;
  /** 年度選択の選択肢。渡されたときだけタブ行に年度セレクトを出す。 */
  fiscalYearOptions?: ReadonlyArray<{ year: number; label: string }>;
  onFiscalYearChange?: (year: number) => void;
};

export function useCostProfitModel({
  periodId,
  onPeriodChange,
  fiscalYear: requestedFiscalYear,
  fiscalYearLabel: requestedFiscalYearLabel,
  fiscalYearOptions,
  onFiscalYearChange,
}: CostProfitProps) {
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
  const [accountTreeSearchInput, setAccountTreeSearchInput] = useState("");
  const [collapsedAccountGroups, setCollapsedAccountGroups] = useState<
    string[]
  >([]);
  const [ledgerRowKeyword, setLedgerRowKeyword] = useState("");
  const [ledgerRowSearchInput, setLedgerRowSearchInput] = useState("");
  const [ledgerPeriod, setLedgerPeriod] = useState("full");
  const [ledgerSideFilter, setLedgerSideFilter] = useState("all");
  const [ledgerRowPage, setLedgerRowPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState<number>(
    LEDGER_PAGE_SIZE_OPTIONS[0],
  );
  const [selectedLedgerRowKey, setSelectedLedgerRowKey] = useState<
    string | null
  >(null);
  // 固定資産。カテゴリ・償却方法・キーワードで台帳を絞り、右で償却を試算する。
  const [assetSectionFilter, setAssetSectionFilter] = useState("all");
  const [assetMethodFilter, setAssetMethodFilter] = useState<string>("all");
  const [assetKeyword, setAssetKeyword] = useState("");
  const [assetSearchInput, setAssetSearchInput] = useState("");
  const [isAssetFilterOpen, setIsAssetFilterOpen] = useState(false);
  const [assetPage, setAssetPage] = useState(1);
  // 決算・試算表。財務3表／試算表／決算整理の切替と、貸借対照表の比較基準。
  const [statementTab, setStatementTab] = useState<StatementTab>("bs");
  const [comparisonBasis, setComparisonBasis] =
    useState<ComparisonBasis>("previousMonth");
  const [balanceSheetKeyword, setBalanceSheetKeyword] = useState("");
  const [balanceSheetSearchInput, setBalanceSheetSearchInput] = useState("");
  const [collapsedBsGroups, setCollapsedBsGroups] = useState<string[]>([]);
  // 会計データを読み込んだ時刻。照合結果の「最終更新」に出す。
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  // e-Tax申告（または優良な電子帳簿保存）の有無で青色申告特別控除の上限が変わる。
  const [usesEtax, setUsesEtax] = useState(true);
  // 取引管理の検索条件（電子帳簿保存法の検索要件）。
  // キーワードだけは一覧上の検索欄に常設し、それ以外は「詳細条件」Drawer で編集する。
  const [filter, setFilter] = useState<EntryFilter>(EMPTY_ENTRY_FILTER);
  const [entrySearchInput, setEntrySearchInput] = useState("");
  // 一覧の絞り込みタブ・ページ・選択行。
  const [entryListTab, setEntryListTab] = useState<EntryListTab>("all");
  const [entryPage, setEntryPage] = useState(1);
  const [selectedEntryIds, setSelectedEntryIds] = useState<number[]>([]);
  // 取引の登録・訂正は Drawer で行う。一覧の文脈を残したまま入力できるようにする。
  const [isEntryDrawerOpen, setIsEntryDrawerOpen] = useState(false);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  // 証憑 Drawer の対象取引ID。新規登録時は保存前のファイルを pendingReceipts に溜める。
  const [receiptDrawerEntryIds, setReceiptDrawerEntryIds] = useState<number[]>(
    [],
  );
  const [pendingReceipts, setPendingReceipts] = useState<File[]>([]);
  const [receiptUnavailableFormOpen, setReceiptUnavailableFormOpen] =
    useState(false);
  const [receiptUnavailableReason, setReceiptUnavailableReason] = useState<
    EvidenceUnavailableReason | ""
  >("");
  const [receiptUnavailableNote, setReceiptUnavailableNote] = useState("");
  const [pendingUnavailableFormOpen, setPendingUnavailableFormOpen] =
    useState(false);
  const [pendingUnavailableReason, setPendingUnavailableReason] = useState<
    EvidenceUnavailableReason | ""
  >("");
  const [pendingUnavailableNote, setPendingUnavailableNote] = useState("");
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
  const [fixedAssets, setFixedAssets] = useState<LedgerFixedAsset[]>([]);
  // 決算整理の入力値と締め状態。前年度のスナップショットが当年度の期首残高になる。
  const [adjustment, setAdjustment] = useState<YearEndAdjustment>(
    EMPTY_YEAR_END_ADJUSTMENT,
  );
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [previousClosingBalances, setPreviousClosingBalances] = useState<Record<
    string,
    number
  > | null>(null);
  const [closingMessage, setClosingMessage] = useState<string | null>(null);
  // 訂正削除履歴（電子帳簿保存法の真実性の要件）。
  const [revisions, setRevisions] = useState<EntryRevision[]>([]);
  const [reviewAcks, setReviewAcks] = useState<EntryReviewAck[]>([]);
  // 確認パネルで開いている取引と、理由ごとのメモ入力。
  const [reviewEntryId, setReviewEntryId] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState<
    Partial<Record<EntryReviewReasonId, string>>
  >({});
  // 開業以来累計の集計元（当年度末までの全取引の最小データ）。
  const [cumulativeEntries, setCumulativeEntries] = useState<FinanceEntry[]>(
    [],
  );
  // 証憑の添付中の取引ID・メッセージ。
  const [uploadingEntryId, setUploadingEntryId] = useState<number | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ExpenseTemplate[]>([]);
  const [summaryOptions, setSummaryOptions] = useState<SummaryOption[]>([]);
  const [stripeAccounting, setStripeAccounting] = useState<StripeAccounting>(
    EMPTY_STRIPE_ACCOUNTING,
  );
  const [confirmingPayout, setConfirmingPayout] =
    useState<StripePayoutRecord | null>(null);
  const [bankArrivalDate, setBankArrivalDate] = useState("");
  const [payoutConfirmError, setPayoutConfirmError] = useState<string | null>(
    null,
  );
  const [isConfirmingPayout, setIsConfirmingPayout] = useState(false);
  const [plan, setPlan] = useState<FinancePlan>(EMPTY_PLAN);
  const [businessType, setBusinessType] =
    useState<BusinessType>("soleProprietor");
  // 会計の期間と、その期間の保存した仕訳・期首（cost-profit GET）。
  const [loadedPeriod, setPeriod] = useState<AccountingPeriod | null>(null);
  // どの要求（periodId か旧の year）で読んだ期間か。要求が変わったら読み終わるまで要求の年で見せる。
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const requestScope =
    periodId !== null
      ? `periodId=${encodeURIComponent(periodId)}`
      : `year=${requestedFiscalYear}`;
  const period = loadedScope === requestScope ? loadedPeriod : null;
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [savedJournal, setSavedJournal] = useState<SavedJournalEntry[]>([]);
  const [openingRows, setOpeningRows] = useState<OpeningBalanceRow[]>([]);
  const [periodNotices, setPeriodNotices] =
    useState<PeriodNotices>(NO_PERIOD_NOTICES);
  // 期間が1つも無い（GET が period:null を返した）。期間を作る案内だけを出す。
  const [hasNoPeriod, setHasNoPeriod] = useState(false);
  // 保存した仕訳を最後まで読めなかった。合計と書き出しを出さない（前の期間の合計も残さない）。
  const [journalIncomplete, setJournalIncomplete] = useState(false);
  // 画面の年・見出し・範囲は読み込んだ期間から決める。読む前は旧の年（暦年）のまま。
  const fiscalYear = period
    ? Number(period.startsOn.slice(0, 4))
    : requestedFiscalYear;
  const fiscalYearLabel = period
    ? period.businessType === "soleProprietor"
      ? formatFiscalYearLabel(fiscalYear)
      : period.name
    : requestedFiscalYearLabel;
  const periodBounds = useMemo<PeriodBounds>(() => {
    if (period) return { startsOn: period.startsOn, endsOn: period.endsOn };
    const { start, end } = fiscalYearRange(requestedFiscalYear);
    return { startsOn: start, endsOn: end };
  }, [period, requestedFiscalYear]);
  const periodRangeLabel = `${slashDate(periodBounds.startsOn)}〜${slashDate(periodBounds.endsOn)}`;
  const periodSpanLabel = (() => {
    const startYear = periodBounds.startsOn.slice(0, 4);
    const endYear = periodBounds.endsOn.slice(0, 4);
    const startMonth = Number(periodBounds.startsOn.slice(5, 7));
    const endMonth = Number(periodBounds.endsOn.slice(5, 7));
    return `${startYear}年${startMonth}月〜${endYear === startYear ? "" : `${endYear}年`}${endMonth}月`;
  })();
  const [selectedProductId, setSelectedProductId] = useState(
    `${seasonKey}-ITEM-001`,
  );
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [archiveHealth, setArchiveHealth] = useState<LegalArchiveHealth | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  // dataMessage はエラー専用（null = 正常）。ヘッダーには「同期済み」等の短い状態だけを出し、
  // 詳細な文言は右下の Toast へ回す。成功メッセージも Toast のみ。
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    variant: "success" | "error";
  } | null>(null);

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
  const [deleteEntry, setDeleteEntry] = useState<Expense | null>(null);
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(
    null,
  );
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!deleteEntry) return;

    if (!isSaving) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>("[data-entry-delete-confirm]")
          ?.focus();
      });
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSaving) return;
      setDeleteEntry(null);
      setDeleteDialogError(null);
      window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleteEntry, isSaving]);
  // 固定資産の登録フォーム
  const [assetForm, setAssetForm] = useState(EMPTY_ASSET_FORM);
  const [assetMessage, setAssetMessage] = useState<string | null>(null);
  // 登録方法。取引から登録が既定（記入漏れ・金額不一致を起こさない側）。
  const [, setAssetExclusionEntryId] = useState<number | null>(null);
  const [assetExclusionReason, setAssetExclusionReason] = useState("");
  const [assetReviewDecision, setAssetReviewDecision] = useState<
    "asset" | "exclude" | null
  >(null);
  const [selectedAssetCandidateSnapshot, setSelectedAssetCandidateSnapshot] =
    useState<Expense | null>(null);
  // 詳細 Drawer で開いている資産。取引→資産→取得仕訳→償却仕訳の関係を見せる。
  const [assetDetailId, setAssetDetailId] = useState<number | null>(null);
  // 固定資産候補の取引を保存直後に案内するダイアログ。
  const [assetCandidate, setAssetCandidate] = useState<{
    entry: Expense;
    candidateClass: AssetCandidateClass;
  } | null>(null);
  // 取引先の新規登録用の一時状態
  const [isAddingPartner, setIsAddingPartner] = useState(false);
  const [newPartnerName, setNewPartnerName] = useState("");
  // テンプレートの選択・保存用の一時状態
  const [selectedTemplateName, setSelectedTemplateName] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [isTemplateOverwriteDialogOpen, setIsTemplateOverwriteDialogOpen] =
    useState(false);
  const [isAddingSummaryOption, setIsAddingSummaryOption] = useState(false);
  const [newSummaryOptionName, setNewSummaryOptionName] = useState("");
  const [isTemplateDiscardDialogOpen, setIsTemplateDiscardDialogOpen] =
    useState(false);
  useEffect(() => {
    if (!isTemplateDiscardDialogOpen) return;

    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>("[data-template-discard-continue]")
        ?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSaving) return;
      event.preventDefault();
      setIsTemplateDiscardDialogOpen(false);
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLInputElement>("[data-template-name-input]")
          ?.focus();
      });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSaving, isTemplateDiscardDialogOpen]);

  const loadFinanceData = useCallback(async () => {
    let incomplete = false;
    try {
      setIsDataLoading(true);
      setDataMessage(null);
      // 会計データは期間で（未選択なら旧の年を個人の暦年の期間に結ぶ）、商品原価だけシーズンで取得する。
      const response = await clientFetch(
        `/api/admin/kpi/cost-profit?${requestScope}&season=${encodeURIComponent(seasonKey)}`,
        {
          cache: "no-store",
        },
      );
      // ok でない応答も本文を読み切る。
      const payload = (await response.json().catch(() => null)) as
        | (CostProfitResponse & { data: PeriodPayload })
        | { error?: string; details?: string; code?: string }
        | null;
      if (!response.ok || !payload || !("data" in payload)) {
        incomplete = Boolean(
          payload &&
            "code" in payload &&
            payload.code &&
            JOURNAL_INCOMPLETE_CODES.has(payload.code),
        );
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "会計データの取得に失敗しました。",
        );
      }

      setPlan(payload.data.plan);
      setBusinessType(
        payload.data.period?.businessType ??
          payload.data.businessType ??
          "soleProprietor",
      );
      setPeriod(payload.data.period ?? null);
      setLoadedScope(requestScope);
      setPeriods(payload.data.periods ?? []);
      setSavedJournal(payload.data.savedJournal ?? []);
      setOpeningRows(payload.data.opening ?? []);
      setPeriodNotices(payload.data.periodNotices ?? NO_PERIOD_NOTICES);
      setHasNoPeriod(payload.data.period === null);
      setJournalIncomplete(false);
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
              closingInventoryMaterials:
                loadedClosing.closingInventoryMaterials,
              allowanceForDoubtful: loadedClosing.allowanceForDoubtful,
            }
          : EMPTY_YEAR_END_ADJUSTMENT,
      );
      setClosedAt(loadedClosing?.closedAt ?? null);
      setPreviousClosingBalances(payload.data.previousClosingBalances ?? null);
      setRevisions(payload.data.revisions ?? []);
      setReviewAcks(payload.data.reviewAcks ?? []);
      setCumulativeEntries(payload.data.cumulativeEntries ?? []);
      setTemplates(payload.data.templates ?? []);
      setSummaryOptions(payload.data.summaryOptions ?? []);
      setStripeAccounting(
        payload.data.stripeAccounting ?? EMPTY_STRIPE_ACCOUNTING,
      );
      setSelectedProductId(
        payload.data.products[0]?.id ?? `${seasonKey}-ITEM-001`,
      );
      setSyncedAt(new Date().toISOString());
    } catch (error) {
      // DB取得に失敗した場合、削除できないサンプル行を残さない。
      // 画面上のデータがSupabase由来であることを保証する。前の期間の仕訳・期首も残さない。
      setSavedJournal([]);
      setOpeningRows([]);
      setPeriodNotices(NO_PERIOD_NOTICES);
      setHasNoPeriod(false);
      setJournalIncomplete(incomplete);
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
      setReviewAcks([]);
      setCumulativeEntries([]);
      setTemplates([]);
      setSummaryOptions([]);
      setStripeAccounting(EMPTY_STRIPE_ACCOUNTING);
      setSelectedProductId(`${seasonKey}-ITEM-001`);
      notifyError(error, "会計データの取得に失敗しました。");
    } finally {
      setIsDataLoading(false);
    }
  }, [requestScope, seasonKey, notifyError]);

  useEffect(() => {
    void loadFinanceData();
  }, [loadFinanceData]);

  useEffect(() => {
    let active = true;
    void clientFetch(`/api/admin/legal-archive/status?year=${fiscalYear}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ data?: LegalArchiveHealth }>;
      })
      .then((payload) => {
        if (active && payload?.data) setArchiveHealth(payload.data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fiscalYear]);

  const postMutation = useCallback(async (body: Record<string, unknown>) => {
    const response = await clientFetch("/api/admin/kpi/cost-profit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      reason?: string;
      permission?: string;
      resourceId?: string;
    } | null;
    if (!response.ok) {
      if (response.status === 403 && payload?.reason === "MFA required") {
        throw new Error(
          "保存には2要素認証が必要です。認証画面で2FAを完了してから、もう一度保存してください。",
        );
      }
      if (
        response.status === 403 &&
        payload?.reason === "CSRF validation failed"
      ) {
        throw new Error(
          "セキュリティ確認に失敗しました。ページを再読み込みして、もう一度保存してください。",
        );
      }
      if (
        response.status === 403 &&
        payload?.permission === "admin.finance.manage"
      ) {
        throw new Error("会計データの保存には財務管理権限が必要です。");
      }
      if (response.status === 403) {
        throw new Error("会計データを保存する権限がありません。");
      }
      throw new Error(payload?.error ?? "会計データの保存に失敗しました。");
    }
    return payload;
  }, []);

  // 財務3表はすべて仕訳の実残高から導出する（架空の係数は使わない）。
  // 期首残高は会計の期間の期首（GET の opening。前の期間の仕訳から計算した繰越か締めた版）から作る。
  // 旧の admin_finance_years の期首の欄・年の締めのスナップショットからは作らない。
  // opening は借方−貸方なので、元帳の normalSide 基準へ向きをそろえる。
  const openingBalances = useMemo(() => {
    const balances = new Map<string, number>();
    for (const row of openingRows) {
      const account = accountByCode(row.accountCode);
      const amount =
        account?.normalSide === "credit" ? -row.signedAmount : row.signedAmount;
      if (amount !== 0) balances.set(row.accountCode, amount);
    }
    return balances;
  }, [openingRows]);

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

  // ── 固定資産と取引の連携 ───────────────────────────────────────────────
  const expensesById = useMemo(
    () => new Map(expenses.map((entry) => [entry.id, entry])),
    [expenses],
  );

  /** 台帳に未登録の固定資産取引。台帳の「取引から登録」と確認キューの両方で使う。 */
  const unlinkedAssetEntryRows = useMemo(
    () => unlinkedAssetEntries(expenses, fixedAssets),
    [expenses, fixedAssets],
  );

  const pendingAssetEntryRows = useMemo(
    () => pendingAssetCandidateEntries(expenses, fixedAssets),
    [expenses, fixedAssets],
  );

  const excludedAssetEntryRows = useMemo(
    () => expenses.filter((entry) => entry.fixedAssetExempt),
    [expenses],
  );

  const selectedAssetCandidate = useMemo(
    () =>
      pendingAssetEntryRows.find((entry) => entry.id === assetForm.entryId) ??
      (selectedAssetCandidateSnapshot?.id === assetForm.entryId
        ? selectedAssetCandidateSnapshot
        : null),
    [pendingAssetEntryRows, assetForm.entryId, selectedAssetCandidateSnapshot],
  );

  /** 資産ID → 取引連携の状態。一覧のバッジと詳細で共有する。 */
  const assetLinkStatuses = useMemo(() => {
    const statuses = new Map<number, FixedAssetLinkStatus>();
    for (const asset of fixedAssets) {
      statuses.set(
        asset.id,
        fixedAssetLinkStatus(
          asset,
          asset.entryId === null ? undefined : expensesById.get(asset.entryId),
          fiscalYear,
        ),
      );
    }
    return statuses;
  }, [fixedAssets, expensesById, fiscalYear]);

  // 帳簿・財務3表は取引管理に入力された実データと決算整理仕訳だけから作る。
  // 仕訳 → 総勘定元帳 → 合計残高試算表 → 損益計算書・貸借対照表 の順に導出する。
  // Stripe原始記録が投影済みの注文は、注文由来の売上仕訳ではなく
  // Stripe仕訳（売上・手数料・返金・入金途上・普通預金）で表現する。
  const stripeProjectedPaymentIntents = useMemo(
    () =>
      new Set(
        stripeAccounting.balanceTransactions
          .filter(
            (row) =>
              row.reporting_category === "charge" && row.payment_intent_id,
          )
          .map((row) => String(row.payment_intent_id)),
      ),
    [stripeAccounting.balanceTransactions],
  );
  const stripeJournalOrders = useMemo(
    () =>
      incomes
        .filter(
          (income) =>
            income.source === "order" &&
            income.paymentIntentId &&
            stripeProjectedPaymentIntents.has(income.paymentIntentId),
        )
        .map((income) => ({
          id: String(income.sourceId),
          paymentIntentId: income.paymentIntentId as string,
          totalAmount: income.grossAmount ?? income.amount,
          currency: "jpy",
        })),
    [incomes, stripeProjectedPaymentIntents],
  );
  // Stripe の合成仕訳。日は日本時間に直し、期間に入る物だけを残す（保存は計画2）。
  const stripeJournal = useMemo(
    () =>
      buildStripeJournal({
        orders: stripeJournalOrders,
        balanceTransactions: stripeRowsInJst(
          stripeAccounting.balanceTransactions,
          ["stripe_created_at"],
        ) as never,
        refunds: stripeRowsInJst(stripeAccounting.refunds, [
          "succeeded_at",
        ]) as never,
        payouts: stripeRowsInJst(
          stripeAccounting.payouts as unknown as Array<Record<string, unknown>>,
          ["paid_at"],
        ) as never,
      }).filter((entry) => isDateInPeriod(entry.date, periodBounds)),
    [stripeJournalOrders, stripeAccounting, periodBounds],
  );
  const journalIncomes = useMemo(
    () =>
      incomes.filter(
        (income) =>
          !(
            income.source === "order" &&
            income.paymentIntentId &&
            stripeProjectedPaymentIntents.has(income.paymentIntentId)
          ),
      ),
    [incomes, stripeProjectedPaymentIntents],
  );

  // 手入力の取引は保存した仕訳が正（S4 のトリガーが仕訳にする）。ここで手入力から仕訳を合成しない。
  const savedJournalEntries = useMemo(
    () =>
      savedJournal.map((saved) => {
        const entry = savedEntryToJournalEntry(
          saved,
          (code) => accountByCode(code) ?? unregisteredAccount(null),
        );
        // savedEntryToJournalEntry と同じ行の順（lineNo）で memo を突き合わせる。
        const savedLines = [...saved.lines].sort((a, b) => a.lineNo - b.lineNo);
        return {
          ...entry,
          lines: entry.lines.map((line, index) =>
            savedLines[index]?.accountCode === "9999"
              ? { ...line, account: unregisteredAccount(savedLines[index].memo) }
              : line,
          ),
        };
      }),
    [savedJournal],
  );
  // 注文の売上の合成（計画1。注文を作った日の日本時間で期間に入る物。計画2が保存へ置き換える）。
  const orderSalesJournal = useMemo(
    () =>
      buildOrderSalesJournal(
        journalIncomes
          .filter((income) => income.source === "order")
          .map((income) => ({
            ...income,
            sourceId: String(income.sourceId ?? income.id),
          })),
        businessType,
        periodBounds,
      ),
    [journalIncomes, businessType, periodBounds],
  );
  /** 保存していない合成の仕訳の伝票番号。仕訳帳で「集計中（計画2で保存）」の印を付ける。 */
  const synthesizedEntryNumbers = useMemo(
    () =>
      new Set(
        [...orderSalesJournal, ...stripeJournal].map((entry) => entry.number),
      ),
    [orderSalesJournal, stripeJournal],
  );

  const journal = useMemo(
    () => [
      ...mergeJournalEntries(
        [...savedJournalEntries, ...orderSalesJournal],
        stripeJournal,
      ),
      // 決算整理仕訳（減価償却・棚卸・引当金）は期間の終わりの日に立てる。
      ...buildDepreciationEntries(depreciation.rows, periodBounds.endsOn),
      ...buildInventoryEntries(adjustment, openingBalances, periodBounds.endsOn),
      ...buildAllowanceEntries(adjustment, periodBounds.endsOn),
    ],
    [
      savedJournalEntries,
      orderSalesJournal,
      stripeJournal,
      depreciation.rows,
      periodBounds.endsOn,
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
  // 3-g: 損益計算書と貸借対照表の青色申告特別控除前の所得が一致するか。
  const preDeductionIncome = useMemo(
    () => checkPreDeductionIncome(profitAndLoss, balanceSheet),
    [profitAndLoss, balanceSheet],
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
    () =>
      buildCumulativeSummary(
        cumulativeEntries,
        fixedAssets,
        periodBounds.endsOn,
      ),
    [cumulativeEntries, fixedAssets, periodBounds.endsOn],
  );
  const cumulativeBalanceTrend = useMemo(
    () => buildCumulativeBalanceTrend(cumulativeEntries, periodBounds),
    [cumulativeEntries, periodBounds],
  );
  const counterpartyBalances = useMemo(() => {
    const officialBalances = new Map(
      ledger.map((account) => [account.account.code, account.closingBalance]),
    );
    return buildCounterpartyBalances(
      cumulativeEntries,
      businessType,
      periodBounds.endsOn,
      officialBalances,
    );
  }, [cumulativeEntries, businessType, periodBounds.endsOn, ledger]);

  // ここから財務概要の派生値。すべて上の仕訳・元帳・試算表から導く。
  // 資金推移。月次＝月末の資金残高、通期＝期首からの累積増減。
  const cashTrend = useMemo(
    () => buildMonthlyCashTrend(ledger, periodBounds),
    [ledger, periodBounds],
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
        cashTrend.points.length,
      ),
    [
      cashTrend.openingCash,
      cashTrend.points.length,
      plan.salesRevenue,
      profitAndLoss.expenseTotal,
    ],
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

  // 構成比。売上高は収入摘要別、売上原価と販管費は勘定科目別に集計する。
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
      ? ((balanceSheet.equityTotal + balanceSheet.netIncome) /
          balanceSheet.assetTotal) *
        100
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
        form.entryType === "income" ? "収入摘要" : "支出摘要";
      setFormMessage(
        `日付・${summaryLabel}・勘定科目・1円以上の金額を入力してください。`,
      );
      return;
    }
    // 会計期間は日付から決まる。選択中の期間の外の日付は保存しても一覧に出ないため弾く。
    if (!isDateInPeriod(form.date, periodBounds)) {
      setFormMessage(
        `日付は選択中の会計期間（${periodRangeLabel}）の範囲で入力してください。`,
      );
      return;
    }
    if (
      form.entryType === "income" &&
      pendingUnavailableFormOpen &&
      (!pendingUnavailableReason ||
        (evidenceUnavailableReasonRequiresNote(pendingUnavailableReason) &&
          !pendingUnavailableNote.trim()))
    ) {
      setFormMessage(
        !pendingUnavailableReason
          ? "証憑を添付できない理由を選択してください。"
          : "この理由では補足メモを入力してください。",
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
              // 旧の年の鍵（admin_finance_years・fiscal_year 列）は取引の日の暦年。
              fiscalYear: fiscalYearOf(form.date) ?? fiscalYear,
              expenseId: editingEntryId,
              expense,
            }
          : {
              operation: "expense.create",
              fiscalYear: fiscalYearOf(form.date) ?? fiscalYear,
              expense,
            },
      );
      // 新規登録では取引IDが保存後に決まるため、Drawer で受けた証憑はここでまとめて送る。
      const createdId = Number(result?.resourceId);
      if (
        !isEditing &&
        Number.isFinite(createdId) &&
        pendingReceipts.length > 0
      ) {
        for (const file of pendingReceipts) {
          await uploadReceiptFile(createdId, file);
        }
        setPendingReceipts([]);
      }
      if (
        !isEditing &&
        expense.entryType === "income" &&
        Number.isFinite(createdId) &&
        pendingUnavailableReason
      ) {
        try {
          await postMutation({
            operation: "evidenceUnavailable.upsert",
            expenseId: createdId,
            reason: pendingUnavailableReason,
            note: pendingUnavailableNote.trim(),
          });
        } catch {
          await loadFinanceData();
          setIsEntryDrawerOpen(false);
          setPendingUnavailableFormOpen(false);
          setPendingUnavailableReason("");
          setPendingUnavailableNote("");
          setToast({
            message:
              "収入は登録しましたが、証憑を添付できない理由を保存できませんでした。取引の証憑管理から再度記録してください。",
            variant: "error",
          });
          return;
        }
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

        // 固定資産に該当しそうな取引は、保存直後に台帳への導線を出す。
        // ここで拾わないと「支出だけ記録され、償却されない資産」が残る。
        if (Number.isFinite(createdId)) {
          const createdEntry: Expense = { id: createdId, ...expense };
          const candidateClass = classifyAssetCandidate(createdEntry);
          if (candidateClass) {
            setAssetCandidate({ entry: createdEntry, candidateClass });
          }
        }
      }
      setIsEntryDrawerOpen(false);
      setPendingUnavailableFormOpen(false);
      setPendingUnavailableReason("");
      setPendingUnavailableNote("");
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
    if (entry.readOnly || entry.source === "order") return;
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

  const closeEntryDrawer = () => {
    setEditingEntryId(null);
    setForm(emptyEntryForm);
    setFormMessage(null);
    setPendingReceipts([]);
    setSelectedTemplateName("");
    setIsSavingTemplate(false);
    setNewTemplateName("");
    setIsTemplateDiscardDialogOpen(false);
    setIsTemplateOverwriteDialogOpen(false);
    setIsEntryDrawerOpen(false);
  };

  const handleCancelEdit = () => {
    if (isSaving) return;
    if (isSavingTemplate) {
      setIsTemplateDiscardDialogOpen(true);
      return;
    }
    closeEntryDrawer();
  };

  const continueTemplateEditing = () => {
    setIsTemplateDiscardDialogOpen(false);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>("[data-template-name-input]")
        ?.focus();
    });
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
    setIsAddingSummaryOption(false);
    setNewSummaryOptionName("");
  };

  const handleSaveSummaryOption = async () => {
    const name = newSummaryOptionName.trim();
    if (!name) {
      setFormMessage(
        `${form.entryType === "income" ? "収入" : "支出"}摘要を入力してください。`,
      );
      return;
    }
    try {
      setIsSaving(true);
      await postMutation({
        operation: "summaryOption.create",
        entryType: form.entryType,
        name,
      });
      await loadFinanceData();
      setForm((current) => ({ ...current, item: name }));
      setIsAddingSummaryOption(false);
      setNewSummaryOptionName("");
      notifySuccess(
        `${form.entryType === "income" ? "収入" : "支出"}摘要を追加しました。`,
      );
    } catch (error) {
      notifyError(error, "摘要の追加に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSummaryOption = async (option: SummaryOption) => {
    if (!window.confirm(`摘要「${option.name}」を削除しますか？`)) return;
    try {
      setIsSaving(true);
      await postMutation({
        operation: "summaryOption.delete",
        summaryOptionId: option.id,
      });
      await loadFinanceData();
      if (form.item === option.name) {
        setForm((current) => ({
          ...current,
          item: shiyouOptionsFor(current.entryType)[0],
        }));
      }
      notifySuccess("摘要を削除しました。");
    } catch (error) {
      notifyError(error, "摘要の削除に失敗しました。");
    } finally {
      setIsSaving(false);
    }
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
    if (name.length > 160) {
      setFormMessage("取引先名は160文字以内で入力してください。");
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

  // テンプレート選択：勘定科目・支出摘要・金額・支払い方法・メモをフォームへ反映する。
  const handleTemplateSelect = (value: string) => {
    if (value === SAVE_TEMPLATE_SENTINEL) {
      // 保存時の名前の初期値は「支出摘要 / 金額」。保存前に変更可能。
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
        partner: template.partner,
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
    if (templates.some((template) => template.name === name)) {
      setFormMessage("同じ名前のテンプレートが存在します。");
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
          partner: form.partner.trim(),
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

  const handleOverwriteTemplate = async () => {
    if (!selectedTemplateName) return;
    try {
      setIsSaving(true);
      setFormMessage(null);
      await postMutation({
        operation: "template.update",
        templateName: selectedTemplateName,
        template: {
          name: selectedTemplateName,
          entryType: form.entryType,
          category: form.category,
          item: form.item,
          partner: form.partner.trim(),
          amount: Math.max(0, Math.round(Number(form.amount) || 0)),
          paymentMethod: form.paymentMethod,
          memo: form.memo.trim(),
        },
      });
      await loadFinanceData();
      setIsTemplateOverwriteDialogOpen(false);
      setFormMessage("テンプレートを上書きしました。");
    } catch (error) {
      setFormMessage(
        error instanceof Error
          ? error.message
          : "テンプレートの上書きに失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleStartSaveTemplateAs = () => {
    setNewTemplateName(selectedTemplateName);
    setIsSavingTemplate(true);
    setFormMessage(null);
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

  const handleDeleteExpense = async (expense: Expense): Promise<boolean> => {
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
        // fiscal_year 列は取引の日の暦年（年をまたぐ法人の期間でも行を見つける）。
        fiscalYear: fiscalYearOf(expense.date) ?? fiscalYear,
        expenseId: expense.id,
      });
      await loadFinanceData();
      notifySuccess(`${typeLabel}をSupabaseから削除しました。`);
      return true;
    } catch (error) {
      setExpenses(previousExpenses);
      setIncomes(previousIncomes);
      notifyError(error, `${typeLabel}の削除に失敗しました。`);
      setDeleteDialogError(
        error instanceof Error
          ? error.message
          : `${typeLabel}の削除に失敗しました。`,
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const closeDeleteDialog = () => {
    if (isSaving) return;
    setDeleteEntry(null);
    setDeleteDialogError(null);
    window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
  };

  const confirmDeleteEntry = async () => {
    if (!deleteEntry || isSaving) return;
    const deleted = await handleDeleteExpense(deleteEntry);
    if (deleted) closeDeleteDialog();
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
        "支出摘要",
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
        [
          "日付",
          "仕訳番号",
          "相手科目",
          "摘要",
          "取引先",
          "借方",
          "貸方",
          "残高",
        ],
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
      ...(
        ["operating", "investing", "financing"] as CashFlowCategory[]
      ).flatMap((category) => [
        ...cashFlow.lines
          .filter((line) => line.category === category)
          .map((line) => [
            CASH_FLOW_CATEGORY_LABELS[category],
            line.account,
            line.amount,
          ]),
        [CASH_FLOW_CATEGORY_LABELS[category], "小計", cashFlow[category]],
      ]),
      ["", "期末現金・預金", cashFlow.closingCash],
      ["検算", "差額", cashFlow.difference],
    ]);
  };

  const confirmPayoutArrival = async () => {
    if (!confirmingPayout) return;
    setIsConfirmingPayout(true);
    setPayoutConfirmError(null);
    try {
      const response = await clientFetch(
        `/api/admin/accounting/stripe-payouts/${confirmingPayout.id}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bankArrivalDate }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setPayoutConfirmError(
          payload?.error ?? "銀行着金の確認に失敗しました。",
        );
        return;
      }
      setConfirmingPayout(null);
      await loadFinanceData();
    } catch (error) {
      notifyError(error, "銀行着金の確認に失敗しました。");
    } finally {
      setIsConfirmingPayout(false);
    }
  };

  const isIncomeForm = form.entryType === "income";
  const entryTypeLabel = isIncomeForm ? "収入" : "支出";
  const paymentFieldLabel = isIncomeForm ? "入金方法" : "出金方法";
  const summaryFieldLabel = isIncomeForm ? "収入摘要" : "支出摘要";
  const customSummaryOptions = summaryOptions.filter(
    (option) => option.entryType === form.entryType,
  );
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
  const allEntries = useMemo(
    () => [...expenses, ...incomes],
    [expenses, incomes],
  );
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
    "h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black outline-none transition-colors focus:border-black";

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
    return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
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

  // 台帳へ未登録の固定資産取引。資産科目に計上済みなので償却されないまま残ってしまう。
  const unlinkedAssetEntryIds = useMemo(
    () => new Set(unlinkedAssetEntryRows.map((entry) => entry.id)),
    [unlinkedAssetEntryRows],
  );

  // 確認済み記録の索引。キーは `${取引の参照}|${理由}`。
  const reviewAckByKey = useMemo(
    () =>
      new Map(reviewAcks.map((ack) => [`${ack.entryRef}|${ack.reason}`, ack])),
    [reviewAcks],
  );

  /**
   * この取引が引っかかっている理由と、その確認済み記録。
   * 検知は毎回やり直すので、取引を直せば理由そのものが消える。
   */
  const entryReviewItemsOf = useCallback(
    (entry: Expense) => {
      const triggered = new Set<EntryReviewReasonId>();
      if (duplicateEntryIds.has(entry.id)) triggered.add("duplicate");
      if (unknownAccountEntryIds.has(entry.id)) triggered.add("unknownAccount");
      if (unlinkedAssetEntryIds.has(entry.id)) triggered.add("unlinkedAsset");
      if (businessType === "corporation" && revisedEntryIds.has(entry.id)) {
        triggered.add("revisedEntry");
      }
      const ref = entryReviewRef(entry);
      return ENTRY_REVIEW_REASONS.filter((reason) =>
        triggered.has(reason.id),
      ).map((reason) => ({
        reason,
        ack: reviewAckByKey.get(`${ref}|${reason.id}`) ?? null,
      }));
    },
    [
      duplicateEntryIds,
      unknownAccountEntryIds,
      unlinkedAssetEntryIds,
      reviewAckByKey,
      businessType,
      revisedEntryIds,
    ],
  );

  /** まだ確認できていない理由が1つでも残っているか。 */
  const hasOpenReviewReason = useCallback(
    (entry: Expense, reasonId: EntryReviewReasonId) =>
      entryReviewItemsOf(entry).some(
        (item) => item.reason.id === reasonId && !item.ack,
      ),
    [entryReviewItemsOf],
  );

  /** 重複の疑いの相手。確認パネルで見比べるために自分以外を返す。 */
  const duplicateSiblingsOf = useCallback(
    (entry: Expense) =>
      allEntries.filter(
        (other) =>
          other.id !== entry.id &&
          other.date === entry.date &&
          other.partner === entry.partner &&
          other.amount === entry.amount,
      ),
    [allEntries],
  );

  const entryStateOf = useCallback(
    (entry: Expense): EntryState => {
      const openReviewReasons = entryReviewItemsOf(entry)
        .filter((item) => !item.ack)
        .map((item) => item.reason.id);
      return resolveTransactionStatus({
        businessType,
        revised: revisedEntryIds.has(entry.id),
        openReviewReasons,
      });
    },
    [businessType, revisedEntryIds, entryReviewItemsOf],
  );

  const evidenceStatusOf = useCallback(
    (entry: Expense) => entry.evidenceStatus ?? resolveEvidenceStatus(entry),
    [],
  );
  const hasReceipt = useCallback(
    (entry: Expense) => evidenceStatusOf(entry) === "attached",
    [evidenceStatusOf],
  );
  const hasEvidence = useCallback(
    (entry: Expense) => evidenceStatusOf(entry) !== "missing",
    [evidenceStatusOf],
  );

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
      noReceipt: entryRows.filter((entry) => !hasEvidence(entry)).length,
      review: entryRows.filter((entry) => entryStateOf(entry) === "review")
        .length,
      revised: entryRows.filter((entry) => revisedEntryIds.has(entry.id))
        .length,
    }),
    [entryRows, entryStateOf, hasEvidence, revisedEntryIds],
  );

  const tabbedEntryRows = useMemo(() => {
    if (entryListTab === "noReceipt") {
      return entryRows.filter((entry) => !hasEvidence(entry));
    }
    if (entryListTab === "review") {
      return entryRows.filter((entry) => entryStateOf(entry) === "review");
    }
    if (entryListTab === "revised") {
      return entryRows.filter((entry) => revisedEntryIds.has(entry.id));
    }
    return entryRows;
  }, [entryRows, entryListTab, entryStateOf, hasEvidence, revisedEntryIds]);

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
    tabbedEntryRows.length === 0
      ? 0
      : (currentEntryPage - 1) * ENTRY_PAGE_SIZE + 1;
  const entryRangeEnd = Math.min(
    currentEntryPage * ENTRY_PAGE_SIZE,
    tabbedEntryRows.length,
  );

  // 取引ステータス（ドーナツ）。合計は一覧に出ている件数と一致させる。
  const entryStatusCounts = useMemo(() => {
    let review = 0;
    for (const entry of entryRows) {
      const state = entryStateOf(entry);
      if (state === "review") review += 1;
    }
    return {
      registered: entryRows.length - review,
      review,
      total: entryRows.length,
    };
  }, [entryRows, entryStateOf]);

  // 証憑ステータス（ドーナツ）。電子取引データの保存漏れを一目で出す。
  const receiptStatusCounts = useMemo(() => {
    const attached = entryRows.filter((entry) => {
      const status = evidenceStatusOf(entry);
      return status === "attached" || status === "system_record";
    }).length;
    const unavailable = entryRows.filter(
      (entry) => evidenceStatusOf(entry) === "unavailable_recorded",
    ).length;
    return {
      attached,
      unavailable,
      missing: entryRows.length - attached - unavailable,
      total: entryRows.length,
    };
  }, [entryRows, evidenceStatusOf]);

  // 今月の収支。今日が選択中の期間に入らなければ、期間の最後の月を対象にする。
  const monthlyBalance = useMemo(() => {
    const months = periodMonthsOf(periodBounds);
    const target =
      months.find(
        (candidate) =>
          today >= candidate.startsOn && today <= candidate.endsOn,
      ) ?? months[months.length - 1];
    const month = target.month;
    const prefix = target.key;
    const sum = (rows: Expense[]) =>
      rows
        .filter((entry) => entry.date.startsWith(prefix))
        .reduce((total, entry) => total + entry.amount, 0);
    const income = sum(incomes);
    const expense = sum(expenses);
    return { month, income, expense, balance: income - expense };
  }, [expenses, incomes, periodBounds, today]);

  // 確認キュー。優先順（証憑 → 金額 → 科目 → 訂正）に並べ、空のグループは出さない。
  const reviewQueue = useMemo(() => {
    const rowsFor = (key: ReviewQueueKey) => {
      if (key === "noReceipt")
        return entryRows.filter((entry) => !hasEvidence(entry));
      // 確認済みにした理由はキューから外す（未対応だけを残す）。
      if (key === "fixedAsset") {
        return entryRows.filter((entry) =>
          hasOpenReviewReason(entry, "unlinkedAsset"),
        );
      }
      if (key === "amount")
        return entryRows.filter((entry) =>
          hasOpenReviewReason(entry, "duplicate"),
        );
      if (key === "account") {
        return entryRows.filter((entry) =>
          hasOpenReviewReason(entry, "unknownAccount"),
        );
      }
      return entryRows.filter((entry) =>
        hasOpenReviewReason(entry, "revisedEntry"),
      );
    };
    return REVIEW_QUEUE_DEFS.map((def) => ({
      ...def,
      rows: rowsFor(def.key),
    })).filter((group) => group.rows.length > 0);
  }, [entryRows, hasOpenReviewReason, hasEvidence]);

  const selectedEntries = entryRows.filter((entry) =>
    selectedEntryIds.includes(entry.id),
  );
  const pageAllSelected =
    pagedEntryRows.length > 0 &&
    pagedEntryRows.every((entry) => selectedEntryIds.includes(entry.id));

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
        evidenceStatusOf(entry) === "system_record"
          ? "注文データ保存済み"
          : evidenceStatusOf(entry) === "unavailable_recorded"
            ? "理由記録済み"
            : hasReceipt(entry)
              ? "添付済み"
              : "未添付",
        ENTRY_STATE_LABELS[entryStateOf(entry)],
        entry.memo,
      ]),
    ]);
  };

  /** 証憑 Drawer を開く。複数IDなら選択中の取引をまとめて扱う。 */
  const openReceiptDrawer = (entryIds: number[]) => {
    setReceiptMessage(null);
    const entry = entryRows.find((candidate) => candidate.id === entryIds[0]);
    setReceiptUnavailableFormOpen(Boolean(entry?.evidenceUnavailable));
    setReceiptUnavailableReason(entry?.evidenceUnavailable?.reason ?? "");
    setReceiptUnavailableNote(entry?.evidenceUnavailable?.note ?? "");
    setReceiptDrawerEntryIds(entryIds);
  };

  const receiptDrawerEntries = entryRows.filter((entry) =>
    receiptDrawerEntryIds.includes(entry.id),
  );

  /** 確認パネルを開く。未確認の理由のメモ欄は空、確認済みは保存済みのメモを出す。 */
  const openReviewDrawer = (entry: Expense) => {
    setReviewNotes(
      Object.fromEntries(
        entryReviewItemsOf(entry).map((item) => [
          item.reason.id,
          item.ack?.note ?? "",
        ]),
      ),
    );
    setReviewEntryId(entry.id);
  };

  const reviewEntry = entryRows.find((entry) => entry.id === reviewEntryId);
  const reviewItems = reviewEntry ? entryReviewItemsOf(reviewEntry) : [];
  const reviewOpenCount = reviewItems.filter((item) => !item.ack).length;

  /** 理由を1件、確認済みにする／確認済みを取り消す。 */
  const handleReviewAck = async (
    entry: Expense,
    reason: EntryReviewReasonDef,
    acknowledged: boolean,
  ) => {
    try {
      setIsSaving(true);
      await postMutation({
        operation: "entry.reviewAck",
        entryRef: entryReviewRef(entry),
        reason: reason.id,
        acknowledged,
        note: acknowledged ? (reviewNotes[reason.id] ?? "") : "",
      });
      await loadFinanceData();
      notifySuccess(
        acknowledged
          ? `「${reason.label}」を確認済みにしました。`
          : `「${reason.label}」の確認を取り消しました。`,
      );
    } catch (error) {
      notifyError(error, "確認結果の保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  };

  // 取引ごとの最終更新（訂正履歴の最新1件）。一覧の「更新履歴」列に出す。
  const latestRevisionOf = (entryId: number) =>
    revisions
      .filter((revision) => revision.entryId === entryId)
      .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))[0];

  // 固定資産1件の来歴。購入取引 → 固定資産 → 取得仕訳 → 減価償却仕訳 を縦に並べ、
  // どこが欠けているか（取引未連携・取得仕訳なし・証憑なし）を一目で分かるようにする。
  const assetDetail = useMemo(() => {
    if (assetDetailId === null) return null;
    const asset = fixedAssets.find((row) => row.id === assetDetailId);
    if (!asset) return null;
    const entry =
      asset.entryId === null ? null : expensesById.get(asset.entryId);
    return {
      asset,
      entry: entry ?? null,
      status: assetLinkStatuses.get(asset.id) ?? "direct",
      row: depreciation.rows.find((row) => row.asset.id === asset.id) ?? null,
      // 取得仕訳は取引から、減価償却仕訳は台帳から生成される（journal.ts）。
      acquisitionEntry:
        asset.entryId === null
          ? null
          : (journal.find((item) => item.entryId === asset.entryId) ?? null),
      depreciationEntry:
        journal.find((item) => item.entryId === -asset.id) ?? null,
    };
  }, [
    assetDetailId,
    fixedAssets,
    expensesById,
    assetLinkStatuses,
    depreciation.rows,
    journal,
  ]);

  const selectedLedger =
    ledger.find((row) => row.account.code === ledgerAccountCode) ?? ledger[0];

  /** 資産名・科目・金額・取得日・償却方法を取引から引き継ぐ。 */
  const fillAssetFormFromEntry = (entry: Expense) => {
    setAssetMessage(null);
    setAssetForm((current) => ({
      ...current,
      entryId: entry.id,
      name: entry.item,
      account: entry.category,
      acquiredOn: entry.date,
      acquisitionCost: String(entry.amount),
      // 金額から償却方法の初期値を推奨する（利用者は後から変えられる）。
      method: suggestDepreciationMethod(entry.amount),
    }));
  };

  const applyAssetEntry = (entryId: number | null) => {
    if (entryId === null) {
      setAssetForm((current) => ({
        ...current,
        entryId: null,
        acquisitionCost: "",
        acquiredOn: new Date().toLocaleDateString("sv-SE"),
      }));
      return;
    }
    const entry = expensesById.get(entryId);
    if (entry) {
      setSelectedAssetCandidateSnapshot(entry);
      fillAssetFormFromEntry(entry);
    }
  };

  /** 誘導ダイアログから固定資産の登録フォームへ送る。 */
  const startAssetFromEntry = (entry: Expense) => {
    setAssetCandidate(null);
    setSelectedAssetCandidateSnapshot(entry);
    fillAssetFormFromEntry(entry);
    setAssetReviewDecision("asset");
    setActiveTab("journal");
    setLedgerTab("assets");
  };

  /** 固定資産候補の疑いを解いて費用として処理する（科目違いの疑いのみ）。 */
  const handleDismissAssetCandidate = async (
    entry: Expense,
    reason: string,
  ) => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      setAssetMessage("対象外にする理由を入力してください。");
      return;
    }
    setAssetCandidate(null);
    try {
      setIsSaving(true);
      await postMutation({
        operation: "entry.assetExempt",
        expenseId: entry.id,
        exempt: true,
        reason: normalizedReason,
      });
      await loadFinanceData();
      setAssetExclusionEntryId(null);
      setAssetExclusionReason("");
      setAssetReviewDecision(null);
      setSelectedAssetCandidateSnapshot(null);
      notifySuccess("対象外の理由を保存しました。");
    } catch (error) {
      notifyError(error, "固定資産の確認状態の保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  };

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
    if (assetForm.entryId === null) {
      setAssetMessage("連携する購入取引を選択してください。");
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
          // 連携時はサーバー側が取引の金額・取得日で上書きする。ここは表示との整合用。
          acquiredOn: assetForm.acquiredOn,
          acquisitionCost: Math.round(cost),
          usefulLife: Math.max(1, Number(assetForm.usefulLife) || 1),
          method: assetForm.method,
          businessUseRatio: Math.min(
            100,
            Math.max(1, Number(assetForm.businessUseRatio) || 100),
          ),
          disposedOn: assetForm.disposedOn || null,
          serviceStartedOn: assetForm.serviceStartedOn || null,
          entryId: assetForm.entryId,
          memo: "",
        },
      });
      await loadFinanceData();
      setAssetForm(EMPTY_ASSET_FORM);
      setAssetReviewDecision(null);
      setSelectedAssetCandidateSnapshot(null);
      setAssetMessage("固定資産を登録し、購入取引と紐付けました。");
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
            debit: onDebitSide ? Math.max(amount, 0) : Math.max(-amount, 0),
            credit: onDebitSide ? Math.max(-amount, 0) : Math.max(amount, 0),
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
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
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
      const payload = (await response.json().catch(() => null)) as {
        data?: { url: string };
        error?: string;
      } | null;
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

  const handleSaveEvidenceUnavailable = async (entry: Expense) => {
    if (!receiptUnavailableReason) return;
    try {
      setIsSaving(true);
      setReceiptMessage(null);
      await postMutation({
        operation: "evidenceUnavailable.upsert",
        expenseId: entry.id,
        reason: receiptUnavailableReason,
        note: receiptUnavailableNote.trim(),
      });
      await loadFinanceData();
      setReceiptUnavailableFormOpen(false);
      setReceiptMessage("証憑を添付できない理由を記録しました。");
    } catch (error) {
      setReceiptMessage(
        error instanceof Error
          ? error.message
          : "証憑を添付できない理由の保存に失敗しました。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteEvidenceUnavailable = async (entry: Expense) => {
    try {
      setIsSaving(true);
      setReceiptMessage(null);
      await postMutation({
        operation: "evidenceUnavailable.delete",
        expenseId: entry.id,
      });
      await loadFinanceData();
      setReceiptUnavailableReason("");
      setReceiptUnavailableNote("");
      setReceiptUnavailableFormOpen(false);
      setReceiptMessage("証憑ステータスを未添付に戻しました。");
    } catch (error) {
      setReceiptMessage(
        error instanceof Error
          ? error.message
          : "証憑ステータスを未添付に戻せませんでした。",
      );
    } finally {
      setIsSaving(false);
    }
  };

  // --- 青色申告決算書（一般用）1〜4ページ ---
  const monthlySummary = useMemo(
    () => buildMonthlySummary(journal, periodBounds),
    [journal, periodBounds],
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
    () =>
      [
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
        [
          "青色申告特別控除前の所得金額",
          deductionCalc.incomeBeforeDeduction,
          "",
        ],
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

  const ledgerClosingBalance = selectedLedger?.closingBalance ?? 0;

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

  /** 四半期の絞り込み。期間の月を始まりから3か月ずつ束ねる（暦年の期間なら 1-3 / 4-6 / 7-9 / 10-12）。 */
  const ledgerQuarters = useMemo(() => {
    const months = periodMonthsOf(periodBounds);
    const quarters: Array<{ startsOn: string; endsOn: string }> = [];
    for (let index = 0; index < months.length; index += 3) {
      const chunk = months.slice(index, index + 3);
      quarters.push({
        startsOn: chunk[0].startsOn,
        endsOn: chunk[chunk.length - 1].endsOn,
      });
    }
    return quarters;
  }, [periodBounds]);
  const ledgerPeriodOptions = [
    {
      value: "full",
      label: `期間：${slashDate(periodBounds.startsOn)} 〜 ${slashDate(periodBounds.endsOn)}`,
    },
    ...ledgerQuarters.map((quarter, index) => ({
      value: `q${index + 1}`,
      label: `期間：${slashDate(quarter.startsOn)} 〜 ${slashDate(quarter.endsOn)}`,
    })),
  ];

  const LEDGER_SIDE_OPTIONS = [
    { value: "all", label: "すべての取引" },
    { value: "debit", label: "借方のみ" },
    { value: "credit", label: "貸方のみ" },
    { value: "closing", label: "決算整理のみ" },
  ];

  // 中央の仕訳一覧。選択中の科目の元帳行を新しい順に並べ、期間・貸借・語で絞る。
  const filteredLedgerRows = (() => {
    if (!selectedLedger) return [];
    const keyword = ledgerRowKeyword.trim().toLowerCase();
    const quarter =
      ledgerPeriod === "full"
        ? null
        : (ledgerQuarters[Number(ledgerPeriod.slice(1)) - 1] ?? null);
    return selectedLedger.rows
      .map((row, index) => ({ ...row, key: `${row.number}-${index}` }))
      .filter((row) => {
        if (
          quarter !== null &&
          !isDateInPeriod(row.date, quarter)
        ) {
          return false;
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
  })();

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
    pagedLedgerRows.find((row) => row.key === selectedLedgerRowKey) ??
    pagedLedgerRows[0] ??
    null;
  const selectedJournalEntry = selectedLedgerRow
    ? (journalByNumber.get(selectedLedgerRow.number) ?? null)
    : null;
  const selectedLedgerEntry = selectedLedgerRow
    ? (entriesById.get(selectedLedgerRow.entryId) ?? null)
    : null;
  const selectedLedgerReceipts = selectedLedgerEntry?.receipts ?? [];

  // 関連仕訳＝同日・同取引先の別伝票。資金移動の相手側を辿る導線。
  const relatedJournalEntries = (() => {
    if (!selectedLedgerRow) return [];
    return journal
      .filter(
        (entry) =>
          entry.number !== selectedLedgerRow.number &&
          entry.date === selectedLedgerRow.date &&
          (selectedLedgerRow.partner
            ? entry.partner === selectedLedgerRow.partner
            : true),
      )
      .slice(0, 4);
  })();

  // 更新履歴＝訂正削除履歴（DBトリガーが記録する。アプリからは書き換えられない）。
  const selectedLedgerRevisions = (() => {
    if (!selectedLedgerRow) return [];
    return revisions
      .filter((revision) => revision.entryId === selectedLedgerRow.entryId)
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  })();

  // 照合結果。元帳の最終残高と試算表の残高は同じ元データから導くので必ず一致する。
  // 一致しないときは仕訳の変換か期首残高が壊れている。
  const selectedTrialRow = selectedLedger
    ? (trialBalance.rows.find(
        (row) => row.account.code === selectedLedger.account.code,
      ) ?? null)
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
      if (
        assetMethodFilter !== "all" &&
        row.asset.method !== assetMethodFilter
      ) {
        return false;
      }
      if (assetSectionFilter !== "all") {
        if (accountByName(row.asset.account)?.section !== assetSectionFilter) {
          return false;
        }
      }
      if (!keyword) return true;
      return `${row.asset.name} ${row.asset.account} ${fixedAssetCode(row.asset)} #${row.asset.id}`
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
        const acquiredYear = Number.parseInt(
          row.asset.acquiredOn.slice(0, 4),
          10,
        );
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

  // 固定資産登録。入力中のフォームをそのまま1件の資産として試算する。
  /** 取引と連携中か。連携中は取得価額・取得日を編集させない。 */
  const isAssetLinked = assetForm.entryId !== null;

  const assetSimulation = useMemo(() => {
    const cost = Math.max(
      0,
      Math.round(Number(assetForm.acquisitionCost) || 0),
    );
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
      serviceStartedOn: assetForm.serviceStartedOn || null,
      memo: "",
    };
    // 償却は供用日から始まるので、満年ベースの起点も供用年に合わせる。
    const startYear = Number.parseInt(
      (assetForm.serviceStartedOn || assetForm.acquiredOn).slice(0, 4),
      10,
    );
    return {
      // 年間償却額（概算）は月割の影響を受けない満年ベース＝供用翌年の額。
      annual: depreciationForYear(draft, startYear + 1).depreciation,
      currentYear: depreciationForYear(draft, fiscalYear).depreciation,
      residual: assetForm.method === "straightLine" ? 1 : 0,
    };
  }, [assetForm, fiscalYear]);

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
        ? (monthlyAccountBalances.opening.get(code) ?? 0)
        : (monthlyAccountBalances.monthly.get(code)?.[monthIndex] ?? 0),
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
      amountOfTypesAt(["revenue"], monthIndex) -
      amountOfTypesAt(["expense"], monthIndex),
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
        amountOfTypesAt(["equity"], currentMonthIndex) +
        netIncomeAt(currentMonthIndex),
      comparison:
        amountOfTypesAt(["equity"], comparisonMonthIndex) +
        netIncomeAt(comparisonMonthIndex),
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
    amountOfTypesAt(["equity"], currentMonthIndex) +
    netIncomeAt(currentMonthIndex);
  const bsRightTotal = bsLiabilityTotal + bsEquityTotal;

  // 構成図の高さ配分。金額が0でも枠が潰れないよう最小値を持たせる。
  const bsShare = (value: number) =>
    bsAssetTotal === 0
      ? 50
      : Math.max(12, (Math.abs(value) / bsAssetTotal) * 100);

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
          amountOfSectionsAt([section], currentMonthIndex) -
          amountOfSectionsAt([section], comparisonMonthIndex),
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
              Number.parseInt(row.date.slice(0, 4), 10) === fiscalYear &&
              Number.parseInt(row.date.slice(5, 7), 10) - 1 ===
                currentMonthIndex,
          ),
        );
        const byCounter = new Map<string, number>();
        for (const row of monthRows) {
          byCounter.set(
            row.counterAccount,
            (byCounter.get(row.counterAccount) ?? 0) +
              Math.abs(row.debit - row.credit),
          );
        }
        const mainCounter =
          [...byCounter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        // 証憑が全て揃っていれば確認済み。決算整理仕訳は証憑の対象外。
        const pending = monthRows.filter(
          (row) =>
            row.entryId >= 0 &&
            (() => {
              const entry = entriesById.get(row.entryId);
              return entry ? evidenceStatusOf(entry) === "missing" : true;
            })(),
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
    evidenceStatusOf,
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

  // 取引の件数。証憑の充足と申告資料の状態は、この実データから決める。
  const taxEntryCounts = useMemo(() => {
    const all = [...expenses, ...incomes];
    const withReceipt = all.filter((entry) => {
      const status = evidenceStatusOf(entry);
      return status === "attached" || status === "system_record";
    }).length;
    const unavailableRecorded = all.filter(
      (entry) => evidenceStatusOf(entry) === "unavailable_recorded",
    ).length;
    return {
      total: all.length,
      withReceipt,
      withoutReceipt: all.length - withReceipt - unavailableRecorded,
      unavailableRecorded,
      expense: expenses.length,
      income: incomes.length,
    };
  }, [expenses, incomes, evidenceStatusOf]);

  return {
    periodId,
    onPeriodChange,
    period,
    periods,
    periodNotices,
    hasNoPeriod,
    journalIncomplete,
    preDeductionIncome,
    synthesizedEntryNumbers,
    periodBounds,
    periodRangeLabel,
    periodSpanLabel,
    fiscalYear,
    fiscalYearLabel,
    fiscalYearOptions,
    onFiscalYearChange,
    activeTab,
    setActiveTab,
    cashTrendMode,
    setCashTrendMode,
    profitScopeMode,
    setProfitScopeMode,
    today,
    ledgerTab,
    setLedgerTab,
    accountTreeKeyword,
    setAccountTreeKeyword,
    accountTreeSearchInput,
    setAccountTreeSearchInput,
    collapsedAccountGroups,
    setCollapsedAccountGroups,
    ledgerRowKeyword,
    setLedgerRowKeyword,
    ledgerRowSearchInput,
    setLedgerRowSearchInput,
    ledgerPeriod,
    setLedgerPeriod,
    ledgerSideFilter,
    setLedgerSideFilter,
    ledgerRowPage,
    setLedgerRowPage,
    ledgerPageSize,
    setLedgerPageSize,
    selectedLedgerRowKey,
    setSelectedLedgerRowKey,
    assetSectionFilter,
    setAssetSectionFilter,
    assetMethodFilter,
    setAssetMethodFilter,
    assetKeyword,
    setAssetKeyword,
    assetSearchInput,
    setAssetSearchInput,
    isAssetFilterOpen,
    setIsAssetFilterOpen,
    assetPage,
    setAssetPage,
    statementTab,
    setStatementTab,
    comparisonBasis,
    setComparisonBasis,
    balanceSheetKeyword,
    setBalanceSheetKeyword,
    balanceSheetSearchInput,
    setBalanceSheetSearchInput,
    collapsedBsGroups,
    setCollapsedBsGroups,
    syncedAt,
    setSyncedAt,
    usesEtax,
    setUsesEtax,
    filter,
    setFilter,
    entrySearchInput,
    setEntrySearchInput,
    entryListTab,
    setEntryListTab,
    entryPage,
    setEntryPage,
    selectedEntryIds,
    setSelectedEntryIds,
    isEntryDrawerOpen,
    setIsEntryDrawerOpen,
    isFilterDrawerOpen,
    setIsFilterDrawerOpen,
    receiptDrawerEntryIds,
    setReceiptDrawerEntryIds,
    pendingReceipts,
    setPendingReceipts,
    receiptUnavailableFormOpen,
    setReceiptUnavailableFormOpen,
    receiptUnavailableReason,
    setReceiptUnavailableReason,
    receiptUnavailableNote,
    setReceiptUnavailableNote,
    pendingUnavailableFormOpen,
    setPendingUnavailableFormOpen,
    pendingUnavailableReason,
    setPendingUnavailableReason,
    pendingUnavailableNote,
    setPendingUnavailableNote,
    isRevisionHistoryOpen,
    setIsRevisionHistoryOpen,
    ledgerAccountCode,
    setLedgerAccountCode,
    seasonOptions,
    seasonKey,
    setSeasonKey,
    seasonLabel,
    expenses,
    setExpenses,
    incomes,
    setIncomes,
    products,
    setProducts,
    partners,
    setPartners,
    fixedAssets,
    setFixedAssets,
    adjustment,
    setAdjustment,
    closedAt,
    setClosedAt,
    previousClosingBalances,
    setPreviousClosingBalances,
    closingMessage,
    setClosingMessage,
    revisions,
    setRevisions,
    reviewAcks,
    setReviewAcks,
    reviewEntryId,
    setReviewEntryId,
    reviewNotes,
    setReviewNotes,
    cumulativeEntries,
    setCumulativeEntries,
    uploadingEntryId,
    setUploadingEntryId,
    receiptMessage,
    setReceiptMessage,
    templates,
    setTemplates,
    summaryOptions,
    setSummaryOptions,
    stripeAccounting,
    setStripeAccounting,
    confirmingPayout,
    setConfirmingPayout,
    bankArrivalDate,
    setBankArrivalDate,
    payoutConfirmError,
    setPayoutConfirmError,
    isConfirmingPayout,
    setIsConfirmingPayout,
    plan,
    setPlan,
    businessType,
    setBusinessType,
    selectedProductId,
    setSelectedProductId,
    isDataLoading,
    setIsDataLoading,
    archiveHealth,
    setArchiveHealth,
    isSaving,
    setIsSaving,
    dataMessage,
    setDataMessage,
    toast,
    setToast,
    notifySuccess,
    notifyError,
    form,
    setForm,
    formMessage,
    setFormMessage,
    editingEntryId,
    setEditingEntryId,
    deleteEntry,
    setDeleteEntry,
    deleteDialogError,
    setDeleteDialogError,
    deleteTriggerRef,
    assetForm,
    setAssetForm,
    assetMessage,
    setAssetMessage,
    setAssetExclusionEntryId,
    assetExclusionReason,
    setAssetExclusionReason,
    assetReviewDecision,
    setAssetReviewDecision,
    selectedAssetCandidateSnapshot,
    setSelectedAssetCandidateSnapshot,
    assetDetailId,
    setAssetDetailId,
    assetCandidate,
    setAssetCandidate,
    isAddingPartner,
    setIsAddingPartner,
    newPartnerName,
    setNewPartnerName,
    selectedTemplateName,
    setSelectedTemplateName,
    isSavingTemplate,
    setIsSavingTemplate,
    newTemplateName,
    setNewTemplateName,
    isTemplateOverwriteDialogOpen,
    setIsTemplateOverwriteDialogOpen,
    isAddingSummaryOption,
    setIsAddingSummaryOption,
    newSummaryOptionName,
    setNewSummaryOptionName,
    isTemplateDiscardDialogOpen,
    setIsTemplateDiscardDialogOpen,
    loadFinanceData,
    postMutation,
    openingBalances,
    seasonForecast,
    emptyProduct,
    selectedProduct,
    selectedUnitCost,
    selectedGrossProfit,
    selectedGrossMargin,
    depreciation,
    expensesById,
    unlinkedAssetEntryRows,
    pendingAssetEntryRows,
    excludedAssetEntryRows,
    selectedAssetCandidate,
    assetLinkStatuses,
    stripeProjectedPaymentIntents,
    stripeJournalOrders,
    stripeJournal,
    journalIncomes,
    journal,
    ledger,
    trialBalance,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    carryForward,
    cumulative,
    cumulativeBalanceTrend,
    counterpartyBalances,
    cashTrend,
    safetyLevel,
    cashTargets,
    isMonthlyTrend,
    trendPoints,
    trendTargets,
    cashSchedule,
    dueSoon,
    overviewActions,
    salesComposition,
    costOfSalesComposition,
    sgaComposition,
    compositionTotal,
    cashFlowNet,
    equityRatio,
    isCumulativeScope,
    profitScope,
    journalRows,
    handleAddExpense,
    handleStartEdit,
    closeEntryDrawer,
    handleCancelEdit,
    continueTemplateEditing,
    handleOpenNewEntry,
    handleEntryTypeChange,
    handleSaveSummaryOption,
    handleDeleteSummaryOption,
    handleBusinessTypeChange,
    handleAddPartner,
    handleTemplateSelect,
    handleSaveTemplate,
    handleOverwriteTemplate,
    handleStartSaveTemplateAs,
    handleDeleteTemplate,
    updateProduct,
    handleDeleteExpense,
    closeDeleteDialog,
    confirmDeleteEntry,
    handleSaveProduct,
    handleSavePlan,
    handleJournalExport,
    handleGeneralLedgerExport,
    handleTrialBalanceExport,
    handleStatementExport,
    confirmPayoutArrival,
    isIncomeForm,
    entryTypeLabel,
    paymentFieldLabel,
    summaryFieldLabel,
    customSummaryOptions,
    visibleTemplates,
    filteredExpenses,
    filteredIncomes,
    filterActive,
    filterConditionCount,
    updateFilter,
    allEntries,
    filterAccountOptions,
    filterPartnerOptions,
    filterFieldClassName,
    revisedEntryIds,
    duplicateEntryIds,
    unknownAccountEntryIds,
    unlinkedAssetEntryIds,
    reviewAckByKey,
    entryReviewItemsOf,
    hasOpenReviewReason,
    duplicateSiblingsOf,
    entryStateOf,
    evidenceStatusOf,
    hasReceipt,
    hasEvidence,
    entryRows,
    entryTabCounts,
    tabbedEntryRows,
    entryTotalPages,
    currentEntryPage,
    pagedEntryRows,
    entryRangeStart,
    entryRangeEnd,
    entryStatusCounts,
    receiptStatusCounts,
    monthlyBalance,
    reviewQueue,
    selectedEntries,
    pageAllSelected,
    toggleEntrySelection,
    togglePageSelection,
    changeEntryListTab,
    handleEntryCsvExport,
    openReceiptDrawer,
    receiptDrawerEntries,
    openReviewDrawer,
    reviewEntry,
    reviewItems,
    reviewOpenCount,
    handleReviewAck,
    latestRevisionOf,
    assetDetail,
    selectedLedger,
    fillAssetFormFromEntry,
    applyAssetEntry,
    startAssetFromEntry,
    handleDismissAssetCandidate,
    handleSaveFixedAsset,
    handleDeleteFixedAsset,
    closingEntries,
    carryForwardCheck,
    carryForwardRows,
    handleSaveClosing,
    handleFinalizeClosing,
    handleReopenClosing,
    uploadReceiptFile,
    handleAttachReceipts,
    handleOpenReceipt,
    handleDeleteReceipt,
    handleSaveEvidenceUnavailable,
    handleDeleteEvidenceUnavailable,
    monthlySummary,
    deductionCalc,
    breakdownOf,
    wagesBreakdown,
    familyWagesBreakdown,
    interestBreakdown,
    rentBreakdown,
    professionalFeesBreakdown,
    closingBalanceSheetBalances,
    balanceSheetComparison,
    page1Rows,
    expenseDetailRows,
    handleBlueReturnExport,
    handleFixedAssetExport,
    accountTree,
    filteredAccountTree,
    toggleAccountGroup,
    ledgerClosingBalance,
    entriesById,
    journalByNumber,
    ledgerPeriodOptions,
    LEDGER_SIDE_OPTIONS,
    filteredLedgerRows,
    ledgerTotalPages,
    currentLedgerPage,
    pagedLedgerRows,
    ledgerRangeStart,
    ledgerRangeEnd,
    selectedLedgerRow,
    selectedJournalEntry,
    selectedLedgerEntry,
    selectedLedgerReceipts,
    relatedJournalEntries,
    selectedLedgerRevisions,
    selectedTrialRow,
    selectedTrialAmount,
    ledgerReconcileDifference,
    selectAccount,
    openEntryFromLedger,
    assetSectionOptions,
    assetMethodOptions,
    filteredDepreciationRows,
    assetTotals,
    depreciationYears,
    depreciationPlanRows,
    depreciationYearTotals,
    businessExpenseYearTotals,
    assetsCompletingThisYear,
    handleDepreciationPlanExport,
    assetTotalPages,
    currentAssetPage,
    pagedAssetRows,
    assetRangeStart,
    assetRangeEnd,
    isAssetLinked,
    assetSimulation,
    monthlyAccountBalances,
    currentMonthIndex,
    comparisonMonthIndex,
    bsSectionGroups,
    amountOfAccountAt,
    amountOfSectionsAt,
    amountOfTypesAt,
    netIncomeAt,
    balanceSheetDetailRows,
    visibleBalanceSheetRows,
    bsAssetTotal,
    bsCurrentAssets,
    bsFixedAssets,
    bsCurrentLiabilities,
    bsFixedLiabilities,
    bsLiabilityTotal,
    bsEquityTotal,
    bsRightTotal,
    bsShare,
    balanceSheetTrend,
    balanceSheetVariance,
    bsComparisonTotal,
    varianceWaterfallData,
    significantVariances,
    toggleBsGroup,
    bsToneColor,
    taxEntryCounts,
  };
}

export type CostProfitModel = ReturnType<typeof useCostProfitModel>;
