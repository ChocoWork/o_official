// 税務サマリー。申告に向けた「今の位置」を1枚で示す。
// 上段＝税額と準備率、中段＝推移と準備チェック、下段＝要対応と期限。
// 数字はすべて帳簿の決算値から導出し、概算であることを明記する。

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  accumulateTrend,
  buildFilingChecklist,
  buildTaxDeadlines,
  buildTaxTrend,
  estimateIncomeTax,
  TAX_DEADLINE_KIND_COLORS,
  TAX_DEADLINE_KIND_LABELS,
  type ChecklistItem,
} from "@/lib/finance/tax";
import type { TaxReportProps } from "@/components/tax/types";
import {
  CountLegend,
  FlowBlock,
  FlowOperator,
  ProgressRing,
  StateBadge,
  TAX_DONE_COLOR,
  TAX_EXPENSE_COLOR,
  TAX_IDLE_COLOR,
  TAX_INCOME_COLOR,
  TAX_SALES_COLOR,
  TAX_TODO_COLOR,
  TaxMetricCard,
  boxRadiusClassName,
  currency,
  panelTitleClassName,
  percent,
} from "@/components/tax/shared";

const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => `${index + 1}月`);

/** 縦軸は桁が大きいので3桁区切りのまま出す（万円丸めはしない）。 */
const axisFormat = (value: number) => value.toLocaleString("ja-JP");

/** 要対応の優先度。証憑・帳簿締めは申告の前提なので高く置く。 */
const PRIORITY_OF: Record<string, "high" | "medium" | "low"> = {
  closing: "high",
  balanced: "high",
  receipts: "medium",
  depreciation: "high",
  privateUse: "high",
  inventory: "medium",
  etax: "low",
  preview: "low",
};

const PRIORITY_LABELS = { high: "高", medium: "中", low: "低" } as const;
const PRIORITY_ICONS = {
  high: "ri-error-warning-line",
  medium: "ri-time-line",
  low: "ri-subtract-line",
} as const;
const PRIORITY_COLORS = {
  high: "#b45309",
  medium: "#8a6d3b",
  low: "#909090",
} as const;

