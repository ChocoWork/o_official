// 税務カレンダー。会計期間に紐づく申告・納付の期限を時間軸で見る。
//
// 上段＝残っている仕事の量、中段＝年間スケジュールと直近の期限、
// 下段＝納税資金の見通しと準備状況。期限はすべて法定期限から算出する。

import { useMemo } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  buildFilingChecklist,
  buildFilingDocuments,
  buildTaxDeadlines,
  buildTaxScheduleBands,
  estimateTaxTotals,
  FILING_DOCUMENT_STATUS_LABELS,
  scheduleIndexOf,
  TAX_DEADLINE_KIND_COLORS,
  TAX_DEADLINE_KIND_LABELS,
  TAX_SCHEDULE_MONTHS,
  type ChecklistItem,
  type TaxDeadlineKind,
} from "@/lib/finance/tax";
import type { TaxReportProps } from "@/components/tax/types";
import {
  StateBadge,
  TaxMetricCard,
  boxRadiusClassName,
  panelTitleClassName,
  ProgressRing,
} from "@/components/tax/shared";

/** 今後30日の期限とみなす日数。 */
const UPCOMING_DAYS = 30;

const URGENCY_LABELS = { high: "高", medium: "中", low: "低" } as const;
const URGENCY_TONES = {
  high: "danger",
  medium: "warning",
  low: "neutral",
} as const;

const axisFormat = (value: number) => value.toLocaleString("ja-JP");

