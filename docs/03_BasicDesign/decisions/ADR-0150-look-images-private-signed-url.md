# ADR-0150 LOOK の画像は非公開の置き場に置き、DB には置き場の中の道筋だけを持ち、出すたびに期限1時間の署名つき URL にする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/lib/storage/look-images.ts`、`src/lib/look/server.ts`、`src/app/api/admin/looks/route.ts`、`src/app/api/admin/looks/[id]/route.ts` | 基準コミット: `4facf63b`

## 概要

LOOK の画像の置き場 `look-images` を非公開にし、管理の窓口は上げた画像の道筋（`looks/<日付>/<uuid>.<拡張子>`）だけを DB に保存する。公開の頁・管理の頁とも、出すたびにサーバーで service role の鍵を使い、期限1時間の署名つき URL を作って渡す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | DRV-LOOK-005（SEC-LOOK-005・006 は今のコードが満たさないので上位にしない。「結果」を参照） |
| 対象のコード | `src/lib/storage/look-images.ts`、`src/lib/look/server.ts`、`src/app/api/admin/looks/route.ts`、`migrations/030_make_look_images_bucket_private.sql`（当てた移行。範囲外） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-look-detail-review.md`、`docs/05_Quality/reviews/security/security_review_look.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0150 LOOK の画像は非公開の置き場に置き、DB には置き場の中の道筋だけを持ち、出すたびに期限1時間の署名つき URL にする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-LOOK-005 |
| 根拠 | 公開の置き場では、まだ公開していない LOOK の画像も URL を知れば誰でも開けたため（コードのレビューの Must Fix）。置き場を閉じたうえで画面に画像を出すには、出すたびに期限つきの URL を作るしかない。期限1時間は「1回の描画に足り、漏れた時の害を短く区切る」とコードのコメントに書かれている |
| 状態 | 推定 |
| 出どころ | `migrations/030_make_look_images_bucket_private.sql`、`src/lib/storage/look-images.ts` のコメント、`docs/05_Quality/reviews/code/2026-04-18-look-detail-review.md`。ユーザーが決めた記録は無い |

#### 背景

- 最初の置き場は公開で作られ、管理の窓口は上げた時点で公開の URL を DB に入れていた（`2026-04-18-look-detail-review.md`）。公開前の LOOK の画像が外から開けた
- LOOK の頁は誰でも見られるので、閉じた置き場の画像を見せるには、サーバーが代わりに許可を出す仕組みが要る

#### 決定

- 置き場 `look-images` を非公開にした（`migrations/030_make_look_images_bucket_private.sql`）
- 管理の作成・更新は、画像を上げた後に置き場の中の道筋だけを `image_urls` に入れる（`src/app/api/admin/looks/route.ts`）
- 出す時は、道筋を取り出し（以前の公開の URL の形も読めるようにする。`look-images.ts`）、service role の鍵で期限 3600 秒の署名つき URL を作る（`look-images.ts`）。公開の取り出しでは DB は匿名の鍵で読み、署名だけを service role で行う（`server.ts`。ADR-0151）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 置き場を公開のままにする | 公開前の LOOK の画像を URL から開ける（Must Fix の指摘） |
| 非公開の置き場で預かり、公開の時に公開の置き場へ移す | レビューが示した別の案（`2026-04-18-look-detail-review.md`）。公開・非公開を切り替えるたびにファイルを動かす手間が要る（推定。退けた記録は無い） |

#### 結果

- 良くなること: 非公開の LOOK の画像を、公開の URL から開けない。漏れた URL も1時間で使えなくなる
- 悪くなること: 頁を出すたびに画像ごとに署名を作る（件数の上限が無い一覧では全部の画像。ADR-0152）。署名に失敗した時は元の値を返していた（`look-images.ts`）ので、SEC-LOOK-008（決まった代わりを返す）と合わなかった（2026-10-28 に `null` を返す形に直した。ADR-0316）。詳細の `og:image` にも1時間で切れる URL が入る（`src/app/look/[id]/page.tsx`）
- 満たさない要件: SEC-LOOK-005 と SEC-LOOK-006 は今のコードが満たさない（満たさない所は各 SEC の本文）ので、上位にしない
- 見直す条件: 共有の画像（`og:image`）を長く使いたくなった時、署名の数が頁の速さに響くほど LOOK が増えた時

## 未確認事項

- 期限を1時間にしたことと、公開の置き場へ移す案を選ばなかったことを、ユーザーが決めた記録
- 本番の置き場が非公開になっているか（移行は当てた記録があるが、本番の設定は見ていない）
