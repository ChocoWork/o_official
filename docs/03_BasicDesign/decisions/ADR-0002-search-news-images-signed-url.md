# ADR-0002 検索の結果の NEWS の画像も署名つき URL にそろえ、置き場を公開にしない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/lib/storage/news-images.ts`、`src/features/search/services/search.service.ts`（範囲外） | 基準コミット: `a03beaff`

## 概要

検索の結果に出す NEWS のサムネイルも `signNewsImageUrl` で署名つき URL にし、画像を出すために置き場を公開に戻すことはしない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-185-REQ-01（SEC-NEWS-003 は満たさないので上位にしない） |
| 対象のコード | `src/lib/storage/news-images.ts`、`src/features/search/services/search.service.ts`（範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-185）、`e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts`（範囲外） |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0002 検索の結果の NEWS の画像も署名つき URL にそろえ、置き場を公開にしない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-185-REQ-01 |
| 根拠 | 置き場は非公開なので、DB の公開 URL のままでは検索の結果のサムネイルが 400 で出ない。出すために置き場を公開に戻すと、ADR-0001 で塞いだ非公開の記事の画像の漏れが戻るため、検索の側を署名つき URL に合わせた（FREQ-185。公開に戻さないと書くが、その理由は要件に無く、ADR-0001 から推定） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-185） |

#### 背景

ADR-0001 で置き場を非公開にした後も、検索の結果は DB にある公開 URL をそのまま返していたため、サムネイルが読み込めなかった。

#### 決定

- 検索の結果の NEWS の `imageUrl` を `signNewsImageUrl` で署名つき URL にする（`src/features/search/services/search.service.ts`）
- 置き場の公開の設定は変えない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 置き場を公開にする | FREQ-185 が「採らない」と書く。非公開の記事の画像が URL で開けるようになる |

#### 結果

- 良くなること: 検索の結果でも NEWS の画像が出る（E2E `e2e/FR-SEARCH-007-thumbnail-signed-urls.spec.ts`、範囲外）
- 悪くなること: 署名の失敗で元の値を返す形と、署名の前に道を確かめない形（SEC-NEWS-007・008）は検索の経路にもそのまま当てはまる（推定）
- 検索の部品は範囲外なので、この判断に従う構造設計は NEWS の画像の署名の側で書く

## 未確認事項

- 検索の経路で署名に失敗した時の表示は試していない
