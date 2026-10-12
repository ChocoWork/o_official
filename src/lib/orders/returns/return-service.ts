import {
  confirmAwaitingRefund,
  type RefundServiceDeps,
  type RefundSubmitResult,
} from '@/lib/orders/refund/refund-service';
import { getOrderRefund } from '@/lib/orders/refund/refund-store';
import type { RefundErrorCode } from '@/lib/orders/refund/refund-types';
import {
  ReturnStoreError,
  cancelReturn,
  closeReturnMissing,
  createReturn,
  inspectReturn,
  receiveReturn,
  recordReturnFeePayment,
  refundReturn,
  releaseReturnExchange,
  reopenReturn,
} from '@/lib/orders/returns/return-store';
import type { ReturnErrorCode } from '@/lib/orders/returns/return-types';

/**
 * 返品の流れ（グループ E-3 設計書 6-3・7・9-1）。窓口が呼ぶ入口。DB の関数（return-store.ts）を呼び、
 * 返金があれば E-2 の返金の流れで Stripe に頼み、メールの予定が書かれていれば送る処理を動かす。
 *
 * 受け取り（receiveReturnAndRefund）も額を決めて返金（refundReturnAndRequestStripe）も、E-2 と同じ
 * 「記録を先に DB に書く → Stripe に頼む（重複防止キー order-refund-{返金の記録の番号}）→ 結果を書く」の順に進む。
 * Stripe に頼む所と結果の後の始末は E-2 の confirmAwaitingRefund（返事待ちの返金の確かめ直し）に任せ、ここでは作り直さない。
 * 返金額が0円になる時（P20）は、DB が返金の記録を作らない（返金の番号が null・状態が waived）ので、Stripe には頼まない。
 * Stripe が受け取りの返金を断った時は、DB が書いた受け取りのメールの予定（P25）を送るために、メールの処理を動かす。
 * 権限・数・状態は確かめない（権限は窓口が、数と状態は DB の関数が決める）。
 */
export type ReturnServiceDeps = RefundServiceDeps;

/** DB が決まった言葉で断った。code は返品の記号か、E-2 の返金の記号（ReturnStoreError.code のまま） */
export type ReturnRefused = { kind: 'refused'; code: ReturnErrorCode | RefundErrorCode };

/**
 * 返金の頼みの、受け付けられた以外の答え（E-2 の答えのまま。窓口は toRefundReply で HTTP に直せる）。
 * refused は、DB が記録を書く前に支払いの番号と注文の状態を確かめる（Task 3）ので、ふつうは来ない
 */
export type RefundNotAccepted = Exclude<RefundSubmitResult, { kind: 'accepted' }>;

type Received = Awaited<ReturnType<typeof receiveReturn>>;

/**
 * 受け取りの返金の結果。pending・succeeded は Stripe が受け付けた返金。
 * waived は、手数料を引くと0円になって返金しないことにした時（P20）で、返金の記録も Stripe への頼みも無い
 */
export type ReceivedRefund =
  | { refundId: string; amount: number; status: 'pending' | 'succeeded' }
  | { refundId: null; amount: 0; status: 'waived' };

export type ReceiveReturnResult =
  | ({
      kind: 'received';
      /** 相談・なしの受け取り（返金の記録が無く、waived でもない）は null */
      refund: ReceivedRefund | null;
    } & Pick<Received, 'receiptId' | 'returnStatus' | 'feeDueAmount' | 'exchangeOrderItemIds' | 'replayed'>)
  | ReturnRefused
  // 受け取りは記録できたが、返金は受け付けられなかった（Stripe が断った・答えが分からないなど）。受け取りの記録は残る
  | ({ kind: 'refund_not_accepted'; refund: RefundNotAccepted } & Pick<Received, 'receiptId' | 'returnStatus'>);

/** 額を決めて返金の答え。受け付けた・Stripe が断った・答えが分からないは E-2 の答えのまま */
export type RefundReturnResult =
  | Exclude<RefundSubmitResult, { kind: 'refused' }>
  // 額を0円にして、返金しないで終えた（P20）。返金の記録も Stripe への頼みも、返金のお知らせも無い
  | { kind: 'waived'; replayed: boolean }
  | ReturnRefused;

/** 返金の無い操作の答え。done に DB の関数の答えをそのまま載せる */
export type ReturnOperationResult<T> = ({ kind: 'done' } & T) | ReturnRefused;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 受け取り。DB が受け取りの記録・在庫・交換の品の行・メールの予定と、返金の記録（返事待ち）を1回の取引で書く。
 * 返金の記録ができたら（相談・なし・返金の品が無い受け取り・0円で返金しない受け取りは無い）、Stripe に頼んで結果を書く。
 * 同じ二重防止の番号の送り直しは、DB が前の受け取りを返し（replayed）、返事待ちの返金は同じ重複防止キー・同じ中身で頼み直す。
 * Stripe が返金を断った時は、DB が返金の記録をエラーにした取引で受け取りのメールを予定する（P25）ので、送る処理を動かす。
 */
