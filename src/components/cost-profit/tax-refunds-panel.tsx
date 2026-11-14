"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { ACCOUNTING_LABELS } from "@/lib/accounting/labels";
import {
  dayLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  labelClassName,
  LIST_RESTART_CODE,
  noteClassName,
  Section,
  tableClassName,
  todayJst,
  useTicket,
} from "./accounting-api";
import { currency } from "./constants";

// 消費税用の返金の一覧（FREQ-583）。返金した日・注文番号・品の内容・税率・税額・元の売上の日・対象外の理由を出し、
// 合計は含む額と外す額に分ける。期間は月で選ぶ（最大12か月）。route の答えは store が直した camelCase。
// 名前・メール・住所は出さない（読み口が持たない）。元の売上の日・売上の期間の区分は無いことがある（出荷前の返金・元の売上の仕訳がまだ無い）。

type Exclusion = "none" | "before_sale" | "sale_unbooked" | "exempt_sale_14_1_6" | "after_exit_14_1_7";

type TaxRefundRow = {
  entryId: string;
  lineKey: string;
  refundDate: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  taxRate: number;
  taxAmount: number;
  itemSummary: string | null;
  originalSaleDate: string | null;
  salePeriodStatus: "taxable" | "exempt" | null;
  refundPeriodStatus: "taxable" | "exempt";
  exclusion: Exclusion;
};

type TaxRefundsPage = {
  rows: TaxRefundRow[];
  nextAfterDate: string | null;
  nextAfterKey: string | null;
  retentionNote: string;
  totals: {
    includedAmount: number;
    includedTax: number;
    excludedAmount: number;
    excludedBy: { beforeSale: number; saleUnbooked: number; exemptSale1416: number; afterExit1417: number };
  };
};

const PAGE_LIMIT = 100;
const MAX_MONTHS = 12;

/** 対象外の理由の文。none は含める行。sale_unbooked は元の売上の仕訳がまだ無い出荷後の返金で、手で確かめる（Ruling P3-T9d） */
const EXCLUSION_TEXT: Readonly<Record<Exclusion, string>> = {
  none: "対象（含める）",
  before_sale: "出荷前の返金（元の売上がありません）",
  sale_unbooked: "元の売上の仕訳がまだ無い（手で確かめる）",
  exempt_sale_14_1_6: "元の売上が免税の期間です",
  after_exit_14_1_7: "免税になった後・事業の形が変わった後の返金です",
};

const RANGE_TOO_LONG_TEXT = `期間は${MAX_MONTHS}か月までです。`;
const RANGE_REVERSED_TEXT = "終わりの月は始まりの月と同じか後にしてください。";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_FORMAT_TEXT = "月は 2026-10 の形で入れてください。";
const RESTART_TEXT = "一覧が変わったため、最初から読み直しました。";

function previousMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
}

