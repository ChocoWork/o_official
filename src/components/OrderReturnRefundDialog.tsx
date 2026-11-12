'use client';

import { useState, type FormEvent } from 'react';
import { ReturnFlowContent, ReturnLoadDialog, ReturnRefundFields, type ReturnDialogProps } from '@/components/ReturnDialogParts';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { useLoadedReturn, type LoadedReturn } from '@/hooks/useLoadedReturn';
import { blockEnterSubmit } from '@/hooks/useRefundSubmission';
import { readRecord, useReturnOperation } from '@/hooks/useReturnOperation';
import { useUnitPricingEstimate } from '@/hooks/useUnitPricingEstimate';
import { lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { UNKNOWN_REFUND_OUTCOME_MESSAGE, formatYen } from '@/lib/orders/refund/refund-messages';
import { RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import type { ReturnReceiveEstimate } from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 額を決めて返金の窓口が返す `data`（C-3）。返金額が0円の時（P20）は、返金を作らず refundId が null、status が 'waived'
 */
export type RefundReturnResponse = {
  refundId: string | null;
  amount: number;
  status: 'pending' | 'succeeded' | 'waived';
  replayed: boolean;
};

/** 額を決めて返金の窓口へ送る本文。C-1 の admin_refund_return の引数を camelCase にした物。amount の null は計算どおり、0 は返金しないで終える */
export type RefundReturnRequest = {
  requestKey: string;
  amount: number | null;
  shippingAmount: number;
  note: string | null;
  notifyCustomer: boolean;
};

type OrderReturnRefundDialogBodyProps = Pick<ReturnDialogProps, 'onClose' | 'onDone' | 'onUncertain'> & { loaded: LoadedReturn };

// 割引・手数料の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';
const IRREVERSIBLE_NOTICE = '返金は取り消せません。';
const ESTIMATING_TEXT = '計算しています';
const ESTIMATE_FAILURE_MESSAGE = '返金の見込みを計算できませんでした。画面を開き直してください。';
// 品を選ばない本文。受け取りの見込みの窓口が、写しのある注文の「相談の残り」（consultOutstanding）だけを返すのに使う
const NO_PICKS_BODY = { units: [], exchangeOverrides: [], refundChoice: 'none', refundShippingAmount: 0 } as const;
const WAIVE_NOTICE = '返金しないで終えます。お客様に返金のメールは送りません。';
// 返金額を0にしても送料が残る（送料の欄の初めの値が入っている）間は押せない。その理由（FREQ-642-AC-37）
const WAIVE_NEEDS_NO_SHIPPING = '返金しないで終えるには、返金額と送料をどちらも0円にしてください。';
const REFUND_NOTICES = {
  accepted: '返金を受け付けました。お金が戻ると、注文の状態が変わります。',
  succeeded: '返金しました。',
  waived: '返金しないで終えました。',
} as const;

/** 相談の受け取りで付き、この返金から引く手数料（DB の order_returns.fee_pending_deduction。C-2 の fees.feePendingDeduction） */
function pendingFeeOf(detail: OrderReturnDetail): number {
  return detail.fees.feePendingDeduction > 0 ? detail.fees.feePendingDeduction : 0;
}

/** 額を決めて返金した後に、親が出す知らせ（E-2 の返金の知らせと同じ言葉。0円で終えた時は C-5 の言葉） */
export function returnRefundNoticeOf(result: RefundReturnResponse): string {
  return REFUND_NOTICES[result.status === 'pending' ? 'accepted' : result.status];
}

/** 額を決めて返金の窓口の答えを、画面が使う形に読む。形が違えば null（答えが分からない時と同じに扱う） */
function parseRefundResponse(data: unknown): RefundReturnResponse | null {
  const record = readRecord(data);
  if (!record || typeof record.amount !== 'number') return null;
  const replayed = record.replayed === true;
  if (record.status === 'waived') return { refundId: null, amount: record.amount, status: 'waived', replayed };
  if (record.status !== 'pending' && record.status !== 'succeeded') return null;
  if (typeof record.refundId !== 'string') return null;
  return { refundId: record.refundId, amount: record.amount, status: record.status, replayed };
}

/**
 * 額を決めて返金の画面（グループ E-3 設計書 6-3）。相談の受け取りの後や、サポートが受け取った後の「返金待ち」の品を、
 * 店長が額を決めて返金する。内訳と入力は受け取りの画面（今返金）と同じ。Stripe に伝える理由は「お客様の希望」だけ（P17）なので選ばせない。
 * 返金額が見込みと同じなら額を送らない（DB が同じ式で計算し、相談の受け取りで付いた手数料を引く）。
 * 返金額を0にすると、返金しないで終える（P20）。DB は返金を作らず Stripe にも頼まないので、メールの選びを隠し、注意の文を替える。
 * 開く時に、注文の返品の窓口を読んで返品の中身と返せる額を得る（useLoadedReturn）。親が開くたびに描き直す（閉じたら外す）ので、
 * 二重防止の番号も入力も開くたびに新しくなる。受け付けたら onDone(C-5 の後の知らせ) を呼ぶ。閉じるのは親。
 * 完了した返品でも、返金待ちの品があれば開ける（返品の返金が失敗した後の返し直し。P21）。
 */
export default function OrderReturnRefundDialog({ orderId, returnId, onClose, onDone, onUncertain }: ReturnDialogProps) {
  const { state } = useLoadedReturn(orderId, returnId);
  if (state.kind !== 'ready') return <ReturnLoadDialog state={state} title="額を決めて返金する" onClose={onClose} />;
  return <OrderReturnRefundDialogBody key={state.detail.id} loaded={state} onClose={onClose} onDone={onDone} onUncertain={onUncertain} />;
}

function OrderReturnRefundDialogBody({ loaded, onClose, onDone, onUncertain }: OrderReturnRefundDialogBodyProps) {
  const { detail, refundableAmount, refundableShipping } = loaded;
  const flow = useReturnOperation({
    unknownMessage: UNKNOWN_REFUND_OUTCOME_MESSAGE,
    fallbackMessage: RETURN_ERROR_MESSAGES.RETURN_ARGUMENT_INVALID.message,
    onClose,
    onUncertain,
  });
  // 送料の欄に店長が入れた値。入れるまでは null で、見込みの送料の初めの値（retryShipping）を使う
  const [shippingEntered, setShippingEntered] = useState<number | null>(null);
  // 返金額を手で直した時だけ入る。送料を変えたら空に戻し、見込みの額に追い付かせる
  const [amountEntered, setAmountEntered] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const stopped = flow.busy || flow.uncertain || flow.recorded;
  const waitingLines = detail.lines.filter((line) => line.progress.refundWaiting > 0);
  // 商品の額は、写しのある注文では見込みの窓口の「相談の残り」（相談の出来事がまだ返していない額に、受け取りの時の返金が失敗した
  // 今すぐの分を足した額。返金しないで終えた分は除く。FREQ-642-AC-37。全部返金済みなら 0）。
  // 写しの無い注文（legacy）は、今の待ち額で出す（FREQ-642-AC-20）。窓口の答えを待つ間・出せない間は額を出さない
  const estimateState = useUnitPricingEstimate<ReturnReceiveEstimate>(
    waitingLines.length > 0 ? `/api/admin/returns/${detail.id}/receive-estimate` : null,
    waitingLines.length > 0 ? NO_PICKS_BODY : null,
    ESTIMATE_FAILURE_MESSAGE,
  );
  const estimating = estimateState.status === 'loading';
  const estimateBlocked = estimating || estimateState.status === 'error';
  const outstanding = estimateState.status === 'ready' && !estimateState.estimate.legacy ? estimateState.estimate.consultOutstanding ?? null : null;
  // 商品の額は全部の行の待ち額（DB の refund_waiting_amount）を足す。H の注文の待ち額は品ごとの仮の割り当てで決まり、
  // 案イの印の行（返金待ちに見える行）と一致しないことがある。admin_refund_return も返品の待ちの品の全部を返す（DD-ADMIN-019）
  const itemsAmount = outstanding ?? detail.lines.reduce((sum, line) => sum + line.refundWaitingAmount, 0);
  // 相談の受け取りで付いた手数料は、商品の額から引く。引ききれない分は DB がお支払い待ちに回す
  const deducted = Math.min(pendingFeeOf(detail), itemsAmount);
  // 送料の初めの値は、返し直す今すぐの分の失敗した返金の送料（FREQ-642-AC-37）。返せる送料を超えない。店長は変えられる
  const retryShipping = estimateState.status === 'ready' && !estimateState.estimate.legacy ? estimateState.estimate.retryShipping ?? 0 : 0;
  const shippingAmount = Math.min(shippingEntered ?? retryShipping, refundableShipping);
  const calculated = itemsAmount - deducted + shippingAmount;
  const amount = Math.min(refundableAmount, amountEntered ?? calculated);
  // 返金額が0円なら、返金しないで終える。手数料が商品の額以上の時は、最初からこうなる（返金待ちの品が無い間は、ただ押せない）
  const waiving = waitingLines.length > 0 && amount === 0;
  const breakdownRows: Array<[string, string]> = [['商品', formatYen(itemsAmount)]];
  if (deducted > 0) breakdownRows.push(['受け取りで付いた手数料', `${MINUS}${formatYen(deducted)}`]);
  breakdownRows.push(['送料', formatYen(shippingAmount)], ['返金額', formatYen(calculated)]);

  // DB は「送料 ≤ 額」を入力の誤りにする。画面に新しい文は足さず、直るまで押せなくする（E-2 の返金の画面と同じ）
  const canSubmit = !stopped && waitingLines.length > 0 && amount >= shippingAmount && !estimateBlocked;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    flow.submit(
      `/api/admin/returns/${detail.id}/refund`,
      (requestKey): RefundReturnRequest => ({
        requestKey,
        // 見込みと同じ額なら送らない（DB が同じ式で計算する）。手で直した額（0を含む）と、返せる額で切った額だけを送る
        amount: amount === calculated ? null : amount,
        shippingAmount,
        note: note.trim() || null,
        // 返金しないで終える時は、お客様にメールを送らない
        notifyCustomer: waiving ? false : notifyCustomer,
      }),
      (data) => {
        const response = parseRefundResponse(data);
        if (response === null) return false;
        onDone(returnRefundNoticeOf(response));
        return true;
      },
    );
  };

  return (
    <Dialog open onClose={flow.close} title={`額を決めて返金する（${detail.label}）`} fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        <ReturnFlowContent
          flow={flow}
          backLabel="戻る"
          submitLabel={estimateBlocked ? '返金する' : waiving ? '返金しないで終える' : `${formatYen(amount)} を返金する`}
          canSubmit={canSubmit}
        >
          {/* 幅が 768px 以上の Dialog は高さを制限しないので、入力の部分だけを縦に動かし、誤りの文とボタンは動かさない */}
          <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
            <ul aria-label="返金する品" className="space-y-1 font-acumin lk-text-sm text-black">
              {waitingLines.map((line) => (
                <li key={line.id}>{`${lineLabel({ name: line.itemName, color: line.color, size: line.size })} × ${line.progress.refundWaiting}`}</li>
              ))}
            </ul>
            {estimating ? <p role="status" className="font-acumin lk-text-sm text-black">{ESTIMATING_TEXT}</p> : null}
            {estimateState.status === 'error' ? (
              <p role="alert" className="font-acumin lk-text-3xs text-red-700">{estimateState.message}</p>
            ) : null}
            <ReturnRefundFields
              idPrefix="return-refund"
              amountsHidden={estimateBlocked}
              rows={breakdownRows}
              amount={amount}
              refundableAmount={refundableAmount}
              onAmountChange={setAmountEntered}
              shippingAmount={shippingAmount}
              refundableShipping={refundableShipping}
              onShippingChange={(next) => {
                setShippingEntered(next);
                setAmountEntered(null);
              }}
              disabled={stopped}
            />
            <TextAreaField
              label="メモ（お客様には見えません）"
              value={note}
              rows={3}
              maxLength={ADMIN_NOTE_MAX_LENGTH}
              disabled={stopped}
              onChange={(event) => setNote(event.target.value)}
            />
            {waiving ? null : (
              <Checkbox
                label="お客様に返金のメールを送る"
                checked={notifyCustomer}
                disabled={stopped}
                onChange={(event) => setNotifyCustomer(event.target.checked)}
              />
            )}
            <p className="font-acumin lk-text-3xs text-[#474747]">
              {waiving ? (shippingAmount > 0 ? WAIVE_NEEDS_NO_SHIPPING : WAIVE_NOTICE) : IRREVERSIBLE_NOTICE}
            </p>
          </div>
        </ReturnFlowContent>
      </form>
    </Dialog>
  );
}
