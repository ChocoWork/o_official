# ADR-0106 items は列単位の SELECT（原価の2列を除く）で、anon・authenticated の書き込みは付け直さない

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `supabase/migrations/20261026130200_sec_grants_hardening.sql`（`public.items` の権限）、`src/lib/items/public.ts`、`src/app/api/items/[id]/route.ts` | 基準コミット: `10b211a8`

## 概要

`public.items` は、anon・authenticated から全部の権限を外し、原価の2列（`pattern_cost`・`mass_production_cost`）を除く21列に SELECT だけを列の単位で付け直す。`product_note` はお客さん向けの注意書きなので公開のままにする。authenticated の INSERT・UPDATE・DELETE は付け直さない（管理の書き込みは全部、認可の後に service role で行う窓口が受け持つ）。service_role の権限は明示の GRANT で保つ。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME |
| 対応する ID | SEC-HOME-003（AC-02）、SEC-HOME-004、SEC-HOME-005 |
| 対象のコード | 移行 `sec_grants_hardening`（`supabase/migrations/`）。公開側の読みは `src/lib/items/public.ts`（`ITEM_SELECT_COLUMNS`）、`src/app/api/items/[id]/route.ts`、`src/features/cart/services/cart-view.ts`、`src/features/checkout/services/checkout-cart.service.ts` |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（Q7、ユーザー承認 2026-10-26）、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の P1・P3 と Task 4、`supabase/migrations/20260927100900_hide_internal_order_columns.sql`（注文の表で列を絞った前例） |
| 要件の文書 | `docs/02_Requirements/areas/home.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（移行の形は単体の読みで確かめた。権限の効き方の DB 結合試験と E2E は書いただけで、controller が流す） |

## 判断

### ADR-0106 items は列単位の SELECT（原価の2列を除く）で、anon・authenticated の書き込みは付け直さない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-004、SEC-HOME-005 |
| 根拠 | `items` は anon・authenticated に8権限が全部付いたままで、RLS が行しか絞らないため、anon の鍵（ブラウザに出る）で `select=pattern_cost,mass_production_cost` を送ると公開済みの商品の原価が読めた（SEC-HOME-004）。RLS の1つの書き違いで anon が商品を書き換えられる状態でもあった（SEC-HOME-005）。列は権限でしか絞れないので、表の権限を全部外してから、公開の画面が使う列だけに SELECT を付ける。書き込みは `src/app/api/admin/items/` の窓口が service role で行い、authenticated の書き込みの権限を使う道は `src` に無い |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md` の Q7（2026-10-26）、[Supabase Column Level Security](https://supabase.com/docs/guides/database/postgres/column-level-security)、[PostgreSQL GRANT](https://www.postgresql.org/docs/current/sql-grant.html) |

#### 背景

比べた物は次のとおり。

| 観点 | 今の私たち（直す前） | Shopify | Supabase の公式の手引き | 結論 |
| --- | --- | --- | --- | --- |
| 原価の置き場と見せ方 | 公開の表の列。anon の鍵で読める | 原価（`InventoryItem.unitCost`）は Admin API の側にあり、買い物客向けの Storefront API の型には出さない（[InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)） | 列の単位の権限で、見せない列を外す。`*` の選び方は制限された役では使えない | 原価の2列を列の権限で外す |
| 権限の付け方 | 全部を付けて RLS で絞る | 読み書きの範囲を権限の枠（access scope）で分ける | 各役に最小の権限だけを付ける（Grant the minimum privileges each role needs） | 全部外してから、要る物だけを付ける |
| 新しい列 | 自動で見える | 新しい項目は権限の枠で決まる | 付け直さない限り見えないのが安全側 | 新しい列は自動では見えない |

#### 決定

- `REVOKE ALL ON TABLE public.items FROM PUBLIC, anon, authenticated` の後で、`GRANT SELECT (id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at, material, origin, sewing_region, care, season, product_note, made_to_order_lead_days, return_ineligible) ON TABLE public.items TO anon, authenticated`
- `product_note` は公開の列にする。ユーザーが2026-10-26に決めた（Q7）。商品の詳細が `/api/items/[id]` と `ITEM_SELECT_COLUMNS` で読み、お客さんに見せる注意書きだから。以前の要件（SEC-HOME-004）の「`product_note` も読めない」は誤りだったので文を直した
- authenticated の INSERT・UPDATE・DELETE（表・列の単位とも）は付け直さない。管理の書き込みは `src/app/api/admin/items/` の窓口が `createServiceRoleClient()` で行う（認可・aal2・session の生存・回数の制限・CSRF は窓口が先に確かめる）
- `GRANT ALL ON TABLE public.items TO service_role` を明示する（他の移行が REVOKE しても落ちないように）
- 移行の末尾の自己検査が、`items` の全列が「公開の21列」か「原価の2列」のどちらかに入ること（後から足した列の取りこぼしで移行ごと落とす）、anon・authenticated が原価の列を読めないこと、表の単位の SELECT と書き込み系7権限が偽であることを確かめる
- RLS の方針（公開済みの行だけ、管理の方針）は消さない。権限の1段目と RLS の2段目の二重の守り

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 原価を別の表（管理だけが読む）に移す | 画面・集計・移行の変更が大きい。列の権限だけで同じ守りが取れる |
| `product_note` も外す（当初の要件） | お客さんに見せる注意書きなので、外すと商品の詳細が壊れる。ユーザーが公開と決めた |
| 公開用のビューを作り、`items` は閉じる | ビューは SECURITY INVOKER にしないと RLS を飛ばす。列の権限のほうが小さく、PostgREST の埋め込み（`items(...)`）も変わらない |
| authenticated の書き込みの権限を残し RLS の管理の方針だけで守る | 管理の書き込みは窓口が service role で行うので使い道が無く、RLS の方針の書き違いが書き換えに直結する |

#### 結果

- 良くなること: anon の鍵・一般会員の JWT で原価の列を select すると権限の誤り（42501）になる。`select *` も同じ（列を並べて選ぶ）。RLS の方針を書き違えても anon が `items` を書き換えられない
- 悪くなること: 公開側の client で `select('*')` や原価の列を選ぶコードを足すと 42501 になる（現状の `src` に無いことを確かめた）。`items` に列を足す移行は、公開の列なら GRANT を足す必要がある（足さないと読めない。自己検査が忘れを検出する）
- 見直す条件: 原価を扱う画面を一般会員向けに広げる時。`items` を ITEM の領域として範囲に入れ、持ち主の SEC に移す時

## 未確認事項

- 本番の `items` の権限が `remote_schema.sql` と同じ「8権限を4役」のままか（適用の前に `has_table_privilege('anon','public.items','select')`・`has_column_privilege('anon','public.items','pattern_cost','select')` で読む）
- 権限の効き方の DB 結合試験（`tests/integration/db/home/home_items_grants.integration.test.ts`）と E2E（`FR-HOME-024`）は、この作業では流していない
