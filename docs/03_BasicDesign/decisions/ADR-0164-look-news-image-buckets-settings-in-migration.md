# ADR-0164 置き場 `look-images`・`news-images` の設定は移行が持つ

> 状態: 推定 | 確認日: 2026-10-26 | 対象: 置き場 `look-images`・`news-images` の設定（`supabase/migrations/20261026130600_sec_storage_buckets.sql`） | 基準コミット: `2d65f0fd`（作業ツリー）

## 概要

画像の置き場 `look-images`・`news-images` の設定（非公開・1 つ 5MiB まで・JPEG/PNG/WebP/GIF の 4 種類）を、手元の見本 `supabase/seed.sql` でなく移行 `sec_storage_buckets` に持たせる。本番には置き場が既にあるので、`INSERT … ON CONFLICT (id) DO UPDATE` で 3 つの設定だけを合わせる。`storage.objects` に置き場を名指しする方針は作らない。`item-images` は R17 の対象外で触らない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK・NEWS が共有する 1 本の移行 `sec_storage_buckets`（波 2 の Task 8） |
| 対応する ID | SEC-LOOK-005、SEC-NEWS-003、THR-LOOK-005、THR-NEWS-003、DATA-LOOK-005、DATA-NEWS-004 |
| 対象のコード | 移行 `20261026130600_sec_storage_buckets.sql`。窓口の同じ値は `allowedImageTypes`・`maxImageBytes`（`src/app/api/admin/looks/route.ts`、`src/app/api/admin/news/route.ts`） |
| 関連文書 | `docs/02_Requirements/areas/{look,news}.md`、`docs/05_Quality/security/threats/{look,news}.md`、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md`（Task 8、P10）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（R17） |
| 調べた時点 | 2026-10-26（移行を読み、DB なしの形の試験を流した。DB 結合試験と E2E は書いただけで流していない。本番の置き場は読んでいない） |

## 判断

### ADR-0164 置き場 `look-images`・`news-images` の設定は移行が持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-005、SEC-NEWS-003 |
| 根拠 | 置き場の設定が手元の見本だけにあると、移行だけで作った DB には置き場が無く、本番と手元の設定が食い違っても気づけない（THR-LOOK-005、THR-NEWS-003）。非公開・大きさ・種類の 3 つを移行に置けば、どの環境でも同じ設定になり、後から変わったら自己検査が落ちる。窓口は既に 4 種類・5MiB だけを受けるので、置き場の側にも同じ上限を置いて直接の上げ物（service role の誤用など）も断つ |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R17）、`wave2-decisions.md`（ユーザーが「波 2 に進んで」と承認した 2026-10-26） |

#### 背景

- 見本 `supabase/seed.sql` は置き場を `(id, name, public)` だけで入れ（`ON CONFLICT DO NOTHING`）、上限を付けない。非公開化と上限は、今の CI が当てない旧い移行（`018`・`030`・`013`）にしか無かった
- 本番には置き場が既にあり、設定の今の値は移行の外にある（まだ読んでいない）
- G-2 の前例（`20261024153505_group_g2_purchasing_foundation.sql` の `purchase-order-documents`）は新しい置き場なので `DO NOTHING` で入れ、末尾で他の設定の既存を検出する。ここは本番に既にあるので合わせる必要がある

#### 決定

- `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)` で 2 行を入れ、`ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 5242880, allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif']`。`name` は変えない
- `storage.objects` に置き場を名指しする方針は作らない。anon・authenticated には何も付けず、service role と署名つき URL だけで扱う。末尾の自己検査（`DO` 文）が、2 行とも「非公開・5242880・4 種類ちょうど」であることと、`pg_policies` の `qual`・`with_check` に置き場の名前を含む方針が 0 件であることを確かめ、外れたら `SEC_WAVE2_MIGRATION_ASSERTION_FAILED`（`55000`）で移行ごと戻す。本番に名指しの方針があれば、ここで止まる（意図した止まり方）
- 既にある物は触らない: 5MiB を超える既存のファイルや 4 種類以外の既存のファイルは残り、新しい上げ物だけが断られる。置き場の設定の変更は既存の行を検査しない
- 見本 `supabase/seed.sql` の置き場の行（`DO NOTHING`）は変えない。移行の後に見本が入っても、移行の設定を壊さない
- `item-images` は R17 の対象外なので触らない
- ヘッダーに対のロールバック（本番の 2 行の値を適用の前に控えて戻す。見本と同じ状態へ戻すなら `file_size_limit`・`allowed_mime_types` を NULL）と、本番の事前の確認の SQL（読むだけ）を残す。`public` を真へ戻すロールバックは書かない

#### 業界の定番との突き合わせ

| 論点 | 定番 | この決定 |
| --- | --- | --- |
| 置き場の制限 | 置き場ごとに許す種類と大きさを持ち、外れた上げ物は断る。全体の上限より小さくする（Supabase 公式「Creating Buckets」の Restricting uploads、「Limits」の Per bucket restrictions） | 置き場ごとに 5MiB・画像 4 種類（全体は 50MiB） |
| 非公開の置き場 | 非公開の置き場は RLS か署名つき URL でだけ読める（Supabase 公式「Storage Buckets」の Private buckets） | 非公開のまま、署名つき URL だけで配る。方針は作らない |
| 設定を移行に置く | 環境の設定は移行で版管理し、手元・本番を同じにする（Supabase 公式のローカル開発の流れ。出典の節は未確認） | 移行に置き、`DO UPDATE` で本番に合わせる |
| Shopify | 店側が置き場を持てない SaaS で、画像の種類・大きさは Shopify の API が決める。比べられる形が無い（出典は未確認） | 比較の対象にしない |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `ON CONFLICT DO NOTHING`（G-2 と同じ） | 本番に置き場が既にあるので、設定が変わらない。移行を当てても上限が付かない |
| 見本 `seed.sql` に上限を足す | 見本は手元だけで、本番に届かない。見本は共有で編集しない決まり |
| `storage.objects` に読み書きの方針を足す | 置き場の扱いは service role と署名つき URL だけ。方針を作ると、緩め方を誤る場所が増える |
| 既存の 5MiB 超のファイルを移行で消す | 本番の物を移行の中で消さない。置き場の掃除は Storage API で別の判断 |
| 3 つの置き場（`item-images` を含める） | R17 の範囲外。商品の画像の上限は別の判断 |

#### 結果

- 良くなること: 移行だけを当てた DB にも置き場ができ、非公開・上限・種類が環境によらず同じになる。直接の上げ物も置き場の側で断られる
- 悪くなること: 本番に名指しの方針や別の設定があると移行が止まる（先に読む）。上限を変えるには移行が要る。適用までの間、本番の設定は変わらない
- 見直す条件: 商品の画像の上限を揃える時（`item-images`）、窓口の上限・種類を変える時（置き場と窓口の 2 か所をそろえる）

## 未確認事項

- 本番の `storage.buckets`（`look-images`・`news-images`）の今の値と、`storage.objects` の方針、5MiB を超える既存のファイルの数。適用の前に読んで確かめる（`wave2-task-8-report.md` の SQL。読むだけ）
- ローカルの Storage の API が、`allowed_mime_types` に外れる上げ物と 5MiB 超を断る挙動の実測（DB 結合試験と E2E は流していない）
