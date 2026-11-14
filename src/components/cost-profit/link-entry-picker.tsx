"use client";

import { useEffect, useState } from "react";
import type { AccountingPeriod } from "@/lib/accounting/period";
import type { SavedJournalEntry } from "@/lib/accounting/journal-types";
import {
  dayLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  labelClassName,
  noteClassName,
  todayJst,
} from "./accounting-api";

// 計上待ち（order_not_postable）を手で入れた仕訳と結ぶ時の、仕訳の選び（レビュー B の Gap 4）。
// 計画1の仕訳帳の読み口（GET /journal）から、選んだ期間の手入力の仕訳を出す。取り消された仕訳・取り消しの仕訳は出さない。
// 裁定 P3-T11b: この注文の行がある仕訳か、注文の行が1つも無い仕訳（経費の欄で入れた手入力）だけを候補にする。route の断りは最後の確かめ。
// 名前は `JE-nnnnnn 日付 説明`、送るのは仕訳の ID。

type JournalCursor = { entryDate: string; entryNo: number };
type JournalPage = { entries: SavedJournalEntry[]; nextAfter: JournalCursor | null };

const PAGE = 200;
/** 手入力が埋もれる期間でも読み切れる上限（200件×10ページ）。超えたら、その旨を出す */
const MAX_PAGES = 10;

const entryNumber = (entryNo: number): string => `JE-${String(entryNo).padStart(6, "0")}`;

/** 候補にする仕訳。手入力で、取り消されておらず、取り消しの仕訳でもなく、注文のルールに合う物 */
export function linkableEntries(entries: readonly SavedJournalEntry[], orderId: string | null): SavedJournalEntry[] {
  const reversed = new Set(entries.flatMap((entry) => (entry.reversesEntryId ? [entry.reversesEntryId] : [])));
  return entries.filter((entry) => {
    if (entry.eventKind !== "manual_entry" || entry.reversesEntryId !== null || reversed.has(entry.id)) return false;
    const orderLines = entry.lines.filter((line) => line.orderId !== null);
    return orderLines.length === 0 || (orderId !== null && orderLines.some((line) => line.orderId === orderId));
  });
}

/** 期間の既定。出来事の日を含む期間、無ければ今日を含む期間、無ければ最後の期間 */
function defaultPeriodId(periods: readonly AccountingPeriod[], entryDate: string | null): string {
  const holding = (day: string) => periods.find((period) => period.startsOn <= day && day <= period.endsOn);
  const chosen = (entryDate ? holding(entryDate) : undefined) ?? holding(todayJst()) ?? periods[periods.length - 1];
  return chosen?.id ?? "";
}

export function LinkEntryPicker({
  orderId,
  entryDate,
  value,
  onChange,
}: {
  /** 結ぶ行の注文（無い行は注文の行が無い仕訳だけが候補） */
  orderId: string | null;
  /** 行の出来事の日（YYYY-MM-DD）。期間の既定を決める */
  entryDate: string | null;
  value: string;
  onChange: (entryId: string) => void;
}) {
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [entries, setEntries] = useState<SavedJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await getAccountingData<{ periods: AccountingPeriod[] }>("periods", {}, (data) => hasArray(data, "periods"));
      if (!active) return;
      if (!result.ok) {
        setError(result.message);
        setLoading(false);
        return;
      }
      setPeriods(result.data.periods);
      setPeriodId(defaultPeriodId(result.data.periods, entryDate));
      if (result.data.periods.length === 0) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [entryDate]);

  useEffect(() => {
    if (!periodId) return;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      setTruncated(false);
      let collected: SavedJournalEntry[] = [];
      let cursor = null as JournalCursor | null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const after: JournalCursor | null = cursor;
        const result: Awaited<ReturnType<typeof getAccountingData<JournalPage>>> = await getAccountingData<JournalPage>(
          "journal",
          { periodId, limit: PAGE, afterEntryDate: after?.entryDate, afterEntryNo: after?.entryNo },
          (data) => hasArray(data, "entries"),
        );
        if (!active) return;
        if (!result.ok) {
          setEntries([]);
          setError(result.message);
          setLoading(false);
          return;
        }
        collected = [...collected, ...result.data.entries];
        cursor = result.data.nextAfter;
        if (!cursor) break;
        if (page === MAX_PAGES - 1) setTruncated(true);
      }
      setEntries(collected);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [periodId]);

  const candidates = linkableEntries(entries, orderId);

  return (
    <div className="space-y-2">
      <label className="block max-w-xs">
        <span className={labelClassName}>仕訳を探す期間</span>
        <select
          className={inputClassName}
          value={periodId}
          onChange={(event) => {
            onChange("");
            setPeriodId(event.target.value);
          }}
        >
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {period.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClassName}>手で入れた仕訳</span>
        <select className={inputClassName} value={value} disabled={loading} onChange={(event) => onChange(event.target.value)}>
          <option value="">選んでください</option>
          {candidates.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entryNumber(entry.entryNo)}　${dayLabel(entry.entryDate)}　${entry.description}`}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p role="status" className={noteClassName}>
          読み込み中
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {error}
        </p>
      ) : null}
      {!loading && !error && periodId !== "" && candidates.length === 0 ? (
        <p className={noteClassName}>この期間に、選べる手入力の仕訳はありません。別の期間を選ぶか、先に手で仕訳を入れてください。</p>
      ) : null}
      {truncated ? <p className={noteClassName}>仕訳が多いため、読み込めた範囲だけを出しています。</p> : null}
      <p className={noteClassName}>この注文の行がある手入力の仕訳か、注文を使わない手入力の仕訳だけが選べます。この期間で取り消された仕訳は出ません。別の期間で取り消された仕訳は出てしまうので、選んでも結ぶ時に断られます。</p>
    </div>
  );
}
