# ADR-0009 回数の制限の数え場所が使えない時は断る側に倒す（503）

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/news/route.ts`、`src/features/auth/middleware/rateLimit.ts`（範囲外の共有部品） | 基準コミット: `a03beaff`

## 概要

回数の制限の数え場所の DB で失敗した時は、要求を通さず `503 Rate limiter unavailable` を返す。`/api/news` もこの共有の部品に従う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | SEC-NEWS-009 |
| 対象のコード | `src/features/auth/middleware/rateLimit.ts`（範囲外の共有部品）、`src/app/api/news/route.ts` |
| 関連文書 | `docs/03_BasicDesign/api/api-spec.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0009 回数の制限の数え場所が使えない時は断る側に倒す（503）

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-NEWS-009 |
| 根拠 | 数え場所が落ちた時に通す側へ倒すと、その間は回数の制限が無いのと同じになり、吸い出しや認証への攻撃を止められないため（コードのコメント「fail-closed to preserve authentication abuse protection」。文書の記録は無い） |
| 状態 | 推定 |
| 出どころ | `src/features/auth/middleware/rateLimit.ts`（コードのコメント）、実装から推定 |

#### 背景

回数の制限は認証の窓口と共有の部品で、呼ばれるたびに数えの行を DB に足して数える（`rateLimit.ts`）。数え場所が落ちた時の扱いを決める必要があった。

#### 決定

- 数える処理で例外が出たら、`503` と `Retry-After`（窓の秒数）を返す（`rateLimit.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 数え場所が落ちた時は通す（fail-open） | 文書の記録は無い。コードのコメントは、認証への攻撃の守りを保つために閉じる側を選んだと書く |

#### 結果

- 悪くなること: 数え場所の障害の間、`/api/news` は 503 になる。`api-spec.md` は 429・500 だけを書き、503 が無い
- 悪くなること: 429・503 の応答に `Cache-Control: no-store` が無い（SEC-NEWS-006）
- 共有の部品の判断なので、NEWS の側だけでは変えない

## 未確認事項

- 数え場所の障害の時の `/api/news` の応答は試していない
- 判断の理由はユーザーの確認を受けていない