export function TaxCalendarView({
  fiscalYear,
  balanceSheet,
  deduction,
  profitAndLoss,
  fixedAssets,
  closedAt,
  entryCounts,
  usesEtax,
  onNavigate,
}: TaxReportProps) {
  const today = useMemo(() => new Date().toLocaleDateString("sv-SE"), []);

  const deadlines = useMemo(
    () => buildTaxDeadlines(fiscalYear, today),
    [fiscalYear, today],
  );
  const bands = useMemo(() => buildTaxScheduleBands(fiscalYear), [fiscalYear]);
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
  const inventory = useMemo(
    () =>
      buildFilingDocuments({
        fiscalYear,
        journalCount: entryCounts.total,
        receiptCount: entryCounts.withReceipt,
        missingReceiptCount: entryCounts.withoutReceipt,
        expenseCount: entryCounts.expense,
        incomeCount: entryCounts.income,
        fixedAssetCount: fixedAssets.length,
        closedAt,
        isBalanced: balanceSheet.isBalanced,
      }),
    [fiscalYear, entryCounts, fixedAssets.length, closedAt, balanceSheet.isBalanced],
  );

  const totals = useMemo(
    () =>
      estimateTaxTotals({
        income: deduction.incomeAfterDeduction,
        consumptionTaxReceived: 0,
        consumptionTaxPaid: 0,
      }),
    [deduction.incomeAfterDeduction],
  );

  const upcoming = deadlines.filter(
    (deadline) => deadline.daysLeft >= 0 && deadline.daysLeft <= UPCOMING_DAYS,
  );

  // 今日の位置。会計期間（1月〜翌3月）の外なら線を引かない。
  const todayIndex = scheduleIndexOf(today, fiscalYear);

  // 納税支出の予定。税目ごとの納付期限が入る月に税額を割り当てる。
  const paymentByMonth = useMemo(() => {
    const values = TAX_SCHEDULE_MONTHS.map(() => 0);
    const put = (dueOn: string, amount: number) => {
      const index = scheduleIndexOf(dueOn, fiscalYear);
      if (index !== null) values[index] += amount;
    };
    put(`${fiscalYear + 1}-03-15`, totals.income.total);
    put(`${fiscalYear + 1}-03-31`, totals.consumptionTax);
    put(`${fiscalYear}-08-31`, Math.round(totals.businessTax / 2));
    put(`${fiscalYear}-11-30`, totals.businessTax - Math.round(totals.businessTax / 2));
    return values;
  }, [fiscalYear, totals]);

  // チェックリストを分類ごとにまとめる（帳簿締め・証憑・控除・申告書）。
  const checklistGroups = useMemo(() => {
    const map = new Map<string, ChecklistItem[]>();
    for (const item of checklist.items) {
      map.set(item.group, [...(map.get(item.group) ?? []), item]);
    }
    return [...map.entries()];
  }, [checklist.items]);

  const kinds: TaxDeadlineKind[] = [
    "incomeTax",
    "consumptionTax",
    "withholding",
    "depreciableAsset",
    "businessTax",
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TaxMetricCard
          icon="ri-calendar-check-line"
          label={`今後${UPCOMING_DAYS}日の期限`}
          value={`${upcoming.length} 件`}
          note={
            upcoming[0]
              ? `直近 ${upcoming[0].dueOn.replaceAll("-", "/")}`
              : "直近の期限はありません"
          }
          tone={upcoming.length > 0 ? "warning" : "neutral"}
        />
        <TaxMetricCard
          icon="ri-list-check-2"
          label="未完了タスク"
          value={`${checklist.todoCount + checklist.notStartedCount} 件`}
          note={`要対応 ${checklist.todoCount}／未着手 ${checklist.notStartedCount}`}
          tone={checklist.todoCount > 0 ? "warning" : "positive"}
        />
        <TaxMetricCard
          icon="ri-search-eye-line"
          label="証憑不足"
          value={`${entryCounts.withoutReceipt} 件`}
          note={`未添付の取引（理由記録済み ${entryCounts.unavailableRecorded} 件は別管理）`}
          tone={entryCounts.withoutReceipt > 0 ? "warning" : "positive"}
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
          label="準備完了率"
          value={`${Math.round(checklist.progress)}%`}
          note={`${checklist.doneCount}／${checklist.items.length} 項目が完了`}
          tone="positive"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="税務スケジュール"
          title={
            <span className={panelTitleClassName}>
              {fiscalYear}年度 税務スケジュール
            </span>
          }
          actions={
            <span className="font-acumin text-[10px] text-[#707070]">
              会計期間 {fiscalYear}/01〜{fiscalYear + 1}/03
            </span>
          }
        >
          <div className="overflow-x-auto">
            <div className="min-w-[600px]">
              {/* 月見出し。1列目は税目のラベル。 */}
              <div className="grid grid-cols-[88px_repeat(15,minmax(0,1fr))] items-end gap-x-px border-b border-[#d4d4d4] pb-1">
                <span />
                {TAX_SCHEDULE_MONTHS.map((label, index) => (
                  <span
                    key={label}
                    className={`text-center font-acumin text-[9px] ${index === todayIndex ? "font-medium text-black" : "text-[#707070]"}`}
                  >
                    {label}
                  </span>
                ))}
              </div>

              {/* 今日の位置。帯の行にまたがる縦線として重ねる。 */}
              <div className="relative">
                {todayIndex !== null ? (
                  <span
                    className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-[#16844b]"
                    style={{
                      left: `calc(88px + (100% - 88px) * ${(todayIndex + 0.5) / 15})`,
                    }}
                    aria-hidden="true"
                  />
                ) : null}
                {kinds.map((kind) => {
                const kindBands = bands.filter((band) => band.kind === kind);
                const kindDeadlines = deadlines.filter(
                  (deadline) => deadline.kind === kind,
                );
                return (
                  <div
                    key={kind}
                    className="grid grid-cols-[88px_repeat(15,minmax(0,1fr))] items-center gap-x-px border-b border-[#ededed] py-2"
                  >
                    <span className="inline-flex items-center gap-1.5 pr-2 font-acumin text-[10px] text-black">
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: TAX_DEADLINE_KIND_COLORS[kind] }}
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {TAX_DEADLINE_KIND_LABELS[kind]}
                      </span>
                    </span>
                    {/* 帯は grid-column で月にまたがせる。期限は帯の上に点で置く。 */}
                    <span
                      className="grid grid-cols-[repeat(15,minmax(0,1fr))] items-center gap-x-px"
                      style={{ gridColumn: "2 / span 15" }}
                    >
                      {kindBands.map((band) => (
                        <span
                          key={band.key}
                          className={`truncate px-1.5 py-1 text-center font-acumin text-[9px] ${boxRadiusClassName}`}
                          style={{
                            gridColumn: `${band.fromIndex + 1} / span ${band.span}`,
                            background: `${TAX_DEADLINE_KIND_COLORS[kind]}1f`,
                            color: TAX_DEADLINE_KIND_COLORS[kind],
                          }}
                          title={band.label}
                        >
                          {band.label}
                        </span>
                      ))}
                      {kindDeadlines.map((deadline) => {
                        const index = scheduleIndexOf(deadline.dueOn, fiscalYear);
                        if (index === null) return null;
                        return (
                          <span
                            key={deadline.key}
                            className="flex justify-center"
                            style={{ gridColumn: `${index + 1} / span 1` }}
                            title={`${deadline.label}（${deadline.dueOn}）`}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{
                                background: TAX_DEADLINE_KIND_COLORS[kind],
                              }}
                              aria-hidden="true"
                            />
                          </span>
                        );
                      })}
                    </span>
                  </div>
                );
                })}
              </div>

              {todayIndex !== null ? (
                <p className="mt-2 font-acumin text-[10px] text-[#707070]">
                  <span
                    className="mr-1 inline-block h-2 w-0.5 align-middle bg-[#16844b]"
                    aria-hidden="true"
                  />
                  今日は {TAX_SCHEDULE_MONTHS[todayIndex]} です。
                </p>
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label={`今後${UPCOMING_DAYS}日の期限`}
          title={
            <span className={panelTitleClassName}>
              今後{UPCOMING_DAYS}日の期限
            </span>
          }
          actions={
            <span className="font-acumin text-[10px] text-[#707070] tabular-nums">
              基準日 {today.replaceAll("-", "/")}
            </span>
          }
        >
          {upcoming.length === 0 ? (
            <p className="flex items-center gap-1.5 font-acumin text-xs text-[#16844b]">
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
              今後{UPCOMING_DAYS}日以内の期限はありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[320px] border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["期限", "手続き・税目", "残り", "緊急度"].map(
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
                  {upcoming.map((deadline) => (
                    <tr
                      key={deadline.key}
                      className="border-b border-[#ededed]"
                    >
                      <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-black tabular-nums">
                        {deadline.dueOn.replaceAll("-", "/")}
                      </td>
                      <td className="px-2 py-2.5 font-acumin text-[11px] text-black">
                        {deadline.label}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 font-acumin text-[11px] text-[#474747] tabular-nums">
                        あと {deadline.daysLeft}日
                      </td>
                      <td className="px-2 py-2.5">
                        <StatusBadge
                          tone={URGENCY_TONES[deadline.urgency]}
                          accent
                          shape="rounded"
                          size="3xs"
                          className="font-acumin"
                        >
                          {URGENCY_LABELS[deadline.urgency]}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="納税資金予測"
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={panelTitleClassName}>納税資金予測</span>
            <span className="font-acumin text-[11px] text-[#707070]">
              （納付期限に税額を割り当てた予定）
            </span>
          </span>
        }
        actions={
          <Button
            variant="outline"
            size="3xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => onNavigate("summary")}
          >
            帳簿の決算値を確認
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <Graph
              variant="line"
              categories={TAX_SCHEDULE_MONTHS}
              unitLabel="（円）"
              series={[
                {
                  label: "納税支出（予定）",
                  kind: "bar",
                  color: "#3d6fc4",
                  values: paymentByMonth,
                },
              ]}
              formatAxisValue={axisFormat}
              formatValueLabel={(value) =>
                value === 0 ? "" : Math.round(value).toLocaleString("ja-JP")
              }
              plotHeight={220}
              plotWidth={1100}
              legendClassName="font-acumin"
              ariaLabel="納付期限ごとの納税支出予定"
            />
          </div>
        </div>
        <p className="mt-2 font-acumin text-[10px] leading-relaxed text-[#707070]">
          ※
          税額見込を法定の納付期限に割り当てた概算です。予定納税・中間納付の額は
          前年の申告額によって決まるため含めていません。
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="申告準備チェックリスト"
          title={
            <span className={panelTitleClassName}>申告準備チェックリスト</span>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {checklistGroups.map(([group, items]) => {
              const done = items.filter(
                (item) => item.status === "done",
              ).length;
              return (
                <div key={group} className="min-w-0">
                  <p className="flex items-baseline justify-between gap-2 border-b border-[#d4d4d4] pb-1.5">
                    <span className="font-acumin text-[11px] font-medium text-black">
                      {group}
                    </span>
                    <span className="font-acumin text-[11px] text-[#474747] tabular-nums">
                      {done}/{items.length}
                    </span>
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {items.map((item) => (
                      <li
                        key={item.key}
                        className="flex items-start gap-1.5 font-acumin text-[11px]"
                      >
                        <i
                          className={
                            item.status === "done"
                              ? "ri-checkbox-circle-fill mt-0.5 shrink-0 text-[#16844b]"
                              : item.status === "todo"
                                ? "ri-error-warning-line mt-0.5 shrink-0 text-[#d98324]"
                                : "ri-checkbox-blank-circle-line mt-0.5 shrink-0 text-[#c4c4c4]"
                          }
                          aria-hidden="true"
                        />
                        <span
                          className={
                            item.status === "done"
                              ? "text-[#474747]"
                              : "text-black"
                          }
                        >
                          {item.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          radius="rounded"
          className="min-w-0"
          aria-label="申告資料・証憑インベントリ"
          title={
            <span className={panelTitleClassName}>
              申告資料・証憑インベントリ
            </span>
          }
          actions={
            <Button
              variant="outline"
              size="3xs"
              shape="rounded"
              className="font-acumin"
              onClick={() => onNavigate("expenses")}
            >
              証憑を追加
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[380px] border-collapse">
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {["資料名", "関連件数", "ステータス", "不足件数"].map(
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
                {inventory.documents.slice(0, 6).map((document) => (
                  <tr key={document.key} className="border-b border-[#ededed]">
                    <td className="px-2 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <i
                          className={
                            document.fileKind === "pdf"
                              ? "ri-file-pdf-2-line shrink-0 text-[#b91c1c]"
                              : "ri-file-excel-2-line shrink-0 text-[#16844b]"
                          }
                          aria-hidden="true"
                        />
                        <span className="font-acumin text-[11px] text-black">
                          {document.name}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right font-acumin text-[11px] text-[#474747] tabular-nums">
                      {document.entryCount} 件
                    </td>
                    <td className="px-2 py-2.5">
                      <StateBadge
                        state={
                          document.status === "created"
                            ? "done"
                            : document.status === "drafting"
                              ? "todo"
                              : "idle"
                        }
                      >
                        {FILING_DOCUMENT_STATUS_LABELS[document.status]}
                      </StateBadge>
                    </td>
                    <td
                      className={`px-2 py-2.5 text-right font-acumin text-[11px] tabular-nums ${document.missingCount > 0 ? "text-[#b91c1c]" : "text-[#707070]"}`}
                    >
                      {document.missingCount} 件
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-acumin text-[10px] text-[#707070]">
            必要資料 {inventory.requiredCount} 件のうち、準備完了{" "}
            {inventory.readyCount} 件（{Math.round(inventory.progress)}%）。
          </p>
        </Panel>
      </div>
    </div>
  );
}
