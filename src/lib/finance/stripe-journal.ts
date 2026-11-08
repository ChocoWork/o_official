import type { JournalEntry } from './journal';

/**
 * 保存した仕訳と決算整理の仕訳を、印（sourceKey。無ければ伝票番号）で1本にまとめて日付順に並べる。
 * 画面は注文の売上も Stripe の仕訳も合成しない（FREQ-570）。
 */
export function mergeJournalEntries(
  base: readonly JournalEntry[],
  generated: readonly JournalEntry[],
): JournalEntry[] {
  const merged = new Map<string, JournalEntry>();
  for (const value of [...base, ...generated]) merged.set(value.sourceKey ?? value.number, value);
  return [...merged.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.number.localeCompare(right.number),
  );
}
