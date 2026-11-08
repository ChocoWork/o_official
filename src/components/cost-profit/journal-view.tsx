import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { type LedgerTab, LEDGER_TABS } from "./constants";
import { LedgerView } from "./ledger-view";
import { AssetsView } from "./assets-view";
import { StatementsView } from "./statements-view";
import type { CostProfitModel } from "./use-cost-profit-model";

export function JournalView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    ledgerTab,
    setLedgerTab,
  } = model;
  const ledgerView = <LedgerView model={model} />;
  const assetsView = <AssetsView model={model} />;
  const statementsView = <StatementsView model={model} />;
  return (
    <div className="space-y-4">
      {/* 主要簿（仕訳・元帳）／固定資産／決算・試算表。入力は取引管理に一本化する。 */}
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="segment-pill"
          size="sm"
          items={LEDGER_TABS}
          activeKey={ledgerTab}
          onChange={(key) => setLedgerTab(key as LedgerTab)}
        />
      </div>

      {ledgerTab === "ledger" ? ledgerView : null}
      {ledgerTab === "assets" ? assetsView : null}
      {ledgerTab === "closing" ? statementsView : null}
    </div>
  );
}
