"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { toJstDate } from "@/lib/accounting/jst-date";
import { ACCOUNTING_LABELS } from "@/lib/accounting/labels";
import { BANK_TXN_NO_PATTERN, MAX_BANK_TXN_NO, MAX_REFUND_BANK_NOTE } from "@/lib/accounting/return-refund-types";
import { accountingUrl, inputClassName, isRecord, labelClassName, noteClassName } from "./accounting-api";
import { sendAccountingJson } from "./period-form";

// 振込で返した分の記録（FREQ-579-AC-04・FREQ-584-AC-03）。返金が Stripe で取り消されて借りが残った分を、銀行の振込で返した時に入れる。
// 注文・借りの種類・額・振込の日・銀行の取引の番号・メモ。未来の日と額0は送る前に止める。同じ内容の再送は同じ二重防止の番号。
// 開くのは権限 admin.finance.manage のある人だけ（呼ぶ側が出し分ける。route と DB が最後に確かめる）。

export type BankTransferOrigin = "pre_shipment" | "post_shipment" | "return";

const ORIGIN_LABEL: Readonly<Record<BankTransferOrigin, string>> = {
  pre_shipment: ACCOUNTING_LABELS.refundPreShipment,
  post_shipment: ACCOUNTING_LABELS.refundAfterShipment,
  return: ACCOUNTING_LABELS.refundReturn,
};
const ORIGINS: readonly BankTransferOrigin[] = ["pre_shipment", "post_shipment", "return"];

const FUTURE_TEXT = "振込の日は今日までです。";
const AMOUNT_TEXT = "額は1円以上で入れてください。";
const TXN_TEXT = `銀行の取引の番号は、英数字・ハイフン・下線の${MAX_BANK_TXN_NO}字までで入れてください。`;
/** 借りの残高を超える額・借りの仕訳がまだ無い時（route は ACCOUNTING_EVENT_NOT_POSTABLE の409） */
const NOT_POSTABLE_TEXT = "借りの残高を超えているか、借りの仕訳がまだ入っていません。額と借りの種類を確かめてください。";
const RECORDED_TEXT = "振込の記録を入れました。";
const DUPLICATE_TEXT = "同じ銀行の取引の番号は、もう記録されています。";

