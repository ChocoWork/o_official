'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { submitCustomerReturnRequest } from '@/features/account/returns/customer-return-client';
import {
  REQUEST_TEXT,
  type ConfirmSummary,
  type SubmitBody,
} from '@/features/account/returns/return-request-model';
import { formatReturnNumber } from '@/lib/orders/returns/return-messages';

type ReturnRequestConfirmProps = {
  orderId: string;
  /** 確かめる段に入った時に作った、窓口へ送る中身（二重防止の番号つき）。この段の間は変わらない */
  body: SubmitBody;
  summary: ConfirmSummary;
  onBack: () => void;
  /** 受け付けた（同じ二重防止の番号の送り直しで前の結果が返った時も）。label は返品番号（ORD-XXXXXXXX-R1 の形） */
  onAccepted: (result: { label: string }) => void;
  /** 写真が合わないと断られた。合わない写真の送り先の番号（DB が断った時は空）と、画面に出す文 */
  onPhotosRejected: (uploadIds: string[], message: string) => void;
};

/**
 * 窓口の成功の答えから返品番号を読む。返品の番号（number）が読めない時は null（受け付けたか分からない扱いにする）。
 * 窓口の label（返品番号の文字）を使い、無い時だけ番号から組む（同じ formatReturnNumber）
 */
function readAcceptedLabel(body: unknown, orderId: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const { returnId, number, label } = data as { returnId?: unknown; number?: unknown; label?: unknown };
  if (typeof returnId !== 'string' || typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  return typeof label === 'string' && label !== '' ? label : formatReturnNumber(orderId, number);
}

/**
 * 「2. 内容を確かめる」の段（共通の約束 C-5・P13）。入力した中身と、返送料・手数料の仮の値を見せ、「申し込む」で窓口へ送る。
 * 二重防止の番号は確かめる段に入った時に作られ（親が body に入れる）、窓口が断った時（400・404・409）だけ作り直す。
 * 処理に入る前の断り（401・403・429）は番号を保つ。通信が切れた・500番台・読めない成功は、記録されたかもしれないので、
 * 入力を止めて「もう一度確かめる」だけを出し、同じ番号・同じ中身で送り直す（DB は前の記録を返し、返品は1件のまま）。
 */
export function ReturnRequestConfirm({ orderId, body, summary, onBack, onAccepted, onPhotosRejected }: ReturnRequestConfirmProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [requestKey, setRequestKey] = useState(body.requestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  // 直近に送った中身。答えが分からない時の「もう一度確かめる」が、これをそのまま送り直す
  const [pending, setPending] = useState<SubmitBody | null>(null);

  // 段が変わったことが分かるように、見出しへ移る（押したボタンは消えるので、移さないと位置が失われる）
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const send = async (payload: SubmitBody) => {
    setPending(payload);
    setBusy(true);
    setError(null);
    const result = await submitCustomerReturnRequest(orderId, payload);
    setBusy(false);
    if (result.kind === 'blocked') {
      // 処理に入る前の断り。前の送信の結果は変わらないので、番号・中身・結果不明の状態を保つ
      setError(result.message);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝申し込みは記録されていない。次の送信は別の操作なので、新しい番号にする
      setRequestKey(crypto.randomUUID());
      setUncertain(false);
      setPending(null);
      if (result.code === 'RETURN_PHOTO_INVALID') {
        // 写真の断りは手順1で直す。合わない写真が分かる時は親が外し、DB が断った時（番号が空）は写真を残して文だけ出す
        onPhotosRejected(result.invalidPhotoUploadIds, result.message);
        return;
      }
      setError(result.message);
      return;
    }
    const label = result.kind === 'ok' ? readAcceptedLabel(result.body, orderId) : null;
    if (label !== null) {
      onAccepted({ label });
      return;
    }
    setUncertain(true);
  };

  const submit = () => {
    if (busy) return;
    void send({ ...body, requestKey });
  };

  const checkAgain = () => {
    if (busy || !pending) return;
    void send(pending);
  };

  // 結果が分からない間に処理前の断り（401・403・429）を受けた時は、断りの文の後ろに、結果が分からない時の文を続けて出す
  const unknownText = uncertain ? REQUEST_TEXT.unknownOutcome : '';
  const alertText = error ? `${error}${unknownText}` : unknownText;

  return (
    <section aria-labelledby="return-request-confirm-heading" className="min-w-0 space-y-4 border border-black/10 p-5 sm:p-8">
      <h2 id="return-request-confirm-heading" ref={headingRef} tabIndex={-1} className="font-acumin outline-none">
        {REQUEST_TEXT.confirmHeading}
      </h2>
      <ul className="space-y-4">
        {summary.lines.map((line) => (
          <li key={line.key} className="min-w-0 space-y-1 break-words font-acumin lk-text-sm text-black">
            <p>{line.title}</p>
            <p>{line.reason}</p>
            {line.note ? <p className="whitespace-pre-wrap">{line.note}</p> : null}
            <p>{line.wish}</p>
            {line.photos ? <p>{line.photos}</p> : null}
          </li>
        ))}
      </ul>
      <div className="space-y-1 border-t border-black/10 pt-4 font-acumin lk-text-sm text-black">
        <p>{summary.shipping}</p>
        {summary.fees.map((fee) => (
          <p key={fee}>{fee}</p>
        ))}
        {summary.feeNote ? <p>{summary.feeNote}</p> : null}
      </div>
      <p className="font-acumin lk-text-sm text-[#474747]">{REQUEST_TEXT.confirmNotice}</p>
      <LiveMessage className="font-acumin lk-text-sm text-red-600">{alertText}</LiveMessage>
      {uncertain ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="primary" size="md" className="w-full font-acumin sm:w-auto" disabled={busy} onClick={checkAgain}>
            {REQUEST_TEXT.checkAgain}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" size="md" className="w-full font-acumin sm:w-auto" disabled={busy} onClick={onBack}>
            {REQUEST_TEXT.back}
          </Button>
          <Button type="button" variant="primary" size="md" className="w-full font-acumin sm:w-auto" disabled={busy} onClick={submit}>
            {REQUEST_TEXT.submit}
          </Button>
        </div>
      )}
    </section>
  );
}

type ReturnRequestAcceptedProps = { orderId: string; label: string };

/** 「3. お申し込みの受付」の段（C-5）。受け付けた文と返品番号、注文の画面へ戻るボタン */
export function ReturnRequestAccepted({ orderId, label }: ReturnRequestAcceptedProps) {
  const messageRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  return (
    <section data-testid="return-request-accepted" className="min-w-0 space-y-4 border border-black/10 p-5 sm:p-8">
      <p ref={messageRef} tabIndex={-1} className="font-acumin lk-text-md text-black outline-none">
        {REQUEST_TEXT.accepted}
      </p>
      <p className="break-words font-acumin lk-text-sm text-black">{REQUEST_TEXT.returnNumber(label)}</p>
      <Button href={`/account/orders/${orderId}`} variant="primary" size="md" className="w-full font-acumin sm:w-auto">
        {REQUEST_TEXT.toOrder}
      </Button>
    </section>
  );
}
