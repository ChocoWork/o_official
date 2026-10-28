# ADR-0261 管理の取扱店の変更は、成功・入力の誤り・DB の誤りの全部を監査の記録に残す

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` | 基準コミット: `4facf63b`

## 概要

管理の取扱店を作る・直す・公開を切り替える・消す時は、成功・入力の誤り・DB の誤りのどれでも監査の記録に残す。操作者・対象・結果・要約・送り元・ブラウザの名を書く。2026-04-18 のレビューの指摘で足した。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FR-ADMIN-006、NFR-SEC-005（範囲外）、NFR-SEC-011（範囲外）。SEC-STOCKIST-012・021 は 2026-10-28（波 4）に満たした（ADR-0416・ADR-0268）。SEC-STOCKIST-013 は 2026-10-26 に満たした |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/code/2026-04-29-stockist-review-addendum.md`、`docs/03_BasicDesign/decisions/ADR-0010-admin-news-audit-no-ip.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0261 管理の取扱店の変更は、成功・入力の誤り・DB の誤りの全部を監査の記録に残す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-006、NFR-SEC-005（範囲外）、NFR-SEC-011（範囲外） |
| 根拠 | 不正や誤った操作を後から追い、公開の状態の変わりを確かめられるようにするため。2026-04-18 のレビュー（Important 3）が、成功と失敗の両方を操作者・対象・変えた中身の要約とともに残すよう求めた |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md` |

#### 背景

- 当時は作る・直す・公開の切替・消すのどれも監査の記録を残していなかった（`2026-04-18-stockist-review.md`）

#### 決定

- 4つの変更で、共有の監査の記録の部品を呼ぶ。結果は成功・入力の誤り・DB の誤りの3つ。消す操作には入力が無いので、成功と DB の誤りの2つ（`route.ts`、`[id]/route.ts`）
- 書く項目は、操作者の id とメール、対象（取扱店と id）、結果、要約（作った・直した店舗名、切り替えた先の状態、消した id）、送り元、ブラウザの名

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 記録を残さない（当時の形） | 誤った操作や不正の追跡、公開の状態の変わりの確かめができない（`2026-04-18-stockist-review.md`） |
| DB の trigger で記録する | レビューは「検討」とした。採っていない。理由の記録は無い |

#### 結果

- 良くなること: 誰がいつ何を変え、失敗したかを後から追える
- 悪くなること: 送り元は 2026-10-28（波 4）より前は `x-forwarded-for` の先頭をそのまま使い、偽れた（`2026-04-29-stockist-review-addendum.md`）。今は `getClientIp`（Vercel の見出しだけ。ADR-0416）から取り、取れなければ null のまま残す（SEC-STOCKIST-012）。NEWS の管理も 2026-10-28 に送り元を残すようにした（ADR-0462 が ADR-0010 を置き換える）ので、形がそろった。要約の店舗名の制御文字は共有の `maskAuditEvent` が除く。認可で断った要求のうち操作者が分かる物は `auditAuthzDenial` で別に残す（SEC-STOCKIST-021、ADR-0268）。無い id への変更の扱いは SEC-STOCKIST-013（2026-10-26 に満たした）

## 未確認事項

- 監査の保存期間と開示（法令対応の後回し。ADR-0462）
