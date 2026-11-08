# 1.16-5 管理の会計（ADMIN ACCOUNTING）詳細設計

> 状態: 現行のソース（会計の作り直し 計画1 Task 8・10・11・12、計画2 Task 10〜13。画面と窓口は単体・RTL・E2E で確かめた分。本番には計画1が適用済み〔2026-11-08〕、計画2は未適用） | 確認日: 2026-11-09 | 対象: ACCOUNTING タブの会計期間の選択、「設定・期間」サブタブ、「計上待ち」「照合」サブタブ、期間で数える読み（保存した仕訳だけで数える）、証憑の種類、減価償却の月数、KPI の受注高

## 概要

ACCOUNTING タブ（`src/components/CostProfitSection.tsx`）は、年の選択をやめ、会計期間で全部を数える。取引・累計・Stripe は選んだ期間の日付の範囲で読み、仕訳は DB が保存した仕訳（`savedJournal`）をそのまま使う。計画2から、注文の売上と Stripe の仕訳を画面で合成する道（`buildStripeJournal`・`buildOrderSalesJournal`）はなく、画面の仕訳は保存した仕訳と減価償却・棚卸・引当金だけ。サブタブは8つ: 計画1の「設定・期間」（開業日・事業の形・期間・申告の期限・個人事業のやめた日）に、計画2の「計上待ち」（仕訳にできていない出来事と前受金の確認）と「照合」（Stripe の残高・手数料の月・受注高・年末の出荷）を足した。

このページは `scripts/trace/scope.json` の範囲の外にあるので、`DD-` の項目は振らず、`16_admin.md`（範囲内の ADMIN の `DD-ADMIN-*`）とは別に置く。管理全体の入口は [ADMIN](16_admin.md)、会計の財務ドメインは[財務](../shared/finance.md)を参照する。

| 部分 | 実装 |
| --- | --- |
| 入れ物と状態 | [CostProfitSection.tsx](../../../src/components/CostProfitSection.tsx)、[use-cost-profit-model.ts](../../../src/components/cost-profit/use-cost-profit-model.ts)（全 hooks と計算）、サブタブごとの `*-view.tsx`（hooks を持たず `model` を受ける） |
| 期間の選択 | [period-picker.tsx](../../../src/components/cost-profit/period-picker.tsx)。`AccountingSection` が `periodId` を持つ |
| 設定・期間 | [settings-view.tsx](../../../src/components/cost-profit/settings-view.tsx)、[period-form.tsx](../../../src/components/cost-profit/period-form.tsx)、[filing-deadlines-panel.tsx](../../../src/components/cost-profit/filing-deadlines-panel.tsx) |
| 期間の計算 | [period.ts](../../../src/lib/accounting/period.ts)・[period-months.ts](../../../src/lib/accounting/period-months.ts)・[filing-deadlines.ts](../../../src/lib/accounting/filing-deadlines.ts)・[startup-deadlines.ts](../../../src/lib/accounting/startup-deadlines.ts)・[jp-holidays.ts](../../../src/lib/accounting/jp-holidays.ts) |
| 読みの範囲 | [period-range.ts](../../../src/lib/finance/period-range.ts) |
| 計上待ち・照合（計画2） | [pending-view.tsx](../../../src/components/cost-profit/pending-view.tsx)・[deferred-revenue-panel.tsx](../../../src/components/cost-profit/deferred-revenue-panel.tsx)・[reconciliation-view.tsx](../../../src/components/cost-profit/reconciliation-view.tsx)・[year-end-shipments-panel.tsx](../../../src/components/cost-profit/year-end-shipments-panel.tsx)。読みの共通部品は [accounting-api.tsx](../../../src/components/cost-profit/accounting-api.tsx) |
| dispute・残高の補充（計画2） | [dispute-list.tsx](../../../src/components/cost-profit/dispute-list.tsx)・[dispute-settings-panel.tsx](../../../src/components/cost-profit/dispute-settings-panel.tsx)・[balance-topup-form.tsx](../../../src/components/cost-profit/balance-topup-form.tsx)。Stripe 精算のタブ（[stripe-settlement-view.tsx](../../../src/components/cost-profit/stripe-settlement-view.tsx)）と設定・期間（[settings-view.tsx](../../../src/components/cost-profit/settings-view.tsx)）に置く |

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応要件 | FREQ-555（期間）、FREQ-557（期間で数える）、FREQ-559（証憑の種類）、FREQ-561（開業日・申告の期限）、FREQ-553（権限）。計画2: FREQ-564（出荷の跡）、FREQ-565・566（Stripe の記録と照合）、FREQ-568（dispute）、FREQ-569（計上待ち・前受金）、FREQ-570（保存した仕訳で数える）、FREQ-571（受注高の照合）、FREQ-572（KPI の受注高）、FREQ-573（月の記録）、FREQ-574（年末の出荷） |
| 設計 | [会計の作り直し 計画1](../../superpowers/plans/2026-11-04-accounting-p1-journal-foundation.md)・[計画2](../../superpowers/plans/2026-11-04-accounting-p2-deferred-revenue-stripe.md)・[設計](../../superpowers/specs/2026-11-03-accounting-redesign-design.md)。窓口は[API 仕様](../../03_BasicDesign/api/api-spec.md)、画面は[画面一覧](../../03_BasicDesign/ui/screen-list.md)の「会計の設定・期間と期間の選択」 |
| 調査時点 | 2026-11-08 のソース。本番には未適用 |

