import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button/Button";
import { DataTable } from "@/components/ui/DataTable/DataTable";
import { Graph } from "@/components/ui/Graph/Graph";
import { PageControl } from "@/components/ui/PageControl/PageControl";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import {
  LEDGER_TREND_COLOR,
  LEDGER_PAGE_SIZE_OPTIONS,
  REVISION_OPERATION_LABELS,
  currency,
  boxRadiusClassName,
  panelTitleClassName,
} from "./constants";
import { FlowOperator } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

/** 保存していない合成の仕訳（注文・Stripe）の印。計画2が保存を始めたら外す。 */
const SYNTHESIZED_ENTRY_LABEL = "集計中（計画2で保存）";

export function LedgerView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    setActiveTab,
    setAccountTreeKeyword,
    accountTreeSearchInput,
    setAccountTreeSearchInput,
    collapsedAccountGroups,
    setLedgerRowKeyword,
    ledgerRowSearchInput,
    setLedgerRowSearchInput,
    ledgerPeriod,
    setLedgerPeriod,
    ledgerSideFilter,
    setLedgerSideFilter,
    setLedgerRowPage,
    ledgerPageSize,
    setLedgerPageSize,
    setSelectedLedgerRowKey,
    syncedAt,
    setIsFilterDrawerOpen,
    trialBalance,
    cumulativeBalanceTrend,
    handleJournalExport,
    handleGeneralLedgerExport,
    selectedLedger,
    filteredAccountTree,
    toggleAccountGroup,
    ledgerClosingBalance,
    entriesById,
    synthesizedEntryNumbers,
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
    selectedTrialAmount,
    ledgerReconcileDifference,
    selectAccount,
    openEntryFromLedger,
  } = model;
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
      <span className="shrink-0 font-acumin lk-text-4xs text-[#707070]">
        {label}
      </span>
      <span className="min-w-0 text-right font-acumin lk-text-3xs text-black">
        {value}
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-acumin lk-text-lg font-medium tracking-widest text-black">
          仕訳・元帳
        </h3>
        {ledgerHeaderActions}
      </div>

      {/* 科目 → 残高推移と仕訳 → 明細。左から右へ絞り込みが進む並びにする。 */}
      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[220px_minmax(0,1fr)_307px]">
        <Panel
          radius="rounded"
          headingLevel={4}
          className="2xl:col-start-1 2xl:row-start-1"
          aria-label="勘定科目"
          title={<span className={panelTitleClassName}>勘定科目</span>}
        >
          <SearchField
            size="2xs"
            aria-label="勘定科目を検索"
            placeholder="科目を検索"
            className="w-full font-acumin **:data-ui-search-field-input:rounded-md"
            value={accountTreeSearchInput}
            showClearButton
            onClear={() => {
              setAccountTreeSearchInput("");
              setAccountTreeKeyword("");
            }}
            onSearch={() => setAccountTreeKeyword(accountTreeSearchInput)}
            searchButtonAriaLabel="勘定科目を検索する"
            onChange={(event) => setAccountTreeSearchInput(event.target.value)}
          />
          {filteredAccountTree.length === 0 ? (
            <p className="mt-3 font-acumin lk-text-3xs text-[#707070]">
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
                      <span className="min-w-0 flex-1 truncate font-acumin lk-text-3xs font-medium text-black">
                        {group.label}
                      </span>
                      <span className="shrink-0 font-acumin lk-text-3xs text-black tabular-nums">
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
                                <span className="min-w-0 flex-1 truncate font-acumin lk-text-4xs text-[#474747]">
                                  {section.section}
                                </span>
                                <span className="shrink-0 font-acumin lk-text-4xs text-[#474747] tabular-nums">
                                  {currency(section.total)}
                                </span>
                              </button>
                              {!sectionOpen
                                ? null
                                : section.accounts.map((row) => {
                                    const active =
                                      selectedLedger?.account.code ===
                                      row.account.code;
                                    return (
                                      <button
                                        key={row.account.code}
                                        type="button"
                                        aria-current={
                                          active ? "true" : undefined
                                        }
                                        className={`flex w-full items-center gap-2 rounded-sm py-1.5 pl-8 pr-1.5 text-left transition-colors ${
                                          active
                                            ? "bg-[#f0f0f0]"
                                            : "hover:bg-[#fafafa]"
                                        }`}
                                        onClick={() =>
                                          selectAccount(row.account.code)
                                        }
                                      >
                                        <span className="shrink-0 font-acumin lk-text-6xs text-[#909090] tabular-nums">
                                          {row.account.code}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate font-acumin lk-text-4xs text-black">
                                          {row.account.name}
                                        </span>
                                        <span className="shrink-0 font-acumin lk-text-4xs text-black tabular-nums">
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

        <div className="min-w-0 space-y-4 2xl:contents">
          <Panel
            radius="rounded"
            headingLevel={4}
            className="2xl:col-start-2 2xl:row-start-1"
            aria-label="月次累積収支推移"
            title={
              <span className={panelTitleClassName}>月次累積収支推移</span>
            }
          >
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_180px]">
              <div className="min-w-0">
                <Graph
                  variant="line"
                  size="2xs"
                  plotHeight={220}
                  unitLabel="（円）"
                  className="font-acumin"
                  ariaLabel={`${fiscalYear}年の月次累積収支推移`}
                  ariaDescribedBy={`cumulative-balance-trend-${fiscalYear}-table`}
                  categories={cumulativeBalanceTrend.monthly.map(
                    (point) => point.label,
                  )}
                  series={[
                    {
                      label: "累積収支",
                      color: LEDGER_TREND_COLOR,
                      values: cumulativeBalanceTrend.monthly.map(
                        (point) => point.balance,
                      ),
                    },
                  ]}
                />
                <table
                  id={`cumulative-balance-trend-${fiscalYear}-table`}
                  className="sr-only"
                >
                  <caption>月次累積収支推移の月別累積収支</caption>
                  <thead>
                    <tr>
                      <th scope="col">月</th>
                      <th scope="col">累積収支</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cumulativeBalanceTrend.monthly.map((point) => (
                      <tr key={point.key}>
                        <th scope="row">{point.label}</th>
                        <td>{currency(point.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 font-acumin lk-text-6xs text-[#707070]">
                  取引管理に入力した全収入・全支出による管理指標です。現金預金・利益・純資産・科目別元帳の残高ではありません。
                </p>
              </div>
              <dl
                className={`${boxRadiusClassName} grid grid-cols-2 gap-x-3 gap-y-3 border border-[#ededed] p-3 xl:grid-cols-1`}
              >
                {[
                  {
                    label: "期首残高",
                    value: cumulativeBalanceTrend.openingBalance,
                  },
                  {
                    label: "当年収入",
                    value: cumulativeBalanceTrend.annualIncome,
                  },
                  {
                    label: "当年支出",
                    value: cumulativeBalanceTrend.annualExpense,
                  },
                  {
                    label: "当年末残高",
                    value: cumulativeBalanceTrend.closingBalance,
                  },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dt className="font-acumin lk-text-4xs text-[#707070]">
                      {label}
                    </dt>
                    <dd className="mt-1 font-acumin lk-text-lg font-medium text-black tabular-nums">
                      {currency(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Panel>

          <Panel
            radius="rounded"
            headingLevel={4}
            size="2xs"
            className="2xl:col-span-2 2xl:col-start-1 2xl:row-start-2"
            aria-label="仕訳一覧"
            title={<span className={panelTitleClassName}>仕訳一覧</span>}
          >
            <div className="flex flex-wrap items-center gap-2">
              <SearchField
                size="2xs"
                aria-label="仕訳を検索"
                placeholder="摘要・取引先・伝票No.で検索"
                className="w-full font-acumin sm:w-50 **:data-ui-search-field-input:rounded-md"
                value={ledgerRowSearchInput}
                showClearButton
                onClear={() => {
                  setLedgerRowSearchInput("");
                  setLedgerRowKeyword("");
                  setLedgerRowPage(1);
                }}
                onSearch={() => {
                  setLedgerRowKeyword(ledgerRowSearchInput);
                  setLedgerRowPage(1);
                }}
                searchButtonAriaLabel="仕訳を検索する"
                onChange={(event) => {
                  setLedgerRowSearchInput(event.target.value);
                }}
              />
              <SingleSelect
                variant="dropdown"
                size="2xs"
                shape="rounded"
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
                shape="rounded"
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

            <p className="mt-3 font-acumin lk-text-6xs text-[#707070]">
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
                tableClassName="min-w-155"
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
                    render: (row) => (
                      <>
                        {row.number}
                        {synthesizedEntryNumbers.has(row.number) ? (
                          <span className="ml-1.5 font-acumin lk-text-6xs text-[#707070]">
                            {SYNTHESIZED_ENTRY_LABEL}
                          </span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: "counter",
                    header: "相手勘定科目",
                    render: (row) => (
                      <span className="block max-w-16 truncate">
                        {row.counterAccount}
                      </span>
                    ),
                  },
                  {
                    key: "partner",
                    header: "取引先",
                    render: (row) => (
                      <span className="block max-w-16 truncate">
                        {row.partner || "—"}
                      </span>
                    ),
                  },
                  {
                    key: "description",
                    header: "摘要",
                    render: (row) => (
                      <span className="block max-w-19 truncate">
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
                <span className="font-acumin lk-text-4xs text-[#707070]">
                  表示件数
                </span>
                <SingleSelect
                  variant="dropdown"
                  size="3xs"
                  shape="rounded"
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
              <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
                {ledgerRangeStart}-{ledgerRangeEnd} /{" "}
                {filteredLedgerRows.length}件
              </span>
            </div>
          </Panel>
        </div>

        <Panel
          radius="rounded"
          headingLevel={4}
          className="h-fit 2xl:col-start-3 2xl:row-span-2 2xl:row-start-1 2xl:h-full"
          aria-label="仕訳詳細"
          title={<span className={panelTitleClassName}>仕訳詳細</span>}
        >
          {!selectedLedgerRow ? (
            <p className="font-acumin lk-text-3xs text-[#707070]">
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
                {ledgerDetailRow(
                  "伝票No.",
                  synthesizedEntryNumbers.has(selectedLedgerRow.number)
                    ? `${selectedLedgerRow.number}（${SYNTHESIZED_ENTRY_LABEL}）`
                    : selectedLedgerRow.number,
                )}
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

              <p className="font-acumin lk-text-4xs leading-relaxed text-[#707070]">
                一覧は選択中の勘定科目の元帳行、以下は伝票全体の仕訳です。
              </p>

              <div className="grid grid-cols-2 gap-3 border-t border-[#ededed] pt-3">
                {(["debit", "credit"] as const).map((side) => {
                  const lines = (selectedJournalEntry?.lines ?? []).filter(
                    (line) => (side === "debit" ? line.debit : line.credit) > 0,
                  );
                  return (
                    <div key={side} className="min-w-0">
                      <p className="font-acumin lk-text-4xs font-medium text-black">
                        {side === "debit" ? "借方" : "貸方"}
                      </p>
                      {lines.length === 0 ? (
                        <p className="mt-1 font-acumin lk-text-4xs text-[#909090]">
                          —
                        </p>
                      ) : (
                        lines.map((line) => (
                          <div
                            key={`${side}-${line.account.code}`}
                            className="mt-1"
                          >
                            <p className="font-acumin lk-text-4xs text-[#707070]">
                              科目
                              <span className="ml-2 text-black">
                                {line.account.name}
                              </span>
                            </p>
                            <p className="font-acumin lk-text-4xs text-[#707070]">
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
                <p className="font-acumin lk-text-4xs font-medium text-black">
                  関連仕訳
                </p>
                {relatedJournalEntries.length === 0 ? (
                  <p className="mt-1 font-acumin lk-text-4xs text-[#909090]">
                    同日・同取引先の別仕訳はありません。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {relatedJournalEntries.map((entry) => (
                      <li key={entry.number}>
                        <span className="font-acumin lk-text-4xs text-black underline">
                          {entry.number}
                        </span>
                        <span className="ml-1 whitespace-nowrap font-acumin lk-text-4xs text-[#707070]">
                          （{entry.description}）
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="border-t border-[#ededed] pt-3">
                <p className="font-acumin lk-text-4xs font-medium text-black">
                  更新履歴
                </p>
                {selectedLedgerRevisions.length === 0 ? (
                  <p className="mt-1 font-acumin lk-text-4xs text-[#909090]">
                    訂正・削除の履歴はありません。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {selectedLedgerRevisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="font-acumin lk-text-4xs text-[#474747] tabular-nums">
                          {new Date(revision.changedAt).toLocaleString("ja-JP")}
                        </span>
                        <span className="font-acumin lk-text-4xs text-black">
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
          <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
            {syncedAt
              ? `最終更新：${new Date(syncedAt).toLocaleString("ja-JP")}（自動照合）`
              : "（自動照合）"}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <p className="font-acumin lk-text-4xs text-[#707070]">
              元帳残高（最終残高）
            </p>
            <p className="flex items-center gap-2 font-acumin lk-text-4xl font-medium text-[#16844b] tabular-nums">
              {currency(ledgerClosingBalance)}
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
            </p>
          </div>
          <FlowOperator symbol="=" />
          <div>
            <p className="font-acumin lk-text-4xs text-[#707070]">
              試算表残高
              {selectedLedger ? `（${selectedLedger.account.name}）` : ""}
            </p>
            <p className="flex items-center gap-2 font-acumin lk-text-4xl font-medium text-[#16844b] tabular-nums">
              {currency(selectedTrialAmount)}
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
            </p>
          </div>
          <div className="border-l border-[#ededed] pl-8">
            <p className="font-acumin lk-text-4xs text-[#707070]">差額</p>
            <p
              className={`font-acumin lk-text-4xl font-medium tabular-nums ${
                ledgerReconcileDifference === 0 ? "text-black" : "text-red-700"
              }`}
            >
              {currency(ledgerReconcileDifference)}
            </p>
          </div>
          <p
            className={`ml-auto flex items-center gap-2 font-acumin lk-text-lg font-medium tracking-widest ${
              trialBalance.isBalanced && ledgerReconcileDifference === 0
                ? "text-[#16844b]"
                : "text-red-700"
            }`}
            role="status"
          >
            <i
              className={
                trialBalance.isBalanced && ledgerReconcileDifference === 0
                  ? "ri-checkbox-circle-line lk-text-4xl"
                  : "ri-error-warning-line lk-text-4xl"
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
}
