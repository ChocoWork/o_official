"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { accountByCode } from "@/lib/finance/accounts";
import {
  accountingUrl,
  dayLabel,
  getAccountingData,
  hasArray,
  labelClassName,
  noteClassName,
  NO_PERMISSIONS,
  Section,
  tableClassName,
  type ViewPermissions,
} from "./accounting-api";
import { currency } from "./constants";
import {
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// カード会社からの支払いの取り消しの一覧（FREQ-568-AC-01）と、確定・科目の決定待ちの振り替え（AC-02）。
// 「チャージバック」とは書かない。結果を待つ間は「カード会社の判断待ち」、確定は「取り消しが確定した（お金は戻らない）」、
// 取り下げは「取り消しが取り下げられた（お金が戻った）」。答えは SQL の snake_case のまま。

export type DisputeRow = {
  dispute_id: string;
  reason: string;
  status: string;
  amount: number;
  order_id: string | null;
  stripe_created_at: string;
  withdrawn_on: string | null;
  confirmed_on: string | null;
  assigned_account_code: string | null;
  pending_reasons: string[];
};

type DisputePage = {
  disputes: DisputeRow[];
  next_after_at: string | null;
  next_after_id: string | null;
};

/** Stripe の原因の呼び名（設定の鍵と同じ16種）。 */
export const DISPUTE_CAUSE_LABELS: Readonly<Record<string, string>> = {
  fraudulent: "不正利用",
  product_not_received: "商品が届かない",
  product_unacceptable: "商品が違う・不備",
  unrecognized: "身に覚えがない",
  duplicate: "二重の請求",
  subscription_canceled: "定期購入の解約",
  credit_not_processed: "返金が済んでいない",
  general: "一般の理由",
  bank_cannot_process: "銀行が処理できない",
  check_returned: "小切手の返却",
  customer_initiated: "お客様からの申し立て",
  debit_not_authorized: "引き落としの承認が無い",
  incorrect_account_details: "口座の情報の誤り",
  insufficient_funds: "残高不足",
  noncompliant: "規則に合わない",
  other: "その他",
};

export const disputeCauseLabel = (reason: string): string =>
  DISPUTE_CAUSE_LABELS[reason] ?? DISPUTE_CAUSE_LABELS.other;

/** 状態の言葉。待っている間は判断待ち、lost は確定、won は取り下げ。 */
export function disputeStatusLabel(status: string): string {
  if (status === "lost") return "取り消しが確定した（お金は戻らない）";
  if (status === "won") return "取り消しが取り下げられた（お金が戻った）";
  if (status === "needs_response" || status === "under_review" || status.startsWith("warning_")) {
    return "カード会社の判断待ち";
  }
  return "その他の状態";
}

export const accountLabel = (code: string): string => `${code} ${accountByCode(code)?.name ?? ""}`.trim();

/** 確定したが、振り替え先の科目がまだの取り消し。 */
const awaitingAssignment = (row: DisputeRow): boolean =>
  row.confirmed_on !== null && row.assigned_account_code === null;

export function DisputeList({
  awaitingOnly = false,
  settingsByReason = {},
  onAssigned,
}: {
  /** true: 確定・科目の決定待ちだけを出し、振り替える操作を付ける（設定のタブ）。 */
  awaitingOnly?: boolean;
  /** 原因 → 設定の科目の符号。 */
  settingsByReason?: Readonly<Record<string, string>>;
  onAssigned?: () => void;
}): React.JSX.Element {
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [next, setNext] = useState<{ at: string; id: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const guard = useRef(false);

  const apply = (page: DisputePage, append: boolean) => {
    setRows((current) => (append ? [...current, ...page.disputes] : page.disputes));
    setNext(page.next_after_at && page.next_after_id ? { at: page.next_after_at, id: page.next_after_id } : null);
  };

  const load = useCallback(async () => {
    const result = await getAccountingData<DisputePage>("disputes", { limit: 50 }, (data) => hasArray(data, "disputes"));
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setPermissions(result.permissions);
    setRows(result.data.disputes);
    setNext(
      result.data.next_after_at && result.data.next_after_id
        ? { at: result.data.next_after_at, id: result.data.next_after_id }
        : null,
    );
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const result = await getAccountingData<DisputePage>("disputes", {
      limit: 50,
      afterAt: next.at,
      afterId: next.id,
    }, (data) => hasArray(data, "disputes"));
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    apply(result.data, true);
  };

  const assign = async (row: DisputeRow) => {
    if (guard.current) return;
    guard.current = true;
    setAssigning(row.dispute_id);
    setNotice(null);
    const result = await sendAccountingJson(
      accountingUrl(`disputes/${row.dispute_id}/assign`),
      "POST",
      { requestKey: crypto.randomUUID() },
    );
    if (result.ok) {
      setNotice(successNotice(`${row.dispute_id}を振り替えました。`));
      await load();
      onAssigned?.();
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setAssigning(null);
  };

  const errorBlock = error ? (
    <div className="space-y-2">
      <p role="alert" className="font-acumin lk-text-3xs text-red-700">
        {error}
      </p>
      <Button variant="outline" size="2xs" shape="rounded" className="font-acumin" onClick={() => void load()}>
        もう一度読み込む
      </Button>
    </div>
  ) : null;

  const moreButton = next ? (
    <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={loadingMore} onClick={() => void loadMore()}>
      さらに読み込む
    </Button>
  ) : null;

  if (awaitingOnly) {
    const waiting = rows.filter(awaitingAssignment);
    return (
      <div className="space-y-3">
        <p className={labelClassName}>確定・科目の決定待ち</p>
        {errorBlock}
        <NoticeLine notice={notice} onReload={() => void load()} />
        {loaded && waiting.length === 0 ? (
          <p className={noteClassName}>科目の決定待ちの取り消しはありません</p>
        ) : null}
        {waiting.length > 0 ? (
          <ul aria-label="科目の決定待ちの取り消し" className="space-y-2">
            {waiting.map((row) => {
              const target = settingsByReason[row.reason];
              return (
                <li key={row.dispute_id} className="space-y-1 rounded-sm border border-[#ededed] p-3 font-acumin lk-text-4xs text-black">
                  <p className="tabular-nums">
                    {`${row.dispute_id}　${disputeCauseLabel(row.reason)}　${currency(row.amount)}　確定した日 ${dayLabel(row.confirmed_on)}`}
                  </p>
                  {target ? (
                    <>
                      <p>{`振り替え先 ${accountLabel(target)}`}</p>
                      {permissions.correctEntries ? (
                        <Button
                          variant="outline"
                          size="2xs"
                          shape="rounded"
                          className="font-acumin"
                          disabled={assigning !== null}
                          aria-label={`${row.dispute_id}を設定の科目へ振り替える`}
                          onClick={() => void assign(row)}
                        >
                          設定の科目へ振り替える
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[#b45309]">先に上の設定で科目を決めてください</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {moreButton}
      </div>
    );
  }

  return (
    <Section title="カード会社からの支払いの取り消し">
      <p className={noteClassName}>
        お客様がカード会社に支払いへの異議を申し出て、売上を取り戻されたものです。申し立ての資料やお客様の情報は出しません。
      </p>
      {errorBlock}
      {loaded && rows.length === 0 ? (
        <p className={noteClassName}>カード会社からの支払いの取り消しはありません</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table aria-label="カード会社からの支払いの取り消しの一覧" className={`${tableClassName} min-w-[640px]`}>
            <thead>
              <tr className="border-b border-[#d4d4d4] text-left text-[#474747]">
                <th scope="col" className="py-2 pr-3 font-normal">取り消しの番号</th>
                <th scope="col" className="py-2 pr-3 font-normal">原因</th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">金額</th>
                <th scope="col" className="py-2 pr-3 font-normal">状態</th>
                <th scope="col" className="py-2 pr-3 font-normal">引かれた日</th>
                <th scope="col" className="py-2 font-normal">振り替え先</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.dispute_id} className="border-b border-[#ededed] tabular-nums">
                  <td className="py-2 pr-3">{row.dispute_id}</td>
                  <td className="py-2 pr-3">{disputeCauseLabel(row.reason)}</td>
                  <td className="py-2 pr-3 text-right">{currency(row.amount)}</td>
                  <td className="py-2 pr-3">{disputeStatusLabel(row.status)}</td>
                  <td className="py-2 pr-3">{dayLabel(row.withdrawn_on)}</td>
                  <td className="py-2">
                    {row.assigned_account_code
                      ? accountLabel(row.assigned_account_code)
                      : row.confirmed_on
                        ? "科目の決定待ち"
                        : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {moreButton}
    </Section>
  );
}
