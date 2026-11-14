"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { MAX_REFUND_DECISION_REASON } from "@/lib/accounting/return-refund-types";
import { accountingUrl, getAccountingData, hasArray, labelClassName, noteClassName } from "./accounting-api";
import { sendAccountingJson } from "./period-form";

// 取り消された返金の区分を選ぶ画面（FREQ-579-AC-03・FREQ-584-AC-02）。計上待ちのタブの refund_cancel_undecided の行から開く。
// 開くのは権限 admin.accounting.entries.correct のある人だけ（呼ぶ側が出し分ける。DB と route が最後に確かめる）。
// 区分は2つ。理由は必須。同じ内容の再送は同じ二重防止の番号で、内容を変えたら作り直す。非okの応答は本文を読み切り、route の文を出す。

type Kind = "abandoned" | "owed";

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  abandoned: "店が返金をやめた",
  owed: "返すつもりのまま返せなかった",
};

/** 「店が返金をやめた」を選ぶ前に伝える（返金の出来事が発送前の取り消しの時、または出来事が分からない時） */
export const ABANDON_NOTE =
  "発送前の取り消しの返金でこれを選ぶと、その発送前の取り消しそのものが取りやめになり、品をまた送れる場合があります。同じ出来事でお金が出た返金や借りがほかにある時は、この返金だけをやめたことになります。";
/** 出来事が発送前の取り消しではないと分かった返金で「店が返金をやめた」を選ぶ時 */
export const ABANDON_ONLY_THIS_NOTE = "この返金だけをやめたことになります。";
const OWED_NOTE = "返すつもりのまま残ります。振込で返したら、振込の記録を入れます。";
/** 返品の返金は、返品の画面からのやり直しでも返せる */
const OWED_RETURN_NOTE = "返すつもりのまま残ります。返品の返金は、返品の画面でやり直すか、振込で返したら振込の記録を入れます。";

type RefundStateSlice = { refundId: string; eventKind: string; source: string };
type RefundStatePage = { refunds: RefundStateSlice[]; nextAfterAt: string | null; nextAfterId: string | null };
const ROW_PAGE = 100;
/** 区分待ちの返金を探して読む上限（100件×5ページ。見つからなければ出来事は「分からない」として慎重な文を出す） */
const ROW_MAX_PAGES = 5;

/** 返金の出来事と元を、借りの一覧の読み（GET /refund-states）から探す。見つからない・読めない時は null */
async function readRefundRow(refundId: string): Promise<RefundStateSlice | null> {
  let after = null as { at: string; id: string } | null;
  for (let page = 0; page < ROW_MAX_PAGES; page += 1) {
    const cursor: { at: string; id: string } | null = after;
    const result: Awaited<ReturnType<typeof getAccountingData<RefundStatePage>>> = await getAccountingData<RefundStatePage>(
      "refund-states",
      { limit: ROW_PAGE, afterAt: cursor?.at, afterId: cursor?.id },
      (data) => hasArray(data, "refunds"),
    );
    if (!result.ok) return null;
    const found = result.data.refunds.find((row) => row.refundId === refundId);
    if (found) return found;
    if (!result.data.nextAfterAt || !result.data.nextAfterId) return null;
    after = { at: result.data.nextAfterAt, id: result.data.nextAfterId };
  }
  return null;
}
/** 選んだ後の流れ（計上係が仕訳を入れると、計上待ちの行は閉じる） */
const REFLECT_NOTE = "選ぶと、自動で計上されて、この行は閉じます。";
/** Stripe に届いていない error の返金で断られた時の固定コード（store が ubrr_status で付ける）。この時は選択肢を出さず、やり直しだけを案内する（裁定 P3-B7） */
const STRIPE_RETRY_CODE = "UNIT_CANCEL_REVERT_STRIPE_RETRY";
/** 区分がもう決まっている・取り消されていない返金の時（一覧が古い）。親が一覧を読み直す */
const STALE_CODES: ReadonlySet<string> = new Set(["ACCOUNTING_REFUND_CANCEL_DECIDED", "ACCOUNTING_REFUND_NOT_CANCELED"]);