export function TaxRefundsPanel({ today: todayProp }: { today?: string }): React.JSX.Element {
  const today = todayProp ?? todayJst();
  const [from, setFrom] = useState(previousMonth(today));
  const [to, setTo] = useState(previousMonth(today));
  const [page, setPage] = useState<TaxRefundsPage | null>(null);
  const [rows, setRows] = useState<TaxRefundRow[]>([]);
  const [shownRange, setShownRange] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  // 期間を替えた後に、古い答えで上書き・追記しない
  const ticket = useTicket();

  const rangeProblem =
    from === "" || to === ""
      ? null
      : !MONTH_PATTERN.test(from) || !MONTH_PATTERN.test(to)
        ? MONTH_FORMAT_TEXT
        : from > to
        ? RANGE_REVERSED_TEXT
        : monthsBetween(from, to) > MAX_MONTHS
          ? RANGE_TOO_LONG_TEXT
          : null;
  const canShow = from !== "" && to !== "" && rangeProblem === null && !loading;

  const reset = () => {
    ticket.next();
    setPage(null);
    setRows([]);
    setShownRange(null);
    setError(null);
    setRestartNote(false);
    setLoading(false);
    setLoadingMore(false);
  };

  const show = async () => {
    if (!canShow) return;
    const mine = ticket.next();
    setLoading(true);
    setError(null);
    setRestartNote(false);
    const result = await getAccountingData<TaxRefundsPage>("tax-refunds", { from, to, limit: PAGE_LIMIT }, (data) => hasArray(data, "rows"));
    if (!ticket.isCurrent(mine)) return;
    setLoading(false);
    if (!result.ok) {
      // 前の期間の一覧を残さない
      setPage(null);
      setRows([]);
      setShownRange(null);
      setError(result.message);
      return;
    }
    setPage(result.data);
    setRows(result.data.rows);
    setShownRange(`${from.replace("-", "/")} 〜 ${to.replace("-", "/")}`);
  };

  const loadMore = async () => {
    if (!page?.nextAfterDate || !page.nextAfterKey || loadingMore) return;
    const mine = ticket.next();
    setLoadingMore(true);
    const result = await getAccountingData<TaxRefundsPage>(
      "tax-refunds",
      { from, to, limit: PAGE_LIMIT, afterDate: page.nextAfterDate, afterKey: page.nextAfterKey },
      (data) => hasArray(data, "rows"),
    );
    if (!ticket.isCurrent(mine)) return;
    setLoadingMore(false);
    if (!result.ok) {
      if (result.code === LIST_RESTART_CODE) {
        // 続きの目印が古い。最初から読み直す
        setRestartNote(true);
        await show();
        setRestartNote(true);
        return;
      }
      setError(result.message);
      return;
    }
    setPage(result.data);
    setRows((current) => [...current, ...result.data.rows]);
  };

  return (
    <Section title="消費税用の返金">
      <p className={noteClassName}>
        消費税の申告で、課税売上から引く返金を、月ごとに確かめます。対象外の返金も、理由つきで出します。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block max-w-xs">
          <span className={labelClassName}>期間の始まり</span>
          <input
            type="month"
            className={inputClassName}
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              reset();
            }}
          />
        </label>
        <label className="block max-w-xs">
          <span className={labelClassName}>期間の終わり</span>
          <input
            type="month"
            className={inputClassName}
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              reset();
            }}
          />
        </label>
        <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={!canShow} onClick={() => void show()}>
          一覧を出す
        </Button>
      </div>
      {rangeProblem ? <p className="font-acumin lk-text-3xs text-red-700">{rangeProblem}</p> : null}
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
      {restartNote ? <p className={noteClassName}>{RESTART_TEXT}</p> : null}

      {page ? (
        <div className="space-y-3">
          {shownRange ? <p className={labelClassName}>{`${shownRange} の返金`}</p> : null}
          <div role="group" aria-label="合計" className="space-y-1 rounded-sm border border-[#ededed] p-3">
            <p className="font-acumin lk-text-4xs text-black tabular-nums">
              {`含む 返金の額 ${currency(page.totals.includedAmount)} 税額 ${currency(page.totals.includedTax)}`}
            </p>
            <p className="font-acumin lk-text-4xs text-black tabular-nums">{`外す 返金の額 ${currency(page.totals.excludedAmount)}`}</p>
            <ul aria-label="外す返金の内訳" className="space-y-1">
              {(
                [
                  ["before_sale", page.totals.excludedBy.beforeSale],
                  ["sale_unbooked", page.totals.excludedBy.saleUnbooked],
                  ["exempt_sale_14_1_6", page.totals.excludedBy.exemptSale1416],
                  ["after_exit_14_1_7", page.totals.excludedBy.afterExit1417],
                ] as const
              ).map(([reason, amount]) => (
                <li key={reason} className="font-acumin lk-text-4xs text-[#474747] tabular-nums">
                  {`${EXCLUSION_TEXT[reason]} ${currency(amount)}`}
                </li>
              ))}
            </ul>
          </div>

          {rows.length === 0 ? (
            <p className={noteClassName}>この期間の返金はありません</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="消費税用の返金の一覧" className={`${tableClassName} min-w-[760px]`}>
                <thead>
                  <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                    <th scope="col" className="py-2 pr-3 font-normal">返金した日</th>
                    <th scope="col" className="py-2 pr-3 font-normal">注文番号</th>
                    <th scope="col" className="py-2 pr-3 font-normal">品の内容</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">税率</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">返金の額</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">税額</th>
                    <th scope="col" className="py-2 pr-3 font-normal">元の売上の日</th>
                    <th scope="col" className="py-2 font-normal">対象外の理由</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.lineKey} className="border-b border-[#ededed] tabular-nums">
                      <td className="py-2 pr-3">{dayLabel(row.refundDate)}</td>
                      <td className="py-2 pr-3">{row.orderNumber}</td>
                      <td className="py-2 pr-3">{row.itemSummary ?? "-"}</td>
                      <td className="py-2 pr-3 text-right">{`${row.taxRate}%`}</td>
                      <td className="py-2 pr-3 text-right">{currency(row.amount)}</td>
                      <td className="py-2 pr-3 text-right">{currency(row.taxAmount)}</td>
                      <td className="py-2 pr-3">{dayLabel(row.originalSaleDate)}</td>
                      <td className="py-2">{EXCLUSION_TEXT[row.exclusion]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.nextAfterDate && page.nextAfterKey ? (
            <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={loadingMore} onClick={() => void loadMore()}>
              さらに読み込む
            </Button>
          ) : null}
          <p data-testid="tax-refund-retention-note" className={noteClassName}>
            {`保存について: ${ACCOUNTING_LABELS.taxRefundRetentionNote}。`}
          </p>
        </div>
      ) : null}
    </Section>
  );
}
