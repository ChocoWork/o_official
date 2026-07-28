// 会計期間（暦年 1/1〜12/31）のヘルパー。
// 個人事業主の課税期間は暦年固定なので、帳簿・税務レポート・財務概要は
// すべてこの軸で切る。シーズン（S/S・A/W）は商品原価専用の分析軸で、
// A/W が 10月〜翌3月と暦年をまたぐため会計期間には使えない。

/**
 * 表示対象の最初の会計期間。これ以前は年度選択に出さない。
 * 2025年から費用が発生しているため、2025年を起点にする。
 */
export const FIRST_FISCAL_YEAR = 2025;

/** 現在（JST）の暦年。 */
export function currentFiscalYear(now: Date = new Date()): number {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
  }).format(now);
  return Number.parseInt(year, 10);
}

/** 年度の表示ラベル（2026 → 2026年）。 */
export function formatFiscalYearLabel(year: number): string {
  return `${year}年`;
}

/** 年度の期間（1/1〜12/31）を ISO 日付で返す。 */
export function fiscalYearRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** 年度選択の選択肢：FIRST_FISCAL_YEAR から現在年までを新しい順で返す。 */
export function fiscalYearOptionsDescending(
  current: number = currentFiscalYear(),
): Array<{ year: number; label: string }> {
  const latest = Math.max(current, FIRST_FISCAL_YEAR);
  const options: Array<{ year: number; label: string }> = [];
  for (let year = latest; year >= FIRST_FISCAL_YEAR; year -= 1) {
    options.push({ year, label: formatFiscalYearLabel(year) });
  }
  return options;
}

/** 日付文字列（YYYY-MM-DD）が属する年度。 */
export function fiscalYearOf(date: string): number | null {
  const matched = date.match(/^(\d{4})-\d{2}-\d{2}$/);
  return matched ? Number.parseInt(matched[1], 10) : null;
}