## 期間で数える読み（`GET /api/admin/kpi/cost-profit`）

| 論点 | 内容 |
| --- | --- |
| 期間の決め方 | `periodId`（UUID）があればその期間（無ければ 404 `ACCOUNTING_NOT_FOUND`、形が違えば 400）。無ければ旧の `year` をその年に始まる個人の期間に結ぶ。どちらも無ければ 400。年の期間が無ければ既定の期間（今日〔日本時間〕を含む期間、個人と法人の両方なら現在の事業の形、無ければ今日までに始まった最後の期間、それも無ければ最初の期間） |
| 期間が1つも無い | 200 で `period:null`・空の配列。画面は「期間がありません」の案内だけ |
| 読みの範囲 | 手入力の取引は `expense_date` が期間の中、累計は期間の終わりまで、Stripe は `stripe_created_at` が期間の中。事業の形は期間の事業の形。注文の表（`orders`）は読まない（計画2 Task 12。取引管理の「注文の収入」の行は、取り消されていない出荷の仕訳〔`shipment_confirmed`・`shipment_redated`〕の 4010 の貸借の差から作る） |
| 保存した仕訳 | 1ページ200件で `nextAfter` が無くなるまで最大100ページ。超えたら 500 `JOURNAL_TOO_LARGE`、途中の失敗と期首の失敗は 500 `JOURNAL_INCOMPLETE`。画面は合計を出さず「一部しか読めていないため、合計を表示できません」を出す |
| 期首 | `opening` は DB の期首の行（借方 − 貸方）。0行は期首なし。画面は元帳の normalSide の向きに直す |
| 画面の仕訳 | 保存した仕訳＋減価償却・棚卸・引当金（日は期間の終わり）。計画2 Task 12 で、注文の売上と Stripe の仕訳を画面で合成する道を無くした（コードに `buildStripeJournal`・`buildOrderSalesJournal`・`toOrderSalesTransaction` は残らない。試験 `no-synthesis.test.ts`）。手入力から仕訳を作る旧の経路もやめた |
| 知らせ | `periodNotices.previousPeriodOpen`（前の期間を締めていない）・`filingDeadlinePassed`（主の税の期限を過ぎた） |
| 出荷の跡の材料 | 応答の `shipmentMeta` に、出荷の仕訳の発送票の番号・出荷した日・登録した日（200件ずつ読む）。読めなかった時は GET を止めず `null` を返し、帳簿の列は固定の案内を出す（計画2 Task 12） |

## 設定・期間サブタブ

