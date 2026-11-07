// 会計期間（暦年 1/1〜12/31）のヘルパー。
// 個人事業主の課税期間は暦年固定なので、帳簿・税務レポート・財務概要は
// すべてこの軸で切る。シーズン（S/S・A/W）は商品原価専用の分析軸で、
// A/W が 10月〜翌3月と暦年をまたぐため会計期間には使えない。

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

/**
 * 年度の期間（1/1〜12/31）を ISO 日付で返す。
 * これは暦年の期間で、会計の期間（法人の決算月や個人のやめた年を含む）は
 * `src/lib/accounting/period.ts` の `AccountingPeriod` を使う。
 */
export function fiscalYearRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** 日付文字列（YYYY-MM-DD）が属する年度。 */
export function fiscalYearOf(date: string): number | null {
  const matched = date.match(/^(\d{4})-\d{2}-\d{2}$/);
  return matched ? Number.parseInt(matched[1], 10) : null;
}
