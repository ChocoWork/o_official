# ADR-0257 ホームの特集の印と並び順の列を持たず、並びは id の昇順にする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/stockist/services/public.ts`、`src/app/api/admin/stockists/route.ts` | 基準コミット: `4facf63b`

## 概要

取扱店に「ホームに出す」印と並び順の数を持たせず、公開・ホーム・管理の一覧はどれも id の小さい順に並べる。表を作った時に入れた2つの列は、同じコミットの次の移行で消した。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | DRV-STOCKIST-001、FR-STOCKIST-004 |
| 対象のコード | `src/features/stockist/services/public.ts`、`src/app/api/admin/stockists/route.ts` |
| 関連文書 | `migrations/027_create_stockists_and_acl.sql`、`migrations/029_drop_stockist_home_feature_and_display_order.sql`、`supabase/migrations/20260901102912_remote_schema.sql` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0257 ホームの特集の印と並び順の列を持たず、並びは id の昇順にする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-STOCKIST-001、FR-STOCKIST-004 |
| 根拠 | 管理で「ホームに出すか」「何番目か」を決める欄と手間を持たず、登録の順で並べるため（推定。消した理由の記録は無い）。表を作った時の移行で入れた2つの列を、同じコミットの移行で消した |
| 状態 | 推定 |
| 出どころ | git `0993fd79`（2026-04-04、取扱店の管理を作ったコミット）、`migrations/029_drop_stockist_home_feature_and_display_order.sql` |

#### 背景

- 表を作った時は、ホームの特集の印と並び順の数の列と、その索引を持っていた（`migrations/027_create_stockists_and_acl.sql`）

#### 決定

- 2つの列と索引を消した（`migrations/029_drop_stockist_home_feature_and_display_order.sql`）。今の表の写しにも無い（`remote_schema.sql`）
- 公開の取り出し（`public.ts`）と管理の一覧（`route.ts`）は id の小さい順。ホームはその先頭の6件（ADR-0252）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 特集の印と並び順を残し、管理で選ばせる | 同じコミットで消した。理由の記録は無い |

#### 結果

- 良くなること: 管理のフォームの欄が増えない。並びが取り出しのたびに変わらない
- 悪くなること: ホームに出す店と並びを管理で変えられない。並びを変えるには登録し直すしかない
- 見直す条件: 公開の店が7件以上になり、ホームに出す店を選びたくなった時

## 未確認事項

- 列を消した理由（コミットの本文に無い）
