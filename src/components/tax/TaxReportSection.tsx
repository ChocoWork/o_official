// 税務レポート。5枚のタブで「申告の全体像 → 決算書 → 調整 → 期限 → 資料」を辿る。
//
// 税務サマリー   ＝ 今どこにいるか（税額・準備率・要対応・期限）
// 青色申告決算書 ＝ 提出する数字そのもの（1P〜4P）
// 税務調整       ＝ 会計利益と課税所得のズレ
// 税務カレンダー ＝ いつまでに何をするか
// 申告資料       ＝ 何を揃えるか

import { useState } from "react";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { BlueReturnView } from "@/components/tax/BlueReturnView";
import { FilingDocumentsView } from "@/components/tax/FilingDocumentsView";
import { TaxAdjustmentView } from "@/components/tax/TaxAdjustmentView";
import { TaxCalendarView } from "@/components/tax/TaxCalendarView";
import { TaxSummaryView } from "@/components/tax/TaxSummaryView";
import type { TaxReportProps } from "@/components/tax/types";

type TaxTab =
  | "summary"
  | "blueReturn"
  | "adjustment"
  | "calendar"
  | "documents";

const TAX_TABS: Array<{ key: TaxTab; label: string }> = [
  { key: "summary", label: "税務サマリー" },
  { key: "blueReturn", label: "青色申告決算書" },
  { key: "adjustment", label: "税務調整" },
  { key: "calendar", label: "税務カレンダー" },
  { key: "documents", label: "申告資料" },
];

export function TaxReportSection(props: TaxReportProps) {
  const [tab, setTab] = useState<TaxTab>("summary");

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <TabSegmentControl
          variant="tabs-standard"
          size="sm"
          items={TAX_TABS}
          activeKey={tab}
          onChange={(key) => setTab(key as TaxTab)}
        />
      </div>

      {tab === "summary" ? (
        <TaxSummaryView {...props} onOpenBlueReturn={() => setTab("blueReturn")} />
      ) : null}
      {tab === "blueReturn" ? <BlueReturnView {...props} /> : null}
      {tab === "adjustment" ? <TaxAdjustmentView {...props} /> : null}
      {tab === "calendar" ? <TaxCalendarView {...props} /> : null}
      {tab === "documents" ? <FilingDocumentsView {...props} /> : null}
    </div>
  );
}
