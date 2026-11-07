import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import {
  DataTable,
  type TableColumn,
} from "@/components/ui/DataTable/DataTable";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { FileDropZone } from "@/components/ui/FileDropZone/FileDropZone";
import { Graph } from "@/components/ui/Graph/Graph";
import { PageControl } from "@/components/ui/PageControl/PageControl";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";
import { TextField } from "@/components/ui/TextField/TextField";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import type { EntryType } from "@/lib/finance/journal";
import {
  EMPTY_ENTRY_FILTER,
  type EntryFilter,
} from "@/lib/finance/entry-filter";
import {
  REVISION_OPERATION_LABELS,
  ENTRY_STATE_LABELS,
  ENTRY_STATE_TONES,
  ENTRY_STATE_COLORS,
  CORRECTION_HISTORY_COLOR,
  RECEIPT_ATTACHED_COLOR,
  RECEIPT_UNAVAILABLE_COLOR,
  RECEIPT_MISSING_COLOR,
  BALANCE_INCOME_COLOR,
  BALANCE_EXPENSE_COLOR,
  BALANCE_POSITIVE_COLOR,
  BALANCE_NEGATIVE_COLOR,
  type EntryListTab,
  DENCHOHO_CHECKLIST,
  RECEIPT_ACCEPT,
  type EvidenceUnavailableReason,
  EVIDENCE_UNAVAILABLE_REASON_OPTIONS,
  evidenceUnavailableReasonRequiresNote,
  type EntryRevision,
  type Expense,
  BUSINESS_TYPE_OPTIONS,
  accountOptionsFor,
  shiyouOptionsFor,
  paymentOptionsFor,
  NEW_PARTNER_SENTINEL,
  SAVE_TEMPLATE_SENTINEL,
  ADD_SUMMARY_OPTION_SENTINEL,
  currency,
  deltaCurrency,
  inputClassName,
  panelTitleClassName,
} from "./constants";
import type { CostProfitModel } from "./use-cost-profit-model";

