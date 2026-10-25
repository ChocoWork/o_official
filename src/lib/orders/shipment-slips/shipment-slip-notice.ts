// File: src/lib/orders/shipment-slips/shipment-slip-notice.ts
// 荷作り表から票の頁へ移る時に、通知（「下書きを保存しました。」）を1回だけ引き継ぐ印（G-3 Task 4）。
// 移った先の URL を /admin/shipment-slips/[id] のまま保つため、sessionStorage に票の id だけを置く。
// 読み書きは必ず try/catch（ブロックされた・無効な環境でも画面は動く）。ブラウザだけで動き、サーバーからは import しない。

const KEY = 'lfdh:shipment-slip-notice';

/** 票 id の通知を次の頁に引き継ぐ */
export function rememberSlipNotice(slipId: string): void {
  try {
    window.sessionStorage.setItem(KEY, slipId);
  } catch {
    // 引き継げなくても票の頁は開く
  }
}

/** この票の通知が引き継がれていれば true を返し、印を消す（他の票の印は消さない） */
export function takeSlipNotice(slipId: string): boolean {
  try {
    if (window.sessionStorage.getItem(KEY) !== slipId) return false;
    window.sessionStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
