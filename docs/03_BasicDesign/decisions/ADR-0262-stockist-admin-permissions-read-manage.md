# ADR-0262 管理の取扱店の権限を閲覧と管理の2つに分け、店長に付けサポーターに付けない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/`、`supabase/migrations/20261023175712_group_g0_permissions.sql` | 基準コミット: `4facf63b`

## 概要

管理の取扱店の窓口は、一覧と1件の読みに「取扱店の閲覧」、作る・直す・公開の切替・消すに「取扱店の管理」の権限を求める。2つとも店長には付け、サポーターには付けない。権限の設計の表で決め、2026-10-23 の権限の移行で本番に当てた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-006、FR-ADMIN-006、FREQ-540-REQ-01（範囲外） |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` |
| 関連文書 | `docs/superpowers/specs/2026-10-23-group-g-design.md`、`supabase/migrations/20261023175712_group_g0_permissions.sql`、`docs/05_Quality/reviews/security/security_review_stockist.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0262 管理の取扱店の権限を閲覧と管理の2つに分け、店長に付けサポーターに付けない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、FR-ADMIN-006、FREQ-540-REQ-01（範囲外） |
| 根拠 | 一覧を見るだけの操作と、店を作る・直す・消す操作を別の権限で守り、注文の対応を担うサポーターに取扱店を触らせないため。権限の設計の表で「取扱店の閲覧・管理は店長は可、サポーターは不可」と決めた |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-10-23-group-g-design.md`、`supabase/migrations/20261023175712_group_g0_permissions.sql`（権限の移行。本番に適用済み） |

#### 背景

- 権限の名前は 権限の設計の前からあった（権限の設計の表で「既存」）。安全のレビューは、読みに閲覧、変更に管理を求める形を「Fixed」とした（`security_review_stockist.md`）

#### 決定

- 読みの窓口は閲覧の権限、変更の窓口は管理の権限を、共有の管理の認可の部品で求める（`route.ts`、`[id]/route.ts`）。部品は署名を確かめた token・有効な session・DB の ACL・2要素認証の済み（aal2）を見る
- サポーターの役には2つとも付けない（`20261023175712_group_g0_permissions.sql`）
- DB の RLS も同じ権限で読み書きを許す（ADR-0258）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 1つの権限で読みと変更をまとめる | 見るだけの役を作れない（推定。記録は無い） |
| サポーターにも付ける | 権限の設計の表で不可とした |

#### 結果

- 良くなること: 権限の設定の画面で、取扱店の閲覧と管理を別々に付け外しできる
- 悪くなること: 1件の窓口は、権限を見る前に id の形の誤りで 400 を返す（`[id]/route.ts`）。作成・編集の頁の入口は権限を確かめない（SEC-STOCKIST-019 の求める形と合わない）

## 未確認事項

- 401・403・`MFA required` の道を試すテストが無く、動かしての確かめはしていない