export function ExpensesView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    filter,
    setFilter,
    entrySearchInput,
    setEntrySearchInput,
    entryListTab,
    setEntryPage,
    selectedEntryIds,
    isEntryDrawerOpen,
    isFilterDrawerOpen,
    setIsFilterDrawerOpen,
    setReceiptDrawerEntryIds,
    pendingReceipts,
    setPendingReceipts,
    receiptKindChoice,
    setReceiptKindChoice,
    receiptPaperKept,
    setReceiptPaperKept,
    receiptEvidence,
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
    seasonOptions,
    partners,
    revisions,
    setReviewEntryId,
    reviewNotes,
    setReviewNotes,
    uploadingEntryId,
    receiptMessage,
    businessType,
    archiveHealth,
    isSaving,
    form,
    setForm,
    formMessage,
    editingEntryId,
    deleteEntry,
    setDeleteEntry,
    deleteDialogError,
    setDeleteDialogError,
    deleteTriggerRef,
    assetCandidate,
    setAssetCandidate,
    isAddingPartner,
    setIsAddingPartner,
    newPartnerName,
    setNewPartnerName,
    selectedTemplateName,
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
    handleAddExpense,
    handleStartEdit,
    closeEntryDrawer,
    handleCancelEdit,
    continueTemplateEditing,
    handleOpenNewEntry,
    handleEntryTypeChange,
    handleSaveSummaryOption,
    handleDeleteSummaryOption,
    handleAddPartner,
    handleTemplateSelect,
    handleSaveTemplate,
    handleOverwriteTemplate,
    handleStartSaveTemplateAs,
    handleDeleteTemplate,
    closeDeleteDialog,
    confirmDeleteEntry,
    entryTypeLabel,
    paymentFieldLabel,
    summaryFieldLabel,
    customSummaryOptions,
    visibleTemplates,
    filterActive,
    filterConditionCount,
    updateFilter,
    filterAccountOptions,
    filterPartnerOptions,
    filterFieldClassName,
    entryReviewItemsOf,
    duplicateSiblingsOf,
    entryStateOf,
    evidenceStatusOf,
    hasReceipt,
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
    startAssetFromEntry,
    handleAttachReceipts,
    handleOpenReceipt,
    handleDeleteReceipt,
    handleSaveEvidenceUnavailable,
    handleDeleteEvidenceUnavailable,
  } = model;
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
      header: "摘要",
      cellClassName: "whitespace-nowrap",
      render: (entry) => {
        if (entry.readOnly || entry.source === "order") {
          return (
            <div className="whitespace-nowrap">
              <span className="block">{entry.item}</span>
              <span className="mt-0.5 flex flex-nowrap gap-1 lk-text-6xs text-[#707070]">
                <span>Supabase注文</span>
                {(entry.refundedAmount ?? 0) > 0 ? (
                  <span>返金 {currency(entry.refundedAmount ?? 0)}</span>
                ) : null}
              </span>
            </div>
          );
        }
        return <span className="block">{entry.item}</span>;
      },
    },
    {
      key: "partner",
      header: "取引先",
      cellClassName: "whitespace-nowrap",
      render: (entry) => entry.partner || "取引先なし",
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
        if (evidenceStatusOf(entry) === "system_record") {
          return (
            <span className="whitespace-nowrap lk-text-3xs text-[#365314]">
              注文データ保存済み
            </span>
          );
        }
        if (evidenceStatusOf(entry) === "unavailable_recorded") {
          return (
            <button
              type="button"
              className="whitespace-nowrap lk-text-3xs text-[#4b5563] underline decoration-dotted underline-offset-4"
              aria-label={`${entry.item}の証憑`}
              data-receipt-state="unavailable-recorded"
              onClick={() => openReceiptDrawer([entry.id])}
            >
              理由記録済み
            </button>
          );
        }
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
          <span className="block font-acumin lk-text-4xs leading-tight text-[#474747] tabular-nums">
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
        const badge = (
          <StatusBadge
            variant="text"
            shape="pill"
            size="3xs"
            tone={ENTRY_STATE_TONES[state]}
            accent
            className="w-18 whitespace-nowrap justify-center font-acumin"
          >
            {ENTRY_STATE_LABELS[state]}
          </StatusBadge>
        );
        const items = entryReviewItemsOf(entry);
        // 理由を持つ取引だけ押せる。押せる／押せないを見た目でも分ける。
        if (items.length === 0) {
          return (
            <span className="inline-flex min-h-11 w-28 items-center px-1.5">
              {badge}
            </span>
          );
        }

        const open = items.filter((item) => !item.ack).length;
        return (
          <button
            type="button"
            onClick={() => openReviewDrawer(entry)}
            aria-label={
              open > 0
                ? `${entry.item}の要確認の理由を開く（未確認${open}件）`
                : `${entry.item}の確認結果を開く`
            }
            className="inline-flex min-h-11 w-28 items-center gap-1 rounded-sm px-1.5 transition-colors hover:bg-[#f0f0f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
          >
            {badge}
            {open === 0 ? (
              <i
                className="ri-checkbox-circle-fill lk-text-4xs text-[#16844b]"
                aria-hidden="true"
              />
            ) : null}
            <i
              className="ri-arrow-right-s-line lk-text-sm text-[#707070]"
              aria-hidden="true"
            />
          </button>
        );
      },
    },
    {
      key: "actions",
      header: "操作",
      align: "center",
      className: "w-32",
      cellClassName: "whitespace-nowrap",
      render: (entry) => {
        if (entry.readOnly || entry.source === "order") {
          return <span className="text-[#909090]">—</span>;
        }
        return (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-black transition-colors hover:bg-[#f0f0f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`${entry.item}を編集`}
              onClick={() => handleStartEdit(entry)}
              disabled={isSaving}
            >
              <i className="ri-edit-line" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-[#b91c1c] transition-colors hover:bg-[#fef2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#b91c1c] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`${entry.item}を削除`}
              onClick={(event) => {
                deleteTriggerRef.current = event.currentTarget;
                setDeleteDialogError(null);
                setDeleteEntry(entry);
              }}
              disabled={isSaving}
            >
              <i className="ri-delete-bin-line" aria-hidden="true" />
            </button>
          </div>
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
      <i className="ri-arrow-right-s-line lk-text-2xl" />
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
        <span className="font-acumin lk-text-3xs text-[#474747]">{label}</span>
      </span>
      <span
        className="font-acumin lk-text-3xs tabular-nums"
        style={{ color: accent ? color : "#111111" }}
      >
        {count}件
      </span>
    </div>
  );

  /**
   * 確認パネル。「なぜ要確認か」と「何を確認すべきか」を理由ごとに示し、
   * 1件ずつ確認済みにできるようにする。全部片づくと状態が登録済みへ戻る。
   */
  const reviewDrawer = (
    <Drawer
      open={reviewEntry !== undefined}
      onClose={() => setReviewEntryId(null)}
      side="right"
      size="md"
      shape="rounded"
      className="flex w-[min(92vw,480px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
          取引の確認
        </h4>
        <Button
          variant="ghost"
          size="sm"
          shape="rounded"
          iconOnly
          className="h-11 w-11 text-[#474747]"
          aria-label="取引の確認を閉じる"
          onClick={() => setReviewEntryId(null)}
        >
          <i className="ri-close-line lk-text-2xl" aria-hidden="true" />
        </Button>
      </div>

      {reviewEntry ? (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* 何の取引を見ているかを最初に固定する。 */}
          <Panel
            radius="rounded"
            tone="muted"
            size="xs"
            className="px-3 py-2.5"
            aria-label="確認対象の取引"
          >
            <p className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
              {reviewEntry.date.replaceAll("-", "/")}
              {reviewEntry.entryType === "income" ? "収入" : "支出"}
              {reviewEntry.category}
            </p>
            <p className="mt-1 font-acumin lk-text-sm text-black">
              {reviewEntry.item}
            </p>
            <p className="mt-0.5 font-acumin lk-text-4xs text-[#474747] tabular-nums">
              {reviewEntry.partner || "取引先なし"}
              {currency(reviewEntry.amount)}
            </p>
          </Panel>

          <div role="status" className="font-acumin lk-text-3xs text-[#474747]">
            {reviewOpenCount > 0 ? (
              <span>
                未確認{" "}
                <span className="text-[#b45309] tabular-nums">
                  {reviewOpenCount}
                </span>
                {" / "}
                <span className="tabular-nums">{reviewItems.length}</span>
                件。すべて確認すると「登録済み」に戻ります。
              </span>
            ) : (
              <span className="text-[#16844b]">
                <i
                  className="ri-checkbox-circle-fill mr-1"
                  aria-hidden="true"
                />
                すべて確認済みです。状態は「登録済み」になっています。
              </span>
            )}
          </div>

          {reviewItems.map(({ reason, ack }) => {
            const siblings =
              reason.id === "duplicate" ? duplicateSiblingsOf(reviewEntry) : [];
            return (
              <Panel
                key={reason.id}
                aria-label={reason.label}
                radius="rounded"
                size="xs"
                className={`px-3 py-3 ${
                  ack
                    ? "border-[#d4d4d4] bg-white"
                    : "border-[#f0c78a] bg-[#fffaf2]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h5 className="flex items-center gap-1.5 font-acumin lk-text-3xs font-medium text-black">
                    <i
                      className={`${reason.icon} lk-text-sm ${
                        ack ? "text-[#16844b]" : "text-[#b45309]"
                      }`}
                      aria-hidden="true"
                    />
                    {reason.label}
                  </h5>
                  <StatusBadge
                    variant="text"
                    shape="pill"
                    size="3xs"
                    tone={ack ? "neutral" : "warning"}
                    accent
                    className="shrink-0 font-acumin"
                  >
                    {ack ? "確認済み" : "未確認"}
                  </StatusBadge>
                </div>

                <p className="mt-2 font-acumin lk-text-4xs leading-relaxed text-[#474747]">
                  <span className="text-[#707070]">なぜ要確認か：</span>
                  {reason.why}
                </p>

                {/* 検知に使った実際の値。文言だけでは自分の取引と結びつかない。 */}
                {reason.id === "unknownAccount" ? (
                  <p className="mt-1.5 font-acumin lk-text-4xs text-[#474747]">
                    登録されていない科目名：
                    <span className="text-black">
                      「{reviewEntry.category}」
                    </span>
                  </p>
                ) : null}
                {reason.id === "unlinkedAsset" ? (
                  <p className="mt-1.5 font-acumin lk-text-4xs text-[#474747] tabular-nums">
                    科目 {reviewEntry.category}／取得価額{" "}
                    {currency(reviewEntry.amount)}
                  </p>
                ) : null}
                {reason.id === "duplicate" ? (
                  <div className="mt-1.5">
                    <p className="font-acumin lk-text-4xs text-[#474747]">
                      同じ日付・取引先・金額の取引（{siblings.length}件）
                    </p>
                    <ul className="mt-1 space-y-1">
                      {siblings.map((sibling) => (
                        <li key={sibling.id}>
                          <Panel
                            radius="rounded"
                            size="3xs"
                            className="border-[#e4e4e4] bg-white px-2 py-1.5 font-acumin lk-text-6xs text-[#474747] tabular-nums"
                          >
                            {/* JSX の行頭に置いた全角スペースは落ちるので1つの式で組む。 */}
                            {`${sibling.date.replaceAll("-", "/")}　${sibling.category}　${currency(sibling.amount)}`}
                            <span className="mt-0.5 block truncate text-[#707070]">
                              {sibling.item}
                            </span>
                          </Panel>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="mt-3 font-acumin lk-text-4xs text-[#707070]">
                  確認すること
                </p>
                <ol className="mt-1 list-decimal space-y-1 pl-4 font-acumin lk-text-4xs leading-relaxed text-[#474747]">
                  {reason.checklist.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>

                {ack ? (
                  <div className="mt-3 border-t border-[#e4e4e4] pt-2.5">
                    <p className="font-acumin lk-text-4xs text-[#474747] tabular-nums">
                      確認日時{" "}
                      {new Date(ack.reviewedAt).toLocaleString("ja-JP", {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    {ack.note ? (
                      <p className="mt-1 font-acumin lk-text-4xs text-black">
                        {ack.note}
                      </p>
                    ) : null}
                    <Button
                      variant="outline"
                      size="2xs"
                      shape="rounded"
                      className="mt-2 font-acumin"
                      disabled={isSaving}
                      onClick={() =>
                        void handleReviewAck(reviewEntry, reason, false)
                      }
                    >
                      確認を取り消す
                    </Button>
                  </div>
                ) : (
                  <div className="mt-3 border-t border-[#f0c78a] pt-2.5">
                    <label
                      htmlFor={`review-note-${reason.id}`}
                      className="block font-acumin lk-text-4xs text-[#707070]"
                    >
                      確認メモ（任意）
                    </label>
                    <TextAreaField
                      id={`review-note-${reason.id}`}
                      rows={2}
                      shape="rounded"
                      size="sm"
                      maxLength={500}
                      value={reviewNotes[reason.id] ?? ""}
                      onChange={(event) =>
                        setReviewNotes((current) => ({
                          ...current,
                          [reason.id]: event.target.value,
                        }))
                      }
                      placeholder="例：注文番号が別なので別々の取引"
                      className="mt-1 w-full font-acumin lk-text-3xs"
                    />
                    <Button
                      variant="primary"
                      size="2xs"
                      shape="rounded"
                      className="mt-2 font-acumin"
                      disabled={isSaving}
                      onClick={() =>
                        void handleReviewAck(reviewEntry, reason, true)
                      }
                    >
                      <i className="ri-check-line mr-1" aria-hidden="true" />
                      確認済みにする
                    </Button>
                  </div>
                )}
              </Panel>
            );
          })}

          <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
            ※
            確認済みにしても取引の内容は変わりません。内容を直す場合は一覧から訂正してください（訂正履歴に残ります）。
          </p>
        </div>
      ) : null}
    </Drawer>
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
        <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
          詳細条件
        </h4>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="詳細条件を閉じる"
          onClick={() => setIsFilterDrawerOpen(false)}
        >
          <i className="ri-close-line lk-text-2xl" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            取引年月日（範囲）
          </span>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="取引年月日（開始）"
              value={filter.dateFrom}
              onChange={(event) =>
                updateFilter({ dateFrom: event.target.value })
              }
              className={filterFieldClassName}
            />
            <span className="font-acumin lk-text-4xs text-[#707070]">〜</span>
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
            <span className="font-acumin lk-text-4xs text-[#707070]">〜</span>
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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

        <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
          ※
          電子帳簿保存法の検索要件（取引年月日・取引金額・取引先／日付と金額の範囲指定／2以上の条件の組み合わせ）に対応しています。
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[#d4d4d4] px-5 py-4">
        <span className="font-acumin lk-text-4xs text-[#707070]">
          {filterActive
            ? `${filterConditionCount}条件で絞り込み中`
            : "条件なし"}
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

  // 固定資産候補の案内。選択肢は候補クラスで変える。
  //   asset   … 資産科目で取得仕訳が既に立っている。台帳登録から逃がしてはいけないので
  //             「費用として処理」は出さず、科目の修正か台帳登録の二択にする。
  //   suspect … 費用科目のまま台帳へ入れると取得仕訳と食い違う。まず科目を直させる。
  const assetCandidateDialog = (
    <Dialog
      open={assetCandidate !== null}
      onClose={() => setAssetCandidate(null)}
      shape="square"
      size="sm"
      title={
        assetCandidate?.candidateClass === "asset"
          ? "この取引は固定資産です"
          : "10万円以上の支出です"
      }
      description={
        assetCandidate?.candidateClass === "asset"
          ? "取得仕訳は資産として計上されています。固定資産台帳へ登録しないと減価償却されません。"
          : "固定資産に該当しませんか。該当する場合は先に勘定科目を固定資産へ修正してください。"
      }
    >
      <div className="flex flex-col gap-2">
        {assetCandidate ? (
          <p className="font-acumin lk-text-3xs text-[#474747] tabular-nums">
            {assetCandidate.entry.date.replaceAll("-", "/")}
            {assetCandidate.entry.partner || "取引先なし"}
            {assetCandidate.entry.item}
            {currency(assetCandidate.entry.amount)}
          </p>
        ) : null}

        {assetCandidate?.candidateClass === "asset" ? (
          <Button
            variant="primary"
            size="sm"
            className="w-full font-acumin"
            onClick={() => {
              if (assetCandidate) startAssetFromEntry(assetCandidate.entry);
            }}
          >
            固定資産として登録
          </Button>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          className="w-full font-acumin"
          onClick={() => {
            const target = assetCandidate?.entry;
            setAssetCandidate(null);
            if (target) handleStartEdit(target);
          }}
        >
          勘定科目を修正
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="w-full font-acumin"
          onClick={() => setAssetCandidate(null)}
        >
          あとで確認
        </Button>
      </div>
    </Dialog>
  );

  // 添付の前に証憑の種類を選ぶ（FREQ-559-AC-03）。紙は原本を残してあることを確かめるまで添付しない。
  const receiptKindPicker = (scope: "drawer" | "pending") => (
    <fieldset className="space-y-2 rounded-sm border border-[#ededed] p-3">
      <legend className="px-1 font-acumin lk-text-4xs text-[#474747]">
        証憑の種類 <span className="text-red-700">*</span>
      </legend>
      {(
        [
          ["electronic", "電子で受け取った（PDF など）"],
          ["paper", "紙あり（画像は写し）"],
        ] as const
      ).map(([value, label]) => (
        <label
          key={value}
          className="flex items-center gap-2 font-acumin lk-text-4xs text-black"
        >
          <input
            type="radio"
            name={`receipt-kind-${scope}`}
            value={value}
            checked={receiptKindChoice === value}
            onChange={() => {
              setReceiptKindChoice(value);
              setReceiptPaperKept(false);
            }}
          />
          {label}
        </label>
      ))}
      {receiptKindChoice === "paper" ? (
        <label className="flex items-center gap-2 pl-5 font-acumin lk-text-4xs text-black">
          <input
            type="checkbox"
            checked={receiptPaperKept}
            onChange={(event) => setReceiptPaperKept(event.target.checked)}
          />
          紙の原本を残してある
        </label>
      ) : null}
      {receiptEvidence === null ? (
        <p className="font-acumin lk-text-5xs text-[#707070]">
          {receiptKindChoice === "paper"
            ? "紙の原本を残してあることを確かめると添付できます。"
            : "種類を選ぶと添付できます。"}
        </p>
      ) : null}
    </fieldset>
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
        <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
          証憑を追加
        </h4>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="証憑の追加を閉じる"
          onClick={() => setReceiptDrawerEntryIds([])}
        >
          <i className="ri-close-line lk-text-2xl" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377） */}
        <LiveMessage
          politeness="status"
          className={`font-acumin lk-text-3xs ${/失敗|ください/.test(receiptMessage ?? "") ? "text-red-700" : "text-[#16844b]"}`}
        >
          {receiptMessage}
        </LiveMessage>
        {receiptKindPicker("drawer")}
        {receiptDrawerEntries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-sm border border-[#ededed] p-3"
          >
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-acumin lk-text-3xs text-black">
                {entry.date.replaceAll("-", "/")} / {entry.category} /{" "}
                {entry.item}
              </span>
              <span className="shrink-0 font-acumin lk-text-3xs tabular-nums text-black">
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
                      className="truncate font-acumin lk-text-4xs text-black underline underline-offset-4"
                      aria-label={`${receipt.fileName}を開く`}
                      onClick={() => void handleOpenReceipt(receipt)}
                    >
                      <i className="ri-attachment-2 mr-1" aria-hidden="true" />
                      {receipt.fileName}
                    </button>
                    {receipt.evidenceKind === "unconfirmed" ? (
                      <span className="shrink-0 font-acumin lk-text-5xs text-[#b45309]">
                        種類を確かめてください
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="shrink-0 text-[#888888] hover:text-black"
                      aria-label={`${receipt.fileName}を削除`}
                      onClick={() => void handleDeleteReceipt(receipt)}
                      disabled={isSaving}
                    >
                      <i
                        className="ri-close-line lk-text-xs"
                        aria-hidden="true"
                      />
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
              disabled={
                receiptEvidence === null ||
                (uploadingEntryId !== null && uploadingEntryId !== entry.id)
              }
              aria-label={`${entry.item}に証憑を添付`}
              label="ドラッグ＆ドロップ／クリックで選択"
              hint="PDF・JPEG・PNG・WebP・HEIC（20MBまで）"
              onFiles={(files) => void handleAttachReceipts(entry, files)}
            />
            {entry.entryType === "income" && entry.source !== "order" ? (
              <div className="mt-3 border-t border-[#ededed] pt-3">
                {entry.evidenceUnavailable && !receiptUnavailableFormOpen ? (
                  <div className="space-y-2">
                    <p className="font-acumin lk-text-4xs font-medium text-[#474747]">
                      理由記録済み：
                      {EVIDENCE_UNAVAILABLE_REASON_OPTIONS.find(
                        (option) =>
                          option.value === entry.evidenceUnavailable?.reason,
                      )?.label ?? entry.evidenceUnavailable.reason}
                    </p>
                    {entry.evidenceUnavailable.note ? (
                      <p className="font-acumin lk-text-4xs text-[#707070]">
                        {entry.evidenceUnavailable.note}
                      </p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="2xs"
                        shape="rounded"
                        onClick={() => setReceiptUnavailableFormOpen(true)}
                      >
                        理由を変更
                      </Button>
                      <Button
                        variant="ghost"
                        size="2xs"
                        shape="rounded"
                        disabled={isSaving}
                        onClick={() =>
                          void handleDeleteEvidenceUnavailable(entry)
                        }
                      >
                        未添付に戻す
                      </Button>
                    </div>
                  </div>
                ) : receiptUnavailableFormOpen ? (
                  <div className="space-y-2">
                    <SingleSelect
                      variant="dropdown"
                      block
                      size="sm"
                      aria-label="添付できない理由"
                      placeholder="理由を選択"
                      options={EVIDENCE_UNAVAILABLE_REASON_OPTIONS}
                      value={receiptUnavailableReason}
                      onValueChange={(value) =>
                        setReceiptUnavailableReason(
                          value as EvidenceUnavailableReason | "",
                        )
                      }
                    />
                    <TextAreaField
                      aria-label="補足メモ"
                      value={receiptUnavailableNote}
                      maxLength={500}
                      shape="rounded"
                      size="sm"
                      placeholder="取得できなかった事情や保管場所を記録"
                      onChange={(event) =>
                        setReceiptUnavailableNote(event.target.value)
                      }
                    />
                    <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
                      この記録は証憑の代わりにはなりません。取得できる資料や取引内容が分かる記録は、可能な範囲で別途保存してください。
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="2xs"
                        shape="rounded"
                        disabled={
                          isSaving ||
                          !receiptUnavailableReason ||
                          (evidenceUnavailableReasonRequiresNote(
                            receiptUnavailableReason,
                          ) &&
                            !receiptUnavailableNote.trim())
                        }
                        onClick={() =>
                          void handleSaveEvidenceUnavailable(entry)
                        }
                      >
                        理由を保存
                      </Button>
                      <Button
                        variant="ghost"
                        size="2xs"
                        shape="rounded"
                        onClick={() => setReceiptUnavailableFormOpen(false)}
                      >
                        キャンセル
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="2xs"
                    shape="rounded"
                    className="w-full font-acumin"
                    onClick={() => setReceiptUnavailableFormOpen(true)}
                  >
                    証憑添付不可
                  </Button>
                )}
              </div>
            ) : null}
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
      open={
        isEntryDrawerOpen &&
        !isTemplateDiscardDialogOpen &&
        !isTemplateOverwriteDialogOpen
      }
      onClose={handleCancelEdit}
      side="right"
      size="md"
      shape="rounded"
      className="flex w-[min(92vw,460px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <div>
          <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
            {editingEntryId === null
              ? `新規${entryTypeLabel}を登録`
              : `${entryTypeLabel}を訂正（#${editingEntryId}）`}
          </h4>
          {editingEntryId !== null ? (
            <p className="mt-1 font-acumin lk-text-6xs leading-relaxed text-[#707070]">
              訂正内容は変更前後が履歴に記録されます（削除・再登録はしません）。
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="rounded"
          iconOnly
          className="h-8 w-8 shrink-0 text-[#474747]"
          aria-label="取引の入力を閉じる"
          onClick={handleCancelEdit}
        >
          <i className="ri-close-line lk-text-2xl" aria-hidden="true" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
                <Button
                  key={type}
                  variant={active ? "primary" : "outline"}
                  size="md"
                  shape="rounded"
                  aria-pressed={active}
                  onClick={() => handleEntryTypeChange(type)}
                  className="h-10 font-acumin lk-text-sm"
                >
                  {type === "income" ? "収入" : "支出"}
                </Button>
              );
            })}
          </div>
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            事業形態
          </span>
          {/* 選んだ期間の事業の形を読み取り専用で示す。変えるのは設定・期間のタブ。 */}
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="事業形態"
            className="font-acumin"
            shape="rounded"
            disabled
            options={BUSINESS_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            value={businessType}
            onValueChange={() => undefined}
          />
          <p className="mt-1 font-acumin lk-text-4xs text-[#707070]">
            選んだ期間の事業の形で使える勘定科目だけを表示します。事業の形は設定・期間のタブで変えます。
          </p>
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            テンプレート
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="テンプレート"
            className="font-acumin"
            shape="rounded"
            placeholder="（テンプレートを選択）"
            options={[
              { value: "", label: "（テンプレートを選択）" },
              ...visibleTemplates.map((template) => ({
                value: template.name,
                label: template.name,
              })),
              { value: SAVE_TEMPLATE_SENTINEL, label: "＋ 現在の入力を保存" },
            ]}
            value={
              isSavingTemplate ? SAVE_TEMPLATE_SENTINEL : selectedTemplateName
            }
            onValueChange={handleTemplateSelect}
          />
          {selectedTemplateName && !isSavingTemplate ? (
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button
                variant="primary"
                size="sm"
                shape="rounded"
                className="shrink-0 font-acumin"
                onClick={() => setIsTemplateOverwriteDialogOpen(true)}
                disabled={isSaving}
              >
                変更を上書き
              </Button>
              <Button
                variant="secondary"
                size="sm"
                shape="rounded"
                className="shrink-0 font-acumin"
                onClick={handleStartSaveTemplateAs}
                disabled={isSaving}
              >
                別名で保存
              </Button>
              <Button
                variant="secondary"
                size="sm"
                shape="rounded"
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
              <TextField
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                data-template-name-input
                shape="rounded"
                size="md"
                className={inputClassName}
                placeholder="テンプレート名"
                aria-label="テンプレート名"
              />
              <Button
                variant="primary"
                size="sm"
                shape="rounded"
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
                shape="rounded"
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            日付 <span className="text-red-700">*</span>
          </span>
          <TextField
            type="date"
            aria-label="取引日"
            shape="rounded"
            size="md"
            value={form.date}
            onChange={(event) =>
              setForm((current) => ({ ...current, date: event.target.value }))
            }
            className={inputClassName}
          />
        </label>
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            {summaryFieldLabel} <span className="text-red-700">*</span>
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label={summaryFieldLabel}
            className="font-acumin"
            shape="rounded"
            options={[
              {
                value: ADD_SUMMARY_OPTION_SENTINEL,
                label: "＋ 新しい項目を追加",
              },
              ...shiyouOptionsFor(form.entryType).map((option) => ({
                value: option,
                label: option,
              })),
              ...customSummaryOptions.map((option) => ({
                value: option.name,
                label: option.name,
                actionLabel: `${option.name}を削除`,
                onAction: () => void handleDeleteSummaryOption(option),
              })),
            ]}
            value={form.item}
            onValueChange={(value) => {
              if (value === ADD_SUMMARY_OPTION_SENTINEL) {
                setIsAddingSummaryOption(true);
                setNewSummaryOptionName("");
                return;
              }
              setForm((current) => ({ ...current, item: value }));
            }}
          />
          {isAddingSummaryOption ? (
            <div className="mt-2 flex gap-2">
              <TextField
                value={newSummaryOptionName}
                onChange={(event) =>
                  setNewSummaryOptionName(event.target.value)
                }
                aria-label={`新しい${summaryFieldLabel}`}
                placeholder={`新しい${summaryFieldLabel}`}
                shape="rounded"
                size="md"
                className={inputClassName}
                maxLength={160}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                shape="rounded"
                aria-label={`${summaryFieldLabel}を保存`}
                onClick={() => void handleSaveSummaryOption()}
                disabled={isSaving}
              >
                保存
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                shape="rounded"
                onClick={() => {
                  setIsAddingSummaryOption(false);
                  setNewSummaryOptionName("");
                }}
                disabled={isSaving}
              >
                取消
              </Button>
            </div>
          ) : null}
        </div>
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            勘定科目 <span className="text-red-700">*</span>
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="勘定科目"
            className="font-acumin"
            shape="rounded"
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            取引先
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="取引先"
            className="font-acumin"
            shape="rounded"
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
              <TextField
                value={newPartnerName}
                onChange={(event) => setNewPartnerName(event.target.value)}
                shape="rounded"
                size="md"
                className={inputClassName}
                placeholder="取引先名を入力"
                aria-label="新規取引先名"
              />
              <Button
                variant="primary"
                size="sm"
                shape="rounded"
                className="shrink-0 font-acumin"
                onClick={() => void handleAddPartner()}
                disabled={isSaving}
              >
                登録
              </Button>
              <Button
                variant="secondary"
                size="sm"
                shape="rounded"
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            金額 <span className="text-red-700">*</span>
          </span>
          <TextField
            type="number"
            min="1"
            shape="rounded"
            size="md"
            value={form.amount}
            onChange={(event) =>
              setForm((current) => ({ ...current, amount: event.target.value }))
            }
            className={inputClassName}
            placeholder="0"
          />
        </label>
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            {paymentFieldLabel}
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label={paymentFieldLabel}
            className="font-acumin"
            shape="rounded"
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
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            シーズンタグ（任意）
          </span>
          <SingleSelect
            variant="dropdown"
            block
            size="md"
            aria-label="シーズンタグ"
            className="font-acumin"
            shape="rounded"
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
          <span className="mt-1 block font-acumin lk-text-6xs text-[#707070]">
            コレクション別の採算分析にのみ使用。会計期間は日付で決まる。
          </span>
        </div>
        <label className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            メモ
          </span>
          <TextAreaField
            value={form.memo}
            shape="rounded"
            size="md"
            onChange={(event) =>
              setForm((current) => ({ ...current, memo: event.target.value }))
            }
            className={`${inputClassName} h-20 py-2`}
            placeholder="任意のメモを入力"
          />
        </label>

        {/* 証憑。新規登録では取引IDが未確定なので、保存時にまとめて送る。 */}
        <div className="block">
          <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
            証憑（電子取引データ）
          </span>
          {editingEntryId === null ? (
            <>
              {receiptKindPicker("pending")}
              <FileDropZone
                size="2xs"
                shape="rounded"
                accept={RECEIPT_ACCEPT}
                multiple
                disabled={receiptEvidence === null}
                aria-label="新規取引に証憑を添付"
                label="ドラッグ＆ドロップ／クリックで選択"
                hint="PDF・JPEG・PNG・WebP・HEIC（20MBまで）"
                onFiles={(files) => {
                  if (!receiptEvidence) return;
                  const evidence = receiptEvidence;
                  setPendingReceipts((current) => [
                    ...current,
                    ...files.map((file) => ({ file, evidence })),
                  ]);
                }}
              />
              {pendingReceipts.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {pendingReceipts.map(({ file, evidence }, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate font-acumin lk-text-4xs text-black">
                        <i
                          className="ri-attachment-2 mr-1"
                          aria-hidden="true"
                        />
                        {file.name}
                        <span className="ml-1 text-[#707070]">
                          （{evidence.evidenceKind === "paper" ? "紙あり" : "電子"}）
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="2xs"
                        shape="rounded"
                        iconOnly
                        className="shrink-0 text-[#888888] hover:text-black"
                        aria-label={`${file.name}を添付から外す`}
                        onClick={() =>
                          setPendingReceipts((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <i
                          className="ri-close-line lk-text-xs"
                          aria-hidden="true"
                        />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 font-acumin lk-text-6xs text-[#707070]">
                  保存と同時に添付します。
                </p>
              )}
              {form.entryType === "income" ? (
                <div className="mt-3 border-t border-[#ededed] pt-3">
                  {pendingUnavailableFormOpen ? (
                    <div className="space-y-2">
                      <SingleSelect
                        variant="dropdown"
                        block
                        size="sm"
                        aria-label="添付できない理由"
                        placeholder="理由を選択"
                        options={EVIDENCE_UNAVAILABLE_REASON_OPTIONS}
                        value={pendingUnavailableReason}
                        onValueChange={(value) =>
                          setPendingUnavailableReason(
                            value as EvidenceUnavailableReason | "",
                          )
                        }
                      />
                      <TextAreaField
                        aria-label="補足メモ"
                        value={pendingUnavailableNote}
                        maxLength={500}
                        shape="rounded"
                        size="sm"
                        placeholder="取得できなかった事情や保管場所を記録"
                        onChange={(event) =>
                          setPendingUnavailableNote(event.target.value)
                        }
                      />
                      <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
                        この記録は証憑の代わりにはなりません。取得できる資料や取引内容が分かる記録は、可能な範囲で別途保存してください。
                      </p>
                      <Button
                        variant="ghost"
                        size="2xs"
                        shape="rounded"
                        onClick={() => {
                          setPendingUnavailableFormOpen(false);
                          setPendingUnavailableReason("");
                          setPendingUnavailableNote("");
                        }}
                      >
                        未添付に戻す
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="2xs"
                      shape="rounded"
                      className="w-full font-acumin"
                      onClick={() => setPendingUnavailableFormOpen(true)}
                    >
                      証憑添付不可
                    </Button>
                  )}
                </div>
              ) : null}
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

        {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377） */}
        <LiveMessage
          politeness="status"
          className={`font-acumin lk-text-3xs ${/失敗|ください/.test(formMessage ?? "") ? "text-red-700" : "text-[#16844b]"}`}
        >
          {formMessage}
        </LiveMessage>
      </div>

      <div className="flex gap-2 border-t border-[#d4d4d4] px-5 py-4">
        <Button
          variant="secondary"
          size="sm"
          shape="rounded"
          className="flex-1 font-acumin"
          onClick={handleCancelEdit}
          disabled={isSaving}
        >
          {editingEntryId === null ? "取消" : "訂正を取消"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          shape="rounded"
          className="flex-1 font-acumin"
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
    </Drawer>
  );

  const templateDiscardDialog = (
    <Dialog
      open={isTemplateDiscardDialogOpen}
      onClose={continueTemplateEditing}
      title="未保存のテンプレートがあります"
      description="テンプレート名はまだ保存されていません。入力内容を破棄して取引画面を閉じますか？"
      shape="rounded"
      size="sm"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          data-template-discard-continue
          variant="secondary"
          size="sm"
          shape="rounded"
          className="font-acumin"
          onClick={continueTemplateEditing}
          disabled={isSaving}
        >
          入力を続ける
        </Button>
        <Button
          variant="primary"
          size="sm"
          shape="rounded"
          className="bg-[#b91c1c] font-acumin text-white hover:bg-[#991b1b]"
          onClick={closeEntryDrawer}
          disabled={isSaving}
        >
          破棄して閉じる
        </Button>
      </div>
    </Dialog>
  );

  const templateOverwriteDialog = (
    <Dialog
      open={isTemplateOverwriteDialogOpen}
      onClose={() => setIsTemplateOverwriteDialogOpen(false)}
      title="テンプレートの変更を上書き"
      description={`「${selectedTemplateName}」を現在の入力内容で上書きします。よろしいですか？`}
      shape="rounded"
      size="sm"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="secondary"
          size="sm"
          shape="rounded"
          className="font-acumin"
          onClick={() => setIsTemplateOverwriteDialogOpen(false)}
          disabled={isSaving}
        >
          キャンセル
        </Button>
        <Button
          variant="primary"
          size="sm"
          shape="rounded"
          className="font-acumin"
          onClick={() => void handleOverwriteTemplate()}
          disabled={isSaving}
        >
          上書きを確定
        </Button>
      </div>
    </Dialog>
  );

  return (
    <div className="space-y-5">
      {/* 見出し＋常設のキーワード検索と主要操作。詳細な条件は Drawer へ。 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-acumin lk-text-lg font-medium tracking-widest text-black">
            取引管理
          </h3>
          <span className="font-acumin lk-text-3xs text-[#707070]">
            {entryRows.length}件
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            size="2xs"
            aria-label="取引を検索"
            placeholder="取引ID・取引先・摘要で検索"
            className="w-full font-acumin sm:w-70 **:data-ui-search-field-input:rounded-md"
            value={entrySearchInput}
            showClearButton
            onClear={() => {
              setEntrySearchInput("");
              updateFilter({ keyword: "" });
              setEntryPage(1);
            }}
            onSearch={() => {
              updateFilter({ keyword: entrySearchInput });
              setEntryPage(1);
            }}
            searchButtonAriaLabel="取引を検索する"
            onChange={(event) => {
              setEntrySearchInput(event.target.value);
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

      <div role="status" className="flex flex-wrap gap-2 lk-text-3xs font-acumin">
        <span>
          {!archiveHealth?.lastArchiveAt || !archiveHealth.lastRestoreCheckAt
            ? "保存要件整備中"
            : archiveHealth.delayed
              ? "アーカイブ要確認"
              : "注文データ保存済み"}
        </span>
        {archiveHealth && !archiveHealth.externalStorageConfigured ? (
          <span className="text-[#b45309]">外部保存先 未設定</span>
        ) : null}
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
                  <span className="font-acumin lk-text-6xs text-[#707070]">
                    合計
                  </span>
                  <span className="font-acumin lk-text-3xs text-black tabular-nums">
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
                  <span className="font-acumin lk-text-6xs text-[#707070]">
                    合計
                  </span>
                  <span className="font-acumin lk-text-3xs text-black tabular-nums">
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
                {
                  label: "理由記録済み",
                  value: receiptStatusCounts.unavailable,
                  color: RECEIPT_UNAVAILABLE_COLOR,
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
                "理由記録済み",
                receiptStatusCounts.unavailable,
                RECEIPT_UNAVAILABLE_COLOR,
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
            <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
              {monthlyBalance.year}/{String(monthlyBalance.month).padStart(2, "0")}
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
                  {
                    key: "noReceipt",
                    label: `証憑未添付（${entryTabCounts.noReceipt}）`,
                  },
                  {
                    key: "review",
                    label: `要確認（${entryTabCounts.review}）`,
                  },
                  {
                    key: "revised",
                    label: `訂正あり（${entryTabCounts.revised}）`,
                  },
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
                <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
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
                tableClassName="min-w-max !table-auto [&_td]:whitespace-nowrap"
                containerClassName="font-acumin [--pad-x:calc(var(--table-font-size)/var(--phi))]"
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
                className="flex items-center gap-1.5 font-acumin lk-text-sm font-medium tracking-widest text-black"
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
            <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
              電子帳簿保存法の真実性の要件により、取引の削除は論理削除として記録し、訂正の前後を保持します。
            </p>
            {!isRevisionHistoryOpen ? null : revisions.length === 0 ? (
              <p className="mt-3 font-acumin lk-text-3xs text-[#707070]">
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
                                ? CORRECTION_HISTORY_COLOR
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
                      render: (revision: EntryRevision) =>
                        `#${revision.entryId}`,
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
                  tableClassName="min-w-180"
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
            title={
              <span className={panelTitleClassName}>確認キュー（優先順）</span>
            }
          >
            {reviewQueue.length === 0 ? (
              <p className="font-acumin lk-text-3xs text-[#707070]">
                確認が必要な取引はありません。
              </p>
            ) : (
              <ul className="space-y-2">
                {reviewQueue.map((group) => {
                  const head = group.rows[0];
                  const color =
                    group.tone === "danger"
                      ? CORRECTION_HISTORY_COLOR
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
                              className="font-acumin lk-text-3xs"
                              style={{ color }}
                            >
                              {group.label}
                            </span>
                          </span>
                          {head ? (
                            <span className="mt-1 flex items-baseline gap-2 font-acumin lk-text-4xs text-[#474747]">
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
                    <span className="font-acumin lk-text-3xs text-black">
                      {item.label}
                    </span>
                  </span>
                  <span className="font-acumin lk-text-4xs text-[#707070]">
                    {item.note}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>

      {filterDrawer}
      {reviewDrawer}
      {entryDrawer}
      {templateDiscardDialog}
      {templateOverwriteDialog}
      {receiptDrawer}
      {assetCandidateDialog}
      <Dialog
        open={deleteEntry !== null}
        onClose={closeDeleteDialog}
        title="取引を削除"
        description="この操作は一覧から取引を削除します。訂正・削除履歴には記録が残ります。"
        shape="rounded"
        size="sm"
      >
        {deleteEntry ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-acumin lk-text-3xs">
              <dt className="text-[#707070]">日付</dt>
              <dd className="tabular-nums">
                {deleteEntry.date.replaceAll("-", "/")}
              </dd>
              <dt className="text-[#707070]">種別</dt>
              <dd>{deleteEntry.entryType === "income" ? "収入" : "支出"}</dd>
              <dt className="text-[#707070]">摘要・取引先</dt>
              <dd>
                {deleteEntry.partner
                  ? `${deleteEntry.item} / ${deleteEntry.partner}`
                  : deleteEntry.item}
              </dd>
              <dt className="text-[#707070]">金額</dt>
              <dd className="tabular-nums">{currency(deleteEntry.amount)}</dd>
            </dl>
            <LiveMessage className="font-acumin lk-text-3xs text-red-700">
              {deleteDialogError}
            </LiveMessage>
            <div className="flex gap-2 border-t border-[#d4d4d4] pt-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                shape="rounded"
                className="flex-1 font-acumin"
                onClick={closeDeleteDialog}
                disabled={isSaving}
              >
                キャンセル
              </Button>
              <Button
                type="button"
                data-entry-delete-confirm="true"
                variant="primary"
                size="sm"
                shape="rounded"
                className="flex-1 bg-[#b91c1c] font-acumin text-white hover:bg-[#991b1b]"
                onClick={() => void confirmDeleteEntry()}
                disabled={isSaving}
              >
                {isSaving ? "削除中…" : "削除を確定"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
