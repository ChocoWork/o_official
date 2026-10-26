# ADR-0310 検索のページは利用者の端末で窓口を呼んで描き、語とタブは URL を置き換えて持つ

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/search/page.tsx`、`src/features/search/components/SearchPageClient.tsx` | 基準コミット: `4e84d5c5`

## 概要

`/search` のページの本体は利用者の端末で動く部品で、語が変わるたびに `/api/search` を呼んで結果を描く（2026-10-26 から、タブだけの変更は取り直さず、取ってある結果から出し分ける。ADR-0313）。語とタブは URL の `q`・`tab` に持ち、変える時はブラウザの履歴を積まずに URL を置き換える。サーバーで DB を読んで描く形にしなかった理由の記録は無い。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FR-SEARCH-001、DRV-SEARCH-004 |
| 対象のコード | `src/app/search/page.tsx`、`src/features/search/components/SearchPageClient.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FR-SEARCH-001）、`docs/03_BasicDesign/decisions/ADR-0021-public-pages-read-db-directly.md`（NEWS は逆の形） |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0310 検索のページは利用者の端末で窓口を呼んで描き、語とタブは URL を置き換えて持つ

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-001、DRV-SEARCH-004 |
| 根拠 | FR-SEARCH-001 は語とタブを URL で受けることだけを求める。入力・候補・タブの切り替えに合わせてその場で結果を取り直すので、画面の全体を利用者の端末の部品にし、ホームのプレビューと同じ窓口を呼ぶ形にしたと推定。履歴を積まないのは、タブを変えるたびに戻るボタンの手間が増えないため（DRV-SEARCH-004、推定） |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/search/components/SearchPageClient.tsx`） |

#### 背景

公開のほかのページ（NEWS など）は、サーバーの部品が DB を直接読んで描く（ADR-0021）。検索のページは入力に合わせて候補と結果が変わる。

#### 決定

- ページのファイルは、title・description・OG の画像を返し、URL の値を読む部品を `Suspense` で包むだけ（`page.tsx`）
- 本体の部品は利用者の端末で動き（`SearchPageClient.tsx`）、語が変わるたびに `/api/search` を `no-store` で呼ぶ（タブだけの変更では呼び直さない。ADR-0313）。語が空でも呼ぶ（FREQ-186-REQ-03）
- 確定した語とタブは `router.replace` で URL を置き換え、スクロールの位置を保つ

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| サーバーの部品で DB を読んで描く（NEWS の ADR-0021 の形） | 理由の記録は無い。入力やタブの切り替えのたびにページを作り直すことになる（推定） |
| `router.push` で履歴を積む | 戻るボタンで検索のページから出るまで何度も押すことになる（推定） |

#### 結果

- 良くなること: ホームのプレビューと検索のページが同じ窓口と回数の制限を通る
- 悪くなること: 最初に届く HTML に結果が無く、結果を描くには端末での実行が要る（推定）
- 良くなること: `tab` はサーバーで結果を絞らない（`src/features/search/services/search.service.ts`）ので、タブを変えても呼び直さない。以前はタブを変えるたびに3つの関数を呼び直し、回数の制限の数も使っていた（SEC-SEARCH-005、ADR-0313 で直した）
- 残ること: `/search?q=` のページに noindex も canonical も無い（DRV-SEARCH-009）

## 未確認事項

- 端末の部品にした時の記録
- 検索エンジンが `/search?q=` のページを載せるか
