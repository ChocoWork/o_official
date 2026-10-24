# ADR-0350 プライバシーポリシーは request のたびに描き、ショップの設定を読めない時は頁の失敗にする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/privacy/page.tsx` | 基準コミット: `4e84d5c5`

## 概要

`/privacy` はビルドの時に固めず、開かれるたびにショップの配送の追跡の設定を読んで描く。設定を読めない時と、読むための client を作れない時は、委託の一覧を黙って出し分けずに頁の描画を失敗にする。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 対応する ID | DRV-PRIVACY-002、SEC-PRIVACY-005、FR-PRIVACY-001、FREQ-495-REQ-01（範囲外） |
| 対象のコード | `src/app/privacy/page.tsx`、`src/lib/orders/tracking/delivery-store.ts`（範囲外の配送の追跡の部品）、`src/lib/supabase/server.ts`（範囲外の共有部品） |
| 関連文書 | `docs/superpowers/plans/2026-10-21-delivery-status.md`、`docs/04_DetailDesign/pages/17_privacy.md`、`docs/06_Operations/webhook-queue-operations.md`、`docs/05_Quality/reviews/security/security_review_privacy.md` |
| 試験 | `tests/unit/components/PrivacyPage.test.tsx` |
| 要件の文書 | `docs/02_Requirements/areas/privacy.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0350 プライバシーポリシーは request のたびに描き、ショップの設定を読めない時は頁の失敗にする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-PRIVACY-002、SEC-PRIVACY-005、FR-PRIVACY-001、FREQ-495-REQ-01（範囲外） |
| 根拠 | 委託の一覧に 17TRACK の一文を出すかは店長が切り替える設定で決まる（FREQ-495-REQ-01（範囲外））ので、ビルドの時に固めた頁では切り替えが公表に届かない。読めない時に一文を黙って隠すと、実際は渡しているのに書かない古い方針を公表し続ける恐れがあるため（`src/app/privacy/page.tsx` のコメント、配送の追跡の追加の計画 `docs/superpowers/plans/2026-10-21-delivery-status.md`） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/plans/2026-10-21-delivery-status.md`、`src/app/privacy/page.tsx`、git `5f29389d`（配送の追跡の追加の作業のコミット） |

#### 背景

- 配送の追跡を足す前の `/privacy` は DB を読まない頁で、要件 FR-PRIVACY-001 は「静的ページ」、詳細設計 `17_privacy.md` は「RSC のまま維持」と書いていた
- 配送の追跡の追加で、配送の追跡がオンの間だけ「5. 個人情報の取扱いの委託」に 17TRACK の一文を足すことになった（`docs/superpowers/specs/2026-10-21-delivery-status-design.md` の決定 25）。オン・オフは `shop_settings` にあり、管理の画面でいつでも切り替わる
- 設定を返す DB の関数は anon・一般会員から取り上げ、service role だけに許している（SEC-PRIVACY-001）

#### 決定

- 頁の処理の初めに Next.js の connection を待ち、ビルドの時に DB へ行かず request の時に描く（`page.tsx`）
- service role の client を作り、`getDeliveryTrackingSettings` でショップの設定を読む（`page.tsx`）。使うのはオンかオフかだけ
- client を作れない時も、設定を読めない時も、例外を握りつぶさずに頁の描画を失敗にする。`/privacy` に専用の誤りの頁は無く、Next.js の既定の誤りの頁になる

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 静的に生成する（FR-PRIVACY-001 の「静的ページ」、`17_privacy.md`） | 追跡を切り替えても、作り直すまで委託の一覧が変わらない。計画は「ビルド時に DB へ行かず request 時の ON を反映する」と決めた（`2026-10-21-delivery-status.md`） |
| 読めない時は一文を出さずに頁を描く | 実際は 17TRACK に渡しているのに書かない、誤った方針を黙って公表する（`page.tsx`） |
| 読めない時は一文を出して頁を描く | 渡していない時に渡すと書く。決定 25 の「渡していない時に、渡すと書かない」に反する |

#### 結果

- 良くなること: 追跡を切り替えると、次に開いた時から委託の一覧が変わる。読めない時に誤った一覧を出さない
- 悪くなること: DB の障害の間は、公表すべきプライバシーポリシーそのものが読めない（THR-PRIVACY-004、SEC-PRIVACY-009）。どちらを優先するかはまだ決まっていない
- 悪くなること: 読む関数が件数と担当者のメールまで受け取る形のままで、ログイン無しで開ける頁から毎回走る（SEC-PRIVACY-002・003 に書いた）。運用の文書は、追跡をオンにする前に「オンか」だけを読む軽い関数に替え、読めない時の扱いを決めるとしている（`webhook-queue-operations.md`）
- 文書: FR-PRIVACY-001 の「静的ページ」と `17_privacy.md` の「RSC のまま維持」は直っていない。`security_review_privacy.md` が求めたキャッシュの方針は、この判断でも明文にしていない
- 見直す条件: 読む関数を軽い物に替える時、`/privacy` に誤りの頁を置く時

## 未確認事項

- この判断を誰が承認したか（計画の文にはあるが、ユーザーの確認の記録は見つけていない）。そのため状態は「推定」
- 本番の誤りの頁が中身を伏せるか、応答の `Cache-Control` の実際の値
