'use client';

import { useRef, useState, type FormEvent } from 'react';
import { accountingUrl } from '@/components/cost-profit/accounting-api';
import { sendAccountingJson } from '@/components/cost-profit/period-form';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { TextField } from '@/components/ui/TextField/TextField';
import { toJstDate } from '@/lib/accounting/jst-date';
import { MAX_ARRIVAL_REASON } from '@/lib/accounting/return-refund-types';

/**
 * 返品の届いた日を直す画面（FREQ-575-AC-01・FREQ-584-AC-02）。権限 admin.accounting.entries.correct を持つ人にだけ、
 * 返品の欄が開くボタンを出す（この画面は権限を読まない。DB と route が最後に確かめる）。
 * 直す日は今日まで・今の届いた日と違う日。理由は必須。同じ内容の再送は同じ二重防止の番号で送り、入力を変えたら番号を作り直す。
 * 非okの応答は本文を最後まで読み、route の日本語の文を出す。確定済みの取り消しなどで断られた時は、選べない日の説明を添える。
 */
type OrderReturnArrivalDialogProps = {
  receiptId: string;
  /** 今の届いた日（YYYY-MM-DD） */
  currentOn: string;
  /** 直した回数（版）。送り直すと DB が版の違いを断る */
  version: number;
  onClose: () => void;
  /** 直せた（同じ要求の再送で前の結果が返った時も）。親が知らせを出して読み直す */
  onDone: (notice: string) => void;
};

const DONE_NOTICE = '届いた日を直しました。';
const FUTURE_TEXT = '未来の日は選べません。';
const SAME_DAY_TEXT = '今の届いた日と同じ日です。';
const INVALID_NOTE =
  '届いた日は、今日より後の日、返品の申し込みより前の日、カード会社の取り消しが確定した日以前の日にはできません。';
const INVALID_CODE = 'RETURN_ARRIVAL_DATE_INVALID';

export default function OrderReturnArrivalDialog({ receiptId, currentOn, version, onClose, onDone }: OrderReturnArrivalDialogProps) {
  const [newOn, setNewOn] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  // 二重防止の番号。同じ内容の再送は同じ番号（DB は前の結果を返す）。内容を変えたら作り直す（DB は同じ番号で違う内容を断る）
  const keyRef = useRef(crypto.randomUUID());

  const today = toJstDate(new Date());
  const trimmedReason = reason.trim();
  const dateProblem = newOn === '' ? null : newOn > today ? FUTURE_TEXT : newOn === currentOn ? SAME_DAY_TEXT : null;
  const canSubmit = !sending && newOn !== '' && dateProblem === null && trimmedReason !== '';

  const changeDate = (value: string) => {
    keyRef.current = crypto.randomUUID();
    setNewOn(value);
    setError(null);
  };
  const changeReason = (value: string) => {
    keyRef.current = crypto.randomUUID();
    setReason(value);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || guard.current) return;
    guard.current = true;
    setSending(true);
    setError(null);
    const result = await sendAccountingJson(accountingUrl('return-arrival'), 'POST', {
      receiptId,
      newOn,
      reason: trimmedReason,
      expectedVersion: version,
      requestKey: keyRef.current,
    });
    guard.current = false;
    setSending(false);
    if (result.ok) {
      onDone(DONE_NOTICE);
      return;
    }
    setError(result.code === INVALID_CODE ? `${result.message}${INVALID_NOTE}` : result.message);
  };

  return (
    <Dialog open onClose={() => (sending ? undefined : onClose())} title="届いた日を直す" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <p className="font-acumin lk-text-sm text-black">{`今の届いた日 ${currentOn.replaceAll('-', '/')}`}</p>
        <TextField
          type="date"
          label="新しい届いた日"
          value={newOn}
          max={today}
          disabled={sending}
          onChange={(event) => changeDate(event.target.value)}
        />
        {dateProblem ? <p className="font-acumin lk-text-3xs text-red-700">{dateProblem}</p> : null}
        <TextAreaField
          label="直す理由（必須）"
          value={reason}
          rows={3}
          maxLength={MAX_ARRIVAL_REASON}
          disabled={sending}
          onChange={(event) => changeReason(event.target.value)}
        />
        <p className="font-acumin lk-text-3xs text-[#474747]">
          直した日・理由・直した人は記録に残ります。お客様には伝わりません。
        </p>
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
            直して記録する
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