export function RefundCancellationDialog({
  refundId,
  orderNumber,
  onClose,
  onDone,
  onStale,
}: {
  refundId: string;
  /** 見出しに添える注文番号（任意） */
  orderNumber?: string;
  onClose: () => void;
  /** 区分を決められた（同じ要求の再送で前の結果が返った時も）。親が一覧を読み直す */
  onDone: () => void;
  /** 一覧が古かった（もう決まっている・取り消されていない）。親が一覧を読み直す。画面は断りの文を出したまま残す */
  onStale?: () => void;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stripe に届いていない error の返金と分かった後は、「店が返金をやめた」を出さない
  const [retryOnly, setRetryOnly] = useState(false);
  // 返金の出来事と元（undefined: 読み込み中、null: 分からない）。注意書きの出し分けに使う
  const [row, setRow] = useState<RefundStateSlice | null | undefined>(undefined);
  const guard = useRef(false);
  const keyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    // 形の違う答えで読みが落ちても、慎重な文（出来事が分からない時）に戻して、送れる状態にする
    void readRefundRow(refundId)
      .catch(() => null)
      .then((found) => {
        if (active) setRow(found);
      });
    return () => {
      active = false;
    };
  }, [refundId]);

  const trimmedReason = reason.trim();
  const canSubmit = !sending && row !== undefined && kind !== null && trimmedReason !== "";
  // 出来事が発送前の取り消しではないと分かった時だけ短い文。分からない時は、取りやめになる場合がある旨も伝える
  const abandonNote = row === undefined ? null : row !== null && row.eventKind !== "pre_shipment_cancel" ? ABANDON_ONLY_THIS_NOTE : ABANDON_NOTE;
  const owedNote = row?.source === "return" ? OWED_RETURN_NOTE : OWED_NOTE;
  const kinds: Kind[] = retryOnly ? [] : ["abandoned", "owed"];

  const choose = (next: Kind) => {
    keyRef.current = crypto.randomUUID();
    setKind(next);
  };

  const send = async () => {
    if (!canSubmit || guard.current || kind === null) return;
    guard.current = true;
    setSending(true);
    setError(null);
    const result = await sendAccountingJson(accountingUrl("refund-cancellations"), "POST", {
      refundId,
      kind,
      reason: trimmedReason,
      requestKey: keyRef.current,
    });
    guard.current = false;
    setSending(false);
    if (result.ok) {
      onDone();
      return;
    }
    setError(result.message);
    if (result.code === STRIPE_RETRY_CODE) {
      setRetryOnly(true);
      setKind(null);
    }
    if (result.code !== null && STALE_CODES.has(result.code)) onStale?.();
  };

  return (
    <Dialog open onClose={() => (sending ? undefined : onClose())} title="返金の取り消しの区分を選ぶ" fullScreenOnMobile>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {orderNumber ? <p className="font-acumin lk-text-sm text-black">{`注文 ${orderNumber}`}</p> : null}
        <p className={noteClassName}>{`この返金は Stripe 側で取り消されました。${retryOnly ? "" : "どちらにあたるかを選んでください。"}`}</p>
        {retryOnly ? null : <p className={noteClassName}>{REFLECT_NOTE}</p>}
        <div role={retryOnly ? undefined : "radiogroup"} aria-label={retryOnly ? undefined : "取り消しの区分"} className="space-y-3">
          {kinds.map((value) => (
            <div key={value} className="space-y-1">
              <label className="flex min-h-9 cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="refund-cancellation-kind"
                  value={value}
                  className="h-4 w-4 accent-black"
                  checked={kind === value}
                  disabled={sending}
                  onChange={() => choose(value)}
                />
                <span className="font-acumin lk-text-sm text-black">{KIND_LABEL[value]}</span>
              </label>
              {value === "abandoned" ? (
                abandonNote ? (
                  <p data-testid="abandon-note" className={noteClassName}>
                    {abandonNote}
                  </p>
                ) : (
                  <p role="status" className={noteClassName}>
                    読み込み中
                  </p>
                )
              ) : (
                <p className={noteClassName}>{owedNote}</p>
              )}
            </div>
          ))}
        </div>
        {retryOnly ? null : (
          <>
            <label className="block">
              <span className={labelClassName}>理由（必須）</span>
              <textarea
                maxLength={MAX_REFUND_DECISION_REASON}
                className="h-20 w-full rounded-md border border-[#d4d4d4] bg-white px-3 py-2 font-acumin lk-text-sm text-black focus:border-black focus:outline-none"
                value={reason}
                disabled={sending}
                onChange={(event) => {
                  keyRef.current = crypto.randomUUID();
                  setReason(event.target.value);
                }}
              />
            </label>
            <p className={noteClassName}>{`何を確かめて決めたかを${MAX_REFUND_DECISION_REASON}文字までで書いてください。個人の名前やメールは書かないでください。`}</p>
          </>
        )}
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        <div className="refund-flow-actions flex flex-col-reverse gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={sending} onClick={onClose}>
            やめる
          </Button>
          {retryOnly ? null : (
            <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
              区分を決める
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