読み込みは `GET /api/admin/accounting/periods`（期間・設定・期限・中間申告・開業日からの届け出）。書き込みは `sendAccountingJson`（二重送信を ref と disabled で止め、ok でない応答も本文を最後まで読む）で、成功すると読み直して `onChanged` を呼び、会計の画面を読み直す。画面の項目と文言は[画面一覧](../../03_BasicDesign/ui/screen-list.md)に書いた。

| 操作 | 窓口 | 補足 |
| --- | --- | --- |
| 開業日の保存 | `PUT /api/admin/accounting/settings` | 一度だけ。範囲は 2000/01/01 〜 今日の日本時間の1年後。画面でも同じ範囲で止める |
| 事業の形の切り替え | 同上 | 個人から法人へは、やめた日の登録と確かめの印が要る（画面の規則） |
| 期間の追加 | `POST /api/admin/accounting/periods` | 送る前に `validateNewPeriod`（重なり・すき間・1年超・個人の暦年）。名前はサーバーが作る |
| 申告の設定 | `PUT /api/admin/accounting/periods/[id]/filing` | 法人税・消費税の延長と課税事業者になった日。期限の表示はこの設定で変わる |
| やめた日の登録・選び直し | `POST /api/admin/accounting/periods/[id]/final-sole` | 選び直しは理由が必須。規則は[会計の期間の状態](../states/accounting-period.md) |

申告の期限（`filingDeadlines`）は、土曜・日曜・祝日・1月2日・3日・12月29日〜31日を次の日へ繰り下げる（国税通則法10条2項、基本通達 第10条関係）。「N か月以内」は翌日から数えて応当日の前日に満了する。祝日の表（内閣府、1955〜2027年）が無い年は繰り下げず目安として出す。

## 証憑の種類

取引の証憑の Drawer と新しい取引の入力で、添付の前に種類（電子／紙）を選ぶ。紙は「紙の原本を残してある」を確かめるまで添付できない。`POST /api/admin/kpi/cost-profit/receipt` と `receipt.attach` は `evidenceKind` を必須にし、紙には `paperOriginalKept` も必須にする（ほかには付けられない）。移行前の領収書は `unconfirmed` のままで、画面は「種類を確かめてください」を出す。置き場 `finance-receipts` は非公開・20MiB・5形式。

## 減価償却の月数

[depreciation.ts](../../../src/lib/finance/depreciation.ts) は選んだ期間の月数で償却額を決める（式は[財務](../shared/finance.md)の「減価償却の月数」）。呼び出しは `use-cost-profit-model.ts` の `depreciationFor`。選んだ年の列だけ期間で数え、他の年の列は暦年のまま。定率法は選択肢に出さない。

## 関連テスト

- 窓口: `tests/unit/api/admin/cost-profit-route.test.ts`・`receipt-route.test.ts`・`accounting-periods-route.test.ts`・`accounting-settings-route.test.ts`・`accounting-journal-route.test.ts`。計画2: `accounting-pending-events-route`・`accounting-disputes-route`・`accounting-stripe-route`・`accounting-reconciliation-route`・`accounting-year-end-route`・`kpi-order-intake`・`kpi-monthly-record-route`。
- 画面: `tests/unit/components/CostProfitSection.test.tsx`、`tests/unit/components/cost-profit/` の `settings-view`・`period-form`・`receipt-kind`・`period-count`。計算: `tests/unit/lib/accounting/`・`tests/unit/lib/finance/`（`period-range`・`depreciation-period`）。
- E2E: `FR-ADMIN-024`〜`050`（期間の選択に合わせて更新）、`FR-ADMIN-128`〜`131`（設定・期間、保存した仕訳、権限、証憑の種類）。計画2: `FR-ADMIN-132`〜`136`（支払い・出荷の仕訳と計上待ち、Stripe と dispute、KPI の受注高、月の記録、年末の出荷。いずれも 390/768/1280px）。

## 未確認事項

