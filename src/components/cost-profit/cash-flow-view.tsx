import { Panel } from "@/components/ui/Panel/Panel";
import {
  CASH_FLOW_CATEGORY_LABELS,
  type CashFlowCategory,
} from "@/lib/finance/cash-flow";
import { currency, deltaCurrency, panelTitleClassName } from "./constants";
import { MetricCard, FlowBlock, FlowOperator } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

export function CashFlowView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    cashFlow,
    cashFlowNet,
  } = model;
  return (
    <Panel
      radius="rounded"
      headingLevel={4}
      aria-label="キャッシュフロー計算書 詳細"
      title={
        <span className={panelTitleClassName}>
          キャッシュフロー計算書 詳細（直接法）
        </span>
      }
      actions={
        <span
          className={`font-acumin lk-text-4xs ${cashFlow.difference === 0 ? "text-[#707070]" : "text-red-700"}`}
        >
          {cashFlow.difference === 0
            ? "検算：期首 + 各活動 = 期末（一致）"
            : `検算差額 ${currency(cashFlow.difference)}`}
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 overflow-x-auto rounded-md border border-[#d4d4d4]">
          <table className="w-full min-w-130 border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {["区分", "科目", "金額（円）"].map((heading, index) => (
                  <th
                    key={heading}
                    className={`px-2 py-2 font-acumin lk-text-4xs font-normal text-[#474747] ${
                      index < 2 ? "text-left" : "text-right"
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                Object.keys(CASH_FLOW_CATEGORY_LABELS) as CashFlowCategory[]
              ).flatMap((category) => {
                const lines = cashFlow.lines.filter(
                  (line) => line.category === category,
                );
                if (lines.length === 0) return [];
                return [
                  ...lines.map((line) => (
                    <tr
                      key={`${category}-${line.account}`}
                      className="border-b border-[#ededed]"
                    >
                      <td className="whitespace-nowrap px-2 py-2 font-acumin lk-text-4xs text-[#707070]">
                        {CASH_FLOW_CATEGORY_LABELS[category]}
                      </td>
                      <td className="px-2 py-2 font-acumin lk-text-3xs text-black">
                        {line.account}
                      </td>
                      <td
                        className={`whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs tabular-nums ${
                          line.amount >= 0 ? "text-[#16844b]" : "text-red-700"
                        }`}
                      >
                        {deltaCurrency(line.amount).replace("¥", "")}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          <MetricCard
            label="営業キャッシュ・フロー"
            value={deltaCurrency(cashFlow.operating)}
            note="本業の資金"
            positive={cashFlow.operating >= 0}
          />
          <MetricCard
            label="投資キャッシュ・フロー"
            value={deltaCurrency(cashFlow.investing)}
            note="設備・資産"
            positive={cashFlow.investing >= 0}
          />
          <MetricCard
            label="財務キャッシュ・フロー"
            value={deltaCurrency(cashFlow.financing)}
            note="借入・元入"
            positive={cashFlow.financing >= 0}
          />
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
        </div>
      </div>
    </Panel>
  );
}
