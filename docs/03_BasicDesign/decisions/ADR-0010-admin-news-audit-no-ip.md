# ADR-0010 管理のニュースの操作を成功と失敗の両方で監査の記録に残し、IP は残さない

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts` | 基準コミット: `a03beaff`

## 概要

管理のニュースの作成・更新・公開の切り替え・削除と画像の書き込みの失敗を、成功と失敗の両方で監査の記録に残す。IP の見出しの値は残さない。

**置き換え済み（IP の部分）:** 「IP は残さない」の判断は 2026-10-28（波 4）に `ADR-0462` が置き換えた。監査の IP は共有の `getAuditRequestContext`（`getClientIp` の値。偽れる `x-forwarded-for` は読まない。取れなければ `null`）から取って残す（SEC-NEWS-016-AC-03）。成功と失敗の両方を監査に残す点は今も有効なので、この項目の状態は「現行」のまま残し（「廃止」にすると指している項目が `retired-reference` になる）、本文は当時の判断として直さない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | NFR-SEC-005（範囲外）。SEC-NEWS-016 は対象の窓口が「0件は 404」を満たさないので上位にしない |
| 対象のコード | `src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`、`src/lib/audit.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md`、`docs/03_BasicDesign/api/api-spec.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0010 管理のニュースの操作を成功と失敗の両方で監査の記録に残し、IP は残さない

| 属性 | 値 |
| --- | --- |
| 上位 | NFR-SEC-005（範囲外） |
| 根拠 | 権限を使う書き換えの記録が無いと、誰がいつ記事を変えたか・失敗が続いていないかを後から調べられないため（2026-04-18 のレビューの指摘）。IP は `x-forwarded-for` などの見出しを利用者が偽れ、確かめる手段が無いうちは記録しても信用できないので残さない（`route.ts` のコメント） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-actions-news-security-review.md`、`src/app/api/admin/news/route.ts`、git `6896bb16`（2026-04-19） |

#### 背景

2026-04-18 の時点では、管理のニュースの作成・更新・状態の変更・削除が監査の部品を呼んでいなかった。

#### 決定

- 操作ごとに `logAudit` を呼び、操作の名前・行う人・対象・結果・User-Agent と、道・状態・分類などの付けたしを残す
- 本文と IP は入れない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| IP を見出しから取って記録する | 見出しは利用者が偽れ、確かめる道が無い（`route.ts`） |

#### 結果

- 良くなること: 記事の書き換えを後から辿れる
- 悪くなること: 対象の記事が無くても PUT・PATCH・DELETE は 200 を返し、成功と記録する（SEC-NEWS-016-AC-02）
- 文書の `api-spec.md` は POST だけに監査と書き、PUT・PATCH・DELETE の監査を書いていない
- 2026-10-28: IP を残さない点は `ADR-0462` が置き換えた。`logNewsAudit`（`route.ts`・`[id]/route.ts`）が `...getAuditRequestContext(request)` で IP とブラウザの名乗りを渡す。理由は ADR-0462（管理者だけが対象、乗っ取られた session の追跡）。保存期間は法令対応の後回しに従う

## 未確認事項

- 無し
