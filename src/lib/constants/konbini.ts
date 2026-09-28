// コンビニ決済の支払期限（日数）。Stripe の payment_method_options.konbini.expires_after_days と
// /legal の「支払方法・支払時期」の表記で共有する（FREQ-106）。Stripe では「注文日＋この日数の 23:59:59（日本時間）」まで払える。
// 7日は 2026-09-27 の決定（グループ A 設計書 5-7）。変えるときは FR-LEGAL-004 と create-session の単体テストの期待値も直す。
export const KONBINI_PAYMENT_DAYS = 7;
