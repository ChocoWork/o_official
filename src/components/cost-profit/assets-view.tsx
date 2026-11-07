import { Button } from "@/components/ui/Button/Button";
import { DataTable } from "@/components/ui/DataTable/DataTable";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { Graph } from "@/components/ui/Graph/Graph";
import { PageControl } from "@/components/ui/PageControl/PageControl";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import {
  DEPRECIATION_METHOD_LABELS,
  straightLineRate,
  type DepreciationMethod,
} from "@/lib/finance/depreciation";
import {
  classifyAssetCandidate,
  FIXED_ASSET_LINK_STATUS_LABELS,
  fixedAssetCode,
} from "@/lib/finance/fixed-asset-link";
import {
  DEPRECIATION_LINE_COLOR,
  DEPRECIATION_BAR_COLOR,
  DEPRECIATION_PAST_YEARS,
  FIXED_ASSET_LINK_STATUS_TONES,
  currency,
  inputClassName,
  panelTitleClassName,
} from "./constants";
import { MetricCard, EmptyIcon } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

export function AssetsView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    setActiveTab,
    assetSectionFilter,
    setAssetSectionFilter,
    assetMethodFilter,
    setAssetMethodFilter,
    setAssetKeyword,
    assetSearchInput,
    setAssetSearchInput,
    isAssetFilterOpen,
    setIsAssetFilterOpen,
    setAssetPage,
    isSaving,
    assetForm,
    setAssetForm,
    assetMessage,
    setAssetExclusionEntryId,
    assetExclusionReason,
    setAssetExclusionReason,
    assetReviewDecision,
    setAssetReviewDecision,
    setAssetDetailId,
    pendingAssetEntryRows,
    excludedAssetEntryRows,
    selectedAssetCandidate,
    assetLinkStatuses,
    handleStartEdit,
    assetDetail,
    applyAssetEntry,
    handleDismissAssetCandidate,
    handleSaveFixedAsset,
    handleDeleteFixedAsset,
    handleOpenReceipt,
    handleFixedAssetExport,
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
  } = model;
  const assetChainArrow = (
    <div className="pl-3 font-acumin lk-text-sm text-[#707070]" aria-hidden="true">
      ↓
    </div>
  );

  const assetDetailDrawer = (
    <Drawer
      open={assetDetail !== null}
      onClose={() => setAssetDetailId(null)}
      side="right"
      size="md"
      shape="square"
      className="flex w-[min(92vw,460px)] flex-col bg-white"
    >
      <div className="flex items-center justify-between border-b border-[#d4d4d4] px-5 py-4">
        <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
          固定資産の詳細
        </h4>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-[#474747] hover:bg-[#f0f0f0] hover:text-black"
          aria-label="固定資産の詳細を閉じる"
          onClick={() => setAssetDetailId(null)}
        >
          <i className="ri-close-line lk-text-2xl" aria-hidden="true" />
        </button>
      </div>

      {assetDetail ? (
        <section
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-5 py-4"
          aria-label="固定資産の来歴"
        >
          <section className="border border-[#d4d4d4] p-3">
            <h5 className="font-acumin lk-text-4xs tracking-widest text-[#474747]">
              購入取引
            </h5>
            {assetDetail.entry ? (
              <>
                <p className="mt-1 font-acumin lk-text-3xs text-black tabular-nums">
                  {assetDetail.entry.date.replaceAll("-", "/")}
                  {assetDetail.entry.partner || "取引先なし"}
                  {currency(assetDetail.entry.amount)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="3xs"
                    shape="rounded"
                    className="font-acumin"
                    onClick={() => {
                      const target = assetDetail.entry;
                      if (!target) return;
                      setAssetDetailId(null);
                      handleStartEdit(target);
                    }}
                  >
                    取引を訂正
                  </Button>
                  {assetDetail.entry.receipts?.length ? (
                    <Button
                      variant="outline"
                      size="3xs"
                      shape="rounded"
                      className="font-acumin"
                      onClick={() => {
                        const receipt = assetDetail.entry?.receipts?.[0];
                        if (receipt) void handleOpenReceipt(receipt);
                      }}
                    >
                      証憑を開く
                    </Button>
                  ) : (
                    <span className="font-acumin lk-text-4xs text-[#b45309]">
                      証憑が添付されていません
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-1 font-acumin lk-text-3xs text-[#707070]">
                {assetDetail.asset.entryId === null
                  ? "購入取引なし（直接登録）"
                  : "連携先の取引が見つかりません（削除された可能性があります）"}
              </p>
            )}
          </section>

          {assetChainArrow}

          <section className="border border-[#d4d4d4] p-3">
            <h5 className="font-acumin lk-text-4xs tracking-widest text-[#474747]">
              固定資産
            </h5>
            <p className="mt-1 font-acumin lk-text-3xs text-black">
              {fixedAssetCode(assetDetail.asset)}　{assetDetail.asset.name}
            </p>
            <p className="mt-1 font-acumin lk-text-4xs text-[#474747]">
              {DEPRECIATION_METHOD_LABELS[assetDetail.asset.method]}
              {assetDetail.asset.method === "straightLine"
                ? `　耐用年数${assetDetail.asset.usefulLife}年`
                : ""}
              　事業専用割合{assetDetail.asset.businessUseRatio}%
            </p>
            {assetDetail.asset.serviceStartedOn ? (
              <p className="mt-1 font-acumin lk-text-4xs text-[#474747] tabular-nums">
                使用開始日{" "}
                {assetDetail.asset.serviceStartedOn.replaceAll("-", "/")}
              </p>
            ) : null}
          </section>

          {assetChainArrow}

          <section className="border border-[#d4d4d4] p-3">
            <h5 className="font-acumin lk-text-4xs tracking-widest text-[#474747]">
              取得仕訳
            </h5>
            {assetDetail.acquisitionEntry ? (
              <div className="mt-1 space-y-1">
                {assetDetail.acquisitionEntry.lines.map((line, index) => (
                  <p
                    key={`${line.account.code}-${index}`}
                    className="font-acumin lk-text-3xs text-black tabular-nums"
                  >
                    {line.account.name}
                    {line.debit > 0
                      ? `${currency(line.debit)} / —`
                      : `— / ${currency(line.credit)}`}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-1 font-acumin lk-text-3xs text-[#b91c1c]">
                取得仕訳がありません。取引管理へ購入取引を登録してください。
              </p>
            )}
          </section>

          {assetChainArrow}

          <section className="border border-[#d4d4d4] p-3">
            <h5 className="font-acumin lk-text-4xs tracking-widest text-[#474747]">
              減価償却仕訳（{fiscalYear}年度）
            </h5>
            {assetDetail.depreciationEntry ? (
              <div className="mt-1 space-y-1">
                {assetDetail.depreciationEntry.lines.map((line, index) => (
                  <p
                    key={`${line.account.code}-${index}`}
                    className="font-acumin lk-text-3xs text-black tabular-nums"
                  >
                    {line.account.name}
                    {line.debit > 0
                      ? `${currency(line.debit)} / —`
                      : `— / ${currency(line.credit)}`}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-1 font-acumin lk-text-3xs text-[#707070]">
                当年度の償却はありません（償却済み・供用前・除却済みのいずれか）。
              </p>
            )}
            {assetDetail.row ? (
              <p className="mt-2 font-acumin lk-text-4xs text-[#474747] tabular-nums">
                期末簿価 {currency(assetDetail.row.closingBookValue)}　累計{" "}
                {currency(assetDetail.row.accumulated)}
              </p>
            ) : null}
          </section>
        </section>
      ) : null}
    </Drawer>
  );

  return (
    <div className="space-y-4 pt-3">
      {assetDetailDrawer}
      <div>
        <h3 className="font-acumin lk-text-lg font-medium tracking-widest text-black">
          固定資産
        </h3>
        <div className="mt-3 grid w-full max-w-197.5 grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            label="当期償却"
            value={currency(assetTotals.depreciation)}
            compact
          />
          <MetricCard
            label="来期予測"
            value={currency(
              depreciationYearTotals[DEPRECIATION_PAST_YEARS + 1] ?? 0,
            )}
            compact
          />
          <MetricCard
            label="必要経費算入額"
            value={currency(assetTotals.businessExpense)}
            compact
          />
          <MetricCard
            label="登録待ち"
            value={`${pendingAssetEntryRows.length}件`}
            compact
          />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-2.5 2xl:grid-cols-[minmax(360px,0.88fr)_minmax(520px,1.28fr)_minmax(500px,1.24fr)] 2xl:items-stretch">
        <Panel
          radius="rounded"
          headingLevel={4}
          className="h-full"
          aria-label="資産一覧"
          title={<span className={panelTitleClassName}>資産一覧</span>}
        >
          <div className="flex items-center gap-2">
            <SearchField
              size="2xs"
              aria-label="資産を検索"
              placeholder="資産名・管理番号で検索"
              className="min-w-0 flex-1 font-acumin **:data-ui-search-field-input:rounded-md"
              value={assetSearchInput}
              showClearButton
              onClear={() => {
                setAssetSearchInput("");
                setAssetKeyword("");
                setAssetPage(1);
              }}
              onSearch={() => {
                setAssetKeyword(assetSearchInput);
                setAssetPage(1);
              }}
              searchButtonAriaLabel="資産を検索する"
              onChange={(event) => {
                setAssetSearchInput(event.target.value);
              }}
            />
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              className="shrink-0 font-acumin"
              aria-expanded={isAssetFilterOpen}
              aria-controls="asset-filter-panel"
              onClick={() => setIsAssetFilterOpen((open) => !open)}
            >
              絞り込み
              <i className="ri-filter-3-line ml-1" aria-hidden="true" />
            </Button>
          </div>
          {isAssetFilterOpen ? (
            <div
              id="asset-filter-panel"
              className="mt-2 border border-[#e3e3e3] bg-[#fafafa] p-2"
            >
              <SingleSelect
                size="2xs"
                aria-label="資産カテゴリで絞り込み"
                options={assetSectionOptions}
                value={assetSectionFilter}
                className="w-full font-acumin"
                onChange={(event) => {
                  setAssetSectionFilter(event.target.value);
                  setAssetPage(1);
                }}
              />
            </div>
          ) : null}
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
                  render: (row) => (
                    <button
                      type="button"
                      className="text-left hover:underline"
                      aria-label={`${row.asset.name}の詳細`}
                      onClick={() => setAssetDetailId(row.asset.id)}
                    >
                      <span className="block text-black">{row.asset.name}</span>
                      <span className="block lk-text-6xs text-[#707070] tabular-nums">
                        {fixedAssetCode(row.asset)}
                      </span>
                    </button>
                  ),
                },
                {
                  key: "linkStatus",
                  header: "状態",
                  cellClassName: "whitespace-nowrap",
                  render: (row) => {
                    const status =
                      assetLinkStatuses.get(row.asset.id) ?? "direct";
                    return (
                      <StatusBadge
                        variant="text"
                        shape="pill"
                        size="3xs"
                        tone={FIXED_ASSET_LINK_STATUS_TONES[status]}
                        accent
                        className="font-acumin"
                      >
                        {FIXED_ASSET_LINK_STATUS_LABELS[status]}
                      </StatusBadge>
                    );
                  },
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
            <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
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
              <p className="font-acumin lk-text-3xs text-[#707070]">
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

          <Panel
            radius="rounded"
            headingLevel={4}
            aria-label="固定資産台帳（主要資産）"
            title={
              <span className={panelTitleClassName}>
                固定資産台帳（主要資産）
              </span>
            }
          >
            <DataTable
              size="2xs"
              shape="rounded"
              rows={filteredDepreciationRows.slice(0, 5)}
              rowKey={(row) => String(row.asset.id)}
              emptyLabel="固定資産がまだありません。"
              containerClassName="font-acumin"
              columns={[
                {
                  key: "asset",
                  header: "資産名",
                  cellClassName: "whitespace-nowrap",
                  render: (row) => row.asset.name,
                },
                {
                  key: "acquiredOn",
                  header: "取得日",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => row.asset.acquiredOn,
                },
                {
                  key: "cost",
                  header: "取得価額",
                  align: "right",
                  cellClassName: "whitespace-nowrap tabular-nums",
                  render: (row) => currency(row.asset.acquisitionCost),
                },
                {
                  key: "method",
                  header: "償却方法",
                  cellClassName: "whitespace-nowrap",
                  render: (row) =>
                    row.asset.method === "straightLine" ? "定額法" : "即時償却",
                },
                {
                  key: "life",
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
              ]}
            />
          </Panel>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-acumin lk-text-4xs text-[#474747]">
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
          className="h-full self-stretch 2xl:-translate-y-39.5 **:data-ui-button:rounded-md! [&_.single-select__trigger]:rounded-md! [&_input]:rounded-md [&_input[type=radio]]:rounded-full! [&_textarea]:rounded-md"
          aria-label="固定資産登録"
          title={<span className={panelTitleClassName}>固定資産登録</span>}
        >
          <div className="space-y-2.5">
            <ol
              className="grid grid-cols-4 border-b border-[#d4d4d4] pb-3"
              aria-label="固定資産登録の進行状況"
            >
              {[
                ["1", "候補選択"],
                ["2", "判定"],
                ["3", "情報補完"],
                ["4", "登録"],
              ].map(([number, label], index) => {
                const activeStep =
                  selectedAssetCandidate === null
                    ? 0
                    : assetReviewDecision === null
                      ? 1
                      : assetReviewDecision === "exclude"
                        ? 2
                        : 3;
                const isActive = index <= activeStep;
                return (
                  <li key={number} className="flex min-w-0 items-center gap-1">
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-acumin lk-text-4xs ${isActive ? "border-black bg-black text-white" : "border-[#d4d4d4] bg-white text-[#707070]"}`}
                      aria-hidden="true"
                    >
                      {number}
                    </span>
                    <span
                      className={`truncate font-acumin lk-text-6xs ${isActive ? "text-black" : "text-[#707070]"}`}
                    >
                      {label}
                    </span>
                  </li>
                );
              })}
            </ol>

            <section aria-labelledby="asset-candidate-heading">
              <h5
                id="asset-candidate-heading"
                className="flex items-center gap-2 font-acumin lk-text-3xs font-medium text-black"
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-black lk-text-6xs text-white"
                  aria-hidden="true"
                >
                  1
                </span>
                固定資産の候補
              </h5>
              <p className="mt-1 font-acumin lk-text-4xs text-[#707070]">
                取引管理の登録内容から候補を表示しています。登録する取引を選ぶか、対象外の理由を記録してください。
              </p>
              {pendingAssetEntryRows.length === 0 ? (
                <p className="mt-2 font-acumin lk-text-3xs text-[#707070]">
                  未確認の候補はありません。
                </p>
              ) : (
                <ul
                  className="mt-2 max-h-72 space-y-2 overflow-y-auto"
                  aria-label="固定資産候補一覧"
                >
                  {pendingAssetEntryRows.map((entry) => {
                    const candidateClass = classifyAssetCandidate(entry);
                    const isSelected = assetForm.entryId === entry.id;
                    return (
                      <li
                        key={entry.id}
                        className={`border p-2.5 ${isSelected ? "border-[#2f6fdb] bg-[#f7faff]" : "border-[#d4d4d4] bg-white"}`}
                      >
                        <label className="flex min-h-11 cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="fixed-asset-candidate"
                            className="mt-0.5 h-4 w-4 accent-black"
                            checked={isSelected}
                            onChange={() => {
                              applyAssetEntry(entry.id);
                              setAssetReviewDecision(null);
                              setAssetExclusionEntryId(null);
                              setAssetExclusionReason("");
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate font-acumin lk-text-3xs font-medium text-black">
                                {entry.item}
                              </span>
                              <StatusBadge
                                variant="text"
                                shape="pill"
                                size="3xs"
                                tone={
                                  candidateClass === "asset"
                                    ? "neutral"
                                    : "warning"
                                }
                                accent
                                className="shrink-0 font-acumin"
                              >
                                {candidateClass === "asset"
                                  ? "資産科目"
                                  : "科目要確認"}
                              </StatusBadge>
                            </span>
                            <span className="mt-1 block font-acumin lk-text-6xs text-[#474747] tabular-nums">
                              {entry.date.replaceAll("-", "/")}　
                              {entry.category}　{currency(entry.amount)}
                            </span>
                            <span className="mt-0.5 block truncate font-acumin lk-text-6xs text-[#707070]">
                              {entry.partner || "取引先なし"}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section
              aria-labelledby="asset-decision-heading"
              className="border-t border-[#d4d4d4] pt-2.5"
            >
              <h5
                id="asset-decision-heading"
                className="flex items-center gap-2 font-acumin lk-text-3xs font-medium text-black"
              >
                <span
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-black lk-text-6xs text-white"
                  aria-hidden="true"
                >
                  2
                </span>
                判定
              </h5>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant={
                    assetReviewDecision === "asset" ? "primary" : "outline"
                  }
                  size="sm"
                  disabled={selectedAssetCandidate === null}
                  selected={assetReviewDecision === "asset"}
                  onClick={() => {
                    setAssetReviewDecision("asset");
                    setAssetExclusionEntryId(null);
                    setAssetExclusionReason("");
                  }}
                >
                  固定資産にする
                </Button>
                <Button
                  variant={
                    assetReviewDecision === "exclude" ? "primary" : "outline"
                  }
                  size="sm"
                  disabled={selectedAssetCandidate === null}
                  selected={assetReviewDecision === "exclude"}
                  onClick={() => {
                    setAssetReviewDecision("exclude");
                    setAssetExclusionEntryId(
                      selectedAssetCandidate?.id ?? null,
                    );
                    setAssetExclusionReason("");
                  }}
                >
                  固定資産にしない
                </Button>
              </div>
              {selectedAssetCandidate === null ? (
                <p className="mt-1 font-acumin lk-text-6xs text-[#707070]">
                  先に候補を1件選択してください。
                </p>
              ) : null}
            </section>

            {assetReviewDecision === "exclude" && selectedAssetCandidate ? (
              <section
                aria-labelledby="asset-exclusion-heading"
                className="border-t border-[#d4d4d4] pt-2.5"
              >
                <h5
                  id="asset-exclusion-heading"
                  className="flex items-center gap-2 font-acumin lk-text-3xs font-medium text-black"
                >
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-black lk-text-6xs text-white"
                    aria-hidden="true"
                  >
                    3
                  </span>
                  対象外の理由
                </h5>
                <label className="mt-2 block">
                  <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                    理由 <span className="text-red-700">*</span>
                  </span>
                  <textarea
                    value={assetExclusionReason}
                    maxLength={500}
                    rows={4}
                    required
                    aria-required="true"
                    onChange={(event) =>
                      setAssetExclusionReason(event.target.value)
                    }
                    className={inputClassName}
                    placeholder="例：修繕費として処理する取引のため"
                  />
                  <span className="mt-1 block text-right font-acumin lk-text-6xs text-[#707070] tabular-nums">
                    {assetExclusionReason.length}/500
                  </span>
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-2 w-full font-acumin"
                  disabled={isSaving || !assetExclusionReason.trim()}
                  onClick={() =>
                    void handleDismissAssetCandidate(
                      selectedAssetCandidate,
                      assetExclusionReason,
                    )
                  }
                >
                  理由を保存して対象外にする
                </Button>
              </section>
            ) : null}

            {excludedAssetEntryRows.length > 0 ? (
              <details className="border border-[#d4d4d4] p-2.5">
                <summary className="cursor-pointer font-acumin lk-text-3xs text-black">
                  対象外の取引（{excludedAssetEntryRows.length}件）
                </summary>
                <ul
                  className="mt-2 space-y-2"
                  aria-label="固定資産の対象外一覧"
                >
                  {excludedAssetEntryRows.map((entry) => (
                    <li
                      key={entry.id}
                      className="border-t border-[#e5e5e5] pt-2"
                    >
                      <p className="font-acumin lk-text-3xs text-black">
                        {entry.item}　{currency(entry.amount)}
                      </p>
                      <p className="mt-1 font-acumin lk-text-4xs text-[#474747]">
                        理由：{entry.fixedAssetExemptReason}
                      </p>
                      {entry.fixedAssetReviewedAt ? (
                        <p className="mt-1 font-acumin lk-text-4xs text-[#707070] tabular-nums">
                          判定日時：
                          {new Date(entry.fixedAssetReviewedAt).toLocaleString(
                            "ja-JP",
                          )}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {assetReviewDecision === "asset" && selectedAssetCandidate ? (
              <>
                <section
                  aria-labelledby="asset-details-heading"
                  className="border-t border-[#d4d4d4] pt-2.5"
                >
                  <h5
                    id="asset-details-heading"
                    className="mb-2 flex items-center gap-2 font-acumin lk-text-3xs font-medium text-black"
                  >
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-black lk-text-6xs text-white"
                      aria-hidden="true"
                    >
                      3
                    </span>
                    不足情報を入力
                  </h5>
                  <p className="mb-2 font-acumin lk-text-6xs text-[#707070]">
                    取引管理で入力済みの項目は読み取り専用です。
                  </p>
                  {classifyAssetCandidate(selectedAssetCandidate) ===
                  "suspect" ? (
                    <div className="mb-2 border border-[#d99a2b] bg-[#fffaf0] p-2.5">
                      <p className="font-acumin lk-text-4xs text-[#6f4b00]">
                        勘定科目が固定資産科目ではありません。先に取引管理で科目を訂正してください。
                      </p>
                      <Button
                        variant="outline"
                        size="xs"
                        className="mt-2"
                        onClick={() => {
                          setActiveTab("expenses");
                          handleStartEdit(selectedAssetCandidate);
                        }}
                      >
                        取引管理で訂正
                      </Button>
                    </div>
                  ) : null}
                  <div className="block">
                    <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                      資産名 <span className="text-red-700">*</span>
                    </span>
                    <p className="border border-[#d4d4d4] bg-[#fafafa] p-2 font-acumin lk-text-3xs text-black">
                      {assetForm.name || "候補を選択してください"}
                    </p>
                  </div>

                  <div className="block">
                    <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                      勘定科目 <span className="text-red-700">*</span>
                    </span>
                    <p className="border border-[#d4d4d4] bg-[#fafafa] p-2 font-acumin lk-text-3xs text-black">
                      {assetForm.account || "候補を選択してください"}
                    </p>
                  </div>

                  {isAssetLinked ? (
                    // 連携中は取引が単一の情報源。ここで直せると食い違いが生まれるので読ませるだけにする。
                    <div className="border border-[#d4d4d4] bg-[#fafafa] p-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-acumin lk-text-4xs text-[#474747]">
                          取得金額
                        </span>
                        <span
                          className="font-acumin lk-text-sm font-medium text-black tabular-nums"
                          data-testid="asset-acquisition-cost-readonly"
                        >
                          {currency(Number(assetForm.acquisitionCost) || 0)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-baseline justify-between gap-2">
                        <span className="font-acumin lk-text-4xs text-[#474747]">
                          取得日
                        </span>
                        <span className="font-acumin lk-text-3xs text-black tabular-nums">
                          {assetForm.acquiredOn.replaceAll("-", "/")}
                        </span>
                      </div>
                      <p className="mt-2 font-acumin lk-text-4xs text-[#707070]">
                        取得金額・取得日は取引管理で訂正できます。
                      </p>
                    </div>
                  ) : null}

                  <div className="space-y-2.5">
                    <label className="block">
                      <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                        使用開始日（任意・未入力なら取得日）
                      </span>
                      <input
                        type="date"
                        value={assetForm.serviceStartedOn}
                        min={assetForm.acquiredOn || undefined}
                        onChange={(event) =>
                          setAssetForm((current) => ({
                            ...current,
                            serviceStartedOn: event.target.value,
                          }))
                        }
                        className={inputClassName}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
                    <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                      償却方法
                    </span>
                    <SingleSelect
                      variant="dropdown"
                      block
                      size="sm"
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

                  <div className="grid grid-cols-2 gap-2">
                    {assetForm.method === "straightLine" ? (
                      <label className="block">
                        <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                          耐用年数（率{" "}
                          {straightLineRate(
                            Number(assetForm.usefulLife) || 1,
                          ).toFixed(3)}
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
                      <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
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
                </section>

                <section
                  aria-labelledby="asset-depreciation-heading"
                  className="border-t border-[#d4d4d4] pt-2.5"
                >
                  <h5
                    id="asset-depreciation-heading"
                    className="mb-2 flex items-center gap-2 font-acumin lk-text-3xs font-medium text-black"
                  >
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-black lk-text-6xs text-white"
                      aria-hidden="true"
                    >
                      4
                    </span>
                    償却シミュレーション
                  </h5>
                  <div className="grid grid-cols-3 gap-2 border border-[#d4d4d4] p-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-acumin lk-text-6xs text-[#474747]">
                        年間償却額
                      </span>
                      <span className="font-acumin lk-text-3xs text-black tabular-nums">
                        {currency(assetSimulation.annual)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-l border-[#d4d4d4] pl-2">
                      <span className="font-acumin lk-text-6xs text-[#474747]">
                        当期影響額
                      </span>
                      <span className="font-acumin lk-text-3xs text-black tabular-nums">
                        {currency(assetSimulation.currentYear)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 border-l border-[#d4d4d4] pl-2">
                      <span className="font-acumin lk-text-6xs text-[#474747]">
                        期末残高
                      </span>
                      <span className="font-acumin lk-text-3xs text-black tabular-nums">
                        {currency(
                          Math.max(
                            0,
                            Number(assetForm.acquisitionCost) -
                              assetSimulation.currentYear,
                          ),
                        )}
                      </span>
                    </div>
                  </div>
                </section>

                {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377） */}
                <LiveMessage
                  politeness="status"
                  className={`font-acumin lk-text-3xs ${/失敗|ください/.test(assetMessage ?? "") ? "text-red-700" : "text-[#16844b]"}`}
                >
                  {assetMessage}
                </LiveMessage>

                <Button
                  variant="primary"
                  size="sm"
                  className="w-full font-acumin"
                  onClick={() => void handleSaveFixedAsset()}
                  disabled={
                    isSaving ||
                    classifyAssetCandidate(selectedAssetCandidate) !== "asset"
                  }
                >
                  {isSaving ? "保存中..." : "固定資産として登録"}
                </Button>
              </>
            ) : null}
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
          <p className="font-acumin lk-text-3xs text-[#707070]">
            固定資産を登録すると、年度別の償却予定が自動計算されます。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-380 border-collapse">
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
                      className="px-2 py-2 text-left font-acumin lk-text-4xs font-normal text-[#474747]"
                    >
                      {heading}
                    </th>
                  ))}
                  {depreciationYears.map(({ year, isForecast }) => (
                    <th
                      key={year}
                      className={`px-2 py-2 text-right font-acumin lk-text-4xs font-normal ${
                        isForecast
                          ? "bg-[#f4f8fe] text-[#2f6fdb]"
                          : "text-[#474747]"
                      }`}
                    >
                      {year}年度
                      <br />（{isForecast ? "予測" : "実績"}）
                    </th>
                  ))}
                  <th className="px-2 py-2 text-left font-acumin lk-text-4xs font-normal text-[#474747]">
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
                    <td className="px-2 py-2.5 font-acumin lk-text-3xs text-black">
                      {plan.row.asset.name}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin lk-text-4xs text-[#474747] tabular-nums">
                      #{plan.row.asset.id}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin lk-text-3xs text-black tabular-nums">
                      {plan.row.asset.acquiredOn.replaceAll("-", "/")}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-black tabular-nums">
                      {currency(plan.row.asset.acquisitionCost)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin lk-text-4xs text-[#474747]">
                      {DEPRECIATION_METHOD_LABELS[plan.row.asset.method]}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {plan.row.asset.method === "straightLine"
                        ? `${plan.row.asset.usefulLife}年`
                        : "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {currency(
                        plan.row.asset.method === "straightLine" ? 1 : 0,
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {plan.row.asset.method === "straightLine"
                        ? `${plan.row.months}/12`
                        : "—"}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {plan.row.asset.businessUseRatio}%
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-black tabular-nums">
                      {currency(plan.row.businessExpense)}
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin lk-text-3xs text-black tabular-nums">
                      {currency(plan.row.closingBookValue)}
                    </td>
                    {depreciationYears.map(({ year, isForecast }, index) => (
                      <td
                        key={year}
                        className={`px-2 py-2.5 text-right font-acumin lk-text-3xs tabular-nums ${
                          isForecast
                            ? "bg-[#f4f8fe] text-[#2f6fdb]"
                            : "text-black"
                        }`}
                      >
                        {currency(plan.byYear[index] ?? 0)}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-2.5 font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {plan.completedYear ? `${plan.completedYear}年度` : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-black">
                  <td className="px-2 py-2 font-acumin lk-text-3xs font-medium text-black">
                    合計
                  </td>
                  <td />
                  <td />
                  <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                    {currency(assetTotals.acquisitionCost)}
                  </td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                    {currency(assetTotals.businessExpense)}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                    {currency(assetTotals.closingBookValue)}
                  </td>
                  {depreciationYears.map(({ year, isForecast }, index) => (
                    <td
                      key={year}
                      className={`px-2 py-2 text-right font-acumin lk-text-3xs font-medium tabular-nums ${
                        isForecast
                          ? "bg-[#f4f8fe] text-[#2f6fdb]"
                          : "text-black"
                      }`}
                    >
                      {currency(depreciationYearTotals[index] ?? 0)}
                    </td>
                  ))}
                  <td className="px-2 py-2 font-acumin lk-text-3xs font-medium text-black tabular-nums">
                    {assetsCompletingThisYear}件
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 font-acumin lk-text-6xs leading-relaxed text-[#707070]">
          ※
          予測は当期と同じ計算式（定額法は「取得価額×償却率×使用月数/12」）を将来年度に適用した値です。
          一括償却資産は3年均等、即時償却は取得年に全額を計上します。
        </p>
      </Panel>
    </div>
  );
}
