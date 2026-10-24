'use client';

// File: src/hooks/usePurchaseOrderWrite.ts
// 発注書の書込み（G-2 Task 6: 数量の確定・訂正、残りの打切り・取消、発注先・メモの訂正）を窓口へ送る流れを、3つのダイアログで共通にする。
// 送信中は二重に送らず閉じない。同じ内容の再押下・通信の再送は同じ本文（同じ requestKey と最初の expectedVersion）で送る。
// 確定した失敗（4xx）の後は新しい要求として送る。版の競合（409）は表の文を出し、親に読み直しを頼む。
import { useRef, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  PURCHASE_ORDER_TEXT,
  PURCHASE_ORDER_VERSION_CONFLICT_CODE,
  purchaseOrderFailureMessage,
} from '@/lib/purchase-orders/purchase-order-types';

type Options = {
  url: string;
  method: 'POST' | 'PATCH';
  /** 保存できた（再送で前の結果が返った時も）。submit に渡した通知の文を渡す。親がダイアログを閉じて発注書を読み直す */
  onSaved: (notice: string) => void;
  /** 版が古かった。親は発注書を読み直す（ダイアログは開いたまま） */
  onStale: () => void;
};

function readCode(body: unknown): unknown {
  return body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
}

/** 成功の応答（窓口の 200 / 201）か。形が崩れていれば成功として扱わない */
function isSaved(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const { version } = body as { version?: unknown };
  return typeof version === 'number' && Number.isInteger(version) && version >= 1;
}

export function usePurchaseOrderWrite({ url, method, onSaved, onStale }: Options) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // 同じ内容の再押下・通信の再送が使う本文。内容（signature）が変わるか、確定した応答（4xx）や成功を受けたら捨てる
  const retry = useRef<{ signature: string; body: string } | null>(null);

  /** 送信中は閉じない */
  const guardClose = (onClose: () => void) => (): void => {
    if (sendingRef.current) return;
    onClose();
  };

  /**
   * signature は送る内容（版と requestKey を除く）の印。buildBody は新しい要求の時だけ呼ばれ、新しい requestKey を受け取る。
   * 再送（signature が前と同じ）は前の本文をそのまま使うので、その間に発注書の版が進んでいても最初の expectedVersion で送る。
   */
  const submit = async (signature: string, buildBody: (requestKey: string) => Record<string, unknown>, notice: string): Promise<void> => {
    if (sendingRef.current) return;
    let attempt = retry.current;
    if (attempt?.signature !== signature) {
      attempt = { signature, body: JSON.stringify(buildBody(crypto.randomUUID())) };
      retry.current = attempt;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const response = await clientFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: attempt.body });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // 確定した応答（4xx）の後は新しい要求として送る。5xx は届いたか分からないので同じ requestKey を残す
        if (response.status < 500) retry.current = null;
        setError(purchaseOrderFailureMessage(response.status, body));
        if (readCode(body) === PURCHASE_ORDER_VERSION_CONFLICT_CODE) onStale();
        return;
      }
      if (!isSaved(body)) {
        setError(PURCHASE_ORDER_TEXT.failed);
        return;
      }
      retry.current = null;
      onSaved(notice);
    } catch {
      setError(PURCHASE_ORDER_TEXT.failed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return { sending, error, submit, guardClose };
}
