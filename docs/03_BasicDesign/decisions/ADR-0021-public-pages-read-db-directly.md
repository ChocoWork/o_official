# ADR-0021 公開の一覧・詳細のページは Server Component から直接 DB を読み、/api/news を通らない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/news/page.tsx`、`src/app/news/[id]/page.tsx` | 基準コミット: `a03beaff`

## 概要

`/news` と `/news/[id]` は、ページを作るサーバーの中で取り出しの関数を直接呼び、自分の `/api/news` を経由しない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FR-NEWS-ALL-001、FR-NEWS-DETAIL-001 |
| 対象のコード | `src/app/news/page.tsx`、`src/app/news/[id]/page.tsx`、`src/features/news/components/PublicNewsGrid.tsx`、`src/features/news/services/public.ts` |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0021 公開の一覧・詳細のページは Server Component から直接 DB を読み、/api/news を通らない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-NEWS-ALL-001、FR-NEWS-DETAIL-001 |
| 根拠 | ページを作るサーバーの中で取り出せば、自分の API へ HTTP で取りに行く往復が無く、記事を入れた HTML をそのまま返せるため（推定。記録は無い） |
| 状態 | 推定 |
| 出どころ | 実装から推定 |

#### 背景

記事の取り出しは `src/features/news/services/public.ts` の関数にまとまり、ページと `/api/news` の両方から呼べる。

#### 決定

- `/news` は `getPublishedNews({ category })` を直接呼び、`limit` を渡さない（`src/app/news/page.tsx`）
- `/news/[id]` は `getPublishedNewsDetailById`・`getPublishedNewsNavigation` を直接呼ぶ（`src/app/news/[id]/page.tsx`）
- 記事を部品へ渡すので、部品が自分で `/api/news` から取る枝は通らない（`PublicNewsGrid.tsx`、推定）

#### 退けた案

記録なし

#### 結果

- 良くなること: ページの表示に API の往復が要らない
- 悪くなること: `/api/news` の回数の制限と件数の上限が公開のページに効かず、一覧は公開済みを全部取る（`security_review_news.md`、Open。SEC-NEWS-009-AC-03）
- 悪くなること: 詳細は記事を2回読み（`[id]/page.tsx`、推定）、前後の記事のために公開済みを全部読む（`public.ts`）
- `/api/news` は今の画面から使われない（DRV-NEWS-007、ADR-0008）

## 未確認事項

- 記事が増えた時の一覧と詳細の読み出しの重さは測っていない
- 判断の理由はユーザーの確認を受けていない
