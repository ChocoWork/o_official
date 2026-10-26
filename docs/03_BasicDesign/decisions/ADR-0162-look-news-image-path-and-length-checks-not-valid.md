# ADR-0162 画像の道筋と長さの CHECK は関数を作らず式を直に書き、`NOT VALID` で入れる

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `looks`・`news_articles` の CHECK（`supabase/migrations/20261026130500_sec_rls_predicates_and_constraints.sql`） | 基準コミット: `10b211a8`（作業ツリー）

## 概要

`looks` と `news_articles` に、長さの上限と画像の道筋の形を DB の CHECK として足す（計 7 本）。画像の道筋の式は補助関数を作らずに CHECK の中へ直に書く。制約は `NOT VALID` で入れ、既存の行を検査も書き換えもしない。本番の旧い行を点検して直した後の `VALIDATE` は、この波では書かない別の移行にする。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK・NEWS が共有する 1 本の移行 `sec_rls_predicates_and_constraints`（波 2 の Task 7） |
| 対応する ID | SEC-LOOK-023、SEC-NEWS-025、THR-LOOK-023、THR-NEWS-025、DATA-LOOK-001、DATA-NEWS-001 |
| 対象のコード | 移行 `20261026130500_sec_rls_predicates_and_constraints.sql`、窓口の同じ式 `isOwnLookImagePath`（`src/features/look/services/admin-images.ts`）・`isOwnNewsImagePath`（`src/features/news/services/admin-images.ts`） |
| 関連文書 | `docs/02_Requirements/areas/{look,news}.md`、`docs/05_Quality/security/threats/{look,news}.md`、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md`（Task 7、P7・P8）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（R5-4） |
| 調べた時点 | 2026-10-26（移行を読み、DB なしの形の試験を流した。DB 結合試験と E2E は書いただけで流していない） |

## 判断

### ADR-0162 画像の道筋と長さの CHECK は関数を作らず式を直に書き、`NOT VALID` で入れる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-023、SEC-NEWS-025 |
| 根拠 | 窓口を通らない PostgREST の直接の書き込みでも、上限の無い長さの文字や置き場の外を指す画像の道筋を表に入れさせないため（THR-LOOK-023、THR-NEWS-025）。CHECK は書く役（service_role と、将来 authenticated に書き込みを戻した時の authenticated）が評価するので、補助関数を作るとその役への EXECUTE の付与が要り、関数の ACL を数える自己検査が増える。式を直に書けば付与が要らない。本番の既存行をこの移行で書き換えられないので `NOT VALID` にする |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R5-4）、`wave2-decisions.md`（ユーザーが「波 2 に進んで」と承認した 2026-10-26） |

#### 背景

- 長さ（`theme` 200 字・`theme_description` 4000 字・`title` 200 字・`content` 2000 字・`detailed_content` 10000 字）と `image_urls`・`image_url` の形は、窓口の zod と保存名の組み立てにしか無かった。表は NOT NULL と分類・状態の CHECK だけだった（`remote_schema.sql` の `looks`・`news_articles`）
- 窓口の道筋の確かめ `isOwnLookImagePath`・`isOwnNewsImagePath` は `^looks\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$`（news は `news/`）で、`..`・先頭の `/`・`//`・`.` で始まる階層・URL を断る
- 見本の行は波 2 の Task 1 で `looks/e2e/…`・`news/e2e/…` に直した。E2E が意図して作る「外の値の行」は、補助 `e2e/legacy-image-rows.ts` が制約を外した取引で入れる

#### 決定

