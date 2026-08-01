// 青色申告決算書（一般用）。1P〜4P の様式に1:1で対応させる。
//
// どのページも「左＝決算書の面、右＝入力状況の面」で組む。
// 左は提出する数字そのもの、右はその数字がどこから来たか（入力元）と
// まだ埋まっていない項目を出す。数字はすべて帳簿・固定資産台帳からの自動連携。

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import {
  DEPRECIATION_METHOD_LABELS,
  depreciationForYear,
  straightLineRate,
} from "@/lib/finance/depreciation";
import { pageCompletionOf, type PageCompletion } from "@/lib/finance/tax";
import type { PartnerBreakdownRow } from "@/lib/finance/blue-return";
import type { TaxPage, TaxReportProps } from "@/components/tax/types";
import {
  CountLegend,
  FlowBlock,
  FlowOperator,
  ProgressRing,
  StateBadge,
  TAX_DONE_COLOR,
  TAX_IDLE_COLOR,
  TAX_SALES_COLOR,
  TAX_TODO_COLOR,
  TaxMetricCard,
  boxRadiusClassName,
  currency,
  panelTitleClassName,
  tableHeadClassName,
  tableNumberClassName,
  tableRowClassName,
  tableTotalRowClassName,
} from "@/components/tax/shared";

const BLUE_RETURN_PAGES: Array<{ key: TaxPage; label: string }> = [
  { key: "page1", label: "1P 損益計算書" },
  { key: "page2", label: "2P 月別・内訳" },
  { key: "page3", label: "3P 減価償却" },
  { key: "page4", label: "4P 貸借対照表" },
];

const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => `${index + 1}月`);

/** 減価償却推移に出す年度の幅（固定資産タブと揃える）。 */
const DEPRECIATION_PAST_YEARS = 4;
const DEPRECIATION_FUTURE_YEARS = 4;

/** 資産区分別の色。円グラフと凡例で共有する。 */
const ASSET_COLORS = [
  "#2f7a4f",
  "#3d6fc4",
  "#e0b23b",
  "#e07b28",
  "#7c5cd6",
  "#a8a8a8",
] as const;

const axisFormat = (value: number) => value.toLocaleString("ja-JP");

/** 決算書の1行がどこから来たか。行のラベルから機械的に決める。 */
function sourceOf(label: string): { source: string; auto: boolean } {
  if (label.includes("売上")) return { source: "売上帳", auto: true };
  if (label.includes("棚卸") || label.includes("仕入"))
    return { source: "売上帳・商品原価", auto: true };
  if (label.includes("青色申告特別控除額"))
    return { source: "設定値", auto: false };
  if (label.includes("差引") || label.includes("所得金額"))
    return { source: "自動計算", auto: true };
  return { source: "仕訳・元帳", auto: true };
}

