import { Button } from "@/components/ui/Button/Button";
import { Panel } from "@/components/ui/Panel/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import {
  CASH_FLOW_CATEGORY_LABELS,
  type CashFlowCategory,
} from "@/lib/finance/cash-flow";
import type { CounterpartyBalanceSection } from "@/lib/finance/counterparty-balances";
import {
  currency,
  deltaCurrency,
  ratioOf,
  inputClassName,
  panelClassName,
  boxRadiusClassName,
  panelTitleClassName,
} from "./constants";
import {
  StatementTable,
  ProfitLadderBar,
  BalanceBars,
  CashTrendChart,
  CompositionCard,
  FlowBlock,
  FlowOperator,
} from "./shared-ui";
import { StripeSettlementView } from "./stripe-settlement-view";
import type { CostProfitModel } from "./use-cost-profit-model";

export function SummaryView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    fiscalYearLabel,
    periodRangeLabel,
    periodSpanLabel,
    setActiveTab,
    cashTrendMode,
    setCashTrendMode,
    profitScopeMode,
    setProfitScopeMode,
    openingSummary,
    plan,
    setPlan,
    isSaving,
    profitAndLoss,
    balanceSheet,
    cashFlow,
    cumulative,
    counterpartyBalances,
    safetyLevel,
    isMonthlyTrend,
    trendPoints,
    trendTargets,
    cashSchedule,
    overviewActions,
    salesComposition,
    costOfSalesComposition,
    sgaComposition,
    compositionTotal,
    cashFlowNet,
    isCumulativeScope,
    profitScope,
    handleSavePlan,
    handleStatementExport,
  } = model;
  const stripeSettlementView = <StripeSettlementView model={model} />;
  const counterpartyBalancePanel = (
    title: "借入・事業主資金" | "その他の支払債務",
    section: CounterpartyBalanceSection,
  ) => {
    const funding = title === "借入・事業主資金";
    return (
      <Panel
        radius="rounded"
        aria-label={title}
        title={<span className={panelTitleClassName}>{title}</span>}
      >
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            [funding ? "借入・投入累計" : "発生累計", section.totals.received],
            [
              funding ? "返済・引出済み" : "支払・返還済み",
              section.totals.settled,
            ],
            [funding ? "返済残高" : "残高", section.totals.balance],
          ].map(([label, amount]) => (
            <div
              key={String(label)}
              className={`${boxRadiusClassName} border border-[#ededed] p-3`}
            >
              <p className="font-acumin lk-text-4xs text-[#707070]">{label}</p>
              <p className="mt-1 font-acumin lk-text-sm font-medium text-black tabular-nums">
                {currency(Number(amount))}
              </p>
            </div>
          ))}
        </div>
        {section.rows.length === 0 ? (
          <p className="font-acumin lk-text-3xs text-[#707070]">
            該当する残高はありません。
          </p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table
              aria-label={title}
              className="w-full min-w-190 border-collapse"
            >
              <thead>
                <tr className="border-b border-[#d4d4d4]">
                  {[
                    funding ? "借入先" : "支払先",
                    "区分",
                    funding ? "借入・投入累計" : "発生累計",
                    funding ? "返済・引出済み" : "支払・返還済み",
                    funding ? "返済残高" : "残高",
                    "最終入出金日",
                  ].map((heading, index) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`px-2 py-2 font-acumin lk-text-4xs font-normal text-[#474747] ${index >= 2 && index <= 4 ? "text-right" : "text-left"}`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr
                    key={`${row.accountCode}-${row.counterparty}`}
                    className="border-b border-[#ededed]"
                  >
                    <td className="px-2 py-2 font-acumin lk-text-3xs text-black">
                      {row.counterparty}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-acumin lk-text-3xs text-black">
                      {row.accountName}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-black tabular-nums">
                      {currency(row.received)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-black tabular-nums">
                      {currency(row.settled)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs font-medium tabular-nums ${row.balance < 0 ? "text-red-700" : "text-black"}`}
                    >
                      {currency(row.balance)}
                      {row.balance < 0 ? (
                        <span className="ml-1 lk-text-6xs">要確認</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {row.lastActivityDate?.replaceAll("-", "/") ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {funding && section.rows.some((row) => row.ownerFunding) ? (
          <p className="mt-3 font-acumin lk-text-4xs leading-relaxed text-[#707070]">
            事業主借の残高は事業主資金残高です。法的な返済義務額ではなく、決算時に元入金へ振り替えられます。
          </p>
        ) : null}
      </Panel>
    );
  };

  return (
    <div className="space-y-4">
      {/* 上段：左に資金の現在地（推移・キャッシュブリッジ）、右に直近の予定と要対応。 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="資金推移"
            title={<span className={panelTitleClassName}>資金推移</span>}
            actions={
              <div
                className="flex rounded-sm bg-[#f2f2f2] p-0.5"
                role="group"
                aria-label="資金推移の表示単位"
              >
                {(
                  [
                    ["monthly", "月次"],
                    ["cumulative", "通期"],
                  ] as const
                ).map(([mode, label]) => {
                  const active = cashTrendMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCashTrendMode(mode)}
                      className={`h-6 rounded-sm px-3 font-acumin lk-text-4xs transition-colors ${
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-acumin lk-text-6xs text-[#474747]">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-px w-5 bg-black"
                  aria-hidden="true"
                />
                実績（{isMonthlyTrend ? "手元資金" : "期首からの累積増減"}）
              </span>
              {trendTargets ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-px w-5 border-t border-dashed border-[#707070]"
                    aria-hidden="true"
                  />
                  目標
                </span>
              ) : null}
              {isMonthlyTrend && safetyLevel > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-5 bg-[#e8f1e9]"
                    aria-hidden="true"
                  />
                  安全水準（3ヶ月分固定費）
                </span>
              ) : null}
            </div>
            {/* 画面が狭いときはパネル内だけを横スクロールさせ、グラフを潰さない。 */}
            <div className="mt-2 overflow-x-auto">
              <div className="min-w-130">
                <CashTrendChart
                  points={trendPoints}
                  targets={trendTargets}
                  safetyLevel={isMonthlyTrend ? safetyLevel : 0}
                  ariaLabel={`${fiscalYearLabel}の資金推移グラフ（${isMonthlyTrend ? "月次" : "通期"}）`}
                />
              </div>
            </div>
            <p className="mt-2 font-acumin lk-text-6xs leading-relaxed text-[#707070]">
              {trendTargets
                ? "目標＝期首資金＋（財務前提の売上見込み − 当期費用）÷12×経過月。"
                : "目標線は財務前提の売上見込みを入力すると表示されます。"}
              安全水準＝経費の月平均×3ヶ月。
            </p>
          </Panel>

          {/* 期首 + 営業CF + 投資CF + 財務CF = 期末。直接法なので必ず一致する。 */}
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="キャッシュブリッジ"
            title={
              <span className={panelTitleClassName}>キャッシュブリッジ</span>
            }
            actions={
              <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
                会計期間 {periodRangeLabel}
              </span>
            }
          >
            <div className="overflow-x-auto">
              <div className="flex flex-col gap-1.5 lg:min-w-115 lg:flex-row lg:items-stretch">
                <FlowBlock
                  size="sm"
                  label="期首残高"
                  value={cashFlow.openingCash}
                />
                <FlowOperator symbol="＋" />
                <FlowBlock
                  size="sm"
                  label="営業CF"
                  value={cashFlow.operating}
                />
                <FlowOperator symbol="＋" />
                <FlowBlock
                  size="sm"
                  label="投資CF"
                  value={cashFlow.investing}
                />
                <FlowOperator symbol="＋" />
                <FlowBlock
                  size="sm"
                  label="財務CF"
                  value={cashFlow.financing}
                />
                <FlowOperator symbol="＝" />
                <FlowBlock
                  size="sm"
                  label="期末残高"
                  value={cashFlow.closingCash}
                  emphasis
                />
              </div>
            </div>
            <p
              className={`mt-2 text-right font-acumin lk-text-4xs ${cashFlow.difference === 0 ? "text-[#16844b]" : "text-red-700"}`}
              role="status"
            >
              <i
                className={`mr-1 ${cashFlow.difference === 0 ? "ri-checkbox-circle-line" : "ri-error-warning-line"}`}
                aria-hidden="true"
              />
              {cashFlow.difference === 0
                ? "検算一致"
                : `検算差額 ${currency(cashFlow.difference)}`}
            </p>
          </Panel>
        </div>

        <div className="min-w-0 space-y-4">
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="今後30日の資金予定"
            title={
              <span className={panelTitleClassName}>今後30日の資金予定</span>
            }
            actions={
              <span className="font-acumin lk-text-6xs text-[#707070] tabular-nums">
                {cashSchedule.from.replaceAll("-", "/")}〜
                {cashSchedule.to.replaceAll("-", "/")}
              </span>
            }
          >
            {[
              {
                title: "入金予定",
                rows: cashSchedule.incoming,
                total: cashSchedule.incomingTotal,
              },
              {
                title: "支払予定",
                rows: cashSchedule.outgoing,
                total: cashSchedule.outgoingTotal,
              },
            ].map((group) => (
              <div key={group.title} className="mt-4">
                <div className="flex items-baseline justify-between gap-2 border-b border-[#d4d4d4] pb-1.5">
                  <span className="font-acumin lk-text-3xs font-medium text-black">
                    {group.title}
                  </span>
                  <span className="font-acumin lk-text-3xs text-black tabular-nums">
                    {currency(group.total)}
                  </span>
                </div>
                {group.rows.length === 0 ? (
                  <p className="mt-2 font-acumin lk-text-4xs text-[#707070]">
                    予定なし
                  </p>
                ) : (
                  group.rows.map((row) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-[#ededed] py-1.5"
                    >
                      <span className="font-acumin lk-text-4xs text-[#474747] tabular-nums">
                        {row.date.replaceAll("-", "/")}
                      </span>
                      <span className="truncate font-acumin lk-text-4xs text-black">
                        {row.partner || "—"}
                      </span>
                      <span className="truncate font-acumin lk-text-4xs text-[#474747]">
                        {row.item}
                      </span>
                      <span className="whitespace-nowrap font-acumin lk-text-4xs text-black tabular-nums">
                        {currency(row.amount)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ))}
            <p className="mt-3 font-acumin lk-text-6xs leading-relaxed text-[#707070]">
              ※
              取引管理に登録済みで、日付が今後30日以内の取引を予定として集計しています。
            </p>
          </Panel>

          {/* 要対応は実データで条件を満たしたものだけを出す。空＝対応不要。 */}
          <Panel
            radius="rounded"
            className="min-w-0"
            aria-label="アクション"
            title={<span className={panelTitleClassName}>アクション</span>}
          >
            {overviewActions.length === 0 ? (
              <p className="flex items-center gap-1.5 font-acumin lk-text-3xs text-[#16844b]">
                <i className="ri-checkbox-circle-line" aria-hidden="true" />
                要対応の項目はありません。
              </p>
            ) : (
              <ul className="-mt-1">
                {overviewActions.map((action) => (
                  <li key={action.key}>
                    <button
                      type="button"
                      onClick={() => setActiveTab(action.target)}
                      className={`flex w-full items-center gap-2 border-b border-[#ededed] px-1 py-2.5 text-left transition-colors hover:bg-[#faf7f2] ${boxRadiusClassName}`}
                    >
                      <i
                        className="ri-error-warning-line shrink-0 text-[#b45309]"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 font-acumin lk-text-3xs text-black">
                        {action.message}
                      </span>
                      <StatusBadge
                        tone="warning"
                        shape="rounded"
                        accent
                        size="3xs"
                        className="shrink-0 font-acumin"
                      >
                        要対応
                      </StatusBadge>
                      <i
                        className="ri-arrow-right-s-line shrink-0 text-[#707070]"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* 中段：財務3表。すべて仕訳の実残高から導出する（架空の係数は使わない）。 */}
      <Panel
        radius="rounded"
        tone="muted"
        aria-label="財務3表"
        title={
          <span className="flex items-center gap-2">
            <span className={panelTitleClassName}>財務3表</span>
            <StatusBadge
              tone="neutral"
              shape="pill"
              size="3xs"
              className="bg-[#ededed] font-acumin tracking-wider text-[#707070]"
            >
              自動連動
            </StatusBadge>
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {/* 構成比は売上高を100%とする。売上原価は期首棚卸＋当期仕入−期末棚卸。 */}
          <StatementTable
            title="損益計算書（P/L）"
            exportLabel="損益計算書CSV"
            onExport={() => handleStatementExport("pl")}
            showRatio
            rows={[
              {
                label: "売上高",
                value: profitAndLoss.sales,
                ratio: ratioOf(profitAndLoss.sales, profitAndLoss.sales),
              },
              {
                label: "売上原価",
                value: -profitAndLoss.costOfSales,
                ratio: ratioOf(-profitAndLoss.costOfSales, profitAndLoss.sales),
              },
              {
                label: "売上総利益",
                value: profitAndLoss.grossProfit,
                ratio: ratioOf(profitAndLoss.grossProfit, profitAndLoss.sales),
                emphasis: true,
              },
              {
                label: "販売費及び一般管理費",
                value: -profitAndLoss.operatingExpenses,
                ratio: ratioOf(
                  -profitAndLoss.operatingExpenses,
                  profitAndLoss.sales,
                ),
              },
              {
                label: "営業利益",
                value: profitAndLoss.operatingProfit,
                ratio: ratioOf(
                  profitAndLoss.operatingProfit,
                  profitAndLoss.sales,
                ),
                emphasis: true,
              },
              {
                label: "当期純利益",
                value: profitAndLoss.netIncome,
                ratio: ratioOf(profitAndLoss.netIncome, profitAndLoss.sales),
                emphasis: true,
              },
            ]}
            aside={
              profitAndLoss.sales > 0 ? (
                <ProfitLadderBar
                  steps={[
                    { label: "売上高", ratio: 100 },
                    {
                      label: "売上総利益",
                      ratio:
                        (profitAndLoss.grossProfit / profitAndLoss.sales) * 100,
                    },
                    {
                      label: "営業利益",
                      ratio:
                        (profitAndLoss.operatingProfit / profitAndLoss.sales) *
                        100,
                    },
                    {
                      label: "当期純利益",
                      ratio:
                        (profitAndLoss.netIncome / profitAndLoss.sales) * 100,
                    },
                  ]}
                />
              ) : undefined
            }
          />
          {/* 構成比は資産合計を100%とする。当期純利益は決算振替前なので純資産に足す。 */}
          <StatementTable
            title="貸借対照表（B/S）"
            exportLabel="貸借対照表CSV"
            onExport={() => handleStatementExport("bs")}
            showRatio
            rows={[
              {
                label: "資産",
                value: balanceSheet.assetTotal,
                ratio: ratioOf(
                  balanceSheet.assetTotal,
                  balanceSheet.assetTotal,
                ),
              },
              {
                label: "負債",
                value: balanceSheet.liabilityTotal,
                ratio: ratioOf(
                  balanceSheet.liabilityTotal,
                  balanceSheet.assetTotal,
                ),
              },
              {
                label: "純資産",
                value: balanceSheet.equityTotal + balanceSheet.netIncome,
                ratio: ratioOf(
                  balanceSheet.equityTotal + balanceSheet.netIncome,
                  balanceSheet.assetTotal,
                ),
              },
            ]}
          >
            <BalanceBars
              assetTotal={balanceSheet.assetTotal}
              liabilityAndEquityTotal={balanceSheet.liabilityAndEquityTotal}
              difference={balanceSheet.difference}
            />
          </StatementTable>
          {/* 直接法なので期首＋増減＝期末が必ず一致する。ずれたら資金科目の判定漏れ。 */}
          <StatementTable
            title="キャッシュ・フロー計算書（C/F）"
            exportLabel="キャッシュフローCSV"
            onExport={() => handleStatementExport("cf")}
            rows={[
              {
                label: "営業キャッシュ・フロー",
                value: cashFlow.operating,
                delta: true,
              },
              {
                label: "投資キャッシュ・フロー",
                value: cashFlow.investing,
                delta: true,
              },
              {
                label: "財務キャッシュ・フロー",
                value: cashFlow.financing,
                delta: true,
              },
              {
                label: "現金増減額",
                value: cashFlowNet,
                delta: true,
                emphasis: true,
              },
            ]}
          >
            <div className="mt-4 border-t border-[#ededed] pt-3">
              <div className="flex items-stretch gap-2">
                <FlowBlock
                  size="sm"
                  label="期首残高"
                  value={cashFlow.openingCash}
                />
                <FlowOperator symbol="→" />
                <FlowBlock
                  size="sm"
                  label="増減額"
                  value={cashFlowNet}
                  display={deltaCurrency(cashFlowNet)}
                  positive
                />
                <FlowOperator symbol="→" />
                <FlowBlock
                  size="sm"
                  label="期末残高"
                  value={cashFlow.closingCash}
                  emphasis
                />
              </div>
              <p
                className={`mt-2 text-center font-acumin lk-text-4xs ${cashFlow.difference === 0 ? "text-[#16844b]" : "text-red-700"}`}
                role="status"
              >
                <i
                  className={`mr-1 ${cashFlow.difference === 0 ? "ri-checkbox-circle-line" : "ri-error-warning-line"}`}
                  aria-hidden="true"
                />
                {cashFlow.difference === 0
                  ? "検算一致"
                  : `検算差額 ${currency(cashFlow.difference)}`}
              </p>
            </div>
          </StatementTable>
        </div>
        <p
          className={`mt-2 font-acumin lk-text-6xs ${cashFlow.difference === 0 ? "text-[#707070]" : "text-red-700"}`}
        >
          {cashFlow.difference === 0
            ? "C/F 検算：期首 + 営業CF + 投資CF + 財務CF = 期末（一致）"
            : `C/F 検算：差額 ${currency(cashFlow.difference)}（不一致）`}
        </p>
      </Panel>

      {/*
        利益がどう積み上がっているかを式のまま見せる。
        年度＝選択中の会計期間の実績、累計＝開業以来（選択年の年末まで）の積み上げ。
        損益計算書は「期間」の表なので年度で切ると開業以来の体力が見えない。
      */}
      <Panel
        radius="rounded"
        className="min-w-0"
        aria-label="利益構造"
        title={<span className={panelTitleClassName}>利益構造</span>}
        actions={
          <div
            className="flex rounded-sm bg-[#f2f2f2] p-0.5"
            role="group"
            aria-label="利益構造の集計期間"
          >
            {(
              [
                ["fiscalYear", "年度"],
                ["cumulative", "累計"],
              ] as const
            ).map(([mode, label]) => {
              const active = profitScopeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setProfitScopeMode(mode)}
                  className={`h-6 rounded-sm px-3 font-acumin lk-text-4xs transition-colors ${
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
        <p className="font-acumin lk-text-4xs text-[#707070]">
          {isCumulativeScope
            ? cumulative.firstYear
              ? `${cumulative.firstYear}年〜${fiscalYear}年（${fiscalYear - cumulative.firstYear + 1}期）・${cumulative.entryCount}件の積み上げ`
              : "取引がまだありません"
            : `${periodSpanLabel}の実績`}
        </p>
        <div className="mt-3 overflow-x-auto">
          <div className="flex flex-col gap-2 lg:min-w-180 lg:flex-row lg:items-stretch">
            <FlowBlock
              label={profitScope.salesLabel}
              value={profitScope.sales}
            />
            <FlowOperator symbol="−" />
            <FlowBlock
              label={profitScope.costOfSalesLabel}
              value={profitScope.costOfSales}
            />
            <FlowOperator symbol="−" />
            <FlowBlock
              label={profitScope.operatingExpensesLabel}
              value={profitScope.operatingExpenses}
            />
            <FlowOperator symbol="＝" />
            <FlowBlock
              label={profitScope.profitLabel}
              value={profitScope.profit}
              emphasis
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-10 gap-y-3 border-t border-[#ededed] pt-4">
          {profitScope.metrics.map((metric) => (
            <div key={metric.label} className="flex items-center gap-2">
              <i
                className={`${metric.icon} lk-text-4xl text-[#474747]`}
                aria-hidden="true"
              />
              <div>
                <span className="block font-acumin lk-text-4xs text-[#474747]">
                  {metric.label}
                </span>
                <span
                  className={`block font-acumin lk-text-lg font-medium tabular-nums ${metric.negative ? "text-red-700" : "text-black"}`}
                >
                  {metric.value}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 下段：何で稼ぎ、何に使っているかの構成比。 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <CompositionCard
          title="売上高構成"
          total={compositionTotal(salesComposition)}
          items={salesComposition}
          emptyMessage="収入がまだ登録されていません。"
        />
        <CompositionCard
          title="売上原価構成"
          total={compositionTotal(costOfSalesComposition)}
          items={costOfSalesComposition}
          emptyMessage="仕入・棚卸がまだ登録されていません。"
        />
        <CompositionCard
          title="販売費及び一般管理費構成"
          total={compositionTotal(sgaComposition)}
          items={sgaComposition}
          emptyMessage="経費がまだ登録されていません。"
        />
      </div>

      {/*
        売上見込みだけを入力する。期首は会計の期間の期首（前の期間からの繰越）から作るので、
        ここでは計算した期首を読み取り専用で示すだけにする（旧の期首の欄は使わない）。
      */}
      <details className={`${panelClassName} ${boxRadiusClassName}`}>
        <summary className="cursor-pointer font-acumin lk-text-sm font-medium tracking-widest text-black">
          財務前提を編集
        </summary>
        <p className="mt-3 font-acumin lk-text-4xs leading-relaxed text-[#707070]">
          期首は会計の期間の期首（前の期間からの繰越）から作ります。ここでは入力しません。持ち込んだ残高は取引として入れてください。売上見込みは資金推移の目標線に使います。
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <label>
            <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
              売上見込み
            </span>
            <input
              type="number"
              min="0"
              value={plan.salesRevenue}
              onChange={(event) =>
                setPlan((current) => ({
                  ...current,
                  salesRevenue: Math.max(0, Number(event.target.value) || 0),
                }))
              }
              className={inputClassName}
              aria-label="売上見込み"
            />
          </label>
          {(
            [
              ["openingCash", "期首現金"],
              ["accountsReceivable", "売掛金"],
              ["fixedAssets", "固定資産"],
              ["accountsPayable", "買掛金・未払金"],
              ["openingCapital", "元入金"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                {label}（期首）
              </span>
              <input
                type="number"
                readOnly
                value={openingSummary[key]}
                className={`${inputClassName} bg-[#f5f5f5] text-[#474747]`}
                aria-label={label}
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            className="font-acumin"
            onClick={() => void handleSavePlan()}
            disabled={isSaving}
          >
            {isSaving ? "保存中..." : "財務前提を保存"}
          </Button>
        </div>
      </details>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        {counterpartyBalancePanel(
          "借入・事業主資金",
          counterpartyBalances.funding,
        )}
        {counterpartyBalancePanel(
          "その他の支払債務",
          counterpartyBalances.payables,
        )}
      </div>

      {/* 資金の増減内訳（直接法）。相手科目ごとの実際の入出金。 */}
      <Panel
        radius="rounded"
        aria-label="資金の増減内訳"
        title={<span className={panelTitleClassName}>資金の増減内訳</span>}
        actions={
          <span className="font-acumin lk-text-4xs text-[#707070]">直接法</span>
        }
      >
        {cashFlow.lines.length === 0 ? (
          <p className="font-acumin lk-text-3xs text-[#707070]">
            現金・預金の入出金がまだありません。
          </p>
        ) : (
          <div className="space-y-4">
            {(
              ["operating", "investing", "financing"] as CashFlowCategory[]
            ).map((category) => {
              const lines = cashFlow.lines.filter(
                (line) => line.category === category,
              );
              if (lines.length === 0) return null;
              return (
                <div key={category}>
                  <p className="font-acumin lk-text-4xs text-[#474747]">
                    {CASH_FLOW_CATEGORY_LABELS[category]}
                  </p>
                  {lines.map((line) => (
                    <div
                      key={`${category}-${line.account}`}
                      className="flex items-center justify-between border-b border-[#ededed] py-2"
                    >
                      <span className="truncate font-acumin lk-text-3xs text-black">
                        {line.account}
                      </span>
                      <span
                        className={`font-acumin lk-text-3xs tabular-nums ${line.amount >= 0 ? "text-[#16844b]" : "text-black"}`}
                      >
                        {currency(line.amount)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-1.5">
                    <span className="font-acumin lk-text-4xs text-[#707070]">
                      小計
                    </span>
                    <span className="font-acumin lk-text-3xs font-medium text-black tabular-nums">
                      {currency(cashFlow[category])}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {stripeSettlementView}
    </div>
  );
}
