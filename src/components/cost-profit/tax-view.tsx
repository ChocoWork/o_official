import { TaxReportSection } from "@/components/tax/TaxReportSection";
import type { CostProfitModel } from "./use-cost-profit-model";

export function TaxView({
  model,
}: {
  model: CostProfitModel;
}): React.JSX.Element {
  const {
    fiscalYear,
    fiscalYearLabel,
    setActiveTab,
    usesEtax,
    setUsesEtax,
    fixedAssets,
    closedAt,
    depreciation,
    journal,
    profitAndLoss,
    balanceSheet,
    handleJournalExport,
    monthlySummary,
    deductionCalc,
    wagesBreakdown,
    familyWagesBreakdown,
    interestBreakdown,
    rentBreakdown,
    professionalFeesBreakdown,
    balanceSheetComparison,
    page1Rows,
    expenseDetailRows,
    handleBlueReturnExport,
    taxEntryCounts,
  } = model;
  // 税務レポートは5枚（税務サマリー／青色申告決算書／税務調整／税務カレンダー／申告資料）。
  // 集計はここまでで済ませ、TaxReportSection は描画だけを受け持つ。
  return (
    <TaxReportSection
      fiscalYear={fiscalYear}
      fiscalYearLabel={fiscalYearLabel}
      journal={journal}
      profitAndLoss={profitAndLoss}
      balanceSheet={balanceSheet}
      balanceSheetComparison={balanceSheetComparison}
      monthlySummary={monthlySummary}
      depreciation={depreciation}
      deduction={deductionCalc}
      page1Rows={page1Rows}
      expenseDetailRows={expenseDetailRows}
      breakdowns={{
        wages: wagesBreakdown,
        familyWages: familyWagesBreakdown,
        interest: interestBreakdown,
        rent: rentBreakdown,
        professionalFees: professionalFeesBreakdown,
      }}
      fixedAssets={fixedAssets}
      closedAt={closedAt}
      entryCounts={taxEntryCounts}
      usesEtax={usesEtax}
      onUsesEtaxChange={setUsesEtax}
      onExportPage={handleBlueReturnExport}
      onExportJournal={handleJournalExport}
      onNavigate={setActiveTab}
    />
  );
}
