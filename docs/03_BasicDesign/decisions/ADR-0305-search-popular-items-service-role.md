# ADR-0305 人気商品は paid の注文の数量の合計で並べ、service_role だけが呼べる関数で集め、購入数を応答に出さない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `get_popular_items`（範囲外の DB）、`src/features/search/services/search.service.ts` | 基準コミット: `4e84d5c5`

## 概要

POPULAR ITEMS は、paid の注文の元の注文の行の数量の合計が多い順に、公開の商品を並べる。集める関数は注文の表を読むので service_role だけに開き、サーバーの service role の client から呼ぶ。購入数そのものは検索の応答に載せない。関数の権限の種類が要件の文と違う点は SEC-SEARCH-009 に書いた。決まりが定まっていないので「推定」にした。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FREQ-186-REQ-01、FREQ-186-REQ-02、SEC-SEARCH-009 |
| 対象のコード | `src/features/search/services/search.service.ts`、`supabase/migrations/20261013001143_order_return_receipts.sql`（範囲外の DB） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-186）、`migrations/060_create_get_popular_items_rpc.sql`、`docs/superpowers/plans/2026-10-12-returns-stage1.md`、git `22dcaf6f` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0305 人気商品は paid の注文の数量の合計で並べ、service_role だけが呼べる関数で集め、購入数を応答に出さない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-186-REQ-01、FREQ-186-REQ-02、SEC-SEARCH-009 |
| 根拠 | 注文の表は RLS で本人と管理者だけが読めるので、匿名の利用者の権限では購入数を数えられない。anon・authenticated から呼べると、集めた売れ行きを外から直接読めるので、関数は service_role だけに開いてサーバーから呼ぶ。購入数は商品ごとの売れ行きなので応答に出さない（FREQ-186-REQ-02、移行 060 の注） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-186）、`migrations/060_create_get_popular_items_rpc.sql`、`supabase/migrations/20261013001143_order_return_receipts.sql` |

#### 背景

前の POPULAR ITEMS は公開の商品の新着順だった（`migrations/060_create_get_popular_items_rpc.sql`）。FREQ-186 が購入数の順に置き換えた。返品の作業で交換の品の行（`line_kind = 'exchange'`）が注文の行に入るようになり、交換で2回売れたことにならないよう人気の数から外した（`docs/superpowers/plans/2026-10-12-returns-stage1.md`）。

#### 決定

- 購入数は、status が paid の注文の元の注文の行（`line_kind = 'order'`）の数量の合計。公開の商品を購入数の多い順、同じ数なら作った日の新しい順に返し、買われていない商品も後ろに残す（`order_return_receipts.sql`）
- 返品の移行を作った時に「paid の注文」という範囲は変えないと決めた
- EXECUTE は PUBLIC・anon・authenticated から外し、service_role だけに付ける
- アプリは service role の client で毎回4件を取り（`search.service.ts`）、`mapPopularItem` で購入数を落とした形にする

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 公開の商品の新着順（前の形） | FREQ-186 が購入数の順に置き換えた |
| anon・authenticated から呼べる関数 | 集めた売れ行きを外から直接読める（移行 060 の注） |
| 購入数を応答に含める | FREQ-186-REQ-02 が含めないと決めた |

#### 結果

- 良くなること: 語が無くても、0件の時も、売れている商品を出せる
- 食い違い: 関数の権限の種類が要件の文と違う点は SEC-SEARCH-009 に書いた。返品の移行で作り直した時に変わった
- 悪くなること: 全部を発送した注文（shipped）は数えないので、発送済みの購入が数から抜ける。台帳の S-2「発送済みの注文が売上と KPI から外れる」（`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`）と同じ種類
- 悪くなること: 購入数を落とすのは `mapPopularItem` の1か所だけで、公開の道で権限の強い client を使う
- EXECUTE の権限を確かめる試験は無い（SEC-SEARCH-009-AC-01）

## 未確認事項

- SEC-SEARCH-009 に書いた権限の種類（INVOKER か DEFINER）のどちらを決まりにするか
- shipped の注文を数えないままにするか
- 本番の DB の関数の定義と権限