- 長さ: `looks_theme_length_check`（`char_length(theme) BETWEEN 1 AND 200`）、`looks_theme_description_length_check`（`char_length(theme_description) <= 4000`）、`news_articles_title_length_check`（200）、`news_articles_content_length_check`（2000）、`news_articles_detailed_content_length_check`（10000）。`char_length` はコードポイントの数で、窓口の zod（UTF-16 の長さ）より緩いか同じ
- `news_articles_image_url_path_check`: `image_url ~ '^news/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'`
- `looks_image_urls_path_check`（配列）: 3 つの条件の AND。(1) `array_position(image_urls, NULL) IS NULL`（NULL の要素を断る）、(2) `cardinality(string_to_array(array_to_string(image_urls, E'\n'), E'\n')) = cardinality(image_urls)`（改行を含む要素・空の文字の要素を断る）、(3) `array_to_string(image_urls, E'\n') ~ '^(P(\nP)*)?$'`（P は 1 つの道筋。空の配列は通る）。(2) が無いと、1 つの要素に 2 つの有効な道筋を改行で並べた値が (3) を通る
- 補助関数（設計書の `private.look_image_paths_ok` 案）は作らない
- 制約は `NOT VALID` で足す（`pg_constraint` に同名が無い時だけ。冪等）。`NOT VALID` でも新しい INSERT と既存の行の UPDATE は検査されるので、関係の無い列だけの更新も、旧い道筋の行では 23514 で落ちる。本番の既存行は読むだけで、この移行は書き換えない
- `VALIDATE CONSTRAINT` は書かない。本番の行を点検（`image_urls` の先頭の階層・長いテーマ・旧い公開 URL）し、必要な行を直してから別の移行で行う
- 移行のヘッダーに対のロールバック（7 本の `DROP CONSTRAINT IF EXISTS`）を残し、末尾の自己検査（`DO` 文）が 7 本とも存在して `convalidated` が偽であることを確かめる

#### 業界の定番との突き合わせ

| 論点 | 定番 | この決定 |
| --- | --- | --- |
| 後から制約を足す | 大きな表には `NOT VALID` で足し、既存の行の検査（`VALIDATE`）は別の段にする。`NOT VALID` の制約は新しい挿入・更新には効く（PostgreSQL の `ALTER TABLE` の `ADD table_constraint [ NOT VALID ]`） | `NOT VALID` で足し、`VALIDATE` は別の移行 |
| 入力の検証を DB にも置く | 窓口の確かめに加えて DB の制約を最後の線にする（OWASP ASVS V5.1、Supabase 公式「Securing your API」の多層防御） | 窓口と同じ式・同じ上限を CHECK にも置く |
| 検証の関数 | CHECK から呼ぶ関数は、書く役が EXECUTE できる必要がある。Supabase は関数の既定の権限を絞る助言（公式「Hardening the Data API」） | 関数を作らず式を直に書く |
| Shopify | 店側が DB の制約を持てない SaaS で、画像の道筋や長さは Shopify の API が決める。比べられる形が無い（出典は未確認） | 比較の対象にしない |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `private.look_image_paths_ok(text[])` のような補助関数を CHECK から呼ぶ | 書く役への EXECUTE の付与と、関数の ACL を数える自己検査が増える。式 1 本で足りる |
| 制約を `VALID` で足す | 本番に旧い道筋・長いテーマの行があると移行が落ちる。本番の行をこの移行で書き換えない決まりとも合わない |
| 本番の旧い行をこの移行の中で正規化する | 本番の行の書き換えは、読んで確かめた後の別の判断。適用の前後の比較（G-1）の対象外にしたい |
| 配列の道筋を `unnest` の部分問い合わせで検査する | CHECK は部分問い合わせを持てない |
| 改行を含む要素の検査を省く | 1 つの要素に有効な道筋を改行で 2 つ並べた値が通ってしまう。件数の比較 1 本で断てる |
| 長さをバイトで数える（`octet_length`） | 日本語の題が 200 字に収まらなくなる。窓口の zod は文字の数 |

#### 結果

- 良くなること: 直接の書き込みでも、長すぎる文字と置き場の外の道筋が表で止まる。窓口・DB・見本が同じ式になる
- 悪くなること: `NOT VALID` の間は、旧い道筋の行の更新が（無関係の列でも）落ちる。E2E が旧い行を作るには補助 `insertLegacyImageRow`（一時的に制約を外す）が要る。`VALIDATE` までの間、本番の旧い行は残る
- 見直す条件: 本番の点検で旧い行が 0 になった時（`VALIDATE` の移行を書く）、窓口の道筋の形を変える時（式を 2 か所そろえる）

## 未確認事項

- 本番の `looks.image_urls`・`news_articles.image_url` の中身（先頭の階層の一覧、旧い公開 URL の行の数）と、長いテーマ・題・概要・本文の行の有無。適用の前に読んで確かめる（`wave2-task-7-report.md` の SQL）
- `VALIDATE` を当てる時期
