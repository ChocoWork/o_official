# ADR-0312 検索の窓口は `Sec-Fetch-Site` が同一オリジンでない要求を 403 にする

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/features/search/lib/cross-site.ts`、`src/app/api/search/route.ts`、`src/app/api/suggest/route.ts` | 基準コミット: `413d8b36`

## 概要

`/api/search` と `/api/suggest` は、検査と回数の制限より前に、ブラウザが付ける `Sec-Fetch-Site` を見る。見出しが無い・`same-origin`・`none` なら通し、それ以外（`cross-site`・`same-site`・知らない値）は `{ error: 'Forbidden' }` の 403 で断る。断った要求は回数の枠に数えない。他の公開の GET には広げない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | SEC-SEARCH-020、SEC-SEARCH-020-AC-02、THR-SEARCH-020 |
| 対象のコード | `src/features/search/lib/cross-site.ts`（`rejectCrossSiteFetch`）、`src/app/api/search/route.ts`、`src/app/api/suggest/route.ts` |
| 関連文書 | `docs/02_Requirements/areas/search.md`、`docs/05_Quality/security/threats/search.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`（Q18） |
| 調べた時点 | 2026-10-26（単体・結合の試験で確かめた。サーバーの契約の確かめは E2E `FR-SEARCH-022` の `SEC-SEARCH-020-AC-02`。ブラウザが付ける `Sec-Fetch-Site: cross-site` を request fixture で手で付けて送り、403 `{ error: 'Forbidden' }` と閲覧者の枠を数えないことを見る。実ブラウザが外のオリジンの `fetch` に `cross-site` を付けることは Fetch Metadata の仕様とブラウザの対応（Chromium、Firefox 90 以降、Safari 16.4 以降）に基づく前提で、この E2E は観測していない。流していない） |

## 判断

### ADR-0312 検索の窓口は `Sec-Fetch-Site` が同一オリジンでない要求を 403 にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-020 |
| 根拠 | GET は送り元の確かめ（Origin）の対象外なので、外のサイトの頁が閲覧者の端末から `/api/search` を何度も呼ばせ、その人の送り元の分の回数を使い切らせられる。画面は同じオリジンの `fetch` で呼ぶので `same-origin` が付き、断らない。ユーザーの承認（2026-10-26 の既定で進める物の Q18）で採った |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`、`design-final.md`（R12 の外のサイト側） |

#### 背景

- 回数の制限は送り元の IP だけで数える（共有部品 `rateLimit.ts`）。外のサイトから呼ばせた要求も閲覧者の分に数えられる
- 偽の送り元（`x-forwarded-for`）の側は `rateLimit.ts` の直しが要るので波 4

#### 決定

- `rejectCrossSiteFetch(request)` は `sec-fetch-site` の値を小文字にそろえて見て、空・`same-origin`・`none` なら `null`、それ以外は `Cache-Control: private, no-store` つきの 403 を返す
- 2 つの窓口は、先頭で呼び、403 なら即座に返す。zod の検査・回数の制限・取り出しは呼ばない
- 見出しが無い要求（curl・Playwright の `request`・古いブラウザ・サーバー間）は通す。`same-site`（同じサイトの別のオリジン）は断る

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `proxy.ts` で全部の公開の GET に掛ける | 共有部品の変更で、他の窓口にも効く。決定は `/api/search` と `/api/suggest` だけ |
| `Origin` や `Referer` を見る | GET の `fetch` には付かないことがあり、`Sec-Fetch-Site` のほうが偽れない（ブラウザが付ける禁止ヘッダー） |
| 見出しが無い要求も断る | 古いブラウザと検査用の道具が使えなくなる |

#### 結果

- 良くなること: 外のサイトから閲覧者の分の枠を使い切らせる道が塞がる
- 悪くなること: 見出しを偽れる非ブラウザの攻撃者（直接 HTTP を送る者）には効かない。それは偽の送り元の側（波 4）の話

## 未確認事項

- 本番の中継が `Sec-Fetch-Site` を落とさないか（未デプロイなので未確認）
