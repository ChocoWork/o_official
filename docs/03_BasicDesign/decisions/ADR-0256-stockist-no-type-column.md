# ADR-0256 店舗の種別（type）を持たない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/`、`src/app/admin/stockist/`、`src/features/stockist/` | 基準コミット: `4facf63b`

## 概要

取扱店に種別（FLAGSHIP STORE・STORE・SELECT SHOP）を持たせない。2026-04-04 に画面・窓口・型から種別を消し、列を消す移行も足した。ただし本番から取った DB の写しには種別の列が必須のまま残る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FR-ADMIN-006、FR-STOCKIST-002、FR-STOCKIST-007 |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/admin/stockist/StockistForm.tsx`、`src/features/stockist/types.ts` |
| 関連文書 | `migrations/027_create_stockists_and_acl.sql`、`migrations/030_remove_stockist_type.sql`、`supabase/migrations/20260901102912_remote_schema.sql`、`supabase/seed.sql` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない。DB は読んでいない） |

## 判断

### ADR-0256 店舗の種別（type）を持たない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006、FR-STOCKIST-002、FR-STOCKIST-007 |
| 根拠 | カードに出す情報を店舗名・住所・電話・営業時間・定休日の5つにそろえ（FR-STOCKIST-002）、取扱の分類も今は付けない（FR-STOCKIST-007）ので、管理で種別を選ばせないため。2026-04-04 のコミットで種別の欄を消した。DB の写しには列が残り食い違うので推定 |
| 状態 | 推定 |
| 出どころ | git `3ff1ff9f`（2026-04-04「Stockist関連のtypeフィールドを削除し、UIを改善」）、`migrations/030_remove_stockist_type.sql` |

#### 背景

- 表を作った時は、種別を3つの値の必須の列にしていた（`migrations/027_create_stockists_and_acl.sql`）

#### 決定

- 窓口の入力の確かめ（`route.ts`）、作る時に入れる値、管理のフォーム（`StockistForm.tsx`）、型のどれにも種別が無い
- 列を消す移行を書いた（`migrations/030_remove_stockist_type.sql`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 種別を残し、管理で選ばせてカードに出す | コミットで消した。理由はコミットの題（UI を改善）のほかに記録が無い |

#### 結果

- 良くなること: 管理のフォームとカードが簡単になった
- 悪くなること: 本番から取った写し（`remote_schema.sql`）では、種別は既定値の無い必須の列で、3つの値の制約も残る。列を消す移行は今の移行の置き場（`supabase/migrations/`）に無い。本番も同じなら、管理で店を作るといつも DB で落ちる（FR-ADMIN-006・FREQ-18-AC-01 と食い違う、推定）。手元の見本（`supabase/seed.sql`）は種別を入れて作るので、手元では気づけない
- 見直す条件: 本番の列の有無を確かめた時

## 未確認事項

- 本番の `stockists` の種別の列が今も必須か（DB は読んでいない）
