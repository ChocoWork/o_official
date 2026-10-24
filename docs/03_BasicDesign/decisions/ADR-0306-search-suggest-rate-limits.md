# ADR-0306 検索とサジェストの窓口に回数の制限を掛け、プレビューは別の枠と少ない件数で数える

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/search/route.ts`、`src/app/api/suggest/route.ts` | 基準コミット: `4e84d5c5`

## 概要

`/api/search` と `/api/suggest` は、送り元ごとに600秒の中の回数を数え、上限を超えたら 429 を返す。検索は通常（120回・1種別8件）とプレビュー（20回・1種別3件）で枠と件数を分け、サジェストは200回。プレビューの枠を別にすることは、セキュリティ要件の案（SEC-SEARCH-005）が残る問題に挙げているので「推定」にした。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | SEC-SEARCH-005、FREQ-187-REQ-01 |
| 対象のコード | `src/app/api/search/route.ts`、`src/app/api/suggest/route.ts`、`src/features/auth/middleware/rateLimit.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`docs/02_Requirements/requirements.md`（FREQ-187）、`docs/05_Quality/reviews/security/security_review_search.md`、git `0b543bc7`、`docs/03_BasicDesign/decisions/ADR-0009-rate-limit-fail-closed.md` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0306 検索とサジェストの窓口に回数の制限を掛け、プレビューは別の枠と少ない件数で数える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-005、FREQ-187-REQ-01 |
| 根拠 | 認証の無い窓口で、集め取り・語の列挙・負荷の試しを安く繰り返せるとレビューが指摘した（Important）。1回の検索で3つの関数と人気商品と署名を呼ぶので、回数を絞る。ホームのプレビューは小さな取り出しなので件数を3にし、通常の検索とは別の枠で数えるのが「本来意図された値」と FREQ-187 が書く |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`docs/02_Requirements/requirements.md`（FREQ-187）、git `0b543bc7` |

#### 背景

- 2026-04-18 のレビューは、search・suggest に回数の制限も異常の記録も無いことを挙げた
- その後、preview の読み方が `z.coerce.boolean()` だったため文字の `'false'` も真になり、通常の検索がプレビューの枠（20回・3件）で数えられていた（FREQ-187）

#### 決定

- 検索は、preview が文字の `'true'` の時だけプレビューとし、ほかの値は通常の検索にする（`route.ts`）
- 通常の検索は `search:public` の枠で120回／600秒・1種別8件、プレビューは `search:preview` の枠で20回／600秒・1種別3件
- サジェストは `suggest:public` の枠で200回／600秒・8件（`suggest/route.ts`）
- 数える場所の DB が使えない時は 503 で断る（`rateLimit.ts`、ADR-0009）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 回数の制限を掛けない | 公開のデータのまとめての収集と負荷を安く繰り返せる（レビュー） |
| `z.coerce.boolean()` で preview を読む | `'false'` も真になり、通常の検索がプレビューの枠と件数に落ちた（FREQ-187） |
| 通常とプレビューを1つの枠で数える | 採らなかった理由の記録は無い。FREQ-187 は枠を分けた形を前提に書く |

#### 結果

- 良くなること: 上限を超えると 429 と `Retry-After` が返る
- 悪くなること: preview は呼び手が決めるので、1つの送り元で2つの枠を合わせて140回使える（SEC-SEARCH-005）
- 悪くなること: 画面はサジェストを1文字ごとに、検索をタブの切り替えごとに呼ぶ（`src/features/search/components/SearchPageClient.tsx`）。普通の利用者が上限に届くことがある（推定）
- 残ること: 送り元は `x-forwarded-for` の先頭をそのまま信じる（`rateLimit.ts`、SEC-SEARCH-006）。レビューが一緒に求めた異常の記録（`logAudit`）は入れていない
- 残ること: PostgREST から検索の関数を直接呼ぶ道はこの制限を通らない（ADR-0302）
- サジェストの200回の値は、文書に記録が無い

## 未確認事項

- プレビューの枠を別にしたままにするか（SEC-SEARCH-005 は推定の案）
- 本番の前段（Vercel など）が `x-forwarded-for` をどう渡すか
