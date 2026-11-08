"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { addDays, type AccountingPeriod } from "@/lib/accounting/period";
import {
  dayLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  labelClassName,
  noteClassName,
  Section,
  tableClassName,
  todayJst,
  useTicket,
} from "./accounting-api";
import { currency } from "./constants";

// 前受金の確認（FREQ-569-AC-04）。計上待ちのタブの下に置く。
// 日を選んで出す「繰り越した前受金の一覧」（既定は課税事業者になる期間の初めの前の日）と、Task 7 の異常の一覧。
// 答えは SQL の snake_case のまま（orders / next_after_order / total_balance / anomalies）。

type DeferredOrder = {
  order_id: string;
  order_number: string;
  balance: number;
  paid_on: string | null;
  unshipped_units: number;
};

type DeferredAnomaly = {
  order_id: string;
  order_number: string;
  balance: number;
  reason: string;
};

type DeferredPage = {
  orders: DeferredOrder[];
  next_after_order: string | null;
  total_balance: number;
  anomalies: DeferredAnomaly[];
};

const PAGE_LIMIT = 100;

const ANOMALY_TEXT: Readonly<Record<string, string>> = {
  negative_balance: "前受金の残りがマイナスです",
  balance_after_all_shipped_or_refunded: "すべて出荷または返金したのに、前受金が残っています",
};

/** 課税事業者になる期間の初めの前の日。課税の期間が無ければ null。 */
function defaultAsOf(periods: readonly AccountingPeriod[]): string | null {
  const taxable = periods
    .filter((period) => period.consumptionTaxStatus === "taxable")
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1))[0];
  return taxable ? addDays(taxable.startsOn, -1) : null;
}

export function DeferredRevenuePanel(): React.JSX.Element {
  const [asOf, setAsOf] = useState<string | null>(null);
  const [page, setPage] = useState<DeferredPage | null>(null);
  const [orders, setOrders] = useState<DeferredOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 日を切り替えた時、古い答え（先頭も続きも）で上書き・追記しない。
  const ticket = useTicket();

  const load = useCallback(async (date: string) => {
    const mine = ticket.next();
    const result = await getAccountingData<DeferredPage>("deferred-revenue", {
      asOf: date,
      limit: PAGE_LIMIT,
    }, (data) => hasArray(data, "orders") && hasArray(data, "anomalies"));
    if (!ticket.isCurrent(mine)) return;
    if (!result.ok) {
      // 前の日の表を残さない。
      setPage(null);
      setOrders([]);
      setError(result.message);
      return;
    }
    setError(null);
    setPage(result.data);
    setOrders(result.data.orders);
  }, [ticket]);

  // 最初に期間を読んで既定の日を決める。読めなければ今日にする。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const periods = await getAccountingData<{ periods: AccountingPeriod[] }>("periods", {}, (data) => hasArray(data, "periods"));
      if (cancelled) return;
      const date = (periods.ok ? defaultAsOf(periods.data.periods) : null) ?? todayJst();
      setAsOf(date);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (asOf) void load(asOf);
  }, [asOf, load]);

  const loadMore = async () => {
    if (!asOf || !page?.next_after_order || loadingMore) return;
    setLoadingMore(true);
    const mine = ticket.next();
    const result = await getAccountingData<DeferredPage>("deferred-revenue", {
      asOf,
      limit: PAGE_LIMIT,
      afterOrder: page.next_after_order,
    }, (data) => hasArray(data, "orders") && hasArray(data, "anomalies"));
    if (!ticket.isCurrent(mine)) return;
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPage(result.data);
    setOrders((current) => [...current, ...result.data.orders]);
  };

  return (
    <Section title="前受金の確認">
      <label className="block max-w-xs">
        <span className={labelClassName}>この日の終わりの前受金</span>
        <input
          type="date"
          className={inputClassName}
          value={asOf ?? ""}
          onChange={(event) => {
            if (!event.target.value) return;
            // 日を替えたら、前の日の表は消して読み直す。
            ticket.next();
            setLoadingMore(false);
            setPage(null);
            setOrders([]);
            setAsOf(event.target.value);
          }}
        />
      </label>
      <p className={noteClassName}>
        既定は、課税事業者になる期間の初めの前の日です。出荷の前に預かっている代金の、注文ごとの残りを出します。
      </p>

      {error ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {error}
        </p>
      ) : null}

      {page ? (
        <>
          <p className="font-acumin lk-text-3xs text-black">{`前受金の残りの合計 ${currency(page.total_balance)}`}</p>
          {orders.length === 0 ? (
            <p className={noteClassName}>繰り越した前受金はありません</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="繰り越した前受金の一覧" className={`${tableClassName} min-w-[480px]`}>
                <thead>
                  <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                    <th scope="col" className="py-2 pr-3 font-normal">注文番号</th>
                    <th scope="col" className="py-2 pr-3 font-normal">支払った日</th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">前受金の残り</th>
                    <th scope="col" className="py-2 text-right font-normal">未出荷の着数</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.order_id} className="border-b border-[#ededed] tabular-nums">
                      <td className="py-2 pr-3">{order.order_number}</td>
                      <td className="py-2 pr-3">{dayLabel(order.paid_on)}</td>
                      <td className="py-2 pr-3 text-right">{currency(order.balance)}</td>
                      <td className="py-2 text-right">{order.unshipped_units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.next_after_order ? (
            <Button
              variant="outline"
              size="sm"
              shape="rounded"
              className="font-acumin"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              さらに読み込む
            </Button>
          ) : null}

          <div className="space-y-2 border-t border-[#ededed] pt-3">
            <p className="font-acumin lk-text-4xs font-medium text-black">前受金の異常</p>
            {page.anomalies.length === 0 ? (
              <p className={noteClassName}>異常はありません</p>
            ) : (
              <ul aria-label="前受金の異常" className="space-y-1">
                {page.anomalies.map((anomaly) => (
                  <li key={anomaly.order_id} className="font-acumin lk-text-4xs text-black">
                    {`${anomaly.order_number}　${ANOMALY_TEXT[anomaly.reason] ?? "確かめてください"}（前受金の残り ${currency(anomaly.balance)}）`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : error ? null : (
        <p role="status" className={noteClassName}>
          読み込み中
        </p>
      )}
    </Section>
  );
}
