# ADR-0259 管理の窓口の回数の制限は送り元と操作者の2本にし、読みと変更で枠を分ける

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/stockist/services/admin-security.ts`、`src/app/api/admin/stockists/` | 基準コミット: `4facf63b`

## 概要

管理の取扱店の窓口は、送り元と操作者の2つの単位で回数を数え、どちらかが枠を超えたら止める。枠は 600 秒ごとに、読みは 120 回、変更は 20 回。2026-04-18 のレビューの指摘で足した。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-007 |
| 対象のコード | `src/features/stockist/services/admin-security.ts`、`src/app/api/admin/stockists/route.ts` |
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
- 送り元の枠を先に見て、通れば操作者の枠を見る。数える名前は読みと変更で分ける
- 権限の確かめの後、操作者が分かってから呼ぶ（`route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 送り元か操作者の片方だけで数える | レビューが「IP と actor 単位」の両方を求めた（`2026-04-18-stockist-review.md`）。送り元だけでは見出しの偽りで抜けられるので操作者の枠を併せる。操作者だけにしなかった理由の記録は無い（推定: 1つの送り元から複数の操作者の token を使う時に、まとめて抑えるため）。回数の制限は認可の後に呼ぶので、送り元の枠も有効な token を持つ要求だけを数え、token の無い要求や権限の無い要求は数えない（THR-STOCKIST-020） |
| 読みと変更を同じ枠にする | レビューが変更をより厳しくするよう求めた |

#### 結果

- 良くなること: 漏れた session でも、変更は 10 分に 20 回までに抑えられる
- 悪くなること: 送り元は共有の回数の制限の部品が `x-forwarded-for` をそのまま信じて決める（`security_review_stockist.md`、Open）。回数の制限が CSRF の確かめより前にあるので、別のサイトからの変更の要求も本人の枠を使う（SEC-STOCKIST-005。ただし proxy の Origin の確かめが先に止める、推定）

## 未確認事項

- 本番の中継が `x-forwarded-for` を上書きするか（本番は未デプロイ）
