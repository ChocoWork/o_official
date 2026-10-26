# ADR-0107 item_cost_history は表を残し、admin.finance.read の SELECT 方針だけを持つ

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `supabase/migrations/20261026130200_sec_grants_hardening.sql`（`public.item_cost_history` の権限と方針） | 基準コミット: `10b211a8`

## 概要

原価の履歴の表 `item_cost_history` は消さずに残す。全員に全権限を許す方針 `"Allow all"` を消し、anon の権限を全部外し、authenticated には SELECT だけを付けて、RLS の方針 `has_permission('admin.finance.read')` で管理者だけが行を読めるようにする。INSERT・UPDATE・DELETE・TRUNCATE は誰にも付けず、書くのは service role だけにする。この表を読む画面・窓口・関数は今は無い。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME |
| 対応する ID | SEC-HOME-020 |
| 対象のコード | 移行 `sec_grants_hardening`。原価を扱う画面は `src/components/ProductCostSection.tsx`・`CostProfitSection.tsx`（読む窓口は `/api/admin/accounting/product-costs`・`/api/admin/kpi/cost-profit`） |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（Q8、ユーザー承認 2026-10-26）、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の P4 と Task 4、ADR-0106 |
| 要件の文書 | `docs/02_Requirements/areas/home.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（`src`・`scripts` の参照を grep で全部確かめた。DB への効き方は書いただけで流していない） |

## 判断

### ADR-0107 item_cost_history は表を残し、admin.finance.read の SELECT 方針だけを持つ

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-HOME-020 |
| 根拠 | `item_cost_history`（`pattern_cost`・`mass_production_cost`・`pdf_url`）は内部の情報なのに、PUBLIC への無条件の全許可の方針と anon・authenticated への全権限が重なっていた。ユーザーが2026-10-26に「表は残す。管理者だけが見られるようにする」と決めた（Q8）。原価を計算する画面は `/api/admin/accounting/product-costs` と `/api/admin/kpi/cost-profit` を呼び、どちらも `admin.finance.read` または `admin.finance.manage` で認可して service role で `admin_costing_items`・`admin_finance_*` を読む。`item_cost_history` を読む画面・窓口・関数は `src` にも `scripts` にも1つも無く、参照は E2E の補助が pg で行を入れる所だけだった |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md` の Q8（2026-10-26）、[Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | Supabase の公式の手引き | 結論 |
| --- | --- | --- | --- | --- |
| 原価の履歴の見せ方 | 全員が読み・書き・消せた | 原価は Admin API の権限の枠（access scope）を持つ管理側だけが読む | RLS の方針は役を名指しし、必要な操作だけを許す。`USING (true)` の全許可は避ける | 管理者の権限（`admin.finance.read`）の SELECT だけを許す |
| 書き込みの経路 | PostgREST から誰でも | 管理側の API だけ | 管理だけの書き込みは service role の窓口にまとめる | service role だけ |

#### 決定

- `"Allow all"` の方針を消し、`REVOKE ALL ... FROM PUBLIC, anon, authenticated` の後で `GRANT SELECT ... TO authenticated` と `GRANT ALL ... TO service_role` を付ける
- 方針 `"admin item_cost_history read by finance permission"`（`FOR SELECT TO authenticated USING ((SELECT public.has_permission('admin.finance.read'::text)))`）を足す。新しい権限の印は作らない（既存の `admin.finance.read` を使う）。`has_permission` を `SELECT` で包むのは、行ごとの再評価を避けるため（Supabase の RLS の性能の手引きと、他の管理の方針の形に合わせた）
- 一般会員の select は、権限の誤りでなく「200で0件」になる。authenticated に SELECT を付けて方針で絞る形のため（権限の誤りにしたいなら authenticated の SELECT を付けない形になり、管理者が直接読む道が無くなる）。この読みをユーザーに確かめる（Task 4 の報告）
- 将来この表を読む画面を作る時は、`admin.finance.read` の窓口（service role）か、この方針を使う。波 5 で `has_permission` に aal2 が入ると、この方針も自動で締まる

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 表ごと消す | ユーザーが残すと決めた。本番に行があるかも未確認 |
| authenticated にも SELECT を付けず service role だけにする | 一般会員の select を権限の誤りにできるが、管理者の直接の読みの道が無くなり、Q8 の「管理者だけが見られる」と両立しない |
| `admin.items.read` の印にする | 原価は会計の情報で、原価を扱う窓口は `admin.finance.*` で認可している。印を合わせる |

#### 結果

- 良くなること: anon は権限の誤り、一般会員は0件、管理者以外は誰も書けない。`"Allow all"` が無くなる
- 悪くなること: 将来の画面が authenticated の JWT で書こうとすると 42501 になる（service role の窓口で書く）
- 見直す条件: この表を読む画面を作る時。本番に行が無く、使わないと決まった時（表ごと消す判断）

## 未確認事項

- 本番に `item_cost_history` の行があるか（`select count(*) from public.item_cost_history` を適用の前に読む。行があれば、権限を外すまで原価が公開されていた期間の記録として報告する）
- 一般会員の select が「200で0件」になること（権限の誤りでない）をユーザーに確かめる
