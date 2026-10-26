# ADR-0024 公開のニュースの取り出しの失敗は throw にして誤りの画面に出し、前後のリンクだけ握る

> 状態: 現行 | 確認日: 2026-10-26 | 対象: `src/features/news/services/public.ts`、`src/app/api/news/route.ts`、`src/app/news/page.tsx`、`src/app/news/[id]/page.tsx`、`src/app/news/error.tsx`、`src/app/page.tsx` | 基準コミット: `16df4479`（作業ツリーに別の作業の未コミットの差分あり）

## 概要

公開のニュースの取り出し（一覧・詳細）は Supabase の `error` を読み、失敗を `NewsFetchError` で投げる。`/news`・`/news/[id]` は同じ階層の `error.tsx` の誤りの画面に任せ、`/api/news` は固定の文の 500 にする。ホームは `.catch(() => [])` で握って NEWS の区画だけを空にする。前後のリンクの取り出しだけは、失敗を記録して前後なしで返し、記事の本体は出す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS・HOME |
| 対応する ID | SEC-NEWS-020、SEC-NEWS-006、SEC-NEWS-012、THR-NEWS-019、SEC-HOME-014、SEC-HOME-015 |
| 対象のコード | `src/features/news/services/public.ts`（`getPublishedNews`・`getPublishedNewsDetailById`・`getPublishedNewsNavigation`・`getPublishedNewsCount`・`NewsFetchError`）、`src/app/api/news/route.ts`、`src/app/news/page.tsx`、`src/app/news/[id]/page.tsx`、`src/app/news/error.tsx`、`src/app/page.tsx` |
| 関連文書 | `ADR-0021`（公開の頁が取り出しの関数を直接呼ぶ判断。この判断で失敗の扱いを足した）、`ADR-0017`（赤い文の例外。部品が自分で取り出す枝の話で変えない）、`ADR-0159`（LOOK の同じ形の判断）、`docs/02_Requirements/areas/news.md`、`docs/05_Quality/security/threats/news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合テストで確かめた。誤りの画面の HTTP 状態は本番ビルドで未確認） |

## 判断

### ADR-0024 公開のニュースの取り出しの失敗は throw にして誤りの画面に出し、前後のリンクだけ握る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-020 |
| 根拠 | DB・RLS の障害を「現在、公開されている記事はありません」に紛れさせず、運営と閲覧者が障害に気づけるようにするため（THR-NEWS-019）。ユーザーが 2026-10-26 に取り出しの失敗は throw にして誤りの画面に出す方針を承認した（設計 R14）。前後のリンクは添え物なので、失敗で記事の本体を隠さない |
| 状態 | 現行 |
| 出どころ | ユーザーの承認（2026-10-26、波 1 を全部）。方針は `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md` の R14。ホームを落とさない・前後だけ握る点は同じ設計の割り当て |

#### 背景

- 公開の取り出しは `{ data }` だけを読み、`error` を見なかった。DB の失敗は空の一覧になり、画面は「記事が無い」と見せ、記録も残らなかった
- 詳細は `.single()` で、行が無い時も失敗の時も `data` が `null` になり、どちらも 404 になった

#### 決定

- `getPublishedNews`・`getPublishedNewsDetailById` は `error` を読み、誤りの名前と符号（`code`）だけ記録して `NewsFetchError`（`message` は固定。`code` を持つ）を投げる。`message`・詳細・ヒントは記録も画面にも出さない
- 詳細は `.maybeSingle()` にして、行が無い時は `null`（404）、DB の失敗は投げる（誤りの画面）に分ける。id が bigint の形でなければ DB を呼ばず `null`
- `/news`・`/news/[id]` は投げたまま、新しい `src/app/news/error.tsx` の誤りの画面（見出し・「エラー」を含む案内・もう一度表示するボタン。`digest` だけを記録）に任せる。`loading.tsx` と頁の中の `<Suspense>` は足さない
- `/api/news` は例外を固定の文 `Failed to fetch news` の 500 にする。記録は名前と符号だけ。全ての応答に `Cache-Control: private, no-store` を付ける
- ホーム（`src/app/page.tsx`）は `getPublishedNews` に `.catch(() => [])` を付け、NEWS の区画だけを空にして他の区画を出す
- `getPublishedNewsNavigation` は失敗を記録して前後なしで返す。`getPublishedNewsCount` は今までどおり 0 を返す（記録は名前と符号に直した）
- 使われていない `getLatestNews`（`src/app/actions/news.ts`）は変えない。失敗はそのまま呼び元に伝わる

#### Shopify との突き合わせ

| 観点 | Shopify の一般的な形 | この判断 |
| --- | --- | --- |
| 取り出しの失敗の見せ方 | ブログ・記事の障害は 0 件の表示にせず、エラーの頁（5xx）を返す（出典は未確認） | 誤りの画面に出し、「記事が無い」にしない |
| 記事が無い場合 | 記事が無ければ 404 | 行が無い時だけ 404。失敗は 404 にしない |
| 記事の周辺（前後・関連） | 周辺の部品の失敗で記事本体は隠さない | 前後の失敗は記録して前後なしで返す |
| トップの区画 | 1 つの区画の障害でトップ全体を落とさない | ホームは NEWS の区画だけを空にする |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 失敗を空の一覧のまま返し、記録だけ足す | 画面は「記事が無い」と見せ続け、閲覧者が障害と区別できない |
| 取り出しの側でホームかどうかを見分けて空にする | 取り出しの関数が呼び元に依存する。呼び元（ホーム）で握るほうが単純 |
| 前後の失敗も投げる | 前後は添え物。記事の本体まで誤りの画面にするのは過剰 |
| `error.tsx` と一緒に `loading.tsx` を足して状態を決める | 流し始める前の誤りなら 500 のままにしたい。Suspense の代わりの表示を足すと状態が 200 に決まりうる |

#### 結果

- 良くなること: 障害が誤りの画面と固定の 500 になり、記録に名前と符号が残る。404 と失敗が分かれる
- 悪くなること: 一時的な DB の失敗で `/news` が誤りの画面になる（以前は空の一覧）。ホームは NEWS の失敗を握るので、運営は記録で気づく必要がある
- 見直す条件: 誤りの画面の HTTP 状態が 200 になると分かった時（検索エンジンへの影響）、前後の失敗が頻繁に記録に出る時

## 未確認事項

- `src/app/news/error.tsx` を足しても HTTP 状態が 500 のままか（controller が本番ビルドの E2E で確かめる）
- Shopify の障害時の挙動の出典
