// 会計の期間の範囲（設計 11-e。I/O なし）。帳簿・決算書は直接書いた1月1日・12月31日でなく、期間の端で数える。

import { addDays, parseIsoDate, type AccountingPeriod } from "@/lib/accounting/period";
import { splitPeriodByMonth } from "@/lib/accounting/period-months";

export type PeriodBounds = Pick<AccountingPeriod, "startsOn" | "endsOn">;

/** 日本時間のその日の 0 時を UTC の ISO 文字列にする（DB の timestamptz の絞りに使う）。 */
export function jstStartOfDayIso(date: string): string {
  parseIsoDate(date);
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

/**
 * 期間の範囲。`from`・`to` は日付、`toExclusiveIso` は終わりの次の日の 0 時（日本時間）を UTC にしたもの。
 * timestamptz は `>= jstStartOfDayIso(from)` かつ `< toExclusiveIso` で絞る。
 */
export function periodRangeOf(period: PeriodBounds): {
  from: string;
  to: string;
  toExclusiveIso: string;
} {
  parseIsoDate(period.startsOn);
  parseIsoDate(period.endsOn);
  if (period.startsOn > period.endsOn) {
    throw new RangeError("startsOn must not be after endsOn");
  }
  return {
    from: period.startsOn,
    to: period.endsOn,
    toExclusiveIso: jstStartOfDayIso(addDays(period.endsOn, 1)),
  };
}

/** 日付（`YYYY-MM-DD`、日時なら先頭の10文字）が期間に入るか。 */
export function isDateInPeriod(date: string, period: PeriodBounds): boolean {
  const day = date.slice(0, 10);
  return day >= period.startsOn && day <= period.endsOn;
}

export type PeriodMonth = {
  /** `YYYY-MM` */
  key: string;
  /** 暦の月（1〜12） */
  month: number;
  /** 横軸の見出し。暦年に収まる期間は `7月`、年をまたぐ期間は `2027年7月`。 */
  label: string;
  startsOn: string;
  endsOn: string;
};

/** 期間を暦の月で区切り、見出しを付ける（11-e2 の `splitPeriodByMonth` の上に載せる）。 */
export function periodMonthsOf(period: PeriodBounds): PeriodMonth[] {
  const slices = splitPeriodByMonth(period.startsOn, period.endsOn);
  const crossesYear =
    period.startsOn.slice(0, 4) !== period.endsOn.slice(0, 4);
  return slices.map((slice) => {
    const month = Number.parseInt(slice.key.slice(5, 7), 10);
    return {
      key: slice.key,
      month,
      label: crossesYear ? `${slice.key.slice(0, 4)}年${month}月` : `${month}月`,
      startsOn: slice.startsOn,
      endsOn: slice.endsOn,
    };
  });
}

/** 期間の月の何番目に日付が入るか。期間の外は -1。 */
export function periodMonthIndexOf(
  months: readonly PeriodMonth[],
  date: string,
): number {
  const day = date.slice(0, 10);
  return months.findIndex(
    (month) => day >= month.startsOn && day <= month.endsOn,
  );
}
