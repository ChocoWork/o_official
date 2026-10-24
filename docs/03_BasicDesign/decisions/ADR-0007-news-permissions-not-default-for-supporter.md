# ADR-0007 お知らせの閲覧と管理の権限は、サポーターに初期値で付けない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `supabase/migrations/20261023175712_group_g0_permissions.sql`、`src/app/api/admin/news/` | 基準コミット: `a03beaff`

## 概要

2026-10-23 の権限の作り直しの初期値で、お知らせの閲覧（`admin.news.read`）と管理（`admin.news.manage`）は店長だけに付け、サポーターには付けない。要る時は店長が権限の画面で付ける。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-519-REQ-01（範囲外）、FREQ-540-REQ-01（範囲外） |
| 対象のコード | `supabase/migrations/20261023175712_group_g0_permissions.sql` |
| 関連文書 | `docs/superpowers/specs/2026-10-23-group-g-design.md`、`docs/superpowers/plans/2026-10-23-group-g0-permissions.md`、`e2e/FR-ADMIN-109-permission-settings.spec.ts`（範囲外） |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0007 お知らせの閲覧と管理の権限は、サポーターに初期値で付けない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-519-REQ-01（範囲外）、FREQ-540-REQ-01（範囲外） |
| 根拠 | 役割を店長とサポーターの2つのまま増やさず、店長が権限の画面で後から付けられる形にしたので、初期値は狭い側に置き、お知らせの書き換えは店長に残すため（権限の作り直しの初期値の表。初期値を狭くした理由の文は無く、推定） |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-10-23-group-g-design.md`、`docs/superpowers/plans/2026-10-23-group-g0-permissions.md` |

#### 背景

2026-10-23 の権限の作り直しで、役割ごとの操作を店長が「権限」画面で決める形にし（FREQ-519（範囲外））、2つの役割の初期値の表を作った。

#### 決定

- 初期値で店長は `admin.news.read`・`admin.news.manage` を持ち、サポーターは持たない（`group-g-design.md`）
- 店長は権限の画面でサポーターに付けられる（E2E `e2e/FR-ADMIN-109-permission-settings.spec.ts` がサポーターに `admin.news.read` を付ける）

#### 退けた案

記録なし

#### 結果

- 良くなること: 初期の状態ではサポーターがお知らせを書き換えられない
- 悪くなること: サポーターに権限を付けても管理の画面のタブは役で決まるので、NEWS のタブが出ない（推定。ADR-0006）
- 古い文書と食い違う: `docs/04_DetailDesign/pages/16_admin.md` は「ニュース CRUD supporter ✅」、`docs/03_BasicDesign/architecture/hybrid-rbac.md` は admin だけ

## 未確認事項

- 本番の DB の初期値が 権限の作り直しの移行（`20261023175712`）と同じか