- 地方税の延長の注記（「都道府県・市町村への申請が別に要ります」）は税理士の確認待ち（e-Gov の条文で確かめられなかった）。
- 年をまたぐ法人の期間の減価償却予定表の年別の列、月末で終わらない期間の使った月数、貸借対照表の月の比べ、旧の年の締め（計画6で置き換え）は、暦年・月単位の近似のまま。
- 実際の幅（390/768/1280px）の見た目は E2E で確かめた分に限る。
- 計上待ちの `units_insufficient` の画面の文は、その発送票自体を取り消した時だけ消えることを言い切っていない（[運用](../../06_Operations/accounting-p2-posting-stripe.md)の未確認事項 20）。
- 帳簿の「出荷の跡」の「担当」は、人の名前でなく利用者 ID の先頭8文字を出す（Task 11 の申し送り）。


## 計上待ち・照合・受注高（計画2）

画面の作りは[画面一覧](../../03_BasicDesign/ui/screen-list.md)の「会計の計上待ち・照合・受注高」、導線は[画面遷移](../../03_BasicDesign/ui/screen-flow.md)、読みの窓口は[API 仕様](../../03_BasicDesign/api/api-spec.md)、運用は[会計の運用](../../06_Operations/accounting-p2-posting-stripe.md)。ここは処理の詳細だけを書く。

| 部分 | 処理 |
| --- | --- |
| 読みの共通 | `getAccountingData`（GET、`no-store`、本文を最後まで読む、答えの形を確かめる）。形が違う答えは固定の失敗の文にして落ちない。権限は応答の `permissions`（`manageSettings`・`manageFinance`・`correctEntries`）で見て、持っていない人にはボタンを出さない |
| 計上待ち | 一覧は `GET …/pending-events`（開いている行だけ、50件ずつ）。「もっと見る」は続きの目印で読み、古い目印（409 `ACCOUNTING_LIST_RESTART`）は最初から読み直す。「もう一度計上する」は `POST …/posting/run`（二重送信は ref と disabled で止める）。「確認済みにする」は `before_cutover`・`no_revenue` の行だけ、メモ必須（`POST …/pending-events/[id]/resolve`）。理由の文は `reasonText`（18種。`period_missing` と `dispute_withdrawal_missing` は詳細で文を変える） |
| 前受金の確認 | `GET …/deferred-revenue`（基準日を選ぶ、100件ずつ）。残高が正の注文を番号順に、未出荷の着の状態（今の状態）とともに出す。異常は毎ページ作り直す |
| 照合 | `GET …/reconciliation?kind=stripe-balance|stripe-fee|intake`。押した直後の2回目は止め、古い答えで上書きしない。説明のつかない差が0以外なら赤字。請求書の記録は `PUT …/stripe-invoices`（版つき。保存後に手数料の照合を引き直す） |
| 年末の出荷 | `GET …/year-end-shipments`（範囲60日まで）、確かめた印は `POST`（`admin.finance.manage`）、運送会社の受付日のオプションは `PUT`（`admin.accounting.settings.manage`）。印は付けた時の出荷日と追跡の版を持ち、その後の変更で「古い」と出す |
| dispute | 一覧 `GET …/disputes`（50件ずつ）、確定した損失の科目の振り替え `POST …/disputes/[id]/assign`、原因ごとの科目の設定 `PUT …/dispute-settings` |
| 残高の補充 | `POST …/balance-topups`。送る前に金額（1以上の整数）、日付（今日まで）、番号（銀行か Stripe のどちらか必須、`^[A-Za-z0-9_.-]{1,128}$`）を検査し、切り替えの日より前は route が 400 を返す |
| 帳簿の出荷の列 | 仕訳帳・元帳の出荷の仕訳に、`shipmentMeta` から「出荷した日」「登録した日」を出す（取引管理の読みと同じ応答で、画面で読み直さない）。「出荷の跡」は `GET …/shipment-trace?slipId=` |
| 発送票の確定の止め | 画面の発送票の確定が 409 `{code:'DISPUTE_HOLD'}` を受けたら、固定の文を出して票を読み直す（`disputeHoldMessage`） |
| KPI の受注高 | `GET /api/admin/kpi` の応答（`backlog`・`intakeBreakdown`・`returnsThisMonth`）を `IntakeSummary` が出す。3つが揃った時だけパネルを出し、内訳が合わない時（`breakdownOk` が偽）は警告を出す。「照合」への案内は `?accountingTab=reconciliation` |
