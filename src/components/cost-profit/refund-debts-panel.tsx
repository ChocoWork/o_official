"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { ACCOUNTING_LABELS } from "@/lib/accounting/labels";
import {
  getAccountingData,
  hasArray,
  noteClassName,
  NO_PERMISSIONS,
  Section,
  type ViewPermissions,
} from "./accounting-api";
import { currency } from "./constants";
import { RefundBankTransferForm, type BankTransferOrigin } from "./refund-bank-transfer-form";
import { RefundSettlementDialog, type SettlementCandidate } from "./refund-settlement-dialog";
import { NoticeLine, successNotice, type Notice } from "./period-form";

// 借りが残る返金の一覧と、振込の記録・やり直しの結び（FREQ-579-AC-04・AC-05。計画3 Task 11）。
// route（GET /refund-states）の答えは、取り消しの区分待ちと、借りが残る返金。区分待ちは計上待ちのタブで選ぶので、ここには借りが残る物だけを出す。
// 同じ返金が2行返ることがある（SQL の Minor 7）ので、返金の番号で1つにまとめる。名前・メールは出さない。

type RefundStateRow = {
  refundId: string;
  orderId: string;
  orderNumber: string;
  source: string;
  state: string;
  preAmount: number;
  postAmount: number;
  owedPre: number;
  owedPost: number;
  canceledAt: string | null;
};

type RefundStatesPage = { refunds: RefundStateRow[]; nextAfterAt: string | null; nextAfterId: string | null };

const PAGE_SIZE = 50;

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  admin: "返金の画面",
  order_cancel: "支払い済みの注文の取り消し",
  return: ACCOUNTING_LABELS.refundReturn,
  auto_cancelled_order_payment: "取り消された注文の自動の返金",
  auto_amount_mismatch: "支払額の違いによる自動の返金",
  stripe_dashboard: "Stripe の画面からの返金",
  legacy: "以前の返金",
  unit_hold_release: "前の注文から差し引いた分の戻し",
};

const PRE_SHIPMENT_GUIDE = "発送前の取り消しの返金の借りは、振込で返して記録してください。";
const CANCEL_TAB_NOTE = "取り消しの区分を選ぶ返金は、計上待ちのタブに出ます。ここには、借りが残る返金を出します。";

/** 同じ返金の行は先に来た方（新しい方）だけ残す */
function mergeByRefundId(current: readonly RefundStateRow[], incoming: readonly RefundStateRow[]): RefundStateRow[] {
  const seen = new Set(current.map((row) => row.refundId));
  const merged = [...current];
  for (const row of incoming) {
    if (seen.has(row.refundId)) continue;
    seen.add(row.refundId);
    merged.push(row);
  }
  return merged;
}

const hasDebt = (row: RefundStateRow): boolean => row.state !== "canceled" && (row.owedPre > 0 || row.owedPost > 0);

/** 借りの種類。発送前の分だけが残る物は出荷前、返品の返金は返品、ほかは出荷後 */
function originOf(row: RefundStateRow): BankTransferOrigin {
  if (row.owedPre > 0 && row.owedPost === 0) return "pre_shipment";
  return row.source === "return" ? "return" : "post_shipment";
}

