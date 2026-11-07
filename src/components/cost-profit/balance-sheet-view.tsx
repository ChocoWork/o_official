import { Button } from "@/components/ui/Button/Button";
import { DataTable } from "@/components/ui/DataTable/DataTable";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  COMPARISON_COLUMN_LABELS,
  BS_ASSET_COLOR,
  BS_LIABILITY_COLOR,
  BS_EQUITY_COLOR,
  BS_ASSET_FILL,
  BS_LIABILITY_FILL,
  BS_EQUITY_FILL,
  LEDGER_MONTH_LABELS,
  currency,
  percent,
  boxRadiusClassName,
  panelTitleClassName,
} from "./constants";
import { FlowBlock, FlowOperator } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

export function BalanceSheetView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    setStatementTab,
    comparisonBasis,
    setBalanceSheetKeyword,
    balanceSheetSearchInput,
    setBalanceSheetSearchInput,
    collapsedBsGroups,
    setCollapsedBsGroups,
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
    varianceWaterfallData,
    significantVariances,
    toggleBsGroup,
    bsToneColor,
  } = model;
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
        className="font-acumin lk-text-4xs font-medium"
        style={{ color: bsToneColor[tone] }}
      >
        {label}
      </span>
      <span
        className="font-acumin lk-text-sm font-medium tabular-nums"
        style={{ color: bsToneColor[tone] }}
      >
        {currency(value)}
      </span>
      <span className="font-acumin lk-text-6xs text-[#707070] tabular-nums">
        （{bsAssetTotal === 0 ? "—" : percent((value / bsAssetTotal) * 100)}）
      </span>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="貸借対照表の構成"
          title={<span className={panelTitleClassName}>貸借対照表の構成</span>}
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
            <p className="font-acumin lk-text-4xs text-[#474747]">
              資産合計
              <span className="ml-1 text-black tabular-nums">
                {currency(bsAssetTotal)}
              </span>
            </p>
            <p className="font-acumin lk-text-4xs text-[#474747]">
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
            className={`${boxRadiusClassName} mt-3 flex flex-wrap items-center justify-center gap-3 border px-3 py-2 font-acumin lk-text-3xs ${
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
          <p className="mt-2 font-acumin lk-text-6xs text-[#707070]">
            ※ 積み上げ高＝負債＋純資産＝資産合計（会計恒等式）。
          </p>
        </Panel>

        <Panel
          radius="rounded"
          headingLevel={4}
          aria-label="増減要因"
          title={
            <span className={panelTitleClassName}>
              増減要因（対{COMPARISON_COLUMN_LABELS[comparisonBasis]}
              の主な内訳）
            </span>
          }
        >
          {balanceSheetVariance.top.length === 0 ? (
            <p className="font-acumin lk-text-3xs text-[#707070]">
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
            className="w-full font-acumin sm:w-55 **:data-ui-search-field-input:rounded-md"
            value={balanceSheetSearchInput}
            showClearButton
            onClear={() => {
              setBalanceSheetSearchInput("");
              setBalanceSheetKeyword("");
            }}
            onSearch={() => setBalanceSheetKeyword(balanceSheetSearchInput)}
            searchButtonAriaLabel="貸借対照表の科目を検索する"
            onChange={(event) => setBalanceSheetSearchInput(event.target.value)}
          />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-180 border-collapse">
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
                      className={`px-2 py-2 font-acumin lk-text-4xs font-normal text-[#474747] ${
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
                            className={`min-w-0 truncate font-acumin lk-text-3xs ${
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
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-black tabular-nums">
                        {row.current.toLocaleString("ja-JP")}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                        {row.comparison.toLocaleString("ja-JP")}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs tabular-nums ${
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
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs tabular-nums ${
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
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
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
              重要差異（対{COMPARISON_COLUMN_LABELS[comparisonBasis]}
              の大きい科目）
            </span>
          }
        >
          {significantVariances.length === 0 ? (
            <p className="font-acumin lk-text-3xs text-[#707070]">
              比較期間との差が大きい科目はありません。
            </p>
          ) : (
            <DataTable
              size="2xs"
              shape="rounded"
              rows={significantVariances}
              rowKey={(row) => row.section}
              containerClassName="font-acumin"
              tableClassName="min-w-180"
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
          <p className="mt-3 font-acumin lk-text-6xs text-[#707070]">
            ※
            構成比は四捨五入のため、合計が100%とならない場合があります。確認状況は当月の証憑添付の有無から判定します。
          </p>
        </Panel>
      </div>
    </div>
  );
}
