// 取引の検索・絞り込み。
//
// 電子帳簿保存法の検索機能要件（国税庁「電子帳簿保存法一問一答【電子取引関係】」）に対応する:
//   1. 取引年月日・取引金額・取引先 を検索条件に設定できる
//   2. 日付・金額は範囲を指定して条件を設定できる
//   3. 2以上の任意の記録項目を組み合わせて条件を設定できる
// この3点は法定要件なので、UI から外してはいけない。

import type { EntryType, FinanceEntry } from "@/lib/finance/journal";

export type EntryFilter = {
  /** 取引年月日の範囲（YYYY-MM-DD、空文字は無制限） */
  dateFrom: string;
  dateTo: string;
  /** 取引金額の範囲（入力欄の文字列。空文字は無制限） */
  amountFrom: string;
  amountTo: string;
  /** 取引先（完全一致。空文字は絞り込まない） */
  partner: string;
  /** 勘定科目（完全一致） */
  account: string;
  /** 種別。空文字は支出・収入の両方 */
  entryType: "" | EntryType;
  /** 取引ID・概要・メモ・取引先を対象にした部分一致 */
  keyword: string;
};

export const EMPTY_ENTRY_FILTER: EntryFilter = {
  dateFrom: "",
  dateTo: "",
  amountFrom: "",
  amountTo: "",
  partner: "",
  account: "",
  entryType: "",
  keyword: "",
};

function toAmount(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 1件でも条件が入っているか。UI の「絞り込み中」表示と解除ボタンの出し分けに使う。 */
export function isFilterActive(filter: EntryFilter): boolean {
  return Object.values(filter).some((value) => value.trim() !== "");
}

/** 有効になっている条件の数。組み合わせ検索が効いていることの確認用。 */
export function activeConditionCount(filter: EntryFilter): number {
  return Object.values(filter).filter((value) => value.trim() !== "").length;
}

/**
 * すべての条件を AND で適用する（＝2以上の条件の組み合わせ）。
 * 日付・金額は範囲指定。範囲の片側だけの指定も許す。
 */
export function filterEntries(
  entries: readonly FinanceEntry[],
  filter: EntryFilter,
): FinanceEntry[] {
  const amountFrom = toAmount(filter.amountFrom);
  const amountTo = toAmount(filter.amountTo);
  const keyword = filter.keyword.trim().toLowerCase();

  return entries.filter((entry) => {
    if (filter.entryType && entry.entryType !== filter.entryType) return false;
    if (filter.dateFrom && entry.date < filter.dateFrom) return false;
    if (filter.dateTo && entry.date > filter.dateTo) return false;
    if (amountFrom !== null && entry.amount < amountFrom) return false;
    if (amountTo !== null && entry.amount > amountTo) return false;
    if (filter.partner && entry.partner !== filter.partner) return false;
    if (filter.account && entry.category !== filter.account) return false;
    if (keyword) {
      // 一覧の検索欄は取引IDでも引けるようにする（証憑や問い合わせからの逆引き用）。
      const haystack = [`#${entry.id}`, entry.item, entry.memo, entry.partner]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}
