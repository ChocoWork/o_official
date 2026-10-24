# ADR-0263 店舗の公開の状態は「非公開」と「公開」の2つにし、作る時の初めは非公開にする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/`、`src/app/admin/stockist/StockistForm.tsx`、`src/components/StockistSection.tsx` | 基準コミット: `4facf63b`

## 概要

取扱店の公開の状態は「非公開」と「公開」の2つだけにする。管理のフォームの初めの値と DB の既定値は「非公開」。一覧から状態だけを切り替えられる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | DRV-STOCKIST-015、SEC-STOCKIST-001、FR-ADMIN-006 |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts`、`src/app/admin/stockist/StockistForm.tsx`、`src/components/StockistSection.tsx` |
| 関連文書 | `supabase/migrations/20260901102912_remote_schema.sql` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0263 店舗の公開の状態は「非公開」と「公開」の2つにし、作る時の初めは非公開にする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-STOCKIST-015、SEC-STOCKIST-001、FR-ADMIN-006 |
| 根拠 | 作ったばかりの店を、確かめる前に公開の画面へ出さないため（推定）。公開の画面の絞り（ADR-0254）が「公開」の1つの値だけを見ればよいようにする。2つの状態は管理を作った時のコミットで決めた |
| 状態 | 推定 |
| 出どころ | git `0993fd79`（2026-04-04、状態を 'private' と 'published' にした）、実装から推定（`src/app/admin/stockist/StockistForm.tsx`） |

#### 背景

- FR-ADMIN-006 は「ステータス管理」を求めるが、状態の数と初めの値は書かれていない

#### 決定

- DB は2つの値の制約と、既定値「非公開」を持つ（`remote_schema.sql`）
- 窓口は2つの値だけを受け、作る時と直す時に状態を必須にする（`route.ts`）。公開の切替の窓口は状態だけを受ける（`[id]/route.ts`）
- 管理のフォームの初めの値は「非公開」（`StockistForm.tsx`）。一覧のボタンは今の状態の反対へ切り替える（`StockistSection.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 下書き・公開の予約など3つ以上の状態 | 記録は無い（推定）。店の情報に公開の日時の決まりは無い |
| 作る時の初めを「公開」にする | 確かめる前に外へ出る（推定） |

#### 結果

- 良くなること: 公開の画面の絞りが1つの値で済む。一覧から1回押して切り替えられる
- 悪くなること: 窓口は状態を必須にするので、DB の既定値「非公開」は窓口からは使われない

## 未確認事項

- 初めを非公開にした理由の記録
