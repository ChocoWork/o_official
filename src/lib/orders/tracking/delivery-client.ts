import { useState } from 'react';
import type { DeliveryCallResult } from '@/lib/orders/tracking/delivery-types';

/**
 * 伝票番号を入れる・直す画面と、配達済みにする画面（発送票の ShipmentSlipTrackingDialog・ShipmentSlipDeliveredDialog）が共有する
 * 「二重防止の番号と結果不明の再送」の流れ（useDeliverySubmission）と、その画面の言葉。
 * 窓口を呼ぶ道具は shipment-slip-client.ts だけに置く（旧の発送ごとの窓口は G-1 で止め、G-3 Task 7 で停止の道具も整理した）。
 * サーバーからは import しない。
 */

// 画面の言葉は計画の C-5・C-4 のとおり（句点を足し引きしない）
export const DELIVERY_FORM_TEXT = {
  back: '戻る',
  saving: '保存しています…',
  checkAgain: 'もう一度確かめる',
  unknown: '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
} as const;

type DeliverySubmissionOptions<Body, Result> = {
  /** 窓口を呼ぶ（shipment-slip-client.ts の submitSlipTrackingEdit か submitSlipDelivered を包んだ関数） */
  send: (body: Body) => Promise<DeliveryCallResult<Result>>;
  /** 記録できた（前の結果の再送でも）。親へ知らせる処理 */
  onSucceeded: () => void;
  onClose: () => void;
  /** 結果が分からないまま閉じる。記録されたかもしれないので、親が一覧を読み直す */
  onUncertain?: () => void;
};

/**
 * 直す画面と配達済みの画面が共有する流れ（計画の Task 10。返品の画面の useReturnOperation と同じ考え）。
 * 二重防止の番号は画面を開いた時（この hook を使う部品を表示した時）に作り、窓口が断った時（refused）だけ作り直す。
 * 結果が分からない時（unknown）は、送った本文をそのまま取っておき、「もう一度確かめる」でその同じ中身と同じ番号だけを送り直す
 * （入力は止める。同じ番号なら DB は前の結果を返すので、記録は1回分のまま）。処理の前の断り（blocked）は、番号も中身も結果不明の状態も保つ。
 */
export function useDeliverySubmission<Body extends { requestKey: string }, Result>({
  send,
  onSucceeded,
  onClose,
  onUncertain,
}: DeliverySubmissionOptions<Body, Result>) {
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 結果が分からない送信の本文。null でなければ、入力を止めて「もう一度確かめる」だけを出す
  const [pending, setPending] = useState<Body | null>(null);
  // 一度でも結果が分からなかったか。閉じる時に、親へ読み直しを頼むために持つ
  const [everUncertain, setEverUncertain] = useState(false);

  const run = async (body: Body) => {
    setBusy(true);
    setMessage(null);
    const result = await send(body);
    setBusy(false);
    if (result.kind === 'ok') {
      setPending(null);
      onSucceeded();
      return;
    }
    if (result.kind === 'blocked') {
      setMessage(result.message);
      return;
    }
    if (result.kind === 'refused') {
      setRequestKey(crypto.randomUUID());
      setPending(null);
      setMessage(result.message);
      return;
    }
    setPending(body);
    setEverUncertain(true);
  };

  return {
    busy,
    /** 結果が分からない状態（入力を止める） */
    uncertain: pending !== null,
    /** 画面の role="alert" に出す断り・入力の誤りの文。結果不明の文（DELIVERY_FORM_TEXT.unknown）は別に出す */
    message,
    setMessage,
    /** 窓口へ送る。本文は、今の二重防止の番号を受け取って組む */
    submit: (build: (requestKey: string) => Body) => {
      if (busy || pending !== null) return;
      void run(build(requestKey));
    },
    /** 「もう一度確かめる」。保存してある同じ中身（同じ番号）で送り直す */
    checkAgain: () => {
      if (busy || pending === null) return;
      void run(pending);
    },
    /** 戻る・Escape。送っている間は閉じない。結果が分からないまま閉じる時は、親に読み直しを頼む */
    close: () => {
      if (busy) return;
      if (everUncertain) onUncertain?.();
      onClose();
    },
  };
}
