"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { TOPUP_REFERENCE_PATTERN } from "@/lib/accounting/posting-schema";
import {
  accountingUrl,
  inputClassName,
  labelClassName,
  noteClassName,
  Section,
  todayJst,
} from "./accounting-api";
import {
  errorNotice,
  failureNotice,
  NoticeLine,
  sendAccountingJson,
  successNotice,
  type Notice,
} from "./period-form";

// 残高の補充の入力（FREQ-565-AC-06）。銀行から Stripe の残高へ入れたお金を記録する（1160／1040）。
// 銀行の取引番号と Stripe の取引の番号は、英数字と _ . - だけ・128文字まで。どちらかは必須で、Stripe の取引の番号を添えると
// その取引に結び付く。日は今日（日本時間）まで。切り替えの日より前は route が断る。権限（admin.finance.manage）が要る。

export const REFERENCE_HELP = "英数字と _ . - だけ、128文字までで入れてください";
const MAX_NOTE = 400;

export function BalanceTopupForm({
  canManage,
  loadError = null,
  today: todayProp,
  onRecorded,
}: {
  /** 権限を読み終えるまでは null（読み込み中を出す）。 */
  canManage: boolean | null;
  /** 権限が読めなかった時の固定の文。 */
  loadError?: string | null;
  /** 日本時間の今日（試験用）。 */
  today?: string;
  onRecorded?: () => void;
}): React.JSX.Element {
  const today = todayProp ?? todayJst();
  const [amount, setAmount] = useState("");
  const [bankDate, setBankDate] = useState("");
  const [bankTxnNo, setBankTxnNo] = useState("");
  const [stripeTxnId, setStripeTxnId] = useState("");
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const guard = useRef(false);

  if (canManage !== true) {
    return (
      <Section title="残高の補充の記録">
        {loadError ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {loadError}
          </p>
        ) : canManage === null ? (
          <p role="status" className={noteClassName}>
            読み込み中
          </p>
        ) : (
          <p className={noteClassName}>残高の補充を記録する権限がありません</p>
        )}
      </Section>
    );
  }

  const submit = async () => {
    if (guard.current) return;
    const amountNumber = amount.trim() === "" ? Number.NaN : Number(amount);
    if (!Number.isSafeInteger(amountNumber) || amountNumber < 1) {
      setNotice(errorNotice("額は1円以上の整数で入れてください。"));
      return;
    }
    if (!bankDate) {
      setNotice(errorNotice("銀行の日を入れてください。"));
      return;
    }
    if (bankDate > today) {
      setNotice(errorNotice("未来の日は入れられません。"));
      return;
    }
    const bank = bankTxnNo.trim();
    const stripe = stripeTxnId.trim();
    if (bank === "" && stripe === "") {
      setNotice(errorNotice("銀行の取引番号かStripeの取引番号のどちらかを入れてください。"));
      return;
    }
    if ((bank !== "" && !TOPUP_REFERENCE_PATTERN.test(bank)) || (stripe !== "" && !TOPUP_REFERENCE_PATTERN.test(stripe))) {
      setNotice(errorNotice("取引番号は英数字と _ . - だけ、128文字までです。"));
      return;
    }
    guard.current = true;
    setSaving(true);
    setNotice(null);
    const result = await sendAccountingJson(accountingUrl("balance-topups"), "POST", {
      amount: amountNumber,
      bankDate,
      bankTxnNo: bank === "" ? null : bank,
      stripeTxnId: stripe === "" ? null : stripe,
      note: note.trim() === "" ? null : note.trim(),
      requestKey: crypto.randomUUID(),
    });
    if (result.ok) {
      const created = (result.data as { topup?: { created?: boolean } } | null)?.topup?.created;
      setNotice(
        successNotice(created === false ? "同じ記録が既にあります。新しくは入れていません。" : "補充を記録しました。"),
      );
      setAmount("");
      setBankDate("");
      setBankTxnNo("");
      setStripeTxnId("");
      setNote("");
      onRecorded?.();
    } else {
      setNotice(failureNotice(result));
    }
    guard.current = false;
    setSaving(false);
  };

  return (
    <Section title="残高の補充の記録">
      <p className={noteClassName}>
        銀行から Stripe の残高へ入れたお金を記録します。Stripe の取引の番号を添えると、その取引に結び付きます。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClassName}>補充した額（円）</span>
          <input type="number" inputMode="numeric" min={1} step={1} className={inputClassName} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelClassName}>銀行の日</span>
          <input type="date" max={today} className={inputClassName} value={bankDate} onChange={(e) => setBankDate(e.target.value)} />
        </label>
        <div>
          <label className="block">
            <span className={labelClassName}>銀行の取引番号</span>
            <input type="text" maxLength={128} className={inputClassName} value={bankTxnNo} onChange={(e) => setBankTxnNo(e.target.value)} />
          </label>
          <p className={noteClassName}>{REFERENCE_HELP}</p>
        </div>
        <div>
          <label className="block">
            <span className={labelClassName}>Stripeの取引番号</span>
            <input type="text" maxLength={128} className={inputClassName} value={stripeTxnId} onChange={(e) => setStripeTxnId(e.target.value)} />
          </label>
          <p className={noteClassName}>{REFERENCE_HELP}</p>
        </div>
      </div>
      <label className="block">
        <span className={labelClassName}>メモ（任意）</span>
        <input type="text" maxLength={MAX_NOTE} className={inputClassName} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <NoticeLine notice={notice} />
      <Button variant="primary" size="sm" shape="rounded" className="font-acumin" disabled={saving} onClick={() => void submit()}>
        補充を記録する
      </Button>
    </Section>
  );
}
