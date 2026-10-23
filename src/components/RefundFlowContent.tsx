'use client';

// File: src/components/RefundFlowContent.tsx
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button/Button';
import type { useRefundSubmission } from '@/hooks/useRefundSubmission';
import { formatYen } from '@/lib/orders/refund/refund-messages';

type RefundFlowContentProps = {
  flow: Pick<
    ReturnType<typeof useRefundSubmission>,
    'materials' | 'awaiting' | 'loadError' | 'alertText' | 'busy' | 'uncertain' | 'close' | 'checkAgain'
  >;
  backLabel: string;
  submitLabel: string;
  canSubmit: boolean;
  children: ReactNode;
};

/** 入力を挟む流れの表示を共有し、返金と支払い済みのキャンセルの状態ごとの操作を揃える。 */
export function RefundFlowContent({ flow, backLabel, submitLabel, canSubmit, children }: RefundFlowContentProps): ReactElement {
  return (
    <>
      {!flow.materials && !flow.loadError ? <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p> : null}

      {flow.awaiting ? (
        <p className="font-acumin lk-text-sm text-black">{`確かめ中の返金があります（${formatYen(flow.awaiting.amount)}）。`}</p>
      ) : null}

      {children}

      {flow.alertText ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {flow.alertText}
        </p>
      ) : null}

      {/* 何もせずに閉じるボタンは、どの状態でも「戻る」（読み込めなかった時・確かめ中・答えが分からない時も） */}
      {flow.loadError ? (
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={flow.close}>
            戻る
          </Button>
        </div>
      ) : flow.awaiting || flow.uncertain ? (
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.close}>
            戻る
          </Button>
          <Button variant="primary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.checkAgain}>
            もう一度確かめる
          </Button>
        </div>
      ) : (
        // 確定のボタンの字は「注文をキャンセルして ￥42,800 を返金する」のように長く、半分ずつの幅に並べると 3つの画面幅とも両端が切れて読めない。
        // 縦に並べて確定を1行の全部の幅にする（見た目は確定が上。並びの順は戻る → 確定のまま）。全部の幅でも収まらない時の折り返しは globals.css が許す
        <div className="refund-flow-actions flex flex-col-reverse gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.close}>
            {backLabel}
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </>
  );
}
