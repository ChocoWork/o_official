# ADR-0266 取扱店の管理の応答は route の包みで `private, no-store` にする

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/lib/http/no-store.ts`、`src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` | 基準コミット: `413d8b36`

## 概要

管理の取扱店の 6 つの窓口（一覧・作成・1 件の読み・更新・切り替え・削除）の応答に、`Cache-Control: private, no-store` を付ける。付け方は各 route の `export` を共有の包み `withNoStore(await …)` で返す形にする。`proxy.ts` と `next.config.ts` は変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-010、SEC-STOCKIST-010-AC-01、THR-STOCKIST-010、ARC-STOCKIST-003、DD-STOCKIST-034、DD-STOCKIST-035 |
| 対象のコード | `src/lib/http/no-store.ts`（共有の包み）、`src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` |
| 関連文書 | `docs/02_Requirements/areas/stockist.md`、`docs/05_Quality/security/threats/stockist.md` |
| 調べた時点 | 2026-10-26（単体テストで全分岐の見出しを確かめた。本番ビルドの応答は E2E `FR-STOCKIST-015` が確かめる。流していない） |

## 判断

### ADR-0266 取扱店の管理の応答は route の包みで `private, no-store` にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-010 |
| 根拠 | 非公開の店を含む管理の応答を中継やブラウザのキャッシュに残さず、429 が残って別の利用者まで断られることも防ぐため。窓口の数は増やさず、共有の部品は呼ぶだけにする（`proxy.ts`・`rateLimit.ts` は触らない） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`（R10）、`design-final.md` |

#### 背景

- 共有の包みが無く、領域ごとにばらばらな見出しの付け方になる恐れがあった
- 応答は、認可の 401・403・503、CSRF の拒否、回数の 429・503、検証の 400、404、本体、外側の `catch` の 500 と戻りが多く、1 つずつ見出しを付けると付け漏れが出やすい

#### 決定

- 各ハンドラーを内側の関数（`listStockists` など）に改名し、`export async function GET/POST/PUT/PATCH/DELETE` が `withNoStore(await <内側の関数>(…))` を返す
- `withNoStore` は応答の `Cache-Control` を `private, no-store` に置き換えるだけで、状態・本文・ほかの見出し（`Retry-After`・`Set-Cookie`）は変えない
- 外側の `catch` の記録は `describeErrorForLog`（名前と符号だけ）にする（SEC-STOCKIST-014）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `proxy.ts` で `/api/admin/**` の全部に付ける | 共有部品の変更で、他の領域の窓口にも効く。波 3 で `/api/auth` と管理の他の窓口をまとめて扱う |
| `next.config.ts` の `headers()` で付ける | 共有の設定の変更。route が自分の応答の見出しを持つほうが、試験で全分岐を確かめやすい |
| 各 `return` に `headers` を足す | 付け漏れが出やすい（特に `authz.response` と回数の制限の応答） |

#### 結果

- 良くなること: 全部の戻りが同じ見出しになり、単体テストで全分岐を 1 つずつ確かめられる
- 悪くなること: `proxy.ts` が route に届く前に返す Origin の 403 には付かない（波 3）。`proxy.ts` などが後から別の値で上書きしないかは、本番ビルドの E2E（`FR-STOCKIST-015`）が見出しの値そのものを見て確かめる

## 未確認事項

- 本番ビルドで応答の `Cache-Control` が `private, no-store` のままか（E2E は書いたが流していない）
