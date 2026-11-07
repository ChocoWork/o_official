import { Panel } from "@/components/ui/Panel/Panel";
import {
  currency,
  signedCurrency,
  percent,
  panelTitleClassName,
} from "./constants";
import { MetricCard } from "./shared-ui";
import type { CostProfitModel } from "./use-cost-profit-model";

export function ProfitAndLossView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYearLabel,
    profitAndLoss,
  } = model;
  return (
    <Panel
      radius="rounded"
      headingLevel={4}
      aria-label="損益計算書 詳細"
      title={<span className={panelTitleClassName}>損益計算書 詳細</span>}
      actions={
        <span className="font-acumin lk-text-4xs text-[#707070]">
          {fiscalYearLabel} 累計 / 構成比は売上高を100%とする
        </span>
      }
    >
      <div className="overflow-hidden rounded-md border border-[#d4d4d4]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-155 border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {["決算書区分", "科目", "金額（円）", "構成比"].map(
                  (heading, index) => (
                    <th
                      key={heading}
                      className={`px-2 py-2 font-acumin lk-text-4xs font-normal text-[#474747] ${
                        index < 2 ? "text-left" : "text-right"
                      }`}
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {profitAndLoss.sections.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-2 py-4 font-acumin lk-text-3xs text-[#707070]"
                  >
                    取引管理に取引を入力すると、損益計算書が作成されます。
                  </td>
                </tr>
              ) : (
                profitAndLoss.sections.flatMap((section) => [
                  ...section.lines.map((line) => (
                    <tr
                      key={`${section.section}-${line.account.code}`}
                      className="border-b border-[#ededed]"
                    >
                      <td className="whitespace-nowrap px-2 py-2 font-acumin lk-text-4xs text-[#707070]">
                        {section.section}
                      </td>
                      <td className="px-2 py-2 font-acumin lk-text-3xs text-black">
                        {line.account.name}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-black tabular-nums">
                        {line.amount.toLocaleString("ja-JP")}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                        {profitAndLoss.sales === 0
                          ? "—"
                          : percent((line.amount / profitAndLoss.sales) * 100)}
                      </td>
                    </tr>
                  )),
                  <tr
                    key={`${section.section}-total`}
                    className="border-b border-[#d4d4d4] bg-[#fafafa]"
                  >
                    <td className="whitespace-nowrap px-2 py-2 font-acumin lk-text-4xs text-[#474747]">
                      {section.section}
                    </td>
                    <td className="px-2 py-2 font-acumin lk-text-3xs font-medium text-black">
                      小計
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                      {section.total.toLocaleString("ja-JP")}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right font-acumin lk-text-3xs text-[#474747] tabular-nums">
                      {profitAndLoss.sales === 0
                        ? "—"
                        : percent((section.total / profitAndLoss.sales) * 100)}
                    </td>
                  </tr>,
                ])
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="売上（収入）金額"
          value={currency(profitAndLoss.sales)}
          note={fiscalYearLabel}
        />
        <MetricCard
          label="差引金額（売上総利益）"
          value={currency(profitAndLoss.grossProfit)}
          note="売上 − 売上原価"
        />
        <MetricCard
          label="経費"
          value={currency(profitAndLoss.operatingExpenses)}
          note="減価償却費を含む"
        />
        <MetricCard
          label="当期純利益"
          value={signedCurrency(profitAndLoss.netIncome)}
          note="決算振替前"
          positive={profitAndLoss.netIncome >= 0}
        />
      </div>
    </Panel>
  );
}
