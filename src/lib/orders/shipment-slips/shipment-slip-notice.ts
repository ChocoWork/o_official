// File: src/lib/orders/shipment-slips/shipment-slip-notice.ts
// 荷作り表から票の頁へ移る時に、通知（「下書きを保存しました。」）を1回だけ引き継ぐ印（G-3 Task 4）。
// 移った先の URL を /admin/shipment-slips/[id] のまま保つため、sessionStorage に票の id だけを置く。
// 読み書きは必ず try/catch（ブロックされた・無効な環境でも画面は動く）。sessionStorage を使う2つの関数はブラウザだけで動く。
// 下の DISPUTE_HOLD の印と文は定数と純粋な関数だけで、確定の route（サーバー）と画面が同じ文を使う。

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

/** 確定の route が、判断待ちのカード会社の取り消しがある注文を含む票を止める時の印（計画2 Task 10。4-e3。DB の止めは計画3）。 */
export const DISPUTE_HOLD_CODE = 'DISPUTE_HOLD';

/** 止めた時に確定の画面へ出す文。お客様の名前・注文番号を入れない（どの注文かは orderIds が示す）。 */
export const DISPUTE_HOLD_MESSAGE = 'カード会社の判断待ちの注文が含まれているため、出荷できません。';

/** 確定の route の断りの本文が DISPUTE_HOLD なら画面に出す文、そうでなければ null（ほかの断りは今までの扱い）。 */
export function disputeHoldMessage(body: unknown): string | null {
  const code = body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  return code === DISPUTE_HOLD_CODE ? DISPUTE_HOLD_MESSAGE : null;
}
