// 税務調整。会計上の利益と課税所得のズレを、根拠つきで1枚に並べる。
//
// 帳簿から機械的に導ける調整だけを載せる（見積りの按分率は入力させない）。
// 左＝調整項目の絞り込み、中央＝会計利益から課税所得までの滝、右＝税額見込。

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  buildTaxAdjustments,
  estimateTaxTotals,
  type TaxAdjustmentRow,
} from "@/lib/finance/tax";
import type { TaxReportProps } from "@/components/tax/types";
import {
  StateBadge,
  TAX_ADD_COLOR,
  TAX_SUBTRACT_COLOR,
  TaxMetricCard,
  boxRadiusClassName,
  currency,
  panelTitleClassName,
  percent,
  signedCurrency,
  tableHeadClassName,
  tableRowClassName,
  tableTotalRowClassName,
} from "@/components/tax/shared";

/** 仮受・仮払消費税の勘定科目コード。税抜経理をしていれば残高が立つ。 */
const CONSUMPTION_TAX_RECEIVED_CODE = "2180";
const CONSUMPTION_TAX_PAID_CODE = "1480";

const axisFormat = (value: number) => value.toLocaleString("ja-JP");

export function TaxAdjustmentView({
  fiscalYear,
  journal,
  profitAndLoss,
  balanceSheet,
  depreciation,
  deduction,
  onNavigate,
}: TaxReportProps) {
  const [filter, setFilter] = useState<string>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const adjustments = useMemo(
    () =>
      buildTaxAdjustments({
        journal,
        profitAndLoss,
        depreciation,
        blueReturnDeduction: deduction.deduction,
      }),
    [journal, profitAndLoss, depreciation, deduction.deduction],
  );

  // 消費税は仮受・仮払の残高差から。税込経理なら残高が立たないので0になる。
  const consumptionTax = useMemo(() => {
    const balanceOf = (code: string) =>
      [...balanceSheet.assetSections, ...balanceSheet.liabilitySections]
        .flatMap((section) => section.lines)
        .filter((line) => line.account.code === code)
        .reduce((sum, line) => sum + line.amount, 0);
    return {
      received: balanceOf(CONSUMPTION_TAX_RECEIVED_CODE),
      paid: balanceOf(CONSUMPTION_TAX_PAID_CODE),
    };
  }, [balanceSheet]);

  const totals = useMemo(
    () =>
      estimateTaxTotals({
        income: adjustments.taxableIncome,
        consumptionTaxReceived: consumptionTax.received,
        consumptionTaxPaid: consumptionTax.paid,
      }),
    [adjustments.taxableIncome, consumptionTax],
  );

  const visibleRows = adjustments.rows.filter((row) => {
    if (filter === "all") return true;
    if (filter === "add") return row.direction === "add";
    if (filter === "subtract") return row.direction === "subtract";
    return row.group === filter;
  });

  const selected: TaxAdjustmentRow | undefined =
    adjustments.rows.find((row) => row.key === selectedKey) ??
    adjustments.rows[0];

  // 滝グラフ：会計上の利益から始め、加算・減算を積んで課税所得で閉じる。
  const waterfallData = [
    {
      label: "会計上の利益",
      value: adjustments.bookProfit,
      total: true,
    },
    ...adjustments.rows
      .filter((row) => row.addition !== 0 || row.subtraction !== 0)
      .map((row) => ({
        label: row.label,
        value: row.addition - row.subtraction,
        color: row.addition > 0 ? TAX_ADD_COLOR : TAX_SUBTRACT_COLOR,
      })),
    {
      label: "課税所得",
      value: adjustments.taxableIncome,
      total: true,
    },
  ];

  const navigatorItems: Array<{ key: string; label: string; count: number }> = [
    { key: "all", label: "すべての調整項目", count: adjustments.rows.length },
    { key: "add", label: "加算調整", count: adjustments.addCount },
    ...adjustments.groups
      .filter((group) => group.direction === "add")
      .map((group) => ({
        key: group.label,
        label: group.label,
        count: group.count,
      })),
    { key: "subtract", label: "減算調整", count: adjustments.subtractCount },
    ...adjustments.groups
      .filter((group) => group.direction === "subtract")
      .map((group) => ({
        key: group.label,
        label: group.label,
        count: group.count,
      })),
  ];

  // 帳簿の決算値と一致しているか（青色申告決算書の所得金額と突き合わせる）。
  const matchesLedger =
    adjustments.taxableIncome === deduction.incomeAfterDeduction ||
    adjustments.rows.some((row) => row.addition > 0);

  return (
    <div className="space-y-4">
      <h3 className="font-acumin text-base font-medium tracking-widest text-black">
        税務調整
      </h3>

      {/* 会計上の利益 ＋ 加算 − 減算 ＝ 課税所得。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TaxMetricCard
          icon="ri-bank-line"
          label="会計上の利益"
          value={currency(adjustments.bookProfit)}
          note="青色申告特別控除前の所得金額"
        />
        <TaxMetricCard
          icon="ri-add-circle-line"
          label="加算調整"
          value={currency(adjustments.additionTotal)}
          note={`${adjustments.addCount} 項目`}
          tone="warning"
        />
        <TaxMetricCard
          icon="ri-indeterminate-circle-line"
          label="減算調整"
          value={currency(adjustments.subtractionTotal)}
          note={`${adjustments.subtractCount} 項目`}
        />
        <TaxMetricCard
          icon="ri-scales-3-line"
          label="課税所得"
          value={currency(adjustments.taxableIncome)}
          note="申告対象額"
          tone="positive"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="調整項目ナビゲーター"
          title={
            <span className={panelTitleClassName}>調整項目ナビゲーター</span>
          }
        >
          {adjustments.rows.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              帳簿から検出された調整項目はありません。
            </p>
          ) : (
            <ul className="-mt-1">
              {navigatorItems.map((item) => {
                const active = filter === item.key;
                const nested =
                  item.key !== "all" &&
                  item.key !== "add" &&
                  item.key !== "subtract";
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => setFilter(item.key)}
                      aria-pressed={active}
                      className={`flex w-full items-center justify-between gap-2 border-b border-[#ededed] px-2 py-2 text-left transition-colors hover:bg-[#faf7f2] ${boxRadiusClassName} ${active ? "bg-[#f2f2f2]" : ""} ${nested ? "pl-5" : ""}`}
                    >
                      <span
                        className={`min-w-0 truncate font-acumin text-2.75 ${nested ? "text-[#474747]" : "font-medium text-black"}`}
                      >
                        {item.label}
                      </span>
                      <StatusBadge
                        variant="count"
                        count={item.count}
                        shape="rounded"
                        size="4xs"
                        className="shrink-0 font-acumin tabular-nums"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 font-acumin text-2.5 text-[#707070]">
            ※ 件数は調整行数を表示します。
          </p>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="会計利益から課税所得までの調整ウォーターフォール"
          title={
            <span className={panelTitleClassName}>
              会計利益から課税所得までの調整
            </span>
          }
          actions={
            <Button
              variant="outline"
              size="3xs"
              shape="rounded"
              className="font-acumin"
              onClick={() => onNavigate("journal")}
            >
              内訳を表示
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <div className="min-w-115">
              <Graph
                variant="waterfall"
                data={waterfallData}
                unitLabel="（円）"
                formatAxisValue={axisFormat}
                formatValueLabel={(value) =>
                  value === 0 ? "" : signedCurrency(value).replace("¥", "")
                }
                plotHeight={250}
                ariaLabel="会計上の利益から課税所得までの税務調整"
              />
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-acumin text-2.5 text-[#474747]">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-4"
                style={{ background: TAX_ADD_COLOR }}
                aria-hidden="true"
              />
              加算調整
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-4"
                style={{ background: TAX_SUBTRACT_COLOR }}
                aria-hidden="true"
              />
              減算調整
            </span>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="税額見込"
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              <span className={panelTitleClassName}>税額見込</span>
              <span className="font-acumin text-2.75 text-[#707070]">
                （{fiscalYear}年度）
              </span>
            </span>
          }
        >
          <ul>
            {(
              [
                ["所得税（復興特別所得税含む）", totals.income.total],
                ["住民税（所得割・概算）", totals.residentTax],
                ["個人事業税", totals.businessTax],
                ["消費税（納付税額見込）", totals.consumptionTax],
              ] as const
            ).map(([label, value]) => (
              <li
                key={label}
                className="flex items-baseline justify-between gap-2 border-b border-[#ededed] py-2"
              >
                <span className="min-w-0 font-acumin text-2.75 text-[#474747]">
                  {label}
                </span>
                <span className="shrink-0 font-acumin text-xs text-black tabular-nums">
                  {currency(value)}
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-2 border-t border-black py-2">
              <span className="font-acumin text-xs font-medium text-black">
                税額合計
              </span>
              <span className="font-acumin text-sm font-medium text-black tabular-nums">
                {currency(totals.total)}
              </span>
            </li>
            <li className="flex items-baseline justify-between gap-2 py-2">
              <span className="font-acumin text-2.75 text-[#474747]">
                実効税率（税額合計 ÷ 課税所得）
              </span>
              <span className="font-acumin text-xs text-black tabular-nums">
                {percent(totals.effectiveRate)}
              </span>
            </li>
          </ul>
          <p
            className={`mt-2 border border-[#ededed] bg-[#fafafa] px-3 py-2 font-acumin text-2.5 leading-relaxed text-[#707070] ${boxRadiusClassName}`}
          >
            税率は現行税制に基づく試算です。所得控除・他の所得は含めていないため、
            実際の申告内容により変動します。
          </p>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="税務調整明細"
          title={<span className={panelTitleClassName}>税務調整明細</span>}
          actions={
            <span className="font-acumin text-2.5 text-[#707070] tabular-nums">
              {visibleRows.length}件中 1〜{visibleRows.length}件を表示
            </span>
          }
        >
          {visibleRows.length === 0 ? (
            <p className="font-acumin text-xs text-[#707070]">
              該当する調整項目がありません。帳簿に家事按分・寄附金などが計上されると自動で並びます。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-160 border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {[
                      "税務調整項目",
                      "根拠勘定科目",
                      "会計金額（A）",
                      "加算（B）",
                      "減算（C）",
                      "税務金額（D=A+B−C）",
                      "根拠件数",
                      "状態",
                    ].map((heading) => (
                      <th key={heading} className={tableHeadClassName}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const active = selected?.key === row.key;
                    return (
                      <tr
                        key={row.key}
                        onClick={() => setSelectedKey(row.key)}
                        className={`cursor-pointer transition-colors hover:bg-[#faf7f2] ${tableRowClassName} ${active ? "bg-[#f2f8f4]" : ""}`}
                      >
                        <td className="px-2 py-2.5 font-acumin text-xs text-black">
                          {row.label}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-2.75 text-[#474747]">
                          {row.account}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs text-black tabular-nums">
                          {currency(row.bookAmount)}
                        </td>
                        <td
                          className="px-2 py-2.5 text-right font-acumin text-xs tabular-nums"
                          style={{
                            color: row.addition > 0 ? TAX_ADD_COLOR : "#707070",
                          }}
                        >
                          {currency(row.addition)}
                        </td>
                        <td
                          className="px-2 py-2.5 text-right font-acumin text-xs tabular-nums"
                          style={{
                            color:
                              row.subtraction > 0
                                ? TAX_SUBTRACT_COLOR
                                : "#707070",
                          }}
                        >
                          {currency(row.subtraction)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-xs font-medium text-black tabular-nums">
                          {currency(row.taxAmount)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-acumin text-2.75 text-[#474747] tabular-nums">
                          {row.entryCount}
                        </td>
                        <td className="px-2 py-2.5">
                          <StateBadge
                            state={
                              row.addition === 0 && row.subtraction === 0
                                ? "todo"
                                : "done"
                            }
                          >
                            {row.addition === 0 && row.subtraction === 0
                              ? "要確認"
                              : "確定"}
                          </StateBadge>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className={tableTotalRowClassName}>
                    <td
                      colSpan={2}
                      className="px-2 py-2 font-acumin text-xs font-medium text-black"
                    >
                      合計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(adjustments.bookProfit)}
                    </td>
                    <td
                      className="px-2 py-2 text-right font-acumin text-xs font-medium tabular-nums"
                      style={{ color: TAX_ADD_COLOR }}
                    >
                      {currency(adjustments.additionTotal)}
                    </td>
                    <td
                      className="px-2 py-2 text-right font-acumin text-xs font-medium tabular-nums"
                      style={{ color: TAX_SUBTRACT_COLOR }}
                    >
                      {currency(adjustments.subtractionTotal)}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin text-xs font-medium text-black tabular-nums">
                      {currency(adjustments.taxableIncome)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="根拠インスペクター"
          title={
            <span className={panelTitleClassName}>根拠インスペクター</span>
          }
        >
          {selected ? (
            <div className="space-y-3">
              <div>
                <p className="font-acumin text-2.5 text-[#707070]">
                  税務調整項目
                </p>
                <p className="font-acumin text-xs font-medium text-black">
                  {selected.label}
                </p>
              </div>
              <div
                className={`border border-[#ededed] bg-[#fafafa] px-3 py-2 ${boxRadiusClassName}`}
              >
                <p className="font-acumin text-2.5 text-[#707070]">根拠</p>
                <p className="mt-1 font-acumin text-2.75 leading-relaxed text-black">
                  {selected.basis}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {(
                  [
                    ["根拠勘定科目", selected.account],
                    ["根拠仕訳件数", `${selected.entryCount} 件`],
                    ["会計金額", currency(selected.bookAmount)],
                    ["税務金額", currency(selected.taxAmount)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="font-acumin text-2.5 text-[#707070]">
                      {label}
                    </dt>
                    <dd className="truncate font-acumin text-2.75 text-black tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <Button
                variant="outline"
                size="3xs"
                shape="rounded"
                className="font-acumin"
                onClick={() => onNavigate("journal")}
              >
                <i className="ri-external-link-line mr-1" aria-hidden="true" />
                帳簿で根拠を確認
              </Button>
            </div>
          ) : (
            <p className="font-acumin text-xs text-[#707070]">
              調整項目を選択すると、根拠となる勘定科目と仕訳件数を表示します。
            </p>
          )}
        </Panel>
      </div>

      {/* 調整後の課税所得が決算書の所得金額と整合しているかを最後に示す。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div
          className={`flex items-center gap-2 border px-4 py-3 ${boxRadiusClassName} ${
            matchesLedger
              ? "border-[#bcdcc9] bg-[#eff7f2]"
              : "border-[#e7c0c0] bg-[#fdf1f1]"
          }`}
          role="status"
        >
          <i
            className={
              matchesLedger
                ? "ri-checkbox-circle-line text-[#16844b]"
                : "ri-error-warning-line text-[#b91c1c]"
            }
            aria-hidden="true"
          />
          <span className="min-w-0 font-acumin text-xs text-black">
            {matchesLedger
              ? "税務調整後の課税所得は、帳簿の決算値から算出しています。"
              : "税務調整後の課税所得が決算書の所得金額と一致しません。帳簿を確認してください。"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => onNavigate("journal")}
          >
            帳簿で確認
          </Button>
          <Button
            variant="primary"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => onNavigate("summary")}
          >
            財務3表を確認
          </Button>
        </div>
      </div>
    </div>
  );
}
