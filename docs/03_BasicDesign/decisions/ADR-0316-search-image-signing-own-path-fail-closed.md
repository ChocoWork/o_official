# ADR-0316 画像の署名は、自分のホストと置き場の接頭辞を確かめ、失敗は元の値でなく null にする（ITEM は3600秒）

> 状態: 推定 | 確認日: 2026-10-28 | 対象: `src/lib/storage/safe-object-path.ts`、`src/lib/storage/item-images.ts`、`src/lib/storage/look-images.ts`、`src/lib/storage/news-images.ts`、`src/features/search/services/search.service.ts` | 基準コミット: `90786822`（作業ツリー）

## 概要

画像の署名つき URL を作る共有の部品が、署名の前に、値が「自分のプロジェクトの置き場の決まった接頭辞の下の安全な道筋」かを確かめる。確かめに通らない値と、署名に失敗した値は、元の値を返さず `null` にする。ITEM の署名の既定の期限を7日から3600秒にし、署名の使い回しは残りが期限の半分以上ある間だけにする。この項目は ITEM の側（`item-images.ts`、Task 3）、LOOK の側（`look-images.ts`、Task 4）、NEWS の側（`news-images.ts`、Task 5）の決定で、3つとも同じ共有の関数を使う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | 波 3 の Task 3（ITEM の署名）、Task 4（LOOK の署名）、Task 5（NEWS の署名）。共有の関数 `parseOwnObjectPath`（Task 1）を ITEM・LOOK・NEWS が使い始める |
| 対応する ID | SEC-SEARCH-014、SEC-SEARCH-015、SEC-SEARCH-016、SEC-HOME-006、SEC-HOME-007、SEC-LOOK-007、SEC-LOOK-008、SEC-NEWS-007、SEC-NEWS-008 |
| 対象のコード | `src/lib/storage/item-images.ts`（`signItemImageUrl`・`signItemImageUrls`・`signItemImageFields`）、`src/lib/storage/look-images.ts`（`signLookImageUrl`・`signLookImageUrls`）、`src/lib/look/server.ts`（`mapLookRowToListItem`）、`src/features/look/services/admin-images.ts`（`isOwnLookImagePath`）、`src/lib/storage/news-images.ts`（`signNewsImageUrl`・`signNewsImageFields`）、`src/features/news/services/admin-images.ts`（`isOwnNewsImagePath`）、`src/features/search/services/search.service.ts`（`SEARCH_IMAGE_URL_TTL_SECONDS`） |
| 関連文書 | `docs/02_Requirements/areas/{search,home}.md`、`docs/05_Quality/security/threats/{search,home}.md`、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 3、P5〜P9、Review Focus 1〜3）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md` |
| 調べた時点 | 2026-10-28（コードと、本番の `SELECT` の結果は計画の P6。DB 結合試験と E2E は書いただけで流していない） |

## 判断

### ADR-0316 画像の署名は、自分のホストと置き場の接頭辞を確かめ、失敗は元の値でなく null にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-014、SEC-SEARCH-015、SEC-SEARCH-016 |
| 根拠 | 署名は service role で行うので置き場の方針が効かず、表の値に外の URL や `..` が入ると別の物を署名してしまう。署名つき URL は取り消せないので期限は短いほうがよい。失敗の時に元の値を返すと、外の URL や置き場の道筋が閲覧者へ渡る（開く側へ倒れる） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R8）、`wave3-decisions.md` |

#### 背景

- ITEM の署名は、道筋の取り出し（`extractItemImageObjectPath`）が host も文字も確かめず、先頭の `/` を全部外して通していた。取り出せない値と署名の失敗は元の値を返し、記録もしなかった
- 既定の期限は7日。LOOK・NEWS は1時間。署名した URL はサーバーの記憶に期限の1分前まで残して使い回した
- 本番の画像の値は全部、安全な文字の式に合う（`items.image_url` 9行は自分の host の `/object/public/item-images/items/…`、`image_urls` の要素も同じ形。外の host 0、接頭辞の外 0）。商品の登録は今も `getPublicUrl` で `/object/public/` の URL を書く。だから `/object/public/` の自分の URL は道筋に直して通す
- 決済は Stripe に画像の URL を送らない（`product_data` は名前だけ）。確認画面は表示のたびに署名し直す。メールは画像を使わない。1時間で困る呼び出しは無い

#### 決定

- 署名の前に共有の `parseOwnObjectPath(raw, { bucket: 'item-images', prefix: 'items' })`（DD-SEARCH-011）を通す。許す host は `NEXT_PUBLIC_SUPABASE_URL`（無ければ `SUPABASE_URL`）の origin 1 つ。道筋は `items/` の下の安全な文字だけ
- `signItemImageUrl` は、入力が空・道筋にできない・署名に失敗の**どれでも** `null` を返す（元の値を返さない）。失敗は種類（`invalid_path` / `sign_failed`）だけを `console.warn` に残し、道筋・URL・Supabase の誤りの文は書かない
- `signItemImageUrls` は入力と同じ長さ・同じ位置の `Array<string | null>` を返す。無効な要素を詰めると、`image_url` が無効の時に `image_urls` の先頭が `image_url` に繰り上がるため。`signItemImageFields` は `image_url` を先頭の要素（無効なら `null`）、`image_urls` を残りから `null` を除いたものにする
- 既定の期限は3600秒。検索は `SEARCH_IMAGE_URL_TTL_SECONDS = 3600` を明示して渡し、共有の既定の変更に引きずられない
- 署名の使い回しは、残りが期限の半分以上ある間だけ（3600秒なら1800秒）。以前は期限の1分前まで使い回したので、使い回しの最後の頃に作られた頁は、残り約60秒の URL を載せて、遅延読み込みの画像が数十秒で切れた。キーは `道筋:期限` のまま（期限の違う呼び手の URL を取り違えない）
- `extractItemImageObjectPath` は残す（`tests/unit/scripts/e2e/seed-storage.test.ts` が使う）

#### LOOK への適用（Task 4、2026-10-28）

- `signLookImageUrl` も署名の前に `parseOwnObjectPath(raw, { bucket: 'look-images', prefix: 'looks' })` を通し、道筋にできない値と署名の失敗で `null` を返す。失敗は種類（`invalid_path` / `sign_failed`）だけを `console.warn` に残す。期限の既定は元から3600秒で、検索は `SEARCH_IMAGE_URL_TTL_SECONDS` を明示して渡す
- `signLookImageUrls` は結果から `null` を外す（位置を保つ必要は無い。LOOK の画像は並びだけが意味を持つ）。署名の使い回しは LOOK には元から無い
- `look/server.ts` の `mapLookRowToListItem` は生の `image_urls` を載せず `imageUrls: []` にし、呼び手が署名した値で埋める。署名で全部外れた LOOK は画像の無い表示になる
- 管理の後始末（`listRemovableLookImagePaths`）が使う `extractLookImageObjectPath` は残し、`isOwnLookImagePath` は共有の `isSafeObjectPath(path, 'looks')` に委譲する（式は同じで、動きは変わらない）
- 署名が例外を投げた時は従来どおり投げ上げる（管理の GET が 500 を返す既存の契約を変えない）。ITEM は例外も `null` にするが、LOOK では契約を変えない

#### NEWS への適用（Task 5、2026-10-28）

- `signNewsImageUrl` も署名の前に `parseOwnObjectPath(raw, { bucket: 'news-images', prefix: 'news' })` を通し、道筋にできない値と署名の失敗で `null` を返す。失敗は種類（`invalid_path` / `sign_failed`）だけを `console.warn` に残す。期限の既定は元から3600秒で、検索は `SEARCH_IMAGE_URL_TTL_SECONDS` を明示して渡す
- `signNewsImageFields` は `image_url` を署名の結果（署名つき URL か `null`）に置き換える。管理の一覧・1件の GET の応答は、外の URL や署名の失敗の記事で `image_url: null` になる（管理の画面は `/placeholder.png` で描く。波 3 の Task 2）。公開の一覧・詳細は画像を出さない（SEC-NEWS-005）ので影響しない
- 本番の `news_articles.image_url` 8行は、自分の host の `/object/public/news-images/news/…` が6行、素の道筋 `news/…` が2行で、全部この式に合う
- 管理の後始末（`removeNewsImages`）が使う `extractNewsImageObjectPath` は残し、`isOwnNewsImagePath` は共有の `isSafeObjectPath(path, 'news')` に委譲する（式は同じで、動きは変わらない）
- 以前の `extractNewsImageObjectPath` は復号した後の道筋に空白や日本語を許した。署名の側は安全な文字に絞るので、そういう道筋の古い行は `null`（画像なし）になる。本番の行に該当は無い
- 署名が例外を投げた時は従来どおり投げ上げる（管理の窓口が 500 を返す既存の契約を変えない）

#### 業界の定番との突き合わせ

| 論点 | 定番 | この決定 |
| --- | --- | --- |
| 署名つき URL の期限 | 取り消せない URL は短い期限にする。Supabase の `createSignedUrl` の `expiresIn` は呼び手が決める。OWASP ASVS V4.1.5（アクセス制御は失敗した時に安全な側へ倒れる） | 3600秒。失敗は `null` で閉じる側へ倒す |
| 入力の許可リスト | 信頼する host と道筋の形を許可リストで確かめ、外は断る（OWASP「Server Side Request Forgery」・「Unvalidated Redirects」の許可リストの勧め） | origin 1 つ・接頭辞・安全な文字の式 |
| Shopify の商品画像 | 画像は CDN の公開 URL で配り、期限つきの署名は使わない（業界の定番は公開 CDN）。この店は非公開のバケットから署名つき URL を配る作りなので、期限は店の側で決める | 公開 CDN には寄せず、非公開のまま短い期限にする |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 失敗の時に元の値を返す（現状） | 外の URL や置き場の道筋が閲覧者へ渡り、失敗や改ざんに気づけない |
| DB の CHECK だけで守る | CHECK は波 2 で `NOT VALID` で入れた。管理の書き込みは守るが、既に入った行と読みの署名の穴は塞がない。読みの側でも確かめる |
| 許す origin を `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` の両方にする | 署名つき URL の host と、CSP の `img-src`・`next/image` の `remotePatterns`（1 host だけ）がずれると、署名が通っても画像が止まる。信頼する origin は1つにし、2つの変数が別の origin を指す設定はビルドで落とす（`next.config.ts` の `assertBuildEnv`。`ADR-0206`） |
| 署名の使い回しを期限の1分前までのままにする | 期限を3600秒にすると、使い回しの最後の頃の頁は残り約60秒になり、遅延読み込みの画像が切れる |
| 署名を使い回さない | 署名の呼び出しが要求のたびに増える。半分で更新すれば、同じ道筋・同じ期限の1つの実行環境あたり30分に1回で足りる |

#### 結果

- 良くなること: 外の URL・`..`・置き場の別の場所を指す値は署名されず、画像の値は `null` になる。署名つき URL の期限が短くなる。署名の失敗が元の値で隠れない
- 悪くなること: 開いたまま1時間を超えた頁の遅延画像は切れる（再読み込みで直る。受け入れる）。署名の呼び出しは最大2倍まで増えうる。`null` を受けられない受け手は先に直した（波 3 の Task 2）。本番の商品画像の値は全部式に合うので、画像が消えることはない（`order_items.item_image_url` は本番で0行）
- 商品詳細の `og:image`（`src/app/item/[id]/page.tsx`）は生の `image_url` を使い、非公開のバケットでは400になる壊れた URL のまま。この項目では直さない

## 未確認事項

- 本番の配備前に、`NEXT_PUBLIC_SUPABASE_URL` が本番のプロジェクトの URL であること（`SUPABASE_URL` と同じ origin。`assertBuildEnv` がビルドで確かめる。`ADR-0206`）
- 開いたまま1時間を超えた頁で、遅延画像が切れることの見え方（ユーザーが許容するか）
- NEWS の画像を空白や日本語の名前で上げた古い行が手元・本番に無いこと（本番の8行は確かめ済み。手元は見本の `news/e2e/…`）