export function RefundBankTransferForm({
  orders,
  initial,
  onDone,
  onCancel,
}: {
  orders: ReadonlyArray<{ orderId: string; orderNumber: string }>;
  /** 最初に選んでおく注文と借りの種類 */
  initial?: { orderId: string; origin: BankTransferOrigin };
  /** 記録できた（同じ要求の再送で前の結果が返った時や、同じ銀行の取引の番号が記録済みだった時も）。親が一覧を読み直す */
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [orderId, setOrderId] = useState(initial?.orderId ?? orders[0]?.orderId ?? "");
  const [origin, setOrigin] = useState<BankTransferOrigin>(initial?.origin ?? "post_shipment");
  const [amount, setAmount] = useState("");
  const [bankDate, setBankDate] = useState("");
  const [txnNo, setTxnNo] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const guard = useRef(false);
  const keyRef = useRef(crypto.randomUUID());

  const today = toJstDate(new Date());
  const amountText = amount.trim();
  const amountValue = /^[0-9]{1,15}$/.test(amountText) ? Number(amountText) : null;
  const amountProblem = amountText !== "" && (amountValue === null || amountValue < 1) ? AMOUNT_TEXT : null;
  const dateProblem = bankDate !== "" && bankDate > today ? FUTURE_TEXT : null;
  const txn = txnNo.trim();
  const txnProblem = txn !== "" && !BANK_TXN_NO_PATTERN.test(txn) ? TXN_TEXT : null;
  const canSubmit =
    !sending && orderId !== "" && amountValue !== null && amountValue >= 1 && bankDate !== "" && dateProblem === null && txn !== "" && txnProblem === null;

  /** 入力を変えたら、前の結果の表示を消して番号を作り直す（DB は同じ番号で違う内容を断る） */
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    keyRef.current = crypto.randomUUID();
    setStatus(null);
    setError(null);
    set(value);
  };

  const send = async () => {
    if (!canSubmit || guard.current || amountValue === null) return;
    guard.current = true;
    setSending(true);
    setError(null);
    setStatus(null);
    const trimmedNote = note.trim();
    const result = await sendAccountingJson(accountingUrl("refund-bank-transfers"), "POST", {
      orderId,
      origin,
      amount: amountValue,
      bankDate,
      bankTxnNo: txn,
      note: trimmedNote === "" ? null : trimmedNote,
      requestKey: keyRef.current,
    });
    guard.current = false;
    setSending(false);
    if (!result.ok) {
      setError(result.code === "ACCOUNTING_EVENT_NOT_POSTABLE" ? NOT_POSTABLE_TEXT : result.message);
      return;
    }
    const transfer = isRecord(result.data) && isRecord(result.data.transfer) ? result.data.transfer : null;
    setStatus(transfer?.created === false ? DUPLICATE_TEXT : RECORDED_TEXT);
    // 記録できたら入力を空にして、同じ記録を続けて送らせない
    keyRef.current = crypto.randomUUID();
    setAmount("");
    setTxnNo("");
    setNote("");
    onDone();
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div role="group" aria-label="振込で返した分を記録する" className="space-y-3 rounded-sm border border-[#ededed] p-4">
        <h4 className="font-acumin lk-text-xs font-medium tracking-widest text-black">振込で返した分を記録する</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={labelClassName}>注文</span>
            <select className={inputClassName} value={orderId} disabled={sending} onChange={(e) => edit(setOrderId)(e.target.value)}>
              {orders.map((order) => (
                <option key={order.orderId} value={order.orderId}>
                  {order.orderNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClassName}>借りの種類</span>
            <select
              className={inputClassName}
              value={origin}
              disabled={sending}
              onChange={(e) => edit(setOrigin)(e.target.value as BankTransferOrigin)}
            >
              {ORIGINS.map((value) => (
                <option key={value} value={value}>
                  {ORIGIN_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClassName}>額（円）</span>
            <input
              type="text"
              inputMode="numeric"
              className={inputClassName}
              value={amount}
              disabled={sending}
              onChange={(e) => edit(setAmount)(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={labelClassName}>振込の日</span>
            <input
              type="date"
              max={today}
              className={inputClassName}
              value={bankDate}
              disabled={sending}
              onChange={(e) => edit(setBankDate)(e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={labelClassName}>銀行の取引の番号</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_BANK_TXN_NO}
              className={inputClassName}
              value={txnNo}
              disabled={sending}
              onChange={(e) => edit(setTxnNo)(e.target.value)}
            />
          </label>
        </div>
        <p className={noteClassName}>切り替えの日より前の日と、カード会社の取り消しが確定した日以前の日は、記録できません。</p>
        {amountProblem ? <p className="font-acumin lk-text-3xs text-red-700">{amountProblem}</p> : null}
        {dateProblem ? <p className="font-acumin lk-text-3xs text-red-700">{dateProblem}</p> : null}
        {txnProblem ? <p className="font-acumin lk-text-3xs text-red-700">{txnProblem}</p> : null}
        <label className="block">
          <span className={labelClassName}>メモ（任意）</span>
          <textarea
            maxLength={MAX_REFUND_BANK_NOTE}
            className="h-16 w-full rounded-md border border-[#d4d4d4] bg-white px-3 py-2 font-acumin lk-text-sm text-black focus:border-black focus:outline-none"
            value={note}
            disabled={sending}
            onChange={(e) => edit(setNote)(e.target.value)}
          />
        </label>
        <p className={noteClassName}>銀行の控えで確かめた額・日・取引の番号を入れてください。個人の名前やメールは書かないでください。</p>
        {error ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {error}
          </p>
        ) : null}
        {status ? (
          <p role="status" className="font-acumin lk-text-3xs text-black">
            {status}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" shape="rounded" className="font-acumin" disabled={!canSubmit}>
            振込を記録する
          </Button>
          {onCancel ? (
            <Button variant="outline" size="sm" shape="rounded" className="font-acumin" disabled={sending} onClick={onCancel}>
              閉じる
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
