# ADR-0020 記事の状態は「非公開」と「公開済み」の2つにする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `supabase/migrations/20260901102912_remote_schema.sql`、`src/app/api/admin/news/`、`src/components/NewsSection.tsx` | 基準コミット: `a03beaff`

## 概要

記事の状態は `private`（非公開）と `published`（公開済み）の2つだけにし、管理の画面で切り替える。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FR-ADMIN-003、SEC-NEWS-001 |
| 対象のコード | `supabase/migrations/20260901102912_remote_schema.sql`、`src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/components/NewsSection.tsx` |
| 関連文書 | `migrations/014_rename_draft_to_private.sql` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0020 記事の状態は「非公開」と「公開済み」の2つにする

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-003、SEC-NEWS-001 |
| 根拠 | 外へ出すかどうかを1つの列の2つの値で決めれば、公開の道（RLS と取り出しの条件）が `published` の1つだけを見ればよくなるため（推定）。`draft` を `private` に改めた理由の記録は無い |
| 状態 | 推定 |
| 出どころ | `migrations/014_rename_draft_to_private.sql`、実装から推定 |

#### 背景

記事の状態は初め `draft` と `published` だった。`migrations/014` で `draft` を `private` に改め、CHECK を2つの値にした。

#### 決定

- `status` の CHECK は `private`・`published` だけを許す（`remote_schema.sql`）
- 管理の入力も2つだけを受ける（`route.ts`）
- 公開・非公開の切り替えは PATCH で行う（`[id]/route.ts`、`NewsSection.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 下書き（`draft`）の名前で持つ | `migrations/014` で `private` に改めた。理由の記録は無い |

#### 結果

- 良くなること: 公開の道は `published` だけを見ればよい（ADR-0003）
- 食い違い: DB の `status` の初期値は今も `'draft'` で、CHECK に合わない（`remote_schema.sql`）。管理の窓口は必ず状態を渡すので今は表に出ない（推定）

## 未確認事項

- 本番の DB の `status` の初期値
- 判断の理由はユーザーの確認を受けていない
