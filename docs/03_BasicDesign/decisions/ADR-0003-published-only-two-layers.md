# ADR-0003 公開済みだけを出す決まりを、DB の RLS と取り出しの条件の2段で守る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/news/services/public.ts`、`supabase/migrations/20260901102912_remote_schema.sql` | 基準コミット: `a03beaff`

## 概要

公開の道で非公開の記事を出さない決まりを、DB の RLS とアプリの取り出しの `status = 'published'` の両方で持つ。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-001、FR-NEWS-ALL-001 |
| 対象のコード | `src/features/news/services/public.ts`、`supabase/migrations/20260901102912_remote_schema.sql` |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0003 公開済みだけを出す決まりを、DB の RLS と取り出しの条件の2段で守る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-001、FR-NEWS-ALL-001 |
| 根拠 | 非公開の記事を外へ出さないため。RLS とアプリの条件のどちらか一方が崩れても（ポリシーの書き換え、service role での取り出しなど）、もう一方で止められる（推定。レビューは2段の形を「維持」と評価したが、2段にした理由は書いていない） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/security/security_review_news.md`、実装から推定 |

#### 背景

公開の一覧・詳細・ホーム・`/api/news` は、非公開の記事も入る同じ表 `news_articles` から読む。

#### 決定

- DB: anon は `status = 'published'` の行だけを読める。authenticated は公開済みか、`admin.news.read` の権限がある時だけ読める（`remote_schema.sql`）
- アプリ: 公開の取り出しの4つの関数は毎回 `.eq('status', 'published')` を付ける（`public.ts`）

#### 退けた案

記録なし

#### 結果

- 良くなること: 片方が崩れても非公開の記事は出ない（推定）
- 悪くなること: どちらか片方を外しても今のテストは全部通る。手元の見本の記事は全部公開済みで（`supabase/seed.sql`）、非公開を出さないことを試すテストが無い（SEC-NEWS-001-AC-01・02）
- 悪くなること: `admin.news.read` を持つ人は aal1 の session でも PostgREST から非公開の記事を読める。RLS が aal を見ないため（SEC-NEWS-002）

## 未確認事項

- 本番の DB のポリシーが移行と同じか
- 判断の理由はユーザーの確認を受けていない