export function TaxSummaryView({
  fiscalYear,
  journal,
  profitAndLoss,
  depreciation,
  deduction,
  balanceSheet,
  fixedAssets,
  closedAt,
  entryCounts,
  usesEtax,
  onExportJournal,
  onNavigate,
}: TaxReportProps & { onOpenBlueReturn: () => void }) {
  const [trendMode, setTrendMode] = useState<"monthly" | "cumulative">(
    "monthly",
  );

  const today = useMemo(() => new Date().toLocaleDateString("sv-SE"), []);
  const trend = useMemo(
    () => buildTaxTrend(journal, fiscalYear),
    [journal, fiscalYear],
  );
  const deadlines = useMemo(
    () => buildTaxDeadlines(fiscalYear, today),
    [fiscalYear, today],
  );
  const checklist = useMemo(
    () =>
      buildFilingChecklist({
        closedAt,
        missingReceiptCount: entryCounts.withoutReceipt,
        fixedAssetCount: fixedAssets.length,
        privateUseAssetCount: fixedAssets.filter(
          (asset) => asset.businessUseRatio < 100,
        ).length,
        usesEtax,
        isBalanced: balanceSheet.isBalanced,
        hasClosingInventory: profitAndLoss.closingInventory !== 0,
      }),
    [
      closedAt,
      entryCounts.withoutReceipt,
      fixedAssets,
      usesEtax,
      balanceSheet.isBalanced,
      profitAndLoss.closingInventory,
    ],
  );

  // 事業所得（青色申告特別控除後）に対する概算税額。所得控除は帳簿の外なので引かない。
  const taxEstimate = useMemo(
    () => estimateIncomeTax(deduction.incomeAfterDeduction),
    [deduction.incomeAfterDeduction],
  );

  const salesValues = trend.rows.map((row) => row.sales);
  const expenseValues = trend.rows.map((row) => row.expenses);
  const incomeValues = trend.rows.map((row) => row.income);
  const isCumulative = trendMode === "cumulative";
  const series = [
    {
      label: "課税売上（円）",
      kind: "bar" as const,
      color: TAX_SALES_COLOR,
      values: isCumulative ? accumulateTrend(salesValues) : salesValues,
    },
    {
      label: "必要経費（円）",
      kind: "bar" as const,
      color: TAX_EXPENSE_COLOR,
      values: isCumulative ? accumulateTrend(expenseValues) : expenseValues,
    },
    {
      label: "所得（円）",
      kind: "line" as const,
      color: TAX_INCOME_COLOR,
      values: isCumulative ? accumulateTrend(incomeValues) : incomeValues,
    },
  ];

  // 要対応は「完了していないチェック項目」を優先度順に並べたもの。
  const actionItems = checklist.items
    .filter((item) => item.status !== "done")
    .map((item) => ({
      ...item,
      priority: PRIORITY_OF[item.key] ?? "low",
    }))
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 } as const;
      return order[a.priority] - order[b.priority];
    });

  const filingDeadline = deadlines.find(
    (deadline) => deadline.key === "incomeTax-return",
  );
  // 期限一覧は「これから来るもの」だけ。過ぎた期限は要対応一覧の側で扱う。
  const upcomingDeadlines = deadlines.filter((deadline) => !deadline.overdue);

  return (
    <div className="space-y-4">
      {/* 上段：税額・所得・控除・準備率。ここだけ見れば申告の全体像が分かる。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TaxMetricCard
          icon="ri-wallet-3-line"
          label="推定所得税"
          value={currency(taxEstimate.total)}
          note={`復興特別所得税 ${currency(taxEstimate.reconstructionSurtax)}を含む`}
        />
        <TaxMetricCard
          icon="ri-calculator-line"
          label="課税所得"
          value={currency(taxEstimate.taxableIncome)}
          note={`税率 ${percent(taxEstimate.rate * 100)}／控除額 ${currency(taxEstimate.bracketDeduction)}`}
        />
        <TaxMetricCard
          icon="ri-price-tag-3-line"
          label="控除見込"
          value={currency(deduction.deduction)}
          note={`青色申告特別控除（上限 ${currency(deduction.limit)}）`}
          tone="positive"
        />
        <TaxMetricCard
          leading={
            <ProgressRing
              value={checklist.progress}
              size={52}
              label={
                <span className="font-acumin text-[10px] font-medium text-black tabular-nums">
                  {Math.round(checklist.progress)}%
                </span>
              }
            />
          }
          label="申告準備"
          value={`${Math.round(checklist.progress)}%`}
          note={`残り ${checklist.todoCount + checklist.notStartedCount} 項目`}
          tone={checklist.todoCount > 0 ? "warning" : "positive"}
        />
      </div>

      {/* 中段：左に推移、右に準備チェック。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="課税売上・必要経費・所得推移"
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={panelTitleClassName}>
                課税売上・必要経費・所得推移
              </span>
              <span className="font-acumin text-[11px] text-[#707070]">
                （{fiscalYear}年1月〜12月）
              </span>
            </span>
          }
          actions={
            <div
              className="flex rounded-sm bg-[#f2f2f2] p-0.5"
              role="group"
              aria-label="推移の表示単位"
            >
              {(
                [
                  ["monthly", "月次"],
                  ["cumulative", "累計"],
                ] as const
              ).map(([mode, label]) => {
                const active = trendMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTrendMode(mode)}
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
          <div className="overflow-x-auto">
            <div className="min-w-[520px]">
              <Graph
                variant="line"
                groupBars
                categories={MONTH_LABELS}
                series={series}
                formatAxisValue={axisFormat}
                plotHeight={250}
                legendClassName="font-acumin"
                ariaLabel={`${fiscalYear}年の課税売上・必要経費・所得の推移（${isCumulative ? "累計" : "月次"}）`}
              />
            </div>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="申告準備チェック"
          title={<span className={panelTitleClassName}>申告準備チェック</span>}
        >
          <ul>
            {checklist.items.slice(0, 6).map((item: ChecklistItem) => (
              <li
                key={item.key}
                className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#ededed] py-2"
              >
                <span className="whitespace-nowrap font-acumin text-[11px] font-medium text-black">
                  {item.group}
                </span>
                <span className="min-w-0 truncate font-acumin text-[11px] text-[#474747]">
                  {item.label}
                </span>
                <StateBadge
                  state={
                    item.status === "done"
                      ? "done"
                      : item.status === "todo"
                        ? "todo"
                        : "idle"
                  }
                >
                  {item.status === "done"
                    ? "完了"
                    : item.status === "todo"
                      ? "要対応"
                      : "未着手"}
                </StateBadge>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <CountLegend
              items={[
                {
                  label: "完了",
                  count: checklist.doneCount,
                  color: TAX_DONE_COLOR,
                },
                {
                  label: "要対応",
                  count: checklist.todoCount,
                  color: TAX_TODO_COLOR,
                },
                {
                  label: "未着手",
                  count: checklist.notStartedCount,
                  color: TAX_IDLE_COLOR,
                },
              ]}
            />
          </div>
        </Panel>
      </div>

      {/* 会計上の利益から推定税額までを一本の流れで示す。 */}
      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="税額見込"
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={panelTitleClassName}>税額見込</span>
            <span className="font-acumin text-[11px] text-[#707070]">
              （帳簿の決算値から自動連携）
            </span>
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 overflow-x-auto">
            <div className="flex flex-col gap-1.5 lg:min-w-[520px] lg:flex-row lg:items-stretch">
              <FlowBlock
                label="会計上の利益"
                value={currency(profitAndLoss.netIncome)}
                note="青色申告特別控除前"
              />
              <FlowOperator symbol="→" />
              <FlowBlock
                tone="subtract"
                label="税務調整"
                value={currency(-deduction.deduction)}
                note="青色申告特別控除"
              />
              <FlowOperator symbol="→" />
              <FlowBlock
                tone="result"
                label="課税所得"
                value={currency(taxEstimate.taxableIncome)}
                note="申告対象額"
              />
              <FlowOperator symbol="→" />
              <FlowBlock
                tone="tax"
                label="推定税額（所得税）"
                value={currency(taxEstimate.total)}
                note="復興特別所得税含む"
              />
            </div>
            <p
              className={`mt-3 border border-dashed border-[#d4d4d4] px-3 py-2 font-acumin text-[10px] leading-relaxed text-[#707070] ${boxRadiusClassName}`}
            >
              ※
              税額は概算です。所得控除（基礎控除・社会保険料控除など）は帳簿の外にあるため
              差し引いていません。実際の申告内容により変動します。
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 xl:w-52">
            <Button
              variant="primary"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              onClick={() => onNavigate("journal")}
            >
              帳簿の決算値を確認
            </Button>
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              onClick={() => onNavigate("summary")}
            >
              財務3表を確認
            </Button>
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              onClick={onExportJournal}
            >
              <i className="ri-download-line mr-1" aria-hidden="true" />
              仕訳帳CSV出力
            </Button>
          </div>
        </div>
      </Panel>

      {/* 下段：左に要対応、右に期限。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="要対応一覧"
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={panelTitleClassName}>要対応一覧</span>
              <span className="font-acumin text-[11px] text-[#707070]">
                （優先度順）
              </span>
            </span>
          }
        >
          {actionItems.length === 0 ? (
            <p className="flex items-center gap-1.5 font-acumin text-xs text-[#16844b]">
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
              要対応の項目はありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["優先度", "対応事項", "期限", "ステータス"].map(
                      (heading) => (
                        <th
                          key={heading}
                          className="px-2 py-2 text-left font-acumin text-[11px] font-normal text-[#474747]"
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {actionItems.map((item) => (
                    <tr key={item.key} className="border-b border-[#ededed]">
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span
                          className="inline-flex items-center gap-1 font-acumin text-[11px]"
                          style={{ color: PRIORITY_COLORS[item.priority] }}
                        >
                          <i
                            className={PRIORITY_ICONS[item.priority]}
                            aria-hidden="true"
                          />
                          {PRIORITY_LABELS[item.priority]}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 font-acumin text-xs text-black">
                        {item.label}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747] tabular-nums">
                        {item.key === "etax"
                          ? "未設定"
                          : (filingDeadline?.dueOn.replaceAll("-", "/") ?? "—")}
                      </td>
                      <td className="px-2 py-2.5">
                        <StateBadge
                          state={item.status === "todo" ? "todo" : "idle"}
                        >
                          {item.status === "todo" ? "要対応" : "未着手"}
                        </StateBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="申告期限・納付予定"
          title={
            <span className={panelTitleClassName}>申告期限・納付予定</span>
          }
          actions={
            <span className="font-acumin text-[10px] text-[#707070] tabular-nums">
              基準日 {today.replaceAll("-", "/")}
            </span>
          }
        >
          <ul className="relative">
            {upcomingDeadlines.slice(0, 6).map((deadline, index, list) => (
              <li
                key={deadline.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 py-2"
              >
                {/* 縦線と点で時系列を示す。最後の項目には線を引かない。 */}
                <span className="relative flex h-full w-3 justify-center pt-1">
                  <span
                    className="z-10 inline-block h-2.5 w-2.5 rounded-full border-2 bg-white"
                    style={{
                      borderColor: TAX_DEADLINE_KIND_COLORS[deadline.kind],
                      background: deadline.urgency === "high"
                        ? TAX_DEADLINE_KIND_COLORS[deadline.kind]
                        : "#ffffff",
                    }}
                    aria-hidden="true"
                  />
                  {index < list.length - 1 ? (
                    <span
                      className="absolute top-3 h-full w-px bg-[#ededed]"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block font-acumin text-xs text-black">
                    {deadline.label}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <StatusBadge
                      shape="rounded"
                      size="4xs"
                      className="font-acumin"
                      style={{
                        color: TAX_DEADLINE_KIND_COLORS[deadline.kind],
                      }}
                    >
                      {TAX_DEADLINE_KIND_LABELS[deadline.kind]}
                    </StatusBadge>
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={`block font-acumin text-[11px] tabular-nums ${
                      deadline.urgency === "high"
                        ? "text-[#b45309]"
                        : "text-black"
                    }`}
                  >
                    {deadline.dueOn.replaceAll("-", "/")}
                  </span>
                  <span className="block font-acumin text-[10px] text-[#707070] tabular-nums">
                    {deadline.overdue
                      ? `${Math.abs(deadline.daysLeft)}日超過`
                      : `残り ${deadline.daysLeft}日`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <p className="font-acumin text-[11px] leading-relaxed text-[#707070]">
        ※
        本画面の数値は帳簿から自動集計した参考値です。実際の申告内容は税理士または所轄税務署へご確認ください。
        減価償却費 {currency(depreciation.businessExpenseTotal)}
        を必要経費に含みます。
      </p>
    </div>
  );
}