/** ページ共通の右カラム。完成度・入力元・未入力・出力をこの順で積む。 */
function PageSidebar({
  completion,
  sourceSummary,
  sections,
  onExport,
  exportLabel,
}: {
  completion: PageCompletion;
  sourceSummary: { auto: number; manual: number; empty: number; note: string };
  sections: Array<{ title: string; body: React.ReactNode }>;
  onExport: () => void;
  exportLabel: string;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="ページ完成度"
        title={<span className={panelTitleClassName}>ページ完成度</span>}
      >
        <div className="flex items-center gap-4">
          <ProgressRing
            value={completion.progress}
            size={92}
            label={
              <span className="font-acumin text-sm font-medium text-black tabular-nums">
                {Math.round(completion.progress)}%
              </span>
            }
          />
          <div className="min-w-0 flex-1">
            <p className="font-acumin text-[11px] leading-relaxed text-[#707070]">
              必須項目のうち、入力済みの項目の割合です。
            </p>
            <div className="mt-2 space-y-1">
              {(
                [
                  ["入力済み", completion.filled, TAX_DONE_COLOR],
                  ["要確認", completion.review, TAX_TODO_COLOR],
                  ["未入力", completion.empty, TAX_IDLE_COLOR],
                ] as const
              ).map(([label, count, color]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="inline-flex items-center gap-1.5 font-acumin text-[11px] text-[#474747]">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    {label}
                  </span>
                  <span className="font-acumin text-[11px] text-black tabular-nums">
                    {count} 件
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="入力元"
        title={<span className={panelTitleClassName}>入力元</span>}
      >
        <div className="flex items-start gap-2">
          <i
            className="ri-database-2-line mt-0.5 shrink-0 text-base text-[#474747]"
            aria-hidden="true"
          />
          <p className="font-acumin text-[11px] leading-relaxed text-[#707070]">
            {sourceSummary.note}
          </p>
        </div>
        <div className="mt-3">
          <CountLegend
            items={[
              {
                label: "自動連携済み",
                count: sourceSummary.auto,
                color: TAX_DONE_COLOR,
              },
              {
                label: "手入力・設定",
                count: sourceSummary.manual,
                color: "#474747",
              },
              {
                label: "未入力",
                count: sourceSummary.empty,
                color: TAX_IDLE_COLOR,
              },
            ]}
          />
        </div>
      </Panel>

      {sections.map((section) => (
        <Panel
          key={section.title}
          radius="rounded"
          className="min-w-0"
          aria-label={section.title}
          title={<span className={panelTitleClassName}>{section.title}</span>}
        >
          {section.body}
        </Panel>
      ))}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button
          variant="outline"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          onClick={onExport}
          aria-label={exportLabel}
        >
          <i className="ri-file-excel-2-line mr-1" aria-hidden="true" />
          CSV出力
        </Button>
        <Button
          variant="outline"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          onClick={() => window.print()}
        >
          <i className="ri-printer-line mr-1" aria-hidden="true" />
          印刷プレビュー
        </Button>
      </div>
    </div>
  );
}

/** 内訳表（給料賃金・専従者給与・地代家賃など）。 */
function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: PartnerBreakdownRow[];
}) {
  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label={title}
      headingLevel={4}
      title={<span className={panelTitleClassName}>{title}</span>}
    >
      {rows.length === 0 ? (
        <p className="font-acumin text-xs text-[#707070]">
          該当する取引がありません。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[200px] border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {["支払先", "件数", "金額"].map((heading) => (
                  <th key={heading} className={tableHeadClassName}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.partner} className={tableRowClassName}>
                  <td className="px-2 py-2 font-acumin text-xs text-black">
                    {row.partner}
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                    {row.count}
                  </td>
                  <td className={tableNumberClassName}>
                    {currency(row.amount)}
                  </td>
                </tr>
              ))}
              <tr className={tableTotalRowClassName}>
                <td
                  colSpan={2}
                  className="px-2 py-2 font-acumin text-xs font-medium text-black"
                >
                  合計
                </td>
                <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                  {currency(rows.reduce((sum, row) => sum + row.amount, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BlueReturnView(props: TaxReportProps) {
  const {
    fiscalYear,
    profitAndLoss,
    balanceSheetComparison,
    monthlySummary,
    depreciation,
    deduction,
    page1Rows,
    expenseDetailRows,
    breakdowns,
    fixedAssets,
    usesEtax,
    onUsesEtaxChange,
    onExportPage,
    onNavigate,
  } = props;

  const [page, setPage] = useState<TaxPage>("page1");
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);

  /* ── ページごとの完成度 ─────────────────────────────────────────── */
  const page1Completion = useMemo(
    () =>
      pageCompletionOf([
        ...page1Rows.map((row) => ({ value: row.value })),
        ...expenseDetailRows.map((row) => ({ value: row.amount })),
      ]),
    [page1Rows, expenseDetailRows],
  );
  const page2Completion = useMemo(
    () =>
      pageCompletionOf([
        ...monthlySummary.rows.flatMap((row) => [
          { value: row.sales },
          { value: row.purchases },
        ]),
        ...breakdowns.wages.map((row) => ({ value: row.amount })),
        ...breakdowns.familyWages.map((row) => ({ value: row.amount })),
      ]),
    [monthlySummary.rows, breakdowns.wages, breakdowns.familyWages],
  );
  const page3Completion = useMemo(
    () =>
      pageCompletionOf(
        depreciation.rows.map((row) => ({
          value: row.businessExpense,
          // 事業専用割合100%未満は家事按分の確認が要る。
          review: row.asset.businessUseRatio < 100,
        })),
      ),
    [depreciation.rows],
  );
  const page4Completion = useMemo(
    () =>
      pageCompletionOf([
        ...balanceSheetComparison.assets.map((row) => ({ value: row.closing })),
        ...balanceSheetComparison.liabilitiesAndEquity.map((row) => ({
          value: row.closing,
        })),
      ]),
    [balanceSheetComparison],
  );

  const completions: Record<TaxPage, PageCompletion> = {
    page1: page1Completion,
    page2: page2Completion,
    page3: page3Completion,
    page4: page4Completion,
  };
  const overallProgress =
    (page1Completion.progress
      + page2Completion.progress
      + page3Completion.progress
      + page4Completion.progress) / 4;

  /* ── 3P 減価償却の推移・構成 ────────────────────────────────────── */
  const depreciationTrend = useMemo(() => {
    const years = Array.from(
      { length: DEPRECIATION_PAST_YEARS + 1 + DEPRECIATION_FUTURE_YEARS },
      (_, index) => fiscalYear - DEPRECIATION_PAST_YEARS + index,
    );
    return {
      years,
      values: years.map((year) =>
        fixedAssets.reduce(
          (sum, asset) => sum + depreciationForYear(asset, year).businessExpense,
          0,
        ),
      ),
    };
  }, [fixedAssets, fiscalYear]);

  const assetComposition = useMemo(
    () =>
      depreciation.rows
        .filter((row) => row.businessExpense > 0)
        .sort((a, b) => b.businessExpense - a.businessExpense)
        .map((row, index) => ({
          label: row.asset.name,
          value: row.businessExpense,
          color: ASSET_COLORS[index % ASSET_COLORS.length],
        })),
    [depreciation.rows],
  );

  const selectedAsset =
    depreciation.rows.find((row) => row.asset.id === selectedAssetId)
    ?? depreciation.rows[0];

  /* ── 4P 貸借対照表の構成比 ──────────────────────────────────────── */
  const assetShares = balanceSheetComparison.assets
    .filter((row) => row.closing > 0)
    .sort((a, b) => b.closing - a.closing);
  const liabilityShares = balanceSheetComparison.liabilitiesAndEquity
    .filter((row) => row.closing > 0)
    .sort((a, b) => b.closing - a.closing);

  const trendSeries = useMemo(() => {
    // 月別の売上・仕入から売上高と経費の推移を作る（2P の値と同じ集計）。
    const sales = monthlySummary.rows.map((row) => row.sales);
    const purchases = monthlySummary.rows.map((row) => row.purchases);
    return { sales, purchases };
  }, [monthlySummary.rows]);

  /* ── 共通の入力元サマリー ───────────────────────────────────────── */
  const sourceSummaryOf = (
    completion: PageCompletion,
    note: string,
    manual: number,
  ) => ({
    auto: completion.filled,
    manual,
    empty: completion.empty,
    note,
  });

  const traceLinks = (
    <ul className="-mt-1">
      {(
        [
          [
            "ri-file-list-3-line",
            "仕訳・元帳",
            "経費・各種収益・費用の内訳はこちら",
            "journal",
          ],
          [
            "ri-archive-2-line",
            "固定資産",
            "減価償却費の内訳・明細はこちら",
            "journal",
          ],
          [
            "ri-exchange-dollar-line",
            "取引管理",
            "売上金額・売上原価の明細はこちら",
            "expenses",
          ],
        ] as const
      ).map(([icon, label, description, target]) => (
        <li key={label}>
          <button
            type="button"
            onClick={() => onNavigate(target)}
            className={`flex w-full items-center gap-2 border-b border-[#ededed] px-1 py-2 text-left transition-colors hover:bg-[#faf7f2] ${boxRadiusClassName}`}
          >
            <i
              className={`${icon} shrink-0 text-[#474747]`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block font-acumin text-[11px] font-medium text-black">
                {label}
              </span>
              <span className="block font-acumin text-[10px] text-[#707070]">
                {description}
              </span>
            </span>
            <i
              className="ri-arrow-right-s-line shrink-0 text-[#707070]"
              aria-hidden="true"
            />
          </button>
        </li>
      ))}
    </ul>
  );

  const filingSettings = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-acumin text-[11px] text-[#474747]">
          青色申告特別控除
        </span>
        <span className="font-acumin text-xs text-black tabular-nums">
          {currency(deduction.deduction)}
        </span>
      </div>
      <Checkbox
        checked={usesEtax}
        onChange={(event) => onUsesEtaxChange(event.target.checked)}
        label="e-Tax利用（電子申告）"
        className="font-acumin"
      />
      <p className="font-acumin text-[10px] leading-relaxed text-[#707070]">
        ※ 65万円控除には複式簿記・貸借対照表の添付・期限内申告に加えて
        e-Tax申告または優良な電子帳簿保存が必要です（国税庁 No.2070）。
      </p>
    </div>
  );

  /* ── 1P 損益計算書 ──────────────────────────────────────────────── */
  const page1View = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <TaxMetricCard
            icon="ri-shopping-bag-3-line"
            label="売上金額"
            value={currency(profitAndLoss.sales)}
          />
          <TaxMetricCard
            icon="ri-inbox-unarchive-line"
            label="売上原価"
            value={currency(profitAndLoss.costOfSales)}
          />
          <TaxMetricCard
            icon="ri-bill-line"
            label="経費合計"
            value={currency(profitAndLoss.operatingExpenses)}
          />
          <TaxMetricCard
            icon="ri-hand-coin-line"
            label="所得金額"
            value={currency(deduction.incomeAfterDeduction)}
            tone="positive"
          />
        </div>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="1ページ 損益計算書"
          title={
            <span className={panelTitleClassName}>1ページ 損益計算書</span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {["科目", "金額", "入力元", "入力状況"].map((heading) => (
                    <th key={heading} className={tableHeadClassName}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page1Rows.map((row) => {
                  const { source, auto } = sourceOf(row.label);
                  return (
                    <tr
                      key={row.label}
                      className={
                        row.emphasis
                          ? "border-t border-black"
                          : tableRowClassName
                      }
                    >
                      <td
                        className={`px-2 py-2 font-acumin text-xs ${row.emphasis ? "font-medium text-black" : "text-[#474747]"} ${row.indent ? "pl-6" : ""}`}
                      >
                        {row.label}
                      </td>
                      <td
                        className={`px-2 py-2 text-right font-acumin text-xs tabular-nums ${row.emphasis ? "font-medium text-black" : "text-black"} ${row.value !== 0 ? "bg-[#f2f8f4]" : ""}`}
                      >
                        {currency(row.value)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-acumin text-[11px] text-[#474747]">
                        {source}
                      </td>
                      <td className="px-2 py-2">
                        <StateBadge
                          state={
                            row.value === 0 ? "idle" : auto ? "done" : "todo"
                          }
                        >
                          {row.value === 0
                            ? "未入力"
                            : auto
                              ? "自動連携済み"
                              : "設定済み"}
                        </StateBadge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 border-t border-[#d4d4d4] pt-3">
            <p className="font-acumin text-[11px] text-[#474747]">経費の内訳</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[320px] border-collapse">
                <tbody>
                  {expenseDetailRows.length === 0 ? (
                    <tr>
                      <td className="px-2 py-2 font-acumin text-xs text-[#707070]">
                        経費の登録がありません。
                      </td>
                    </tr>
                  ) : (
                    expenseDetailRows.map((row) => (
                      <tr key={row.account.code} className={tableRowClassName}>
                        <td className="px-2 py-2 font-acumin text-xs text-[#474747]">
                          {row.account.name}
                        </td>
                        <td className={tableNumberClassName}>
                          {currency(row.amount)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 font-acumin text-[11px] text-[#474747]">
                          仕訳・元帳
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="損益構造の内訳"
          title={<span className={panelTitleClassName}>損益構造の内訳</span>}
        >
          <div className="overflow-x-auto">
            {/* 7ブロックは1行に収まらないことがあるので折り返しを許す。 */}
            <div className="flex flex-col gap-1.5 lg:flex-row lg:flex-wrap lg:items-stretch">
              <FlowBlock
                tone="tax"
                label="売上高"
                value={currency(profitAndLoss.sales)}
              />
              <FlowOperator symbol="−" />
              <FlowBlock
                tone="add"
                label="売上原価"
                value={currency(profitAndLoss.costOfSales)}
              />
              <FlowOperator symbol="−" />
              <FlowBlock
                tone="result"
                label="必要経費"
                value={currency(profitAndLoss.operatingExpenses)}
              />
              <FlowOperator symbol="＝" />
              <FlowBlock
                tone="subtract"
                label="控除前所得"
                value={currency(profitAndLoss.netIncome)}
              />
              <FlowOperator symbol="−" />
              <FlowBlock
                tone="subtract"
                label="青色申告特別控除"
                value={currency(deduction.deduction)}
              />
              <FlowOperator symbol="＝" />
              <FlowBlock
                tone="tax"
                label="所得金額"
                value={currency(deduction.incomeAfterDeduction)}
              />
            </div>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="売上・経費・所得推移"
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={panelTitleClassName}>売上・経費・所得推移</span>
              <span className="font-acumin text-[11px] text-[#707070]">
                （12か月）
              </span>
            </span>
          }
        >
          <div className="overflow-x-auto">
            <div className="min-w-[520px]">
              <Graph
                variant="line"
                groupBars
                categories={MONTH_LABELS}
                unitLabel="金額（円）"
                rightAxis={{ seriesIndexes: [2], unitLabel: "所得金額（円）" }}
                series={[
                  {
                    label: "売上高",
                    kind: "bar",
                    color: TAX_SALES_COLOR,
                    values: trendSeries.sales,
                  },
                  {
                    label: "経費（仕入）",
                    kind: "bar",
                    color: "#e9b3b3",
                    values: trendSeries.purchases,
                  },
                  {
                    label: "所得金額",
                    kind: "line",
                    color: "#3d6fc4",
                    values: trendSeries.sales.map(
                      (value, index) => value - (trendSeries.purchases[index] ?? 0),
                    ),
                  },
                ]}
                formatAxisValue={axisFormat}
                plotHeight={230}
                legendClassName="font-acumin"
                ariaLabel={`${fiscalYear}年の売上・経費・所得の月次推移`}
              />
            </div>
          </div>
        </Panel>
      </div>

      <PageSidebar
        completion={page1Completion}
        sourceSummary={sourceSummaryOf(
          page1Completion,
          "売上帳・仕訳元帳・固定資産台帳から自動連携しています。",
          1,
        )}
        sections={[
          {
            title: "未入力・要確認",
            body:
              page1Completion.empty === 0 ? (
                <p className="flex items-center gap-1.5 font-acumin text-xs text-[#16844b]">
                  <i className="ri-checkbox-circle-line" aria-hidden="true" />
                  未入力の項目はありません。
                </p>
              ) : (
                <ul>
                  {page1Rows
                    .filter((row) => row.value === 0)
                    .map((row) => (
                      <li
                        key={row.label}
                        className="flex items-center justify-between gap-2 border-b border-[#ededed] py-2"
                      >
                        <span className="min-w-0 truncate font-acumin text-[11px] text-black">
                          {row.label}
                        </span>
                        <Button
                          variant="outline"
                          size="3xs"
                          shape="rounded"
                          className="shrink-0 font-acumin"
                          onClick={() => onNavigate("expenses")}
                        >
                          入力へ
                        </Button>
                      </li>
                    ))}
                </ul>
              ),
          },
          { title: "入力元トレース", body: traceLinks },
          { title: "申告設定", body: filingSettings },
        ]}
        onExport={() => onExportPage("page1")}
        exportLabel="1ページ 損益計算書CSV"
      />
    </div>
  );

  /* ── 2P 月別・内訳 ──────────────────────────────────────────────── */
  const monthlyAnomalies = monthlySummary.rows
    .map((row, index) => ({ index, row }))
    // 売上が0で仕入だけ立っている月は入力漏れの疑いがある。
    .filter(({ row }) => row.sales === 0 && row.purchases > 0);

  const page2View = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="2ページ 月別・内訳"
          title={
            <span className={panelTitleClassName}>2ページ 月別売上・仕入</span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse [&_td]:px-1 [&_th]:px-1 [&_td]:text-[10px] [&_th]:text-[10px]">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  <th className={tableHeadClassName} />
                  {MONTH_LABELS.map((label) => (
                    <th
                      key={label}
                      className="px-2 py-2 text-right font-acumin text-[11px] font-normal text-[#474747]"
                    >
                      {label}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-acumin text-[11px] font-medium text-black">
                    合計
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [
                      "売上金額",
                      monthlySummary.rows.map((row) => row.sales),
                      monthlySummary.salesTotal,
                    ],
                    [
                      "仕入金額",
                      monthlySummary.rows.map((row) => row.purchases),
                      monthlySummary.purchasesTotal,
                    ],
                  ] as const
                ).map(([label, values, total]) => (
                  <tr key={label} className={tableRowClassName}>
                    <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs text-[#474747]">
                      {label}
                    </td>
                    {values.map((value, index) => (
                      <td
                        key={`${label}-${index}`}
                        className="px-2 py-2 text-right font-acumin text-[11px] text-black tabular-nums"
                      >
                        {Math.round(value).toLocaleString("ja-JP")}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-right font-acumin text-[11px] font-medium text-black tabular-nums">
                      {Math.round(total).toLocaleString("ja-JP")}
                    </td>
                  </tr>
                ))}
                <tr className={tableTotalRowClassName}>
                  <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs font-medium text-black">
                    雑収入
                  </td>
                  <td
                    colSpan={12}
                    className="px-2 py-2 font-acumin text-[11px] text-[#707070]"
                  >
                    月別欄の外に計上します
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-[11px] font-medium text-black tabular-nums">
                    {Math.round(monthlySummary.miscIncome).toLocaleString(
                      "ja-JP",
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-acumin text-[10px] text-[#707070]">
            ※ 金額は円未満を切り捨てて表示しています。
          </p>
        </Panel>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          <BreakdownTable title="給料賃金の内訳" rows={breakdowns.wages} />
          <BreakdownTable
            title="専従者給与の内訳"
            rows={breakdowns.familyWages}
          />
          <BreakdownTable title="地代家賃の内訳" rows={breakdowns.rent} />
        </div>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="利子割引料・税理士等報酬の内訳"
          title={
            <span className={panelTitleClassName}>
              利子割引料・税理士等報酬の内訳
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {["区分", "支払先・内容", "件数", "金額"].map((heading) => (
                    <th key={heading} className={tableHeadClassName}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["利子割引料", breakdowns.interest] as const,
                  ["税理士・弁護士等報酬", breakdowns.professionalFees] as const,
                ].flatMap(([label, rows]) =>
                  rows.length === 0
                    ? [
                        <tr key={label} className={tableRowClassName}>
                          <td className="px-2 py-2 font-acumin text-xs text-[#474747]">
                            {label}
                          </td>
                          <td
                            colSpan={3}
                            className="px-2 py-2 font-acumin text-xs text-[#707070]"
                          >
                            該当する取引がありません。
                          </td>
                        </tr>,
                      ]
                    : rows.map((row) => (
                        <tr
                          key={`${label}-${row.partner}`}
                          className={tableRowClassName}
                        >
                          <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs text-[#474747]">
                            {label}
                          </td>
                          <td className="px-2 py-2 font-acumin text-xs text-black">
                            {row.partner}
                          </td>
                          <td className="px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                            {row.count}
                          </td>
                          <td className={tableNumberClassName}>
                            {currency(row.amount)}
                          </td>
                        </tr>
                      )),
                )}
                <tr className={tableTotalRowClassName}>
                  <td
                    colSpan={3}
                    className="px-2 py-2 font-acumin text-xs font-medium text-black"
                  >
                    合計
                  </td>
                  <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                    {currency(
                      [
                        ...breakdowns.interest,
                        ...breakdowns.professionalFees,
                      ].reduce((sum, row) => sum + row.amount, 0),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <PageSidebar
        completion={page2Completion}
        sourceSummary={sourceSummaryOf(
          page2Completion,
          "売上帳・仕訳元帳から自動連携しています。",
          breakdowns.wages.length + breakdowns.familyWages.length,
        )}
        sections={[
          {
            title: "月別チェック",
            body: (
              <>
                <p className="font-acumin text-[11px] text-[#707070]">
                  売上が計上されていない月を検知します。
                </p>
                <div className="mt-3 flex items-end justify-between gap-1">
                  {monthlySummary.rows.map((row, index) => {
                    const anomaly = row.sales === 0 && row.purchases > 0;
                    return (
                      <span
                        key={row.month}
                        className="flex flex-1 flex-col items-center gap-1"
                      >
                        {anomaly ? (
                          <i
                            className="ri-error-warning-line text-[11px] text-[#d98324]"
                            aria-hidden="true"
                          />
                        ) : (
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{
                              background:
                                row.sales > 0 ? TAX_DONE_COLOR : TAX_IDLE_COLOR,
                            }}
                            aria-hidden="true"
                          />
                        )}
                        <span className="font-acumin text-[9px] text-[#707070]">
                          {index + 1}
                        </span>
                      </span>
                    );
                  })}
                </div>
                <p className="mt-2 font-acumin text-[10px] text-[#707070]">
                  {monthlyAnomalies.length === 0
                    ? "検知された異常はありません。"
                    : `${monthlyAnomalies.map(({ index }) => `${index + 1}月`).join("・")}は仕入のみ計上されています。`}
                </p>
              </>
            ),
          },
          { title: "入力元トレース", body: traceLinks },
        ]}
        onExport={() => onExportPage("page2")}
        exportLabel="2ページ 月別・内訳CSV"
      />
    </div>
  );

  /* ── 3P 減価償却 ────────────────────────────────────────────────── */
  const page3View = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TaxMetricCard
            icon="ri-line-chart-line"
            label="当期償却費"
            value={currency(depreciation.depreciationTotal)}
          />
          <TaxMetricCard
            icon="ri-bill-line"
            label="必要経費算入"
            value={currency(depreciation.businessExpenseTotal)}
            tone="positive"
          />
          <TaxMetricCard
            icon="ri-archive-2-line"
            label="未償却残高"
            value={currency(depreciation.closingBookValueTotal)}
          />
        </div>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="3ページ 減価償却"
          title={<span className={panelTitleClassName}>3ページ 減価償却</span>}
        >
          {depreciation.rows.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              固定資産台帳に資産を登録すると、この欄が自動作成されます。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse [&_td]:px-1.5 [&_th]:px-1.5">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {[
                      "資産名",
                      "取得年月",
                      "取得価額（円）",
                      "償却方法",
                      "耐用年数（年）",
                      "償却率",
                      "本年中の償却期間（月）",
                      "本年分償却費（円）",
                      "事業専用割合",
                      "必要経費算入額（円）",
                      "未償却残高（円）",
                    ].map((heading) => (
                      <th key={heading} className={tableHeadClassName}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {depreciation.rows.map((row) => {
                    const active = selectedAsset?.asset.id === row.asset.id;
                    return (
                      <tr
                        key={row.asset.id}
                        onClick={() => setSelectedAssetId(row.asset.id)}
                        className={`cursor-pointer transition-colors hover:bg-[#faf7f2] ${tableRowClassName} ${active ? "bg-[#f6f6f6]" : ""}`}
                      >
                        <td className="px-2 py-2.5 font-acumin text-xs text-black">
                          {row.asset.name}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-xs text-[#474747]">
                          {row.asset.acquiredOn.slice(0, 7).replace("-", "/")}
                        </td>
                        <td className="bg-[#f2f8f4] px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                          {Math.round(
                            row.asset.acquisitionCost,
                          ).toLocaleString("ja-JP")}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747]">
                          {DEPRECIATION_METHOD_LABELS[row.asset.method]}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.method === "straightLine"
                            ? row.asset.usefulLife
                            : "—"}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.method === "straightLine"
                            ? straightLineRate(row.asset.usefulLife).toFixed(3)
                            : "—"}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.months}
                        </td>
                        <td className="bg-[#f2f8f4] px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                          {Math.round(row.depreciation).toLocaleString("ja-JP")}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-[#474747] tabular-nums">
                          {row.asset.businessUseRatio}%
                        </td>
                        <td
                          className={`px-2 py-2.5 text-right font-acumin text-xs font-medium text-black tabular-nums ${row.privatePortion > 0 ? "bg-[#fdf6ef]" : "bg-[#f2f8f4]"}`}
                        >
                          {Math.round(row.businessExpense).toLocaleString(
                            "ja-JP",
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                          {Math.round(row.closingBookValue).toLocaleString(
                            "ja-JP",
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className={tableTotalRowClassName}>
                    <td
                      colSpan={7}
                      className="px-2 py-2 font-acumin text-xs font-medium text-black"
                    >
                      合計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {Math.round(
                        depreciation.depreciationTotal,
                      ).toLocaleString("ja-JP")}
                    </td>
                    <td />
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {Math.round(
                        depreciation.businessExpenseTotal,
                      ).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {Math.round(
                        depreciation.closingBookValueTotal,
                      ).toLocaleString("ja-JP")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-acumin text-[10px] text-[#707070]">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-4 bg-[#f2f8f4]"
                aria-hidden="true"
              />
              自動連携済み
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-4 bg-[#fdf6ef]"
                aria-hidden="true"
              />
              要確認（家事按分あり）
            </span>
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="減価償却費の推移"
            title={
              <span className="flex flex-wrap items-baseline gap-2">
                <span className={panelTitleClassName}>減価償却費の推移</span>
                <span className="font-acumin text-[11px] text-[#707070]">
                  （実績・予測）
                </span>
              </span>
            }
          >
            <div className="overflow-x-auto">
              <div className="min-w-[330px]">
                <Graph
                  variant="line"
                  categories={depreciationTrend.years.map(
                    (year) => `${year}年度`,
                  )}
                  unitLabel="（単位：円）"
                  series={[
                    {
                      label: "償却費",
                      kind: "bar",
                      color: "#2f7a4f",
                      values: depreciationTrend.values,
                    },
                  ]}
                  forecastFrom={DEPRECIATION_PAST_YEARS + 1}
                  forecastLabels={{ past: "実績", future: "予測" }}
                  formatAxisValue={axisFormat}
                  formatValueLabel={(value) =>
                    value === 0 ? "" : Math.round(value).toLocaleString("ja-JP")
                  }
                  plotHeight={220}
                  plotWidth={440}
                  legendClassName="font-acumin"
                  ariaLabel="減価償却費の推移（実績・予測）"
                />
              </div>
            </div>
          </Panel>

          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="資産区分別 償却費内訳"
            title={
              <span className="flex flex-wrap items-baseline gap-2">
                <span className={panelTitleClassName}>
                  資産区分別 償却費内訳
                </span>
                <span className="font-acumin text-[11px] text-[#707070]">
                  （本年分）
                </span>
              </span>
            }
          >
            {assetComposition.length === 0 ? (
              <p className="font-acumin text-xs text-[#707070]">
                当期の償却費がありません。
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <Graph
                  variant="donut"
                  size={140}
                  showLegend={false}
                  data={assetComposition}
                  centerLabel={
                    <span className="block text-center">
                      <span className="block font-acumin text-[10px] text-[#707070]">
                        合計
                      </span>
                      <span className="block font-acumin text-[11px] font-medium text-black tabular-nums">
                        {currency(depreciation.businessExpenseTotal)}
                      </span>
                    </span>
                  }
                />
                <ul className="min-w-0 flex-1 space-y-1.5">
                  {assetComposition.map((item) => (
                    <li
                      key={item.label}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: item.color }}
                          aria-hidden="true"
                        />
                        <span className="truncate font-acumin text-[11px] text-[#474747]">
                          {item.label}
                        </span>
                      </span>
                      <span className="shrink-0 font-acumin text-[11px] text-black tabular-nums">
                        {currency(item.value)}（
                        {(
                          (item.value
                            / Math.max(1, depreciation.businessExpenseTotal))
                          * 100
                        ).toFixed(1)}
                        %）
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-3 font-acumin text-[10px] text-[#707070]">
              ※ 端数処理により合計が一致しない場合があります。
            </p>
          </Panel>
        </div>
      </div>

      <PageSidebar
        completion={page3Completion}
        sourceSummary={sourceSummaryOf(
          page3Completion,
          "固定資産台帳から取得価額・取得年月・耐用年数・償却方法を自動連携しています。",
          0,
        )}
        sections={[
          {
            title: "計算チェック",
            body: (
              <ul>
                {(
                  [
                    [
                      "償却費の計算チェック",
                      depreciation.rows.every(
                        (row) => row.depreciation >= row.businessExpense,
                      ),
                    ],
                    [
                      "事業専用割合のチェック",
                      depreciation.rows.every(
                        (row) => row.asset.businessUseRatio === 100,
                      ),
                    ],
                  ] as const
                ).map(([label, ok]) => (
                  <li
                    key={label}
                    className="flex items-center justify-between gap-2 border-b border-[#ededed] py-2"
                  >
                    <span className="min-w-0 truncate font-acumin text-[11px] text-black">
                      {label}
                    </span>
                    <StateBadge state={ok ? "done" : "todo"}>
                      {ok ? "問題ありません" : "要確認"}
                    </StateBadge>
                  </li>
                ))}
              </ul>
            ),
          },
          {
            title: "選択中の資産詳細",
            body: selectedAsset ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {(
                  [
                    ["資産名", selectedAsset.asset.name],
                    [
                      "取得年月",
                      selectedAsset.asset.acquiredOn
                        .slice(0, 7)
                        .replace("-", "/"),
                    ],
                    [
                      "取得価額",
                      currency(selectedAsset.asset.acquisitionCost),
                    ],
                    [
                      "償却方法",
                      DEPRECIATION_METHOD_LABELS[selectedAsset.asset.method],
                    ],
                    ["耐用年数", `${selectedAsset.asset.usefulLife} 年`],
                    ["本年中の償却期間", `${selectedAsset.months} か月`],
                    [
                      "事業専用割合",
                      `${selectedAsset.asset.businessUseRatio}%`,
                    ],
                    ["本年分償却費", currency(selectedAsset.depreciation)],
                    [
                      "必要経費算入額",
                      currency(selectedAsset.businessExpense),
                    ],
                    [
                      "未償却残高",
                      currency(selectedAsset.closingBookValue),
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="font-acumin text-[10px] text-[#707070]">
                      {label}
                    </dt>
                    <dd className="truncate font-acumin text-[11px] text-black tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="font-acumin text-xs text-[#707070]">
                固定資産が登録されていません。
              </p>
            ),
          },
          { title: "入力元トレース", body: traceLinks },
        ]}
        onExport={() => onExportPage("page3")}
        exportLabel="3ページ 減価償却CSV"
      />
    </div>
  );

  /* ── 4P 貸借対照表 ──────────────────────────────────────────────── */
  const balanceDifference =
    balanceSheetComparison.closingAssetTotal
    - balanceSheetComparison.closingLiabilityEquityTotal;

  const page4View = (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="4ページ 貸借対照表"
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={panelTitleClassName}>4ページ 貸借対照表</span>
              <span className="font-acumin text-[11px] text-[#707070]">
                （{fiscalYear}/12/31時点）
              </span>
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {(
              [
                ["資産の部", balanceSheetComparison.assets, "asset"],
                [
                  "負債・資本の部",
                  balanceSheetComparison.liabilitiesAndEquity,
                  "liability",
                ],
              ] as const
            ).map(([side, rows, kind]) => (
              <div key={side} className="min-w-0">
                <p className="font-acumin text-[11px] font-medium text-black">
                  {side}
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[240px] border-collapse [&_td]:px-1.5 [&_th]:px-1.5">
                    <thead>
                      <tr className="border-b border-[#d4d4d4]">
                        {["科目", "1月1日（期首）", "12月31日（期末）"].map(
                          (heading) => (
                            <th key={heading} className={tableHeadClassName}>
                              {heading}
                            </th>
                          ),
                        )}
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
                          <tr key={row.code} className={tableRowClassName}>
                            <td className="whitespace-nowrap px-2 py-2 font-acumin text-xs text-black">
                              {row.name}
                            </td>
                            <td className="px-2 py-2 text-right font-acumin text-xs text-[#474747] tabular-nums">
                              {currency(row.opening)}
                            </td>
                            <td className={tableNumberClassName}>
                              {currency(row.closing)}
                            </td>
                          </tr>
                        ))
                      )}
                      <tr className={tableTotalRowClassName}>
                        <td className="px-2 py-2 font-acumin text-xs font-medium text-black">
                          {kind === "asset" ? "資産合計" : "負債・資本合計"}
                        </td>
                        <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(
                            kind === "asset"
                              ? balanceSheetComparison.openingAssetTotal
                              : balanceSheetComparison.openingLiabilityEquityTotal,
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(
                            kind === "asset"
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

          <div className="mt-4 flex justify-center">
            <span
              className={`inline-flex items-center gap-1.5 border px-4 py-2 font-acumin text-xs ${boxRadiusClassName} ${
                balanceDifference === 0
                  ? "border-[#bcdcc9] bg-[#eff7f2] text-[#16844b]"
                  : "border-[#e7c0c0] bg-[#fdf1f1] text-[#b91c1c]"
              }`}
              role="status"
            >
              <i
                className={
                  balanceDifference === 0
                    ? "ri-checkbox-circle-line"
                    : "ri-error-warning-line"
                }
                aria-hidden="true"
              />
              {balanceDifference === 0
                ? "貸借一致"
                : `貸借差額 ${currency(balanceDifference)}`}
            </span>
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(
            [
              ["資産の構成比（期末）", assetShares, "#3d6fc4"],
              ["負債・資本の構成比（期末）", liabilityShares, "#e0913b"],
            ] as const
          ).map(([title, rows, color]) => {
            const total = rows.reduce((sum, row) => sum + row.closing, 0);
            return (
              <Panel
                key={title}
                radius="rounded"
                className="min-w-0"
                aria-label={title}
                title={<span className={panelTitleClassName}>{title}</span>}
              >
                {rows.length === 0 ? (
                  <p className="font-acumin text-xs text-[#707070]">
                    残高がありません。
                  </p>
                ) : (
                  <Graph
                    variant="progress"
                    layout="inline"
                    legendClassName="font-acumin"
                    className="font-acumin"
                    data={rows.map((row) => ({
                      label: row.name,
                      value: row.closing,
                      color,
                      formattedValue: `${currency(row.closing)}（${((row.closing / Math.max(1, total)) * 100).toFixed(1)}%）`,
                    }))}
                  />
                )}
              </Panel>
            );
          })}
        </div>
      </div>

      <PageSidebar
        completion={page4Completion}
        sourceSummary={sourceSummaryOf(
          page4Completion,
          "仕訳・元帳、固定資産、決算整理から自動連携しています。",
          0,
        )}
        sections={[
          {
            title: "整合性チェック（期首・期末）",
            body: (
              <ul>
                {(
                  [
                    [
                      "期首残高の一致",
                      balanceSheetComparison.openingAssetTotal
                        === balanceSheetComparison.openingLiabilityEquityTotal,
                    ],
                    ["期末残高の一致", balanceDifference === 0],
                  ] as const
                ).map(([label, ok]) => (
                  <li
                    key={label}
                    className="flex items-center justify-between gap-2 border-b border-[#ededed] py-2"
                  >
                    <span className="min-w-0 truncate font-acumin text-[11px] text-black">
                      {label}
                    </span>
                    <StateBadge state={ok ? "done" : "todo"}>
                      {ok ? "一致しています" : "不一致"}
                    </StateBadge>
                  </li>
                ))}
              </ul>
            ),
          },
          {
            title: "主な増減ハイライト（期末）",
            body: (
              <ul>
                {[
                  ...balanceSheetComparison.assets,
                  ...balanceSheetComparison.liabilitiesAndEquity,
                ]
                  .map((row) => ({ ...row, delta: row.closing - row.opening }))
                  .filter((row) => row.delta !== 0)
                  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                  .slice(0, 4)
                  .map((row) => (
                    <li
                      key={row.code}
                      className="flex items-center justify-between gap-2 border-b border-[#ededed] py-2"
                    >
                      <span className="min-w-0 truncate font-acumin text-[11px] text-black">
                        {row.name}
                      </span>
                      <span
                        className={`shrink-0 font-acumin text-[11px] tabular-nums ${row.delta > 0 ? "text-[#16844b]" : "text-[#b91c1c]"}`}
                      >
                        {row.delta > 0 ? "+" : "△"}
                        {currency(Math.abs(row.delta)).replace("¥", "¥")}
                      </span>
                    </li>
                  ))}
              </ul>
            ),
          },
          { title: "入力元トレース", body: traceLinks },
        ]}
        onExport={() => onExportPage("page4")}
        exportLabel="4ページ 貸借対照表CSV"
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 4ページ通しの進み具合。どのページが埋まっていないか一目で分かるようにする。 */}
      <Panel radius="rounded" className="min-w-0" aria-label="申告書全体の進捗">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex min-w-[220px] flex-1 items-center gap-3">
            <span className="whitespace-nowrap font-acumin text-[11px] font-medium text-black">
              申告書全体の進捗
            </span>
            <span
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#ededed]"
              aria-hidden="true"
            >
              <span
                className="block h-full rounded-full bg-black"
                style={{ width: `${Math.round(overallProgress)}%` }}
              />
            </span>
            <span className="font-acumin text-[11px] text-black tabular-nums">
              {Math.round(overallProgress)}%
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-acumin text-[11px] text-[#707070]">
              ページ別ステータス
            </span>
            {BLUE_RETURN_PAGES.map((item) => (
              <span
                key={item.key}
                className="inline-flex items-center gap-1.5 font-acumin text-[11px] text-[#474747]"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background:
                      completions[item.key].empty === 0
                        ? TAX_DONE_COLOR
                        : completions[item.key].filled === 0
                          ? TAX_IDLE_COLOR
                          : TAX_TODO_COLOR,
                  }}
                  aria-hidden="true"
                />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </Panel>

      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={BLUE_RETURN_PAGES}
          activeKey={page}
          onChange={(key) => setPage(key as TaxPage)}
        />
      </div>

      {page === "page1" ? page1View : null}
      {page === "page2" ? page2View : null}
      {page === "page3" ? page3View : null}
      {page === "page4" ? page4View : null}
    </div>
  );
}
