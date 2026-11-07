import { Button } from "@/components/ui/Button/Button";
import { ACCOUNT_TYPE_LABELS, currency, panelClassName } from "./constants";
import type { CostProfitModel } from "./use-cost-profit-model";

export function TrialBalanceView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    trialBalance,
    handleTrialBalanceExport,
  } = model;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className={`font-acumin lk-text-3xs ${trialBalance.isBalanced ? "text-[#16844b]" : "text-red-700"}`}
          role="status"
        >
          <i
            className={`mr-1.5 ${trialBalance.isBalanced ? "ri-checkbox-circle-fill" : "ri-error-warning-fill"}`}
            aria-hidden="true"
          />
          {trialBalance.isBalanced
            ? "貸借一致（借方合計 = 貸方合計）"
            : `貸借不一致：差額 ${currency(trialBalance.difference)}`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          shape="rounded"
          className="font-acumin"
          onClick={handleTrialBalanceExport}
        >
          <i className="ri-download-line mr-1.5" aria-hidden="true" />
          試算表CSV
        </Button>
      </div>
      <div className={`${panelClassName} min-w-0 rounded-md`}>
        <div className="overflow-x-auto rounded-md border border-[#d4d4d4]">
          <table className="w-full min-w-205 border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                {[
                  "コード",
                  "勘定科目",
                  "会計区分",
                  "借方合計",
                  "貸方合計",
                  "借方残高",
                  "貸方残高",
                ].map((heading) => (
                  <th
                    key={heading}
                    className="px-2 py-2 text-left font-acumin lk-text-4xs font-normal text-[#474747]"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trialBalance.rows.map((row) => (
                <tr
                  key={row.account.code}
                  className="border-b border-[#ededed]"
                >
                  <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-4xs text-[#474747]">
                    {row.account.code}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                    {row.account.name}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-4xs text-[#474747]">
                    {ACCOUNT_TYPE_LABELS[row.account.type]}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                    {row.debitTotal > 0 ? currency(row.debitTotal) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                    {row.creditTotal > 0 ? currency(row.creditTotal) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                    {row.debitBalance > 0 ? currency(row.debitBalance) : "—"}
                  </td>
                  <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                    {row.creditBalance > 0 ? currency(row.creditBalance) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-black">
                <td
                  colSpan={3}
                  className="px-2 py-2 font-acumin lk-text-3xs font-medium text-black"
                >
                  合計
                </td>
                <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                  {currency(trialBalance.debitTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                  {currency(trialBalance.creditTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                  {currency(trialBalance.debitBalanceTotal)}
                </td>
                <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                  {currency(trialBalance.creditBalanceTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
