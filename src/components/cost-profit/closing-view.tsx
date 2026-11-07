import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { currency, inputClassName, panelClassName } from "./constants";
import type { CostProfitModel } from "./use-cost-profit-model";

export function ClosingView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    fiscalYearLabel,
    adjustment,
    setAdjustment,
    closedAt,
    closingMessage,
    businessType,
    isSaving,
    depreciation,
    closingEntries,
    carryForwardCheck,
    carryForwardRows,
    handleSaveClosing,
    handleFinalizeClosing,
    handleReopenClosing,
  } = model;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <div className={`${panelClassName} rounded-md`}>
            <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
              決算整理の内訳（{fiscalYearLabel}）
            </h4>
            <div className="mt-3 overflow-x-auto rounded-md border border-[#d4d4d4]">
              <table className="w-full min-w-140 border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["決算整理", "借方", "貸方", "金額"].map((heading) => (
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
                  {closingEntries.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-2 py-4 font-acumin lk-text-3xs text-[#707070]"
                      >
                        決算整理仕訳はまだありません。固定資産の登録と実地棚卸の入力で自動生成されます。
                      </td>
                    </tr>
                  ) : (
                    closingEntries.map((entry) => {
                      const debitLine = entry.lines.find(
                        (line) => line.debit > 0,
                      );
                      const creditLine = entry.lines.find(
                        (line) => line.credit > 0,
                      );
                      return (
                        <tr
                          key={entry.number}
                          className="border-b border-[#ededed]"
                        >
                          <td className="px-2 py-3 font-acumin lk-text-3xs text-black">
                            {entry.description}
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                            {debitLine?.account.name ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                            {creditLine?.account.name ?? "—"}
                          </td>
                          <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                            {currency(creditLine?.credit ?? 0)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={`${panelClassName} rounded-md`}>
            <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
              翌年度（{fiscalYear + 1}年）へ繰り越す期首残高
            </h4>
            <p className="mt-1 font-acumin lk-text-6xs leading-relaxed text-[#707070]">
              損益科目は0にし、
              {businessType === "soleProprietor"
                ? "元入金 = 当年元入金 + 当期純利益 + 事業主借 − 事業主貸 として事業主貸借を精算します。"
                : "当期純利益を繰越利益剰余金へ振り替えます。"}
            </p>
            <div className="mt-3 overflow-x-auto rounded-md border border-[#d4d4d4]">
              <table className="w-full min-w-105 border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    {["コード", "勘定科目", "借方", "貸方"].map((heading) => (
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
                  {carryForwardRows.map((row) => (
                    <tr key={row.code} className="border-b border-[#ededed]">
                      <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-4xs text-[#474747]">
                        {row.code}
                      </td>
                      <td className="whitespace-nowrap px-2 py-3 font-acumin lk-text-3xs text-black">
                        {row.name}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                        {row.debit > 0 ? currency(row.debit) : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-acumin lk-text-3xs text-black tabular-nums">
                        {row.credit > 0 ? currency(row.credit) : "—"}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-black">
                    <td
                      colSpan={2}
                      className="px-2 py-2 font-acumin lk-text-3xs font-medium text-black"
                    >
                      合計
                    </td>
                    <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                      {currency(carryForwardCheck.debitTotal)}
                    </td>
                    <td className="px-2 py-2 text-right font-acumin lk-text-3xs font-medium text-black tabular-nums">
                      {currency(carryForwardCheck.creditTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p
              className={`mt-3 font-acumin lk-text-3xs ${carryForwardCheck.isBalanced ? "text-[#16844b]" : "text-red-700"}`}
              role="status"
            >
              <i
                className={`mr-1.5 ${carryForwardCheck.isBalanced ? "ri-checkbox-circle-fill" : "ri-error-warning-fill"}`}
                aria-hidden="true"
              />
              {carryForwardCheck.isBalanced
                ? "翌年度期首の貸借が一致（翌年期首BS = 当年期末BS）"
                : `翌年度期首の貸借が不一致：差額 ${currency(carryForwardCheck.debitTotal - carryForwardCheck.creditTotal)}`}
            </p>
          </div>
        </div>

        <aside
          className={`${panelClassName} h-fit rounded-md **:data-ui-button:rounded-md! [&_input]:rounded-md`}
        >
          <h4 className="font-acumin lk-text-sm font-medium tracking-widest text-black">
            決算整理を入力
          </h4>
          <p className="mt-1 font-acumin lk-text-6xs text-[#707070]">
            期首棚卸高は前年度の期末棚卸高が自動で引き継がれます。
          </p>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                期末商品（製品）棚卸高
              </span>
              <input
                type="number"
                min="0"
                aria-label="期末商品棚卸高"
                value={adjustment.closingInventoryGoods || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    closingInventoryGoods: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                期末材料棚卸高
              </span>
              <input
                type="number"
                min="0"
                aria-label="期末材料棚卸高"
                value={adjustment.closingInventoryMaterials || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    closingInventoryMaterials: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">
                貸倒引当金繰入額
              </span>
              <input
                type="number"
                min="0"
                aria-label="貸倒引当金繰入額"
                value={adjustment.allowanceForDoubtful || ""}
                onChange={(event) =>
                  setAdjustment((current) => ({
                    ...current,
                    allowanceForDoubtful: Math.max(
                      0,
                      Math.round(Number(event.target.value) || 0),
                    ),
                  }))
                }
                className={inputClassName}
                placeholder="0"
                disabled={Boolean(closedAt)}
              />
            </label>

            <div className="border-t border-[#d4d4d4] pt-3">
              <div className="flex items-center justify-between">
                <span className="font-acumin lk-text-4xs text-[#474747]">
                  減価償却費（自動）
                </span>
                <span className="font-acumin lk-text-3xs text-black tabular-nums">
                  {currency(depreciation.businessExpenseTotal)}
                </span>
              </div>
              <p className="mt-1 font-acumin lk-text-6xs text-[#707070]">
                固定資産台帳から自動計算されます。
              </p>
            </div>

            {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-377） */}
            <LiveMessage
              politeness="status"
              className={`font-acumin lk-text-3xs ${/失敗|ください|一致し/.test(closingMessage ?? "") ? "text-red-700" : "text-[#16844b]"}`}
            >
              {closingMessage}
            </LiveMessage>

            {closedAt ? (
              <>
                <p className="font-acumin lk-text-3xs text-[#16844b]">
                  <i className="ri-lock-line mr-1.5" aria-hidden="true" />
                  {new Date(closedAt).toLocaleDateString("ja-JP")}
                  に決算を確定済み
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  shape="rounded"
                  className="w-full font-acumin"
                  onClick={() => void handleReopenClosing()}
                  disabled={isSaving}
                >
                  決算を解除して修正する
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  shape="rounded"
                  className="w-full font-acumin"
                  onClick={() => void handleSaveClosing()}
                  disabled={isSaving}
                >
                  決算整理を保存
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  shape="rounded"
                  className="w-full font-acumin"
                  onClick={() => void handleFinalizeClosing()}
                  disabled={isSaving || !carryForwardCheck.isBalanced}
                >
                  {isSaving ? "処理中..." : `${fiscalYearLabel}を締める`}
                </Button>
                <p className="font-acumin lk-text-6xs leading-relaxed text-[#707070]">
                  締めると期末残高が確定し、翌年度の期首残高になります。以後は取引の変更が決算書へ反映されません。
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