export async function receiveReturnAndRefund(
  deps: ReturnServiceDeps,
  input: Parameters<typeof receiveReturn>[1],
): Promise<ReceiveReturnResult> {
  let received: Received;
  try {
    received = await receiveReturn(deps.store, input);
  } catch (error) {
    if (error instanceof ReturnStoreError) {
      return { kind: 'refused', code: error.code };
    }
    throw error;
  }

  // 送る処理を動かすのは、メールの予定を新しく書いた時だけ（送り直しは何も書かない）。
  // 返金の記録が無い受け取りは、お客様向けのメール（return_received・return_sent_back）を DB が予定する。0円で返金しない受け取りも同じ。
  // 店への知らせ（返金待ち）も同じ処理で送る。
  // 返金がある受け取りのお知らせは、Stripe が受け付けた後に予定される（E-2 の結果の後の始末が動かす。断られた時は下で動かす）
  if (!received.replayed && (received.refundId === null || received.shopNoticeEnqueued)) {
    deps.scheduleOrderEmailDelivery();
  }

  const { receiptId, returnStatus, refundId, refundStatus, feeDueAmount, exchangeOrderItemIds, replayed } = received;
  if (refundId === null) {
    // 返金の記録が無い。0円で返金しないことにした時（P20）は waived、相談・なしは null
    const refund: ReceivedRefund | null =
      refundStatus === 'waived' ? { refundId: null, amount: 0, status: 'waived' } : null;
    return { kind: 'received', receiptId, returnStatus, refund, feeDueAmount, exchangeOrderItemIds, replayed };
  }

  const refund = await settleReturnRefund(deps, refundId, replayed);
  if (refund.kind !== 'accepted') {
    // Stripe が断って返金の記録がエラーになった時、DB は受け取りのメール（return_received）を予定する（P25）。
    // E-2 の断りの道（recordRejection）は送る処理を動かさないので、予定を書いた後のここで動かす。
    // 送り直し（replayed）でも動かす: 前の頼みが分からないままで、今回初めて断られて記録がエラーになることがあるため。
    // unknown・refused は DB が何も書いていないので動かさない（見回りが後でエラーにした時の予定は、毎分の定期処理が送る）。
    // DB が何を予定したかは分からないが、空振りしても害は無い
    if (refund.kind === 'stripe_rejected') {
      deps.scheduleOrderEmailDelivery();
    }
    return { kind: 'refund_not_accepted', receiptId, returnStatus, refund };
  }
  return {
    kind: 'received',
    receiptId,
    returnStatus,
    refund: { refundId: refund.refundId, amount: refund.amount, status: refund.status },
    feeDueAmount,
    exchangeOrderItemIds,
    replayed,
  };
}

/**
 * 額を決めて返金（店長だけ）。DB が返金の記録（返事待ち）を書き、Stripe に頼んで結果を書く。
 * 手数料の引き直しと「返せる額」までの確かめは DB が行う。額 0 は「返金しないで終える」（P20）で、返金の記録を作らない。
 * 返金が断られて返品が closed のまま返金待ちの数が戻った時の返し直し（P21）も、この入口を通る
 * （返品の返金のまま。E-2 のふつうの返金の画面は返金待ちの品を選べない）。
 */
export async function refundReturnAndRequestStripe(
  deps: ReturnServiceDeps,
  input: Parameters<typeof refundReturn>[1],
): Promise<RefundReturnResult> {
  let began: Awaited<ReturnType<typeof refundReturn>>;
  try {
    began = await refundReturn(deps.store, input);
  } catch (error) {
    if (error instanceof ReturnStoreError) {
      return { kind: 'refused', code: error.code };
    }
    throw error;
  }
  if (began.refundId === null) {
    return { kind: 'waived', replayed: began.replayed };
  }
  return settleReturnRefund(deps, began.refundId, began.replayed);
}

/** 返品を作る。受付のお知らせの予定は DB が書くので、新しく作って知らせる時だけ送る処理を動かす */
export async function submitCreateReturn(deps: ReturnServiceDeps, input: Parameters<typeof createReturn>[1]) {
  const result = await runOperation(() => createReturn(deps.store, input));
  if (result.kind === 'done' && input.notifyCustomer && !result.replayed) {
    deps.scheduleOrderEmailDelivery();
  }
  return result;
}

