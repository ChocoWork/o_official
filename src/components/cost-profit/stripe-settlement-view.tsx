import { useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { Panel } from "@/components/ui/Panel/Panel";
import { TextField } from "@/components/ui/TextField/TextField";
import { useAccountingPermissions } from "./accounting-api";
import { BalanceTopupForm } from "./balance-topup-form";
import { DisputeList } from "./dispute-list";
import { InvoiceRecordForm } from "./reconciliation-view";
import {
  payoutConfirmBlockReason,
  currency,
  panelTitleClassName,
} from "./constants";
import type { CostProfitModel } from "./use-cost-profit-model";

/** 月ごとの Stripe の適格請求書の記録。月を選ぶと、その月の合計を入れる欄が出る。 */
function InvoiceMonthSection(): React.JSX.Element {
  const [month, setMonth] = useState("");
  return (
    <div className="space-y-2 border-t border-[#ededed] pt-4">
      <label className="block max-w-xs">
        <span className="mb-1 block font-acumin lk-text-4xs text-[#474747]">請求書を記録する月</span>
        <input
          type="month"
          className="h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 font-acumin lk-text-sm text-black focus:border-black focus:outline-none"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </label>
      {month ? <InvoiceRecordForm key={month} month={month} /> : null}
    </div>
  );
}

/** Stripe の精算に足す、残高の補充の入力・請求書の記録・カード会社からの支払いの取り消しの一覧（計画2）。 */
function StripeAccountingTools(): React.JSX.Element {
  const { permissions, error } = useAccountingPermissions();
  return (
    <div className="space-y-4 border-t border-[#d4d4d4] pt-4">
      <BalanceTopupForm
        canManage={permissions === null ? null : permissions.manageFinance}
        loadError={error}
      />
      <InvoiceMonthSection />
      <DisputeList />
    </div>
  );
}

export function StripeSettlementView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    stripeAccounting,
    setConfirmingPayout,
    setBankArrivalDate,
    setPayoutConfirmError,
  } = model;
  return (
    <Panel
      radius="rounded"
      className="min-w-0"
      aria-label="Stripe精算"
      title={<span className={panelTitleClassName}>Stripe精算</span>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-sm bg-[#f7f7f7] px-3 py-2">
            <p className="font-acumin lk-text-6xs text-[#707070]">
              Stripe決済残高
            </p>
            <p className="font-acumin lk-text-lg text-[#111111]">
              {currency(stripeAccounting.summary.stripeBalance)}
            </p>
          </div>
          <div className="rounded-sm bg-[#f7f7f7] px-3 py-2">
            <p className="font-acumin lk-text-6xs text-[#707070]">
              Stripe入金途上
            </p>
            <p className="font-acumin lk-text-lg text-[#111111]">
              {currency(stripeAccounting.summary.inTransitBalance)}
            </p>
          </div>
        </div>
        {stripeAccounting.summary.unmatchedPayoutCount > 0 ? (
          <p className="font-acumin lk-text-4xs text-[#b45309]">
            照合できていないPayoutが
            {stripeAccounting.summary.unmatchedPayoutCount}件あります。
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-180 border-collapse font-acumin lk-text-4xs">
            <thead>
              <tr className="border-b border-[#e5e5e5] text-left text-[#707070]">
                <th scope="col" className="px-2 py-1.5">
                  Payout ID
                </th>
                <th scope="col" className="px-2 py-1.5 text-right">
                  金額
                </th>
                <th scope="col" className="px-2 py-1.5">
                  Stripe状態
                </th>
                <th scope="col" className="px-2 py-1.5">
                  予定着金日
                </th>
                <th scope="col" className="px-2 py-1.5">
                  照合
                </th>
                <th scope="col" className="px-2 py-1.5">
                  銀行確認
                </th>
                <th scope="col" className="px-2 py-1.5">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {stripeAccounting.payouts.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-2 py-3 text-center text-[#707070]"
                  >
                    Payoutはまだありません。
                  </td>
                </tr>
              ) : (
                stripeAccounting.payouts.map((payout) => {
                  const blockReason = payoutConfirmBlockReason(payout);
                  return (
                    <tr
                      key={payout.id}
                      className="border-b border-[#f0f0f0] text-[#111111]"
                    >
                      <td className="px-2 py-1.5">{payout.id}</td>
                      <td className="px-2 py-1.5 text-right">
                        {currency(payout.amount)}
                      </td>
                      <td className="px-2 py-1.5">{payout.status}</td>
                      <td className="px-2 py-1.5">
                        {payout.arrival_date ?? "-"}
                      </td>
                      <td className="px-2 py-1.5">
                        {payout.reconciliation_status === "matched"
                          ? "照合済み"
                          : "照合未完了"}
                      </td>
                      <td className="px-2 py-1.5">
                        {payout.bank_arrival_date ?? "未確認"}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            shape="rounded"
                            className="font-acumin"
                            disabled={blockReason !== null}
                            aria-label={`Payout ${payout.id} の銀行着金を確認`}
                            onClick={() => {
                              setConfirmingPayout(payout);
                              setBankArrivalDate(payout.arrival_date ?? "");
                              setPayoutConfirmError(null);
                            }}
                          >
                            銀行着金を確認
                          </Button>
                          {blockReason ? (
                            <span className="lk-text-6xs text-[#707070]">
                              {blockReason}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <StripeAccountingTools />
      </div>
    </Panel>
  );
}

export function PayoutConfirmDialog({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    confirmingPayout,
    setConfirmingPayout,
    bankArrivalDate,
    setBankArrivalDate,
    payoutConfirmError,
    isConfirmingPayout,
    confirmPayoutArrival,
  } = model;
  return (
    <Dialog
      open={confirmingPayout !== null}
      onClose={() => setConfirmingPayout(null)}
      shape="rounded"
      size="sm"
      title="銀行着金の確認"
      description={
        confirmingPayout
          ? `Payout ${confirmingPayout.id}（${currency(confirmingPayout.amount)}）の着金日を記録します。`
          : ""
      }
    >
      <div className="space-y-3">
        <TextField
          type="date"
          label="銀行着金日"
          value={bankArrivalDate}
          onChange={(event) => setBankArrivalDate(event.target.value)}
        />
        {payoutConfirmError ? (
          <p className="font-acumin lk-text-4xs text-[#b91c1c]">
            {payoutConfirmError}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="secondary"
            size="sm"
            shape="rounded"
            className="font-acumin"
            onClick={() => setConfirmingPayout(null)}
          >
            キャンセル
          </Button>
          <Button
            variant="primary"
            size="sm"
            shape="rounded"
            className="font-acumin"
            disabled={isConfirmingPayout || bankArrivalDate === ""}
            onClick={() => void confirmPayoutArrival()}
          >
            着金を確定
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
