'use client';

import { useEffect, useState } from 'react';
import { fetchReturnData, type ReturnReadResult } from '@/lib/orders/returns/return-client';
import { RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

/** 読めなかった時の代わりの文。返品の欄と同じ言葉 */
const LOAD_FAILURE_MESSAGE = '返品の情報を読み込めませんでした。';

/**
 * `GET /api/admin/orders/[id]/returns` の `data` のうち、操作の画面が使う分（C-2・C-3）。
 * inspectionEnabled（ショップの設定の「要検品を使う」）は C-3 の欄で、Task 7 が設定から入れる。念のため無ければ偽として扱う
 */
type ReturnsReadData = {
  returns: OrderReturnDetail[];
  canRefund: boolean;
  refundableAmount: number;
  refundableShipping: number;
  inspectionEnabled?: boolean;
};

/** 操作の画面が使う材料。操作する返品の中身と、返金に関わる分 */
export type LoadedReturn = {
  detail: OrderReturnDetail;
  /** 権限 admin.orders.refund を持つ人か（窓口が権限から決めた答え）。持たない人は、今返金も額を直すこともできない */
  canRefund: boolean;
  /** 返せる額・返せる送料（E-2 の材料の値）。返金額と送料の入力の上限 */
  refundableAmount: number;
  refundableShipping: number;
  /** ショップの設定の「要検品を使う」。オンの時だけ受け取りの画面で「検品待ち」を選べる */
  inspectionEnabled: boolean;
};

type LoadResult = { kind: 'error'; message: string } | ({ kind: 'ready' } & LoadedReturn);

/** 読み込み中・読めなかった・読めた */
export type ReturnLoadState = { kind: 'loading' } | LoadResult;

function amountOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 窓口の答えから、操作する返品を探す。無ければ（取り消された・別の注文の番号など）見つからない旨の文 */
function toLoadResult(read: ReturnReadResult<ReturnsReadData>, returnId: string): LoadResult {
  if (read.kind === 'error') return { kind: 'error', message: read.message };
  const detail = Array.isArray(read.data.returns) ? read.data.returns.find((item) => item.id === returnId) : undefined;
  if (!detail) return { kind: 'error', message: RETURN_ERROR_MESSAGES.RETURN_NOT_FOUND.message };
  return {
    kind: 'ready',
    detail,
    canRefund: read.data.canRefund === true,
    refundableAmount: amountOf(read.data.refundableAmount),
    refundableShipping: amountOf(read.data.refundableShipping),
    inspectionEnabled: read.data.inspectionEnabled === true,
  };
}

/**
 * 開く時と在庫不足の断りの後に読む。注文・返品の番号が変われば前の結果を使わない。
 * 読み直しは同じ返品の ready を残して入力を保つ。失敗も伝え、古い在庫のまま送らせない。
 */
export function useLoadedReturn(orderId: string, returnId: string): {
  state: ReturnLoadState;
  reload: () => void;
  reloading: boolean;
  reloadError: string | null;
} {
  const [loaded, setLoaded] = useState<{
    orderId: string; returnId: string; count: number; result: LoadResult; reloadError: string | null;
  } | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchReturnData<ReturnsReadData>(`/api/admin/orders/${orderId}/returns`, LOAD_FAILURE_MESSAGE).then((read) => {
      if (!active) return;
      const result = toLoadResult(read, returnId);
      setLoaded((previous) =>
        result.kind === 'error' && previous?.orderId === orderId && previous.returnId === returnId && previous.result.kind === 'ready'
          ? { ...previous, count: reloadCount, reloadError: result.message }
          : { orderId, returnId, count: reloadCount, result, reloadError: null },
      );
    });
    return () => { active = false; };
  }, [orderId, returnId, reloadCount]);

  const current = loaded?.orderId === orderId && loaded.returnId === returnId ? loaded : null;
  return {
    state: current?.result ?? { kind: 'loading' },
    reload: () => setReloadCount((count) => count + 1),
    reloading: current !== null && current.count !== reloadCount,
    reloadError: current?.reloadError ?? null,
  };
}
