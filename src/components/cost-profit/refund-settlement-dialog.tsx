"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import {
  accountingUrl,
  dayLabel,
  getAccountingData,
  hasArray,
  inputClassName,
  labelClassName,
  noteClassName,
} from "./accounting-api";
import { currency } from "./constants";
import { sendAccountingJson } from "./period-form";

// やり直しの返金と借りの結び（FREQ-579-AC-05。preflight #16）。借りが残る返金（元の返金）と、同じ注文のやり直しの返金を選んで結ぶ。
// 開くのは権限 admin.accounting.entries.correct のある人だけ（呼ぶ側が出し分ける。route と DB が最後に確かめる）。
// 候補は GET /refund-settlements/candidates から読む（同じ注文で成功した返金のうち、結びの関数が受ける物だけ。同じ出来事の返金が先頭）。
// 借りの仕訳がまだ・残高を超える時（409）は、理由の文を出す。

/** route（GET /refund-settlements/candidates）が返す候補。名前・メール・住所は無い */
export type SettlementCandidate = {
  refundId: string;
  amount: number;
  /** 成功を知った日（日本の日付） */
  succeededOn: string;
  eventId: string | null;
  eventKind: string;
  /** 元の返金と同じ出来事の返金（route が先頭に並べる） */
  sameEvent: boolean;
};

const labelOf = (candidate: SettlementCandidate): string => {
  const base = `返金 ${candidate.refundId.slice(0, 8).toUpperCase()}　${dayLabel(candidate.succeededOn)}に成功　${currency(candidate.amount)}`;
  return candidate.sameEvent ? `${base}（同じ出来事）` : base;
};

const NOT_POSTABLE_TEXT = "借りの仕訳がまだ入っていないか、返す額が借りの残高を超えています。内容を確かめてください。";
const NO_CANDIDATE_TEXT = "結べるやり直しの返金が見つかりません。先に、やり直しの返金を作ってください。";

export function RefundSettlementDialog({
  owed,
  onClose,
  onDone,
}: {
  /** 借りが残る返金（元の返金） */
  owed: { refundId: string; orderNumber: string; owedPre: number; owedPost: number };
  onClose: () => void;
  /** 結べた（同じ要求の再送で前の結果が返った時も）。親が一覧を読み直す */
  onDone: () => void;
}) {
  const [payingId, setPayingId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SettlementCandidate[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const guard = useRef(false);
  const keyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await getAccountingData<{ candidates: SettlementCandidate[] }>(
        "refund-settlements/candidates",
        { owedRefundId: owed.refundId },
        (data) => hasArray(data, "candidates"),
      );
      if (!active) return;
      if (!result.ok) {
        setReadError(result.message);
        setCandidates([]);
        return;
      }
      setCandidates(result.data.candidates);
    })();
    return () => {
      active = false;
    };
  }, [owed.refundId]);

  const canSubmit = !sending && payingId !== "" && (candidates ?? []).some((candidate) => candidate.refundId === payingId);

  const send = async () => {
    if (!canSubmit || guard.current) return;
    guard.current = true;
    setSending(true);
    setError(null);
    const result = await sendAccountingJson(accountingUrl("refund-settlements"), "POST", {
      owedRefundId: owed.refundId,
      payingRefundId: payingId,
      requestKey: keyRef.current,
    });
    guard.current = false;
    setSending(false);
    if (result.ok) {
      onDone();
      return;
    }
    setError(result.code === "ACCOUNTING_EVENT_NOT_POSTABLE" ? NOT_POSTABLE_TEXT : result.message);
  };

  return (
    <Dialog open onClose={() => (sending ? undefined : onClose())} title="やり直しの返金と結ぶ" fullScreenOnMobile>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <p className="font-acumin lk-text-sm text-black">{`借りが残る返金 ${owed.orderNumber}`}</p>
        <p className={noteClassName}>
          {[
            owed.owedPre > 0 ? `出荷前の分 ${currency(owed.owedPre)}` : null,
            owed.owedPost > 0 ? `出荷後の分 ${currency(owed.owedPost)}` : null,
          ]
            .filter((text): text is string => text !== null)
            .join("　")}
        </p>
        {candidates === null ? (
          <p role="status" className={noteClassName}>
            読み込み中
          </p>
        ) : readError ? (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {readError}
          </p>
        ) : candidates.length === 0 ? (
          <p className={noteClassName}>{NO_CANDIDATE_TEXT}</p>
        ) : (
          <label className="block">
            <span className={labelClassName}>やり直しの返金</span>
            <select
              className={inputClassName}
              value={payingId}
              disabled={sending}
              onChange={(event) => {
                // 選び直したら番号を作り直す（DB は同じ番号で違う内容を断る）
                keyRef.current = crypto.randomUUID();
                setPayingId(event.target.value);
                setError(null);
              }}
            >
              <option value="">選んでください</option>
              {candidates.map((candidate) => (
                <option key={candidate.refundId} value={candidate.refundId}>
                  {labelOf(candidate)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className={noteClassName}>結ぶと、やり直しの返金で返した分だけ、借りが減ります。結んだ後は元に戻せません。</p>
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
            やり直しと結ぶ
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
