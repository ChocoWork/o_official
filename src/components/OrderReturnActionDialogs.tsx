'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { ReturnFlowContent, ReturnLoadDialog, type ReturnDialogProps } from '@/components/ReturnDialogParts';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { useLoadedReturn } from '@/hooks/useLoadedReturn';
import { blockEnterSubmit } from '@/hooks/useRefundSubmission';
import { parseActionResponse, useReturnOperation } from '@/hooks/useReturnOperation';
import { lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import { DISPOSITION_LABELS, RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

type ActionBodyProps = Pick<ReturnDialogProps, 'onClose' | 'onDone' | 'onUncertain'> & { detail: OrderReturnDetail };

// C-5 に無い。受け取りの画面の「答えが分からない時」の文と同じ形で、操作の名前だけを外した物
const UNKNOWN_ACTION_MESSAGE = '操作の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const PLACEHOLDER = '選択してください';
const INSPECT_OPTIONS = [
  { value: 'restocked', label: DISPOSITION_LABELS.restocked },
  { value: 'not_restocked', label: DISPOSITION_LABELS.not_restocked },
];

/**
 * 5つの画面が同じ流れ（送る・答えが分からない・閉じる）を使う。違うのは、送る窓口の名前（/api/admin/returns/[返品]/[path]）と本文だけ。
 * 取消・手数料・支払いを待たずに送るは二重防止の番号を使わない。送り直して状態が変わっていれば、窓口が「状態が変わりました」と断る。
 * 受け付けられたら onDone を知らせなしで呼ぶ（C-5 に、この5つの後の知らせは無い。返品の欄が中身を読み直して見せる）。
 * 例外は手数料の「いただかないで終える」で、send に C-5 の知らせを渡す（P27）。
 */
function useReturnActionFlow({
  detail,
  path,
  onClose,
  onDone,
  onUncertain,
}: ActionBodyProps & { path: 'cancel' | 'reopen' | 'inspect' | 'fee-payment' | 'release-exchange' }) {
  const flow = useReturnOperation({
    unknownMessage: UNKNOWN_ACTION_MESSAGE,
    fallbackMessage: RETURN_ERROR_MESSAGES.RETURN_ARGUMENT_INVALID.message,
    onClose,
    onUncertain,
  });
  // notice は親へ渡す知らせ。省くと知らせなしの onDone()（C-5 に後の知らせがある「いただかないで終える」だけが渡す）
  const send = (makeBody: (requestKey: string) => object, notice?: string) => {
    flow.submit(`/api/admin/returns/${detail.id}/${path}`, makeBody, (data) => {
      if (parseActionResponse(data) === null) return false;
      if (notice === undefined) onDone();
      else onDone(notice);
      return true;
    });
  };
  return { flow, send, idle: !flow.busy && !flow.uncertain };
}

type ActionFrameProps = {
  flow: ReturnType<typeof useReturnOperation>;
  title: string;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  /** 確定と戻るの間に出す、もう1つの操作（手数料の「いただかないで終える」）。省ける */
  extraAction?: { label: string; onClick: () => void };
  children: ReactNode;
};

function ActionFrame({ flow, title, submitLabel, canSubmit, onSubmit, extraAction, children }: ActionFrameProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSubmit) onSubmit();
  };
  return (
    <Dialog open onClose={flow.close} title={title} fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        <ReturnFlowContent flow={flow} backLabel="戻る" submitLabel={submitLabel} canSubmit={canSubmit} extraAction={extraAction}>
          <div className="space-y-3">{children}</div>
        </ReturnFlowContent>
      </form>
    </Dialog>
  );
}

const CANCEL_TITLE = '返品を取り消す';

/** 返品の取消の画面（設計書 7-3）。何も受け取っていない返品だけ。お客様にメールは送らない */
export function OrderReturnCancelDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title={CANCEL_TITLE} onClose={onClose} />;
  return <CancelBody key={state.detail.id} detail={state.detail} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function CancelBody({ detail, onClose, onDone, onUncertain }: ActionBodyProps) {
  const { flow, send, idle } = useReturnActionFlow({ detail, path: 'cancel', onClose, onDone, onUncertain });
  return (
    <ActionFrame flow={flow} title={CANCEL_TITLE} submitLabel="返品を取り消す" canSubmit={idle} onSubmit={() => send(() => ({}))}>
      <p className="font-acumin lk-text-sm text-black">この返品を取り消します。品はまた返品できるようになります。お客様にメールは送りません。</p>
    </ActionFrame>
  );
}

const REOPEN_TITLE = '返品を開き直す';

/** 返品の開き直しの画面（設計書 7-4）。「届かない」として終えた品を、また受け取れるようにする */
export function OrderReturnReopenDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title={REOPEN_TITLE} onClose={onClose} />;
  return <ReopenBody key={state.detail.id} detail={state.detail} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function ReopenBody({ detail, onClose, onDone, onUncertain }: ActionBodyProps) {
  const { flow, send, idle } = useReturnActionFlow({ detail, path: 'reopen', onClose, onDone, onUncertain });
  // progress.missing は、開き直しで受け取れるようにした分を引いた後の「届かない」の数
  const missing = detail.lines.reduce((sum, line) => sum + line.progress.missing, 0);
  return (
    <ActionFrame
      flow={flow}
      title={REOPEN_TITLE}
      submitLabel="開き直す"
      canSubmit={idle}
      onSubmit={() => send((requestKey) => ({ requestKey }))}
    >
      <p className="font-acumin lk-text-sm text-black">{`「届かない」として終えた ${missing} 点を、また受け取れるようにします。`}</p>
    </ActionFrame>
  );
}

