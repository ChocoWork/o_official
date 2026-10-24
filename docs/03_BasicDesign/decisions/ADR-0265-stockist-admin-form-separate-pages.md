# ADR-0265 管理の取扱店の作成と編集は一覧とは別の頁にし、同じフォームを使う

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/admin/stockist/` | 基準コミット: `4facf63b`

## 概要

管理の取扱店の作成は `/admin/stockist/create`、編集は `/admin/stockist/edit/<id>` の別の頁にし、どちらも同じフォームの部品を使う。保存できたら管理の STOCKIST タブへ戻る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FR-ADMIN-006、DRV-STOCKIST-015 |
| 対象のコード | `src/app/admin/stockist/create/page.tsx`、`src/app/admin/stockist/edit/[id]/page.tsx`、`src/app/admin/stockist/StockistForm.tsx` |
| 関連文書 | `docs/03_BasicDesign/ui/screen-list.md`、`docs/04_DetailDesign/pages/16_admin.md`（範囲外。別の作業が書き換え中） |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0265 管理の取扱店の作成と編集は一覧とは別の頁にし、同じフォームを使う

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006、DRV-STOCKIST-015 |
| 根拠 | 作成と編集の入力の欄と確かめ（DRV-STOCKIST-015）を1つの部品にまとめ、ITEM・LOOK・NEWS の管理と同じ「別の頁のフォームから一覧へ戻る」形にそろえるため（推定。判断の記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/app/admin/stockist/create/page.tsx`、`src/app/admin/stockist/edit/[id]/page.tsx`）、`docs/03_BasicDesign/ui/screen-list.md` |

#### 背景

- 一覧は管理の頁の STOCKIST タブにある（共有の `src/app/admin/page.tsx`、範囲外）
- 管理の ITEM・LOOK・NEWS のフォームも、保存の後に一覧へ戻る（`screen-list.md`）

#### 決定

- 作成の頁はフォームに作る窓口と送り方を渡すだけ（`create/page.tsx`）
- 編集の頁は URL の id で1件を取り、初めの値にしてフォームに渡す（`edit/[id]/page.tsx`）
- フォームは保存できたら `/admin?tab=STOCKIST` へ戻る（`StockistForm.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 一覧の上の窓（モーダル）で編集する | 詳細設計 `16_admin.md` はモーダルと書くが、今のコードに無い。変えた記録は無い（推定） |

#### 結果

- 良くなること: 作成と編集で入力の欄と確かめが1か所にそろう
- 悪くなること: 作成・編集の頁の入口は権限を確かめず、データは窓口だけが守る（SEC-STOCKIST-019 の求める形と合わない）。編集の頁は URL の id を確かめずに窓口の道に入れる（SEC-STOCKIST-015 の求める形と合わない）

## 未確認事項

- `16_admin.md` の「モーダル」と今の頁のどちらを正とするか（範囲外の文書なので報告だけ）