export function RefundDebtsPanel(): React.JSX.Element {
  const [rows, setRows] = useState<RefundStateRow[]>([]);
  const [next, setNext] = useState<{ at: string; id: string } | null>(null);
  const [permissions, setPermissions] = useState<ViewPermissions>(NO_PERMISSIONS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [bankFor, setBankFor] = useState<{ orderId: string; orderNumber: string; origin: BankTransferOrigin } | null>(null);
  const [settling, setSettling] = useState<RefundStateRow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const result = await getAccountingData<RefundStatesPage>("refund-states", { limit: PAGE_SIZE }, (data) => hasArray(data, "refunds"));
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setLoaded(true);
    setRows(mergeByRefundId([], result.data.refunds));
    setNext(result.data.nextAfterAt && result.data.nextAfterId ? { at: result.data.nextAfterAt, id: result.data.nextAfterId } : null);
    setPermissions(result.permissions);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const result = await getAccountingData<RefundStatesPage>(
      "refund-states",
      { limit: PAGE_SIZE, afterAt: next.at, afterId: next.id },
      (data) => hasArray(data, "refunds"),
    );
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRows((current) => mergeByRefundId(current, result.data.refunds));
    setNext(result.data.nextAfterAt && result.data.nextAfterId ? { at: result.data.nextAfterAt, id: result.data.nextAfterId } : null);
  };

  const debts = rows.filter(hasDebt);
  // 結びの候補。同じ注文の、ほかの返金（この読みが返した行だけ。同じ出来事かどうかは、この読みには無い）
  const candidatesOf = (row: RefundStateRow): SettlementCandidate[] =>
    rows
      .filter((other) => other.orderId === row.orderId && other.refundId !== row.refundId)
      .map((other) => ({ refundId: other.refundId, label: `返金 ${other.refundId.slice(0, 8).toUpperCase()}`, sameEvent: false }));

  return (
    <Section title="返金の借りと振込の記録">
      <p className={noteClassName}>{CANCEL_TAB_NOTE}</p>
      <NoticeLine notice={notice} onReload={() => void load()} />
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
          <Button variant="outline" size="sm" shape="rounded" className="font-acumin" onClick={() => void load()}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}
      {loaded && debts.length === 0 && !error ? <p className={noteClassName}>借りが残る返金はありません</p> : null}
      {debts.length > 0 ? (
        <ul aria-label="借りが残る返金の一覧" className="space-y-3">
          {debts.map((row) => {
            const preOnly = row.owedPre > 0;
            return (
              <li key={row.refundId} className="space-y-2 rounded-sm border border-[#ededed] p-3">
                <p className="font-acumin lk-text-4xs text-black tabular-nums">
                  {[
                    row.orderNumber,
                    SOURCE_LABEL[row.source] ?? "返金",
                    row.owedPre > 0 ? `出荷前の分の借り ${currency(row.owedPre)}` : null,
                    row.owedPost > 0 ? `出荷後の分の借り ${currency(row.owedPost)}` : null,
                  ]
                    .filter((text): text is string => text !== null)
                    .join("　")}
                </p>
                {preOnly ? <p className={noteClassName}>{PRE_SHIPMENT_GUIDE}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {permissions.manageFinance ? (
                    <Button
                      variant="outline"
                      size="sm"
                      shape="rounded"
                      className="font-acumin"
                      onClick={() => setBankFor({ orderId: row.orderId, orderNumber: row.orderNumber, origin: originOf(row) })}
                    >
                      振込を記録する
                    </Button>
                  ) : null}
                  {permissions.correctEntries && !preOnly ? (
                    <Button variant="outline" size="sm" shape="rounded" className="font-acumin" onClick={() => setSettling(row)}>
                      やり直しと結ぶ
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {next ? (
        <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={loadingMore} onClick={() => void loadMore()}>
          さらに読み込む
        </Button>
      ) : null}
      {bankFor ? (
        <RefundBankTransferForm
          key={`${bankFor.orderId}:${bankFor.origin}`}
          orders={[{ orderId: bankFor.orderId, orderNumber: bankFor.orderNumber }]}
          initial={{ orderId: bankFor.orderId, origin: bankFor.origin }}
          onDone={() => void load()}
          onCancel={() => setBankFor(null)}
        />
      ) : null}
      {settling ? (
        <RefundSettlementDialog
          owed={{ refundId: settling.refundId, orderNumber: settling.orderNumber, owedPre: settling.owedPre, owedPost: settling.owedPost }}
          candidates={candidatesOf(settling)}
          onClose={() => setSettling(null)}
          onDone={() => {
            setSettling(null);
            setNotice(successNotice("やり直しの返金と結びました。"));
            void load();
          }}
        />
      ) : null}
    </Section>
  );
}
