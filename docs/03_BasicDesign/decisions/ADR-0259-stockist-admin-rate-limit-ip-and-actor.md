# ADR-0259 管理の窓口の回数の制限は送り元と操作者の2本にし、読みと変更で枠を分ける

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/features/stockist/services/admin-security.ts`、`src/app/api/admin/stockists/` | 基準コミット: `4facf63b`

## 概要

管理の取扱店の窓口は、送り元と操作者の2つの単位で回数を数え、どちらかが枠を超えたら止める。枠は 600 秒ごとに、読みは 120 回、変更は 20 回。2026-04-18 のレビューの指摘で足した。2026-10-28（波 4）に、送り元の枠を認可の前、操作者の枠を認可の後に分けた。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-007、SEC-STOCKIST-020 |
| 対象のコード | `src/features/stockist/services/admin-security.ts`、`src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts`、`src/app/api/admin/stockists/access/route.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`、`tests/unit/api/admin/stockists-security.test.ts` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0259 管理の窓口の回数の制限は送り元と操作者の2本にし、読みと変更で枠を分ける

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-007 |
| 根拠 | 管理の token や session が漏れた時に、短い時間で大量の列挙・書き換え・削除をさせないため。2026-04-18 のレビュー（Priority 1 の2）が「送り元と操作者の単位で制限し、変更はより厳しい枠に分ける」よう求めた |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md` |

#### 背景

- 当時の窓口には回数の制限が無かった（`2026-04-18-stockist-review.md`）

#### 決定

- 枠の長さは 600 秒、読みは 120 回、変更は 20 回（`admin-security.ts`）
- 数える名前は読みと変更で分ける（`admin:stockists:read`・`admin:stockists:mutation`）
- 送り元の枠（`enforceAdminStockistIpRateLimit(request, kind)`、subject なし）は窓口の最初、認可の前に呼ぶ。操作者の枠（`enforceAdminStockistActorRateLimit(request, actorId, kind)`）は認可の後、操作者が分かってから呼ぶ。限度・窓・名前は 2 つで同じ（SEC-STOCKIST-020、2026-10-28）
- 窓口の順序は「送り元の枠 → （道の id の形）→ 認可 → 操作者の枠 → （変更だけ）CSRF」。送り元の枠は道の id の形の検査より前に置き、形の悪い id の連打も数える

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 送り元か操作者の片方だけで数える | レビューが「IP と actor 単位」の両方を求めた（`2026-04-18-stockist-review.md`）。送り元だけでは見出しの偽りで抜けられるので操作者の枠を併せる。操作者だけにしなかった理由の記録は無い（推定: 1つの送り元から複数の操作者の token を使う時に、まとめて抑えるため）。2026-10-28 より前は回数の制限を認可の後に呼んだので、token の無い要求や権限の無い要求を数えなかった（THR-STOCKIST-020）。送り元の枠を認可の前に移して直した |
| 送り元の枠も認可の後に置いたままにする | 認可で断られる要求も session の生存の確かめと ACL の照会で DB を往復させる。断られる要求の量を抑えられない（SEC-STOCKIST-020） |
| 送り元の枠を認可の前、操作者の枠も同じ前に置く | 操作者は認可の後でなければ分からない |
| 読みと変更を同じ枠にする | レビューが変更をより厳しくするよう求めた |

#### 結果

- 良くなること: 漏れた session でも、変更は 10 分に 20 回までに抑えられる
- 良くなること（2026-10-28）: 未ログインの 401・権限の無い 403 の連打も、送り元ごとに止まる
- 悪くなること（2026-10-28）: 送り元の枠は未ログインの 401・権限の無い 403・CSRF の拒否も数えるので、同じ送り元の店長が巻き添えで 429 になりうる（Vercel では送り元は単一の接続元）
- 悪くなること: 送り元は共有の回数の制限の部品が決める。以前は `x-forwarded-for` をそのまま信じていた（`security_review_stockist.md`、Open）が、2026-10-28（波 4 の Task 2）に共有の `getClientIp` が Vercel の見出しだけから取る形に直した（ADR-0416）。回数の制限が CSRF の確かめより前にあるので、別のサイトからの変更の要求も本人の枠を使う（SEC-STOCKIST-005。ただし proxy の Origin の確かめが先に止める、推定）

## 未確認事項

- 本番の中継（Vercel）が `x-vercel-forwarded-for`・`x-real-ip` を上書きするか（本番は未デプロイ。ADR-0416）
