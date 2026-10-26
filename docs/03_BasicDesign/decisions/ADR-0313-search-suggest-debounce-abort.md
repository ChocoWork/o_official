# ADR-0313 候補の取得は 250 ミリ秒待ち、古い要求を打ち切る

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/features/search/components/SearchPageClient.tsx` | 基準コミット: `413d8b36`

## 概要

検索のページの部品は、候補の取得を入力が止まって 250 ミリ秒たってから始め、新しい入力・アンマウントのたびに前の要求を `AbortController` で打ち切る。入力を空にした時は待たずに候補を消し、取得しない。検索（`/api/search`）はタブを切り替えただけでは呼び直さず、語が変わった時だけ呼ぶ。URL の `tab` は最新の値を `useRef` から読む。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | SEC-SEARCH-005、SEC-SEARCH-005-AC-02、THR-SEARCH-005 |
| 対象のコード | `src/features/search/components/SearchPageClient.tsx` |
| 関連文書 | `docs/02_Requirements/areas/search.md`、`docs/03_BasicDesign/decisions/ADR-0306-search-suggest-rate-limits.md`、`docs/03_BasicDesign/decisions/ADR-0310-search-page-client-fetch-url-replace.md` |
| 調べた時点 | 2026-10-26（単体・結合の試験で確かめた。ブラウザでの確かめは E2E `FR-SEARCH-022` の `SEC-SEARCH-005-AC-02`。流していない） |

## 判断

### ADR-0313 候補の取得は 250 ミリ秒待ち、古い要求を打ち切る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-005 |
| 根拠 | 1 文字ごとに窓口を呼ぶと、速く打つ普通の利用者が回数の枠（候補 200 回/600 秒）に届く。タブを切り替えるだけで検索を呼び直すと、窓口が `tab` で絞らないのに枠と DB の関数 3 つを無駄に使う |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R12 の画面の呼びすぎ） |

#### 背景

- 候補の取得は入力のたびに窓口を呼んでいた（待ちも最小の字数も無かった）
- 検索の取得（`useEffect`）は `[activeTab, query]` に依存し、タブを押すたびに取り直していたが、窓口は 3 種の結果を全部返し、タブは表示の切り替えだけだった

#### 決定

- 定数 `SUGGEST_DEBOUNCE_MS = 250`。候補の取得（`useEffect`）は `setTimeout` で待ち、片付けで `clearTimeout`・`AbortController.abort()`・`cancelled = true` にする（遅れて返った前の応答で候補を上書きしない）
- 打ち切られた要求の失敗は記録しない。それ以外の失敗は誤りのオブジェクトを渡さず固定の文だけ記録する
- 検索の取得の依存は `[query]` だけにする。URL に載せる `tab` は `activeTabRef`（`useEffect` で最新に保つ）から読む
- 最小の字数は置かない（1 文字目から候補を出す。FREQ-190）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 窓口の `tab` を絞る形に直してタブで取り直す | 窓口の仕様変更で範囲が広い。画面が全種別を持っているので取り直す必要が無い |
| 最小の字数（2 文字など）を置く | 1 文字目から候補を出す既存の要求（FREQ-190）を変える |
| 待ちを 300〜500 ミリ秒にする | 候補が出るのが遅くなる。250 ミリ秒は打鍵の間隔より長く、体感が重くならない値（推定） |

#### 結果

- 良くなること: 5 文字を続けて打っても候補の要求は最後の 1 回だけになり、タブの切り替えでは窓口を呼ばない
- 悪くなること: 候補が出るまで 250 ミリ秒遅れる

## 未確認事項

- 実機での打鍵の間隔に対して 250 ミリ秒が適切か（E2E は 20 ミリ秒間隔で打つ）
