# ADR-0304 検索の結果の画像は種別ごとの署名つき URL にし、置き場を公開にしない

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/features/search/services/search.service.ts`、`src/lib/storage/item-images.ts`・`look-images.ts`（範囲外） | 基準コミット: `4e84d5c5`

## 概要

検索の結果と人気商品のサムネイルは、商品・ルック・ニュースの種別ごとの署名の関数を service role の client で呼んで署名つき URL にする。画像を出すために置き場を公開にはしない。NEWS の画像の分は ADR-0002 に書いてあり、ここでは検索の側の判断と、商品・ルックの分を書く。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FREQ-185-REQ-01（範囲外。NEWS が定義） |
| 対象のコード | `src/features/search/services/search.service.ts`、`src/lib/storage/item-images.ts`（範囲外）、`src/lib/storage/look-images.ts`（範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-185）、`docs/03_BasicDesign/decisions/ADR-0002-search-news-images-signed-url.md`、`e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts`、git `22dcaf6f` |
| 要件の文書 | `docs/02_Requirements/areas/news.md`（FREQ-185） |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0304 検索の結果の画像は種別ごとの署名つき URL にし、置き場を公開にしない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-185-REQ-01（範囲外） |
| 根拠 | 画像の置き場は非公開（migrations 030・044）で、DB に残る公開 URL のままでは 400 になり、検索の結果のサムネイルが出なかった。ほかのページ（商品の一覧・ルックの詳細・カート・注文）と同じ署名つき URL にそろえ、置き場は公開に戻さない（FREQ-185）。署名は storage の RLS を通る service role の client で行う |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-185）、`src/features/search/services/search.service.ts` の注 |

#### 背景

検索の結果は、DB の `image_url` をそのまま返していた。置き場が非公開になった後は画像が読み込めなかった（FREQ-185 の要求の文）。

#### 決定

- `signResultImages` が種別を見て `signItemImageUrl`・`signLookImageUrl`・`signNewsImageUrl` のどれかを呼ぶ（`search.service.ts`）
- 署名は service role の client で行う。検索の結果の3種と人気商品の全部に当てる
- 画像の無い行は署名しない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 置き場を公開にする | FREQ-185 が「行わない」と書く。非公開の物の画像が URL で開けるようになる |
| 利用者の session の client で署名する | storage の RLS を通れない（FREQ-185 が service role の client を指定） |

#### 結果

- 良くなること: 検索の結果と人気商品の画像が出る（E2E `e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts`）
- 悪くなること: 署名の期限は検索から明示して 3600 秒にそろえた（2026-10-28。以前は商品が7日で、非公開にしても外に出た URL で最大7日画像が見えた。SEC-SEARCH-014 を満たした。ADR-0316）。1時間の間は、非公開にしても外に出た URL で画像が見える
- 悪くなること: 以前は署名に失敗した時や道筋を取り出せない時に元の値をそのまま返していた（`item-images.ts`）。2026-10-28 に `null` を返す形に直した（SEC-SEARCH-015 を満たした。ADR-0316）
- 公開の道で service role の client を作る。使うのは署名と人気商品だけ（ADR-0305）

## 未確認事項

- 本番の置き場の公開の設定
- 検索の経路で署名に失敗した時の表示は試していない
