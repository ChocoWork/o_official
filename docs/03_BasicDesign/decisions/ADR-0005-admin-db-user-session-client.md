# ADR-0005 管理のニュースの DB の操作は利用者の session の client で行い、RLS の権限を効かせる

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` | 基準コミット: `a03beaff`

## 概要

管理のニュースの表の読み書きはログイン中の利用者の token を持つ client で行い、service role は画像の書き込みと署名だけに使う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-015、FR-ADMIN-003 |
| 対象のコード | `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0005 管理のニュースの DB の操作は利用者の session の client で行い、RLS の権限を効かせる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-015、FR-ADMIN-003 |
| 根拠 | service role で表を触ると、権限ごとに決めた RLS（`has_permission`）を素通りし、窓口の確かめが1か所崩れただけで記事を書き換えられるため（2026-04-18 のレビューの指摘） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md` |

#### 背景

2026-04-18 の時点の管理のニュースの窓口は、表の読み書きに `createServiceRoleClient()` を使い、`migrations/023` の権限ごとの RLS を通っていなかった。

#### 決定

- 表の読み書きは `createClient(request)`（ログイン中の利用者の token）で行う
- service role は画像の書き込み（`route.ts`）と署名だけに使う

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 表の読み書きを全部 service role で行う（2026-04-18 の時点の形） | 権限ごとの RLS を素通りし、DB の段で止められない |

#### 結果

- 良くなること: 窓口の確かめ（ADR-0006）と DB の RLS の2段で書き換えを止める
- 悪くなること: RLS は `has_permission` だけを見て aal を見ないので、DB の段では2要素認証を求めない（SEC-NEWS-002）（2026-10-29 追記: 波 5 の移行 M2 を当てると、DB の `has_permission` が aal2 と結び付いた生きた session を求めるので、この点は直る。ADR-0418。M2 は 2026-10-29 に本番適用済み）
- 悪くなること: 画像の書き込みは service role なので、置き場の側には権限の段が無い
- 直った後の形を確かめたレビューの記録は無い。今のコードを読んで確かめただけ
- 2026-10-26: 書き込み（POST・PUT・PATCH・DELETE）は、認可の後に service role で行う形に ADR-0026 が置き換えた。読み（GET）はこの判断のまま

## 未確認事項

- 本番の DB で `has_permission` のポリシーが移行と同じか
