'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { callRefundApi, fetchRefundMaterials } from '@/lib/orders/refund/refund-client';
import { UNKNOWN_REFUND_OUTCOME_MESSAGE } from '@/lib/orders/refund/refund-messages';
import type { RefundAcceptedResponse, RefundMaterials } from '@/lib/orders/refund/refund-types';

type UseRefundSubmissionOptions = {
  orderId: string;
  /** 返金する窓口（POST）。返金の画面は /refund、支払い済みのキャンセルの画面は /status */
  submitUrl: string;
  /** 窓口が日本語の断りを返さない時の代わりの文 */
  fallbackMessage: string;
  /** 受け付けた（同じ二重防止の番号の送り直しで前の結果が返った時も） */
  onAccepted: (result: RefundAcceptedResponse) => void;
  onClose: () => void;
  /** 答えが分からないまま画面を閉じた。返金が頼まれたかもしれないので、親が一覧を読み直す */
  onUncertain?: () => void;
};

/** 窓口へ送る1回分。「もう一度確かめる」は、保存してあるこの同じ中身で送り直す。confirm は、確かめ中の返金の確かめ直し */
type PostRequest = { url: string; body: object; confirm?: boolean };

/**
 * 返金の画面と支払い済みのキャンセルの画面が共有する流れ（グループ E-2 設計書 5-1・5-3）。
 * 開く時に返金の材料を読み、二重防止の番号を作る。返金を送る・確かめ中の返金や答えが分からない返金を確かめ直す・閉じる、の動きを持つ。
 * 窓口の答えは4つに分ける: 受け付けた（onAccepted）・処理前に断られた（文だけを出す）・
 * 処理の中で断られた（お金は動いていない。文を出し、番号を作り直す）・
 * 分からない（通信が切れた・500番台。Stripe が返金を作ったかもしれない）。
 * 分からない時は、番号も中身も変えずに送り直せるようにしておく（同じ番号なら DB は前の記録を返し、Stripe の返金は1件だけになる）。
 * 番号と直近の中身は ref ではなく state で持つ（ref を読む関数を戻り値の object に入れると、lint の react-hooks/refs が止めるため）。
 */
export function useRefundSubmission({
  orderId,
  submitUrl,
  fallbackMessage,
  onAccepted,
  onClose,
  onUncertain,
}: UseRefundSubmissionOptions) {
  const [materials, setMaterials] = useState<RefundMaterials | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  // 二重防止の番号。画面を開いた時に作り、処理の中で断られた時だけ作り直す
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  // 直近に送った中身。答えが分からない時の「もう一度確かめる」が、これをそのまま送り直す
  const [pending, setPending] = useState<PostRequest | null>(null);

  useEffect(() => {
    let active = true;
    void fetchRefundMaterials(orderId).then((result) => {
      if (!active) return;
      if (result.kind === 'error') {
        setLoadError(result.message);
        return;
      }
      setMaterials(result.materials);
    });
    return () => {
      active = false;
    };
  }, [orderId]);

  const post = async (request: PostRequest) => {
    setPending(request);
    setBusy(true);
    setError(null);
    const result = await callRefundApi<RefundAcceptedResponse>(request.url, request.body, fallbackMessage);
    if (result.kind === 'blocked') {
      // 今回は処理に入っていない。前の送信の結果は分からないままなので、番号・中身・結果不明の状態を保つ
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝返金は作られていない（Stripe の断りは記録がエラーになる）。次の送信は別の操作なので、新しい番号にする
      setRequestKey(crypto.randomUUID());
      setUncertain(false);
      setError(result.message);
      // 確かめ直し・結果不明の再送の断りでは、現在の材料を読み直す。読み直す間は押せないままにする
      if (request.confirm || uncertain) {
        const reloaded = await fetchRefundMaterials(orderId);
        if (reloaded.kind === 'ok') setMaterials(reloaded.materials);
        else setError(reloaded.message);
      }
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result.kind === 'ok') {
      setUncertain(false);
      onAccepted(result.body);
      return;
    }
    setUncertain(true);
  };

  const awaiting = materials?.awaitingRefund ?? null;
  // 結果が分からない間に処理前の断り（401・403・429）を受けた時は、断りの文の後ろに、結果が分からない時の文を続けて出す。
  // 断りの文だけにすると、取り消せない操作の結果が分からないことが読めなくなり、失敗したと読めてしまう
  const unknownText = uncertain ? UNKNOWN_REFUND_OUTCOME_MESSAGE : '';
  const alertText = error ? `${error}${unknownText}` : unknownText || loadError;

  return {
    materials,
    /** 返事待ちの返金（前の送信の返事が届かなかった記録）。あれば入力を出さず、確かめ直しだけを出す */
    awaiting,
    loadError,
    error,
    busy,
    uncertain,
    /** 画面の中の `role="alert"` に出す文。処理前の断りも、結果不明の状態を保ったまま表示する */
    alertText,
    /** 返金（またはキャンセル）を送る。本文は、今の二重防止の番号を受け取って組む */
    submit: (makeBody: (requestKey: string) => object) => {
      if (busy || uncertain) return;
      void post({ url: submitUrl, body: makeBody(requestKey) });
    },
    /** 「もう一度確かめる」。答えが分からない時は同じ中身で送り直し、確かめ中の返金があれば記録の番号で確かめ直す */
    checkAgain: () => {
      if (busy) return;
      if (uncertain && pending) {
        void post(pending);
        return;
      }
      if (awaiting) {
        void post({ url: `/api/admin/orders/${orderId}/refund/confirm`, body: { refundId: awaiting.id }, confirm: true });
      }
    },
    /** 閉じる。送っている間は閉じない。答えが分からないまま閉じる時は、一覧の読み直しを親に頼む */
    close: () => {
      if (busy) return;
      if (uncertain) onUncertain?.();
      onClose();
    },
  };
}

/**
 * フォームの Enter で返金が確定しないようにする（返金は取り消せない）。ボタンの Enter（押す動き）と、
 * 改行に使うメモの欄は止めない。
 */
export function blockEnterSubmit(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter') return;
  if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
}
