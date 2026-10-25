/**
 * G-1 で止めた旧の発送・仕上がりの操作の固定の言葉と記号（グループ G 設計書 13 章、G-1 Task 14）。
 * 画面（Task 15）と server の窓口・store が同じ文を使うので、副作用の無い定義だけを置く（server-only にしない）。
 * DB の旧の関数も同じ記号を SQLSTATE 55000 で返す（admin_create_fulfillment など）。G-3 で新しい発送票（荷作り表から行う）に移ったので、旧い入口は再開しない。
 */
export const LEGACY_FULFILLMENT_DISABLED = 'LEGACY_FULFILLMENT_DISABLED';
export const MANUAL_COMPLETION_DISABLED = 'MANUAL_COMPLETION_DISABLED';

export type LegacyFulfillmentDisabledCode = typeof LEGACY_FULFILLMENT_DISABLED | typeof MANUAL_COMPLETION_DISABLED;

export const LEGACY_FULFILLMENT_DISABLED_TEXT = '旧い発送の操作は終了しました。発送・発送取消・伝票番号の訂正・手動の配達済みは、荷作り表の発送票から行ってください。';
export const MANUAL_COMPLETION_DISABLED_TEXT = '仕上がりの手動記録・取消は終了しました。在庫の入荷から自動で割り当てます。';

/** 止めた操作の HTTP 410 の本文（全文固定。未知の入力でも同じ） */
export type LegacyFulfillmentDisabledBody = { code: LegacyFulfillmentDisabledCode; error: string };

export function legacyFulfillmentDisabledBody(code: LegacyFulfillmentDisabledCode): LegacyFulfillmentDisabledBody {
  return {
    code,
    error: code === LEGACY_FULFILLMENT_DISABLED ? LEGACY_FULFILLMENT_DISABLED_TEXT : MANUAL_COMPLETION_DISABLED_TEXT,
  };
}

/** 止めた store の関数が、DB を呼ぶ前に投げる。message は記号だけ（DB の文を持たない） */
export class LegacyFulfillmentDisabledError extends Error {
  readonly sqlstate = '55000';

  constructor(readonly code: LegacyFulfillmentDisabledCode) {
    super(code);
    this.name = 'LegacyFulfillmentDisabledError';
  }
}
