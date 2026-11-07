import { Button } from "@/components/ui/Button/Button";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import {
  type StatementTab,
  STATEMENT_TABS,
  type ComparisonBasis,
  COMPARISON_TABS,
} from "./constants";
import { ClosingView } from "./closing-view";
import { TrialBalanceView } from "./trial-balance-view";
import { BalanceSheetView } from "./balance-sheet-view";
import { ProfitAndLossView } from "./profit-and-loss-view";
import { CashFlowView } from "./cash-flow-view";
import type { CostProfitModel } from "./use-cost-profit-model";

export function StatementsView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    statementTab,
    setStatementTab,
    comparisonBasis,
    setComparisonBasis,
    syncedAt,
    handleTrialBalanceExport,
    handleStatementExport,
  } = model;
  const closingView = <ClosingView model={model} />;
  const trialBalanceView = <TrialBalanceView model={model} />;
  const balanceSheetView = <BalanceSheetView model={model} />;
  const profitAndLossView = <ProfitAndLossView model={model} />;
  const cashFlowView = <CashFlowView model={model} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-acumin lk-text-lg font-medium tracking-widest text-black">
          決算・試算表
        </h3>
        <span className="font-acumin lk-text-4xs text-[#707070] tabular-nums">
          {syncedAt
            ? `最終更新：${new Date(syncedAt).toLocaleString("ja-JP")}（自動照合）`
            : "（自動照合）"}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto">
          <TabSegmentControl
            variant="tabs-standard"
            size="2xs"
            items={STATEMENT_TABS}
            activeKey={statementTab}
            onChange={(key) => setStatementTab(key as StatementTab)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statementTab === "bs" ? (
            <TabSegmentControl
              variant="segment-pill"
              size="3xs"
              items={COMPARISON_TABS}
              activeKey={comparisonBasis}
              onChange={(key) => setComparisonBasis(key as ComparisonBasis)}
            />
          ) : null}
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            aria-label="表示中のCSV出力"
            onClick={() => {
              if (statementTab === "pl") handleStatementExport("pl");
              else if (statementTab === "cf") handleStatementExport("cf");
              else if (statementTab === "bs") handleStatementExport("bs");
              else handleTrialBalanceExport();
            }}
          >
            CSV出力
            <i className="ri-download-2-line ml-1" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            className="font-acumin"
            aria-label="財務諸表CSV"
            onClick={() =>
              handleStatementExport(
                statementTab === "pl"
                  ? "pl"
                  : statementTab === "cf"
                    ? "cf"
                    : "bs",
              )
            }
          >
            財務諸表出力
            <i className="ri-file-list-3-line ml-1" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {statementTab === "bs" ? balanceSheetView : null}
      {statementTab === "pl" ? profitAndLossView : null}
      {statementTab === "cf" ? cashFlowView : null}
      {statementTab === "trial" ? trialBalanceView : null}
      {statementTab === "closing" ? closingView : null}
    </div>
  );
}