const INSPECT_TITLE = '検品を終える';

/** 検品の画面（設計書 6-1）。検品待ちの品を、在庫に戻すか戻さないかに決める。返金は受け取りの時に決めた選び方のまま */
export function OrderReturnInspectDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title={INSPECT_TITLE} onClose={onClose} />;
  return <InspectBody key={state.detail.id} detail={state.detail} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function InspectBody({ detail, onClose, onDone, onUncertain }: ActionBodyProps) {
  const { flow, send, idle } = useReturnActionFlow({ detail, path: 'inspect', onClose, onDone, onUncertain });
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  // 検品待ちの品を1点ずつ並べる
  const rows = detail.lines.flatMap((line) =>
    Array.from({ length: line.progress.pendingInspection }, (_, index) => ({ key: `${line.id}-${index}`, line })),
  );
  const undecided = rows.filter((row) => !decisions[row.key]).length;
  const canSubmit = idle && rows.length > 0 && undecided === 0;

  const buildBody = (requestKey: string) => ({
    requestKey,
    lines: detail.lines.flatMap((line) => {
      const mine = rows.filter((row) => row.line.id === line.id);
      if (mine.length === 0) return [];
      return [
        {
          returnLineId: line.id,
          restocked: mine.filter((row) => decisions[row.key] === 'restocked').length,
          notRestocked: mine.filter((row) => decisions[row.key] === 'not_restocked').length,
        },
      ];
    }),
  });

  return (
    <ActionFrame
      flow={flow}
      title={`${INSPECT_TITLE}（${detail.label}）`}
      submitLabel="検品を終える"
      canSubmit={canSubmit}
      onSubmit={() => send(buildBody)}
    >
      <ul aria-label="検品待ちの品" className="space-y-3">
        {rows.map((row) => {
          const label = lineLabel({ name: row.line.itemName, color: row.line.color, size: row.line.size });
          return (
            <li key={row.key}>
              <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
                <span className="font-acumin lk-text-sm text-black">{label}</span>
                <SingleSelect
                  label="品の状態"
                  placeholder={PLACEHOLDER}
                  options={INSPECT_OPTIONS}
                  value={decisions[row.key] ?? ''}
                  disabled={!idle}
                  onChange={(event) => setDecisions((previous) => ({ ...previous, [row.key]: event.target.value }))}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </ActionFrame>
  );
}

const FEE_PAYMENT_TITLE = '手数料の受け取りを記録する';
// C-5・P27。いただかないことにして終えた後の知らせ（受け取りを記録した時は知らせなし）
const FEE_WAIVED_NOTICE = '手数料をいただかないことにしました。';

/**
 * 手数料の受け取りを記録する画面（設計書 6-4）。手で受け取った手数料を記録し、お支払い待ちを終える。
 * 「いただかないで終える」（P27）で、いただかないことにして終えることもできる。店長だけ
 */
export function OrderReturnFeePaymentDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title={FEE_PAYMENT_TITLE} onClose={onClose} />;
  return <FeePaymentBody key={state.detail.id} detail={state.detail} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function FeePaymentBody({ detail, onClose, onDone, onUncertain }: ActionBodyProps) {
  const { flow, send, idle } = useReturnActionFlow({ detail, path: 'fee-payment', onClose, onDone, onUncertain });
  const [note, setNote] = useState('');
  // 受け取りの記録（waive: false）といただかないで終える（waive: true）は、同じ窓口へ同じメモで送る。違いは waive と、親へ渡す知らせだけ
  const sendFee = (waive: boolean) =>
    send(() => ({ note: note.trim() || null, waive }), waive ? FEE_WAIVED_NOTICE : undefined);
  return (
    <ActionFrame
      flow={flow}
      title={FEE_PAYMENT_TITLE}
      submitLabel="受け取りを記録する"
      canSubmit={idle}
      onSubmit={() => sendFee(false)}
      extraAction={{ label: 'いただかないで終える', onClick: () => sendFee(true) }}
    >
      <p className="font-acumin lk-text-sm text-black">{`いただく額: ${formatYen(detail.fees.feeDueAmount)}`}</p>
      <TextAreaField
        label="受け取りの方法のメモ（お客様には見えません）"
        value={note}
        rows={3}
        maxLength={ADMIN_NOTE_MAX_LENGTH}
        disabled={!idle}
        onChange={(event) => setNote(event.target.value)}
      />
    </ActionFrame>
  );
}

const RELEASE_EXCHANGE_TITLE = '支払いを待たずに送る';

/** 支払いを待たずに送る画面（設計書 6-4）。手数料のお支払い待ちの交換の品を、発送できるようにする。店長だけ */
export function OrderReturnReleaseExchangeDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title={RELEASE_EXCHANGE_TITLE} onClose={onClose} />;
  return <ReleaseExchangeBody key={state.detail.id} detail={state.detail} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function ReleaseExchangeBody({ detail, onClose, onDone, onUncertain }: ActionBodyProps) {
  const { flow, send, idle } = useReturnActionFlow({ detail, path: 'release-exchange', onClose, onDone, onUncertain });
  return (
    <ActionFrame
      flow={flow}
      title={RELEASE_EXCHANGE_TITLE}
      submitLabel="支払いを待たずに送る"
      canSubmit={idle}
      onSubmit={() => send(() => ({}))}
    >
      <p className="font-acumin lk-text-sm text-black">
        手数料のお支払いを待たずに、交換の品を送れるようにします。手数料はお支払い待ちのまま残ります。
      </p>
    </ActionFrame>
  );
}
