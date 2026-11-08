# 1.16-5 管理の会計（ADMIN ACCOUNTING）詳細設計

> 状態: 現行のソース（会計の作り直し 計画1 Task 8・10・11・12。画面と窓口は単体・RTL・E2E で確かめた分。本番には未適用） | 確認日: 2026-11-08 | 対象: ACCOUNTING タブの会計期間の選択、「設定・期間」サブタブ、期間で数える読み、証憑の種類、減価償却の月数

## 概要

ACCOUNTING タブ（`src/components/CostProfitSection.tsx`）は、年の選択をやめ、会計期間で全部を数える。取引・累計・注文・Stripe は選んだ期間の日付の範囲で読み、手入力の仕訳は DB が保存した仕訳（`savedJournal`）をそのまま使う。6つ目のサブタブ「設定・期間」で、開業日・事業の形・期間・申告の期限・個人事業のやめた日を扱う。

この頁は `scripts/trace/scope.json` の範囲の外にあるので、`DD-` の項目は振らず、`16_admin.md`（範囲内の ADMIN の `DD-ADMIN-*`）とは別に置く。管理全体の入口は [ADMIN](16_admin.md)、会計の財務ドメインは[財務](../shared/finance.md)を参照する。

| 部分 | 実装 |
| --- | --- |
| 入れ物と状態 | [CostProfitSection.tsx](../../../src/components/CostProfitSection.tsx)（173行）、[use-cost-profit-model.ts](../../../src/components/cost-profit/use-cost-profit-model.ts)（全 hooks と計算）、サブタブごとの `*-view.tsx`（hooks を持たず `model` を受ける） |
| 期間の選択 | [period-picker.tsx](../../../src/components/cost-profit/period-picker.tsx)。`AccountingSection` が `periodId` を持つ |
| 設定・期間 | [settings-view.tsx](../../../src/components/cost-profit/settings-view.tsx)、[period-form.tsx](../../../src/components/cost-profit/period-form.tsx)、[filing-deadlines-panel.tsx](../../../src/components/cost-profit/filing-deadlines-panel.tsx) |
| 期間の計算 | [period.ts](../../../src/lib/accounting/period.ts)・[period-months.ts](../../../src/lib/accounting/period-months.ts)・[filing-deadlines.ts](../../../src/lib/accounting/filing-deadlines.ts)・[startup-deadlines.ts](../../../src/lib/accounting/startup-deadlines.ts)・[jp-holidays.ts](../../../src/lib/accounting/jp-holidays.ts) |
| 読みの範囲 | [period-range.ts](../../../src/lib/finance/period-range.ts) |

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応要件 | FREQ-555（期間）、FREQ-557（期間で数える）、FREQ-559（証憑の種類）、FREQ-561（開業日・申告の期限）、FREQ-553（権限） |
| 設計 | [会計の作り直し 計画1](../../superpowers/plans/2026-11-04-accounting-p1-journal-foundation.md)・[設計](../../superpowers/specs/2026-11-03-accounting-redesign-design.md)。窓口は[API 仕様](../../03_BasicDesign/api/api-spec.md)、画面は[画面一覧](../../03_BasicDesign/ui/screen-list.md)の「会計の設定・期間と期間の選択」 |
| 調査時点 | 2026-11-08 のソース。本番には未適用 |

## 期間で数える読み（`GET /api/admin/kpi/cost-profit`）

| 論点 | 内容 |
| --- | --- |
| 期間の決め方 | `periodId`（UUID）があればその期間（無ければ 404 `ACCOUNTING_NOT_FOUND`、形が違えば 400）。無ければ旧の `year` をその年に始まる個人の期間に結ぶ。どちらも無ければ 400。年の期間が無ければ既定の期間（今日〔日本時間〕を含む期間、個人と法人の両方なら現在の事業の形、無ければ今日までに始まった最後の期間） |
| 期間が1つも無い | 200 で `period:null`・空の配列。画面は「期間がありません」の案内だけ |
| 読みの範囲 | 手入力の取引は `expense_date` が期間の中、累計は期間の終わりまで、注文は日本時間の日付が期間に入る物、Stripe は `stripe_created_at` が期間の中。事業の形は期間の事業の形 |
| 保存した仕訳 | 1ページ200件で `nextAfter` が無くなるまで最大100ページ。超えたら 500 `JOURNAL_TOO_LARGE`、途中の失敗と期首の失敗は 500 `JOURNAL_INCOMPLETE`。画面は合計を出さず「一部しか読めていないため、合計を表示できません」を出す |
| 期首 | `opening` は DB の期首の行（借方 − 貸方）。0行は期首なし。画面は元帳の normalSide の向きに直す |
| 画面の仕訳 | 保存した仕訳＋注文の売上の合成＋Stripe の合成＋減価償却・棚卸・引当金（日は期間の終わり）。手入力から仕訳を作る旧の経路はやめた |
| 知らせ | `periodNotices.previousPeriodOpen`（前の期間を締めていない）・`filingDeadlinePassed`（主の税の期限を過ぎた） |

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

- 窓口: `tests/unit/api/admin/cost-profit-route.test.ts`・`receipt-route.test.ts`・`accounting-periods-route.test.ts`・`accounting-settings-route.test.ts`・`accounting-journal-route.test.ts`。
- 画面: `tests/unit/components/CostProfitSection.test.tsx`、`tests/unit/components/cost-profit/` の `settings-view`・`period-form`・`receipt-kind`・`period-count`。計算: `tests/unit/lib/accounting/`・`tests/unit/lib/finance/`（`period-range`・`depreciation-period`）。
- E2E: `FR-ADMIN-024`〜`050`（期間の選択に合わせて更新）、`FR-ADMIN-128`〜`131`（設定・期間、保存した仕訳、権限、証憑の種類）。

## 未確認事項

- 地方税の延長の注記（「都道府県・市町村への申請が別に要ります」）は税理士の確認待ち（e-Gov の条文で確かめられなかった）。
- 年をまたぐ法人の期間の減価償却予定表の年別の列、月末で終わらない期間の使った月数、貸借対照表の月の比べ、旧の年の締め（計画6で置き換え）は、暦年・月単位の近似のまま。
- 実際の幅（390/768/1280px）の見た目は E2E で確かめた分に限る。
