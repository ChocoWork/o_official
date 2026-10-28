# ADR-0269 取扱店の作成の頁は、入口で GET /api/admin/stockists/access を呼んで権限を確かめてからフォームを出す

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/app/admin/stockist/create/page.tsx`、`src/app/api/admin/stockists/access/route.ts` | 基準コミット: `ea393ce4`

## 概要

取扱店の作成の頁は、開いた時に `GET /api/admin/stockists/access` を呼び、`admin.stockists.manage` を持つ人（204）にだけフォームを出す。未ログインの人（401）と権限の無い人（403）には固定の誤りの文だけを出す。窓口は 1 本増える。2026-10-28（波 4）に決めた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-019 |
| 対象のコード | `src/app/admin/stockist/create/page.tsx`、`src/app/api/admin/stockists/access/route.ts` |
| 関連文書 | `docs/superpowers/plans/2026-10-28-wave4-client-ip-audit-admin-ui.md`（Task 8、前提の読み P15）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md`（Q20） |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-28 の作業ツリー |

## 判断

### ADR-0269 取扱店の作成の頁は、入口で GET /api/admin/stockists/access を呼んで権限を確かめてからフォームを出す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-019 |
| 根拠 | 権限の無い人に管理の画面を見せないため。データは窓口が守るので、画面の守りは 2 段目。作成の頁は client の部品で、サーバーの守りを置けない（THR-STOCKIST-019） |
| 状態 | 現行 |
| 出どころ | 波 4 の決定（Q20 を推奨で進める） |

#### 背景

- 作成の頁は入口に権限の確かめが無く、未ログインの人にもフォームの殻が見えた
- 頁は `'use client'` で、`/admin` の判定は proxy にも layout にも無い

#### 決定

- 頁は開いた時に `clientFetch('/api/admin/stockists/access')` を 1 回呼ぶ。通る（2xx）までは「読み込み中...」、通ればフォーム、401 は「ログインが必要です」、403 は「STOCKISTを作成する権限がありません」、ほかは「権限の確認に失敗しました」を赤い 1 行で出す
- 窓口 `access` は `admin.stockists.manage` で認可し、通れば本文の無い 204 を返す。順序・回数の制限・断った時の監査は他の窓口と同じ（ADR-0259・ADR-0268）。応答は全部 `private, no-store`
- 2xx 以外の応答は本文を読み切ってから文を出す（`no-store` の応答を読まずに捨てると、ブラウザが要求を開いたまま残し、E2E の `networkidle` が止まる。波 3 の学び）
- 編集の頁は触らない（決定 Q20 は作成の頁）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 書き込みの窓口を試しに呼んで 403 かを見る | 表や監査に触る恐れがあり、副作用のある窓口を確かめに使うのは筋が悪い |
| 一覧の窓口（`GET /api/admin/stockists`）を呼ぶ | `admin.stockists.read` で通るので、`manage` を確かめられない。サポーターにもフォームが出る |
| 頁をサーバーの部品にして layout で確かめる | 作成の頁と共通のフォームが client の部品で、作り替えが大きい。画面の守りは 2 段目なので、窓口 1 本で足りる |
| 編集の頁も同じ入口にする | 決定 Q20 は作成の頁。編集は 1 件の取得（読みの権限）が通っており、`read` だけの人にフォームが出るが、書き込みは窓口が断る |

#### 結果

- 良くなること: 未ログインの人と `manage` の無い人（サポーター）に、作成のフォームが見えない
- 悪くなること: 作成の頁を開くたびに窓口を 1 回呼ぶ（読みの枠に数える）。窓口が 1 本増える（管理の窓口は 7 本）。編集の頁は `read` だけの人にもフォームが出る

## 未確認事項

- 編集の頁も入口で `manage` を確かめるか
