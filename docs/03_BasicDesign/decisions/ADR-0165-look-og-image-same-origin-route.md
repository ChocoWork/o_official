# ADR-0165 LOOK の og:image は、署名を含まない同一オリジンの窓口 /look/[id]/og が返す

> 状態: 推定 | 確認日: 2026-10-28 | 対象: `src/app/look/[id]/og/route.ts`、`src/app/look/[id]/page.tsx`（`generateMetadata`）、`src/lib/look/server.ts`（`getPublishedLookCoverRaw`） | 基準コミット: `90786822`（作業ツリー）

## 概要

LOOK の詳細の頁の `og:image` に、1 時間で切れる署名つき URL を入れるのをやめ、署名を含まない同一オリジンの窓口 `GET /look/[id]/og` の URL を入れる。窓口は公開の LOOK の先頭の画像を、検証した道筋のバイトで返す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | SEC-LOOK-006 |
| 対象のコード | `src/app/look/[id]/og/route.ts`（`GET`。IMPL-LOOK-157）、`src/lib/look/server.ts` の `getPublishedLookCoverRaw`（IMPL-LOOK-158）、`src/app/look/[id]/page.tsx` の `generateMetadata`、共有の `parseOwnObjectPath`（`src/lib/storage/safe-object-path.ts`、DD-SEARCH-011）・`detectImageType`（`src/lib/storage/image-signature.ts`） |
| 関連文書 | `docs/02_Requirements/areas/look.md`（SEC-LOOK-006）、`docs/05_Quality/security/threats/look.md`（THR-LOOK-006）、`docs/03_BasicDesign/areas/look.md`（API-LOOK-007）、`docs/03_BasicDesign/decisions/ADR-0150-look-images-private-signed-url.md`、`docs/03_BasicDesign/decisions/ADR-0316-search-image-signing-own-path-fail-closed.md`、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 11、P13・P14）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q10） |
| 調べた時点 | 2026-10-28（単体試験と、`generateMetadata` の試験は流した。E2E は書いただけで流していない） |

## 判断

### ADR-0165 LOOK の og:image は、署名を含まない同一オリジンの窓口 /look/[id]/og が返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-006 |
| 根拠 | 署名つき URL は取り消せず、期限（1 時間）で切れる。`og:image` に入れると、共有された後に画像が切れ、SNS のクローラーに期限つきの URL が残り、非公開にした後もその期限まで画像が開く。署名を含まない URL にし、公開の LOOK だけを短い共有キャッシュで返せば、期限の切れる URL が外へ残らない |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q10。推奨で進めた）、`design-final.md`（R9） |

#### 背景

- 詳細の頁の `generateMetadata` は `getPublishedLookById`（全画像を署名）の先頭の署名つき URL を `openGraph.images` に入れていた（ADR-0150。署名の期限は 1 時間）
- 置き場 `look-images` は非公開なので、署名の無い URL では画像を配れない

#### 決定

- `GET /look/[id]/og` を足す。`id` は `parseLookId` で確かめ、合わなければ LOOK を取りに行かず 404
- 公開の LOOK だけを匿名の client で読み（RLS と `status='published'` の両方）、`image_urls` のうち `parseOwnObjectPath(raw, { bucket: 'look-images', prefix: 'looks' })` に通る最初の 1 枚を取る（`getPublishedLookCoverRaw`。署名しない）。窓口はもう一度同じ関数を通し、service role の `download` でバイトを読む
- 種類は置き場の申告でなく、バイトの先頭の印（`detectImageType`）で決める。画像でなければ 404
- 成功の応答の見出しは `Content-Type`（検出した種類）、`Cache-Control: public, max-age=300, s-maxage=300`、`X-Content-Type-Options: nosniff`。`Set-Cookie` は付けない（`src/proxy.ts` の `session_id` の発行は `/cart`・`/checkout`・`/api/checkout` だけで、この窓口の道では発行しない。ADR-0355。公開で共有キャッシュに載る応答に識別子を混ぜないため）
- 非公開・無い・不正な id・画像なし・道筋が確かめに通らない・置き場の失敗は全部 404（本文は固定の短い文字、`Cache-Control: no-store`）にし、有無と置き場の誤りを外へ出さない。記録は固定の種類（`download_failed`・`not_image`）だけ
- `generateMetadata` は、署名できる画像が 1 枚以上ある LOOK だけ `openGraph.images` を `[{ url: '/look/<id>/og' }]`（相対。`metadataBase` で絶対になる）にし、無い・非公開は空の配列
- 回数の制限は付けない。公開の LOOK の数に限られ、`s-maxage=300` で CDN が受ける。クエリの付け替えで置き場を叩かれる量は、波 4 の `rateLimit.ts` の見直しで扱う

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 署名つき URL をそのまま `og:image` に入れる | 1 時間で切れ、クローラーに期限つきの URL が残る。これが直す対象 |
| `opengraph-image` のファイル規約（`ImageResponse`） | 画像の再エンコードで重く、元の画像をそのまま返す今の要件に合わない |
| 回数の制限を窓口に付ける | 公開で共有キャッシュに載せる応答に、回数の見出しや識別子を混ぜない。量は波 4 で見直す |

#### 結果

- 良くなること: `og:image` に署名・期限が出ない。非公開にすると窓口は 404 になり、共有キャッシュの分（最長 300 秒）で消える
- 悪くなること: 窓口が 1 本増える（`src/app/api` の外の `route.ts`）。画像の取り出しのたびに置き場を読む（CDN が 300 秒受ける）。`image_urls` の先頭が確かめに通らない時は、通る最初の 1 枚を返す
- ITEM の `og:image`（`src/app/item/[id]/page.tsx`）は別件。DB の生の `image_url`（非公開のバケットの `/object/public/…` で 400 になる）を入れている。直すなら同じ形の `/item/[id]/og` の窓口を足す

## 未確認事項

- 本番ビルドの `/look/<id>/og` の `Cache-Control` が、CDN を通ってどう見えるか（E2E `SEC-LOOK-006-AC-03` は手元の見出しだけを見る）
- SNS のクローラーが `og:image` の `Content-Type` と相対 URL の絶対化（`metadataBase`）をどう扱うか
