'use client';

import { useState } from 'react';
import { callReturnApi } from '@/lib/orders/returns/return-client';
import { RETURN_STATUSES, type ReturnStatus } from '@/lib/orders/returns/return-types';

/** 窓口へ送る1回分。「もう一度確かめる」は、保存してあるこの同じ中身（同じ二重防止の番号）で送り直す */
type PostRequest = {
  url: string;
  body: object;
  /** 窓口の答えの `data` を読んで親へ渡す。読めない形なら false を返す（答えが分からない時と同じに扱う） */
  accept: (data: unknown) => boolean;
};

type UseReturnOperationOptions = {
  /** 答えが分からない時に出す文（操作ごとに違う） */
  unknownMessage: string;
  /** 窓口が日本語の断りを返さない時の代わりの文 */
  fallbackMessage: string;
  onClose: () => void;
  /**
   * 送信を試みた後、成功を確かめられないまま閉じた（答えが分からない・窓口に断られた）。記録されたかもしれない。
   * 受け取りは記録できたのに返金だけ断られた時のように、断られても状態が変わっていることがあるので、親が返品の一覧を読み直す
   */
  onUncertain?: () => void;
  /** 処理の中で断られた（記録していない）時に、窓口の記号を渡す。受け取りの画面が在庫不足の断り（在庫が戻った行への上書きの断り RETURN_ARGUMENT_INVALID を含む）の後に返品を読み直す（T10-8） */
  onRefused?: (code: string | null) => void;
};


/** 取消・開き直し・届かないで終える・検品・手数料・支払いを待たずに送るの窓口が返す `data` */
export type ReturnActionResponse = {
  returnStatus: ReturnStatus;
  receiptId?: string;
  replayed?: boolean;
};

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseActionResponse(data: unknown): ReturnActionResponse | null {
  const record = readRecord(data);
  if (!record || typeof record.returnStatus !== 'string') return null;
  if (!(RETURN_STATUSES as readonly string[]).includes(record.returnStatus)) return null;
  return {
    returnStatus: record.returnStatus as ReturnStatus,
    ...(typeof record.receiptId === 'string' ? { receiptId: record.receiptId } : {}),
    ...(typeof record.replayed === 'boolean' ? { replayed: record.replayed } : {}),
  };
}

/**
 * 返品の画面（受け取り・額を決めて返金・検品・取消・開き直し・手数料・支払いを待たずに送る）が共有する流れ
 * （グループ E-3 設計書 6-1。E-2 の useRefundSubmission と同じ考え）。
 * 窓口の答えは4つに分ける: 受け付けた（accept に渡す）・処理に入る前に断られた（401・403・429。文だけを出す）・
 * 処理の中で断られた（receiptId があれば記録済みで閉じるだけ、無ければ番号を作り直す）・分からない（通信が切れた・500番台・読めない答え。
 * 記録や返金が済んでいるかもしれない）。分からない時は、番号も中身も変えずに送り直せるようにしておく
 * （同じ番号なら DB は前の記録を返し、受け取りも Stripe の返金も1回分のまま）。
 * 画面に出す材料（返品の中身）は親から受け取るので、ここでは読み込まない。
 * 番号と直近の中身は ref ではなく state で持つ（ref を読む関数を戻り値の object に入れると、lint の react-hooks/refs が止めるため）。
 */
// C-5 に無い。受け取りは記録できたのに返金だけ断られた時に、断りの文の後ろに続ける（P21 の返し直しの入口を示す）
const RECEIPT_RECORDED_NOTE = '受け取りは記録しました。返金は、返品の画面の「額を決めて返金する」からやり直してください。';

export function useReturnOperation({ unknownMessage, fallbackMessage, onClose, onUncertain, onRefused }: UseReturnOperationOptions) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  // 受け取りは記録済みで、返金だけが断られた（窓口が断りの本文に receiptId を付けた）。同じ受け取りを送り直さない
  const [recorded, setRecorded] = useState(false);
  // 送信を試みたことが一度でもあるか。閉じる時に、親へ一覧の読み直しを頼むために持つ
  const [attempted, setAttempted] = useState(false);
  // 二重防止の番号。画面を開いた時に作り、処理の中で断られた（記録していない）時だけ作り直す
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  // 直近に送った中身。答えが分からない時の「もう一度確かめる」が、これをそのまま送り直す
  const [pending, setPending] = useState<PostRequest | null>(null);

  const post = async (request: PostRequest) => {
    setPending(request);
    setAttempted(true);
    setBusy(true);
    setError(null);
    const result = await callReturnApi(request.url, request.body, fallbackMessage);
    if (result.kind === 'blocked') {
      // 今回は処理に入っていない。前の送信の結果は分からないままなので、番号・中身・結果不明の状態を保つ
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.kind === 'refused' && result.receiptId !== null) {
      // 受け取りの記録は残っている（Stripe の断り 422・E-2 の断り）。新しい番号で同じ品を送ると、まだ届いていない品まで
      // 受け取ったことになるので、入力を止めて閉じるだけにする（閉じると親が読み直し、返品は返金待ちになっている。P21）
      setRecorded(true);
      setUncertain(false);
      setError(`${result.message}${RECEIPT_RECORDED_NOTE}`);
      setBusy(false);
      return;
    }
    if (result.kind === 'refused') {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい番号にする
      setRequestKey(crypto.randomUUID());
      setUncertain(false);
      setError(result.message);
      setBusy(false);
      onRefused?.(result.code);
      return;
    }
    setBusy(false);
    if (result.kind === 'ok') {
      setUncertain(false);
      if (request.accept(readRecord(result.body)?.data)) return;
    }
    setUncertain(true);
  };

  // 結果が分からない間に処理前の断り（401・403・429）を受けた時は、断りの文の後ろに、結果が分からない時の文を続けて出す
  const unknownText = uncertain ? unknownMessage : '';
  const alertText = error ? `${error}${unknownText}` : unknownText || null;

  return {
    busy,
    uncertain,
    /** 受け取りは記録済みで返金だけ断られた。入力を止め、閉じるだけにする */
    recorded,
    /** 画面の中の `role="alert"` に出す文 */
    alertText,
    /** 窓口へ送る。本文は、今の二重防止の番号を受け取って組む */
    submit: (url: string, makeBody: (requestKey: string) => object, accept: (data: unknown) => boolean) => {
      if (busy || uncertain || recorded) return;
      void post({ url, body: makeBody(requestKey), accept });
    },
    /** 「もう一度確かめる」。答えが分からない時に、保存してある同じ中身で送り直す */
    checkAgain: () => {
      if (busy || !uncertain || !pending) return;
      void post(pending);
    },
    /** 閉じる。送っている間は閉じない。送信を試みた後に（成功せず）閉じる時は、一覧の読み直しを親に頼む */
    close: () => {
      if (busy) return;
      if (attempted) onUncertain?.();
      onClose();
    },
  };
}
