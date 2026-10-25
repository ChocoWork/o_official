'use client';

// File: src/hooks/useShipmentSlipWrite.ts
// 発送票の書込み（G-3 Task 4: 下書きの作成・入替・破棄。後の Task の確定・伝票・配達済み・取消・出荷日の訂正）を窓口へ送る流れを、画面で共通にする。
// 送信中は二重に送らない。同じ内容（signature）の再押下・通信の再送は同じ requestKey で送り、内容が変われば新しい requestKey で送る。
// 結果が分からない時（unknown）は、送った内容と同じ requestKey を取っておき、入力を止めて「もう一度確かめる」でその同じ中身だけを送り直す
// （同じ番号なら DB は前の結果を返すので、記録は1回分のまま）。処理の前の断り（blocked）は番号も中身も保つ。処理の中の断り（refused）は新しい要求として送る。
import { useRef, useState } from 'react';
import type { ShipmentSlipSaved } from '@/lib/orders/shipment-slips/shipment-slip-types';
import type { DeliveryCallResult } from '@/lib/orders/tracking/delivery-types';

export type SlipWriteResult = DeliveryCallResult<ShipmentSlipSaved>;

type Attempt = {
  signature: string;
  requestKey: string;
  send: (requestKey: string) => Promise<SlipWriteResult>;
  onResult: (result: SlipWriteResult) => void;
};

export function useShipmentSlipWrite() {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const sendingRef = useRef(false);
  const uncertainRef = useRef(false);
  const attempt = useRef<Attempt | null>(null);

  const settle = (current: Attempt, result: SlipWriteResult): void => {
    if (result.kind === 'ok') {
      attempt.current = null;
      uncertainRef.current = false;
      setUncertain(false);
    } else if (result.kind === 'blocked') {
      setMessage(result.message);
    } else if (result.kind === 'refused') {
      attempt.current = null;
      uncertainRef.current = false;
      setUncertain(false);
      setMessage(result.message);
    } else {
      uncertainRef.current = true;
      setUncertain(true);
    }
    current.onResult(result);
  };

  const dispatch = async (current: Attempt): Promise<void> => {
    sendingRef.current = true;
    setSending(true);
    setMessage(null);
    let result: SlipWriteResult;
    try {
      result = await current.send(current.requestKey);
    } catch {
      result = { kind: 'unknown' };
    }
    sendingRef.current = false;
    setSending(false);
    settle(current, result);
  };

  return {
    /** 送っている間 */
    sending,
    /** 画面の role="alert" に出す断りの文（blocked・refused）。結果不明の文は別に出す */
    message,
    clearMessage: () => setMessage(null),
    /** 結果が分からない状態（入力を止めて「もう一度確かめる」だけを出す） */
    uncertain,
    /**
     * 窓口へ送る。signature は送る内容（requestKey を除く）の印で、前と同じなら同じ requestKey で送る。
     * send は requestKey を受け取って窓口を呼ぶ。onResult は結果（再送の結果も）を受け取る。送信中・結果不明の間は何もしない。
     */
    run: (signature: string, send: Attempt['send'], onResult: Attempt['onResult']): void => {
      if (sendingRef.current || uncertainRef.current) return;
      let current = attempt.current;
      if (current === null || current.signature !== signature) {
        current = { signature, requestKey: crypto.randomUUID(), send, onResult };
        attempt.current = current;
      } else {
        current.send = send;
        current.onResult = onResult;
      }
      void dispatch(current);
    },
    /** 「もう一度確かめる」。保存してある同じ中身（同じ requestKey）で送り直す */
    checkAgain: (): void => {
      if (sendingRef.current || !uncertainRef.current || attempt.current === null) return;
      void dispatch(attempt.current);
    },
    /** 結果が分からないまま画面を片付ける時に、取ってある送信を捨てる（記録されたかもしれないので、呼び手が読み直す） */
    forget: (): void => {
      attempt.current = null;
      uncertainRef.current = false;
      setUncertain(false);
      setMessage(null);
    },
  };
}
