import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import type { AccountingPeriod } from "@/lib/accounting/period";

/**
 * 会計の期間の選択（FREQ-555）。新しい期間を先頭に並べる。
 * 値は親が持つ選択、未選択なら読み込んだ期間、どちらも無ければ一番新しい期間。
 */
export function PeriodPicker({
  periods,
  value,
  onChange,
}: {
  periods: readonly AccountingPeriod[];
  value: string | null;
  onChange: (periodId: string) => void;
}) {
  if (periods.length === 0) return null;
  const options = [...periods]
    .sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1))
    .map((period) => ({ value: period.id, label: period.name }));
  return (
    <SingleSelect
      variant="dropdown"
      size="2xs"
      shape="rounded"
      className="font-acumin"
      aria-label="会計期間"
      options={options}
      value={value ?? options[0].value}
      onValueChange={(next) => onChange(next)}
    />
  );
}
