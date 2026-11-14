"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { MAX_REFUND_DECISION_REASON } from "@/lib/accounting/return-refund-types";
import { accountingUrl, labelClassName, noteClassName } from "./accounting-api";
import { sendAccountingJson } from "./period-form";

// 取り消された返金の区分を選ぶ画面（FREQ-579-AC-03・FREQ-584-AC-02）。計上待ちのタブの refund_cancel_undecided の行から開く。
// 開くのは権限 admin.accounting.entries.correct のある人だけ（呼ぶ側が出し分ける。DB と route が最後に確かめる）。
// 区分は2つ。理由は必須。同じ内容の再送は同じ二重防止の番号で、内容を変えたら作り直す。非okの応答は本文を読み切り、route の文を出す。

type Kind = "abandoned" | "owed";

const KIND_LABEL: Readonly<Record<Kind, string>> = {
  abandoned: "店が返金をやめた",
  owed: "返すつもりのまま返せなかった",
};

/** 「店が返金をやめた」を選ぶ前に伝える。発送前の取り消しの返金か、ほかの返金かは、この画面では分からない */
export const ABANDON_NOTE =
  "発送前の取り消しの返金でこれを選ぶと、その発送前の取り消しそのものが取りやめになり、品をまた送れる場合があります。同じ出来事でお金が出た返金や借りがほかにある時は、この返金だけをやめたことになります。";
const OWED_NOTE = "返金は Stripe 側で取り消されましたが、お客様には返すつもりです。振込で返したら、振込の記録を入れます。";
/** Stripe に届いていない error の返金で断られた時の文（route の store と同じ）。この時は「店が返金をやめた」を出さない */
const STRIPE_RETRY_TEXT = "Stripe への返金をやり直してください。";
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
  const guard = useRef(false);
  const keyRef = useRef(crypto.randomUUID());

  const trimmedReason = reason.trim();
  const canSubmit = !sending && kind !== null && trimmedReason !== "";
  const kinds: Kind[] = retryOnly ? ["owed"] : ["abandoned", "owed"];

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
    if (result.code === "UNIT_CANCEL_REVERT_REFUSED" && result.message === STRIPE_RETRY_TEXT) {
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
        <p className={noteClassName}>この返金は Stripe 側で取り消されました。どちらにあたるかを選んでください。</p>
        <div role="radiogroup" aria-label="取り消しの区分" className="space-y-3">
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
                <p data-testid="abandon-note" className={noteClassName}>
                  {ABANDON_NOTE}
                </p>
              ) : (
                <p className={noteClassName}>{OWED_NOTE}</p>
              )}
            </div>
          ))}
        </div>
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
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        <div className="refund-flow-actions flex flex-col-reverse gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={sending} onClick={onClose}>
            やめる
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
            区分を決める
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
