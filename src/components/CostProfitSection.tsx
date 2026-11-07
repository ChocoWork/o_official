import { Button } from "@/components/ui/Button/Button";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { ProductCostSection } from "@/components/ProductCostSection";
import {
  type CostProfitTab,
  COST_PROFIT_TABS,
} from "@/components/cost-profit/constants";
import {
  useCostProfitModel,
  type CostProfitProps,
} from "@/components/cost-profit/use-cost-profit-model";
import { PayoutConfirmDialog } from "@/components/cost-profit/stripe-settlement-view";
import { SummaryView } from "@/components/cost-profit/summary-view";
import { ExpensesView } from "@/components/cost-profit/expenses-view";
import { JournalView } from "@/components/cost-profit/journal-view";
import { ProductView } from "@/components/cost-profit/product-view";
import { TaxView } from "@/components/cost-profit/tax-view";

export default function CostProfitSection(props: CostProfitProps) {
  const model = useCostProfitModel(props);
  const {
    fiscalYear,
    fiscalYearOptions,
    onFiscalYearChange,
    activeTab,
    setActiveTab,
    seasonOptions,
    seasonKey,
    setSeasonKey,
    isDataLoading,
    isSaving,
    dataMessage,
    toast,
    setToast,
    loadFinanceData,
  } = model;
  const payoutConfirmDialog = <PayoutConfirmDialog model={model} />;
  const summaryView = <SummaryView model={model} />;
  const expensesView = <ExpensesView model={model} />;
  const journalView = <JournalView model={model} />;
  const productView = <ProductView model={model} />;
  const taxView = <TaxView model={model} />;
  // Legacy JSX remains temporarily for a small rollback window while the new data model is deployed.
  // Evaluating the binding keeps lint honest without rendering or exposing the retired editor.
  void productView;
  return (
    <div className="min-w-0">
      {/* タブ行の右端に同期ステータスと再読み込みを並べる。詳細な文言は右下の Toast へ。 */}
      <div className="mb-5 flex items-end gap-3 border-b border-[#d4d4d4]">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabSegmentControl
            variant="tabs-standard"
            size="sm"
            items={COST_PROFIT_TABS}
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as CostProfitTab)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pb-2">
          {/*
            年度選択。会計期間（暦年）はどのサブタブでもここから切り替える。
            期間が 1/1〜12/31 なので表記は「年度」ではなく「年」。
          */}
          {fiscalYearOptions && onFiscalYearChange ? (
            <SingleSelect
              variant="dropdown"
              size="2xs"
              shape="rounded"
              className="font-acumin"
              aria-label="会計年"
              options={fiscalYearOptions.map((option) => ({
                value: String(option.year),
                label: option.label,
              }))}
              value={String(fiscalYear)}
              onValueChange={(value) => onFiscalYearChange(Number(value))}
            />
          ) : null}
          {/*
            状態は色の付いた小さな丸＋短いラベルだけ。詳細は右下の Toast へ。
            height="control" で年度選択・更新ボタンと同じ φ 式の高さに揃える。
          */}
          <StatusBadge
            shape="rounded"
            size="2xs"
            height="control"
            className={`font-acumin ${dataMessage ? "text-red-700" : "text-[#16844b]"}`}
          >
            <span className="inline-flex items-center gap-1.5" role="status">
              <StatusBadge
                variant="dot"
                tone={
                  isDataLoading
                    ? "neutral"
                    : dataMessage
                      ? "danger"
                      : "positive"
                }
                accent={!isDataLoading}
                size="4xs"
              />
              {isDataLoading
                ? "読み込み中"
                : dataMessage
                  ? "同期エラー"
                  : "同期済み"}
            </span>
          </StatusBadge>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            onClick={() => void loadFinanceData()}
            disabled={isDataLoading || isSaving}
          >
            <i className="ri-refresh-line mr-1" aria-hidden="true" />
            更新
          </Button>
        </div>
      </div>
      {activeTab === "summary" ? summaryView : null}
      {activeTab === "expenses" ? expensesView : null}
      {activeTab === "journal" ? journalView : null}
      {activeTab === "products" ? (
        <ProductCostSection
          seasonKey={seasonKey}
          seasonOptions={seasonOptions}
          onSeasonChange={setSeasonKey}
        />
      ) : null}
      {activeTab === "tax" ? taxView : null}
      {payoutConfirmDialog}

      {/* エラー・完了の詳細は画面右下の Toast に出す。成功は自動で消し、エラーは操作で閉じる。
          読み上げの入れ物は常に置き、エラーは割り込み・完了は順番待ちで読む（FREQ-376）。
          トーストが出ている方だけが中身と data-testid を持つ */}
      <LiveMessage
        as="div"
        data-testid={toast?.variant === "error" ? "finance-toast" : undefined}
        className="fixed bottom-4 right-4 z-50 max-w-[min(92vw,420px)]"
      >
        {toast?.variant === "error" ? (
          <ToastSnackbar
            message={toast.message}
            variant="error"
            actionLabel="閉じる"
            onAction={() => setToast(null)}
          />
        ) : null}
      </LiveMessage>
      <LiveMessage
        as="div"
        politeness="polite"
        data-testid={toast && toast.variant !== "error" ? "finance-toast" : undefined}
        className="fixed bottom-4 right-4 z-50 max-w-[min(92vw,420px)]"
      >
        {toast && toast.variant !== "error" ? (
          <ToastSnackbar
            message={toast.message}
            variant={toast.variant}
            actionLabel="閉じる"
            onAction={() => setToast(null)}
          />
        ) : null}
      </LiveMessage>
    </div>
  );
}
