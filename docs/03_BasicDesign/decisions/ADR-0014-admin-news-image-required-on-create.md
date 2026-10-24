# ADR-0014 記事を作る時は画像を必須にし、直す時は付け直さなければ元の画像を使う

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/app/admin/news/NewsForm.tsx` | 基準コミット: `a03beaff`

## 概要

管理のニュースは作る時に画像を必須にし、直す時は新しい画像を送らなければ元の画像を残す。受ける画像は JPEG・PNG・WebP・GIF の 5MB まで。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-252-REQ-02、FREQ-252-REQ-03 |
| 対象のコード | `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`supabase/migrations/20260901102912_remote_schema.sql` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-33・FREQ-252） |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0014 記事を作る時は画像を必須にし、直す時は付け直さなければ元の画像を使う

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-252-REQ-02、FREQ-252-REQ-03 |
| 根拠 | 記事にはアイキャッチの画像が要り、検索の結果のサムネイル（FREQ-185）も画像がある前提なので、作る時は必須にした。直す時にまで付け直しを求めると文だけ直したい時に手間になるので、元の画像を残す（FREQ-252-REQ-02。「手間になる」は理由が要件に無く、推定） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-33・FREQ-252） |

#### 背景

以前は管理のニュースで画像を扱わない方針（FREQ-33）だったが、アイキャッチと検索のサムネイルのために画像が要るようになった。

#### 決定

- POST は画像のファイルが無ければ 400（`route.ts`）
- PUT は画像のファイルがあれば差し替え、無ければ `image_url` を変えない（`[id]/route.ts`）
- 種類は JPEG・PNG・WebP・GIF、大きさは 5MB まで（`route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 管理のニュースで画像を扱わない（FREQ-33。廃止） | 記事にアイキャッチが要り、検索のサムネイルも画像を前提にする |

#### 結果

- 良くなること: 公開の記事には必ず画像があり、検索の結果にサムネイルを出せる
- 悪くなること: 種類は送る側が申告する MIME だけで確かめ、中身は見ない（SEC-NEWS-017）
- 悪くなること: 差し替えた前の画像は置き場に残る（SEC-NEWS-018）
- 食い違い: `migrations/056_make_news_image_url_nullable.sql` は画像を必須でなくすが、今の DB の定義は NOT NULL（`remote_schema.sql`）

## 未確認事項

- 本番の DB の `image_url` が NOT NULL か
