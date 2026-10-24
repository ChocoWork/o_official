# ADR-0001 ニュースの画像は非公開の置き場に置き、期限1時間の署名つき URL で配る

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/lib/storage/news-images.ts`、`src/features/news/services/public.ts`、`src/app/api/admin/news/` | 基準コミット: `a03beaff`

## 概要

記事の画像は非公開の置き場 `news-images` に置き、取り出すたびに期限1時間の署名つき URL に置き換えて配る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-004、DRV-NEWS-008（SEC-NEWS-003 は満たさないので上位にしない） |
| 対象のコード | `src/lib/storage/news-images.ts`、`src/features/news/services/public.ts`、`src/app/api/admin/news/route.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md`、`migrations/013_create_news_images_bucket.sql`、`supabase/seed.sql` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0001 ニュースの画像は非公開の置き場に置き、期限1時間の署名つき URL で配る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-004、DRV-NEWS-008 |
| 根拠 | 置き場を公開にすると、非公開の記事の画像も URL を知る人なら誰でも開け、記事の状態で決めた公開の線引きが画像だけ崩れるため（2026-04-18 のレビューの Priority 1 の指摘） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-news-id-security-review.md`、git `5300deb9`（2026-04-19「change news-images bucket to private」） |

#### 背景

記事を外へ出すかどうかは `news_articles.status` と RLS で決める。ところが画像の置き場は `migrations/013_create_news_images_bucket.sql` で `public = true` だった。レビューは、非公開の記事の画像が URL の分かる人に見えると指摘し、非公開の置き場と署名つき URL、またはサーバーの中継、または置き場を2つに分ける案を挙げた。

#### 決定

- 置き場 `news-images` を非公開にした（git `5300deb9` で `migrations/013_create_news_images_bucket.sql` を直した。手元の DB は `supabase/seed.sql` が作る）
- DB の `image_url` には置き場の中の道（`news/<日付>/<uuid>.<拡張子>`）か古い公開 URL を持ち、取り出すたびに service role で期限 3600 秒の署名つき URL を作る（`src/lib/storage/news-images.ts`）
- 古い public・sign・authenticated の URL からも置き場の中の道を取り出して署名し直す（`news-images.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 画像を返すサーバーの中継 | レビューが挙げた案の1つ。選ばなかった理由の記録は無い（推定: 署名つき URL なら中継の処理と負荷を持たずに済む） |
| 下書き用と公開用で置き場を分け、公開の時に画像を移す | レビューが挙げた案の1つ。選ばなかった理由の記録は無い（推定: 状態を切り替えるたびに移す処理と、その失敗の扱いが要る） |

#### 結果

- 良くなること: 非公開の記事の画像は、署名つき URL を持たない人には開けない
- 悪くなること: 出した署名つき URL は、記事を非公開にしても期限まで開ける。`next/image` の最適化のキャッシュでさらに残りうる（推定。SEC-NEWS-004）
- 悪くなること: 署名に失敗した時・道にできない時は元の値を返す（`news-images.ts`）（SEC-NEWS-008）
- 悪くなること: 公開の一覧・詳細は画像を出さない（FREQ-32）のに行ごとに署名し、`/api/news` の JSON に署名つき URL が載る（SEC-NEWS-005、ADR-0004）
- 見直す条件: 置き場の設定を移行で持つ時（SEC-NEWS-003）、公開の画面で画像を出す時

## 未確認事項

- 本番の `news-images` が非公開か、置き場のポリシーがどうなっているか（今の `supabase/migrations/` に置き場の定義が無い）
- 旧 `migrations/013` の書き直しが本番に当たっているか