// 以下の6つはお客様にメールを送らない（設計書 9-1「送らない出来事」と、手数料・支払いを待たずに送るの記録）。
// DB の関数を呼ぶだけで、送る処理は動かさない

/** 返品を取り消す（何も受け取る前だけ） */
export function submitCancelReturn(deps: ReturnServiceDeps, input: Parameters<typeof cancelReturn>[1]) {
  return runOperation(() => cancelReturn(deps.store, input));
}

/** 開き直す（「届かない」で終えた品がある時だけ） */
export function submitReopenReturn(deps: ReturnServiceDeps, input: Parameters<typeof reopenReturn>[1]) {
  return runOperation(() => reopenReturn(deps.store, input));
}

/** 残りは届かないものとして返品を終える */
export function submitCloseReturnMissing(deps: ReturnServiceDeps, input: Parameters<typeof closeReturnMissing>[1]) {
  return runOperation(() => closeReturnMissing(deps.store, input));
}

/** 検品待ちの品を、戻す・戻さないに決める。返金は受け取りの時に決めた選び方のまま */
export function submitInspectReturn(deps: ReturnServiceDeps, input: Parameters<typeof inspectReturn>[1]) {
  return runOperation(() => inspectReturn(deps.store, input));
}

/** 手数料の受け取りを記録する。input.waive が true なら、いただかないで終える（P27。DB が決める）。店長だけ。権限は窓口が確かめる */
export function submitRecordReturnFeePayment(
  deps: ReturnServiceDeps,
  input: Parameters<typeof recordReturnFeePayment>[1],
) {
  return runOperation(() => recordReturnFeePayment(deps.store, input));
}

/** 手数料のお支払いを待たずに、交換の品を送れるようにする（店長だけ。権限は窓口が確かめる） */
export function submitReleaseReturnExchange(
  deps: ReturnServiceDeps,
  input: Parameters<typeof releaseReturnExchange>[1],
) {
  return runOperation(() => releaseReturnExchange(deps.store, input));
}

// ---- ここから下は、このファイルの中だけで使う ----

/**
 * DB の関数を1つ呼び、答えを done で返す。決まった言葉での断り（ReturnStoreError）は refused にし、
 * 想定外の誤りはそのまま投げる（窓口が 500 にする）。答えの型は then の中で受けるので、DB の関数ごとの型がそのまま残る
 */
function runOperation<T extends object>(operation: () => Promise<T>): Promise<ReturnOperationResult<T>> {
  return operation().then(
    (answer): ReturnOperationResult<T> => ({ kind: 'done' as const, ...answer }),
    (error: unknown): ReturnRefused => {
      if (error instanceof ReturnStoreError) {
        return { kind: 'refused', code: error.code };
      }
      throw error;
    },
  );
}

/**
 * DB が返金の記録を作った（または前の記録を返した）後の、Stripe への頼み。E-2 の確かめ直し（confirmAwaitingRefund）に任せる:
 * 返事待ちなら DB の記録の額・理由・実行した人で、重複防止キー order-refund-{記録の番号} で頼み、結果を書き、
 * 後の始末（メールの処理・失敗の店への知らせ）まで行う。返事待ちでなければ記録の今の状態で答える。
 * 最初の頼みも送り直しも同じ作りなので中身が変わらず、通信が切れた後の送り直しでも Stripe の返金は1件になる。
 * 返金の記録の注文の番号は DB の答えに無いので、記録から読む。
 *
 * 受け取りと返金の記録は、もう DB に書けている。ここで例外を投げると、画面が受け取りの失敗と受け取って、
 * 別の二重防止の番号で押し直すおそれがある。想定外の失敗は「分からない」にして、同じ番号の送り直し（もう一度確かめる）に任せる。
 * ログに出すのは誤りの名前だけ（DB の文には宛先などが混ざりうる）。
 */
async function settleReturnRefund(
  deps: ReturnServiceDeps,
  refundId: string,
  replayed: boolean,
): Promise<RefundSubmitResult> {
  try {
    const ref = await getOrderRefund(deps.store, refundId);
    if (!ref) {
      return { kind: 'unknown', refundId };
    }
    const result = await confirmAwaitingRefund(deps, { orderId: ref.orderId, refundId });
    // 確かめ直しは、受け付けた答えを常に replayed: true にする。DB が新しく作った返金は false で返す
    return result.kind === 'accepted' ? { ...result, replayed } : result;
  } catch (error) {
    console.error('[return] the refund request failed after the return was recorded', errorName(error));
    return { kind: 'unknown', refundId };
  }
}
