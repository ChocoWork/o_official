# ADR-0258 管理の取扱店の DB の操作は利用者の session の client で行い、RLS の権限を効かせる

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` | 基準コミット: `4facf63b`

## 概要

管理の取扱店の窓口は、DB の読み書きを service role でなく、要求の利用者の session の client で行う。DB の RLS が取扱店の権限で最後に拒めるようにする。2026-04-18 のレビューの指摘で直した。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | SEC-STOCKIST-006、FR-ADMIN-006。SEC-STOCKIST-003 はこの判断では満たさない（「結果」を参照）ので上位にしない |
| 対象のコード | `src/app/api/admin/stockists/route.ts`、`src/app/api/admin/stockists/[id]/route.ts` |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`、`supabase/migrations/20260901102912_remote_schema.sql`、`supabase/migrations/20261023175712_group_g0_permissions.sql` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0258 管理の取扱店の DB の操作は利用者の session の client で行い、RLS の権限を効かせる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-STOCKIST-006、FR-ADMIN-006 |
| 根拠 | 窓口の認可に欠陥が入っても、DB の RLS で拒めるようにするため。service role では RLS を素通りし、DB の方針が最後の守りにならない、と 2026-04-18 のレビュー（Important 4）が指摘した |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-stockist-review.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`（RLS バイパス、Fixed） |

#### 背景

- 当時の管理の窓口は、いつも service role の client を使っていた（`2026-04-18-stockist-review.md`）
- 表の RLS は、取扱店の閲覧・管理の権限で読み・作る・直す・消すを許す（`remote_schema.sql`）

#### 決定

- 6つの窓口とも、要求の利用者の session の client で読み書きする（`route.ts`、`[id]/route.ts`）
- 窓口の認可（ADR-0262）を通った後に、DB の RLS がもう一度権限を見る

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| service role の client を使い続ける | RLS を素通りし、窓口の認可の欠陥を DB で止められない（`2026-04-18-stockist-review.md`） |

#### 結果

- 良くなること: 窓口と DB の2段で権限を確かめる
- 悪くなること: DB の権限の判定は ACL だけを見て、2要素認証の済み（aal2）と session が有効かを見ない（`20261023175712_group_g0_permissions.sql`）。窓口はどちらも見る（`src/lib/auth/admin-rbac.ts`）。店長の access token で DB の API を直に呼ぶ道は、窓口の回数の制限・CSRF・監査・aal2 を通らない。SEC-STOCKIST-003 の求める形と合わない（推定）
- 2026-10-26: 書き込み（POST・PUT・PATCH・DELETE）は、認可の後に service role で行う形に ADR-0267 が置き換えた。読み（GET の2つ）はこの判断のまま

## 未確認事項

- 2要素認証を済ませていない token で DB の API を直に呼べるか（動かしていない）
