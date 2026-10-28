# ADR-0158 管理の LOOK の変更は、LOOK 用の記録の関数を通して成功と失敗の両方を監査に残し、送り元は端末の名乗りだけを残す

> 状態: 推定 | 確認日: 2026-10-28 | 対象: `src/features/look/services/admin-audit.ts`、`src/app/api/admin/looks/route.ts`、`src/app/api/admin/looks/[id]/route.ts` | 基準コミット: `4facf63b`

## 概要

管理の LOOK の作成・更新・公開の切り替え・削除は、成功も失敗も、LOOK 用の記録の関数を通して共有の監査の記録に残す。記録には操作者・操作・対象の LOOK・結果・端末の名乗り（user-agent）を入れ、IP は入れない。

**置き換え済み（IP の部分）:** 「IP は入れない」の判断は 2026-10-28（波 4）に `ADR-0462` が置き換えた。`logAdminLookAudit` は共有の `getAuditRequestContext`（`getClientIp` の値。偽れる `x-forwarded-for` は読まない。取れなければ `null`）で IP も渡す（SEC-LOOK-020）。成功と失敗の両方を LOOK 用の関数で残す点は今も有効なので、この項目の状態は変えず（「廃止」にすると指している項目が `retired-reference` になる）、本文は当時の判断として直さない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | FR-ADMIN-005、NFR-SEC-005（範囲外）（SEC-LOOK-020 は IP を残すので 2026-10-28 から満たす。「結果」を参照） |
| 対象のコード | `src/features/look/services/admin-audit.ts`、`src/app/api/admin/looks/route.ts`（失敗の記録の例）、`src/lib/audit.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-look-review.md`、`docs/05_Quality/reviews/security/security_review_look.md`、NEWS の同じ形の判断 `ADR-0010-admin-news-audit-no-ip.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0158 管理の LOOK の変更は、LOOK 用の記録の関数を通して成功と失敗の両方を監査に残し、送り元は端末の名乗りだけを残す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ADMIN-005、NFR-SEC-005（範囲外） |
| 根拠 | 管理の LOOK の変更に跡が残らないとコードのレビューが Must Fix とし（`2026-04-18-look-review.md`）、LOOK タブの作成・編集・削除・公開の切り替え（FR-ADMIN-005）を、誰がいつしたか後から追えるようにするため（全体の監査ログの決まり NFR-SEC-005）。窓口ごとに書き方がばらつかないよう、資源の名前と項目の詰め方を1つの関数にまとめた（推定） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-look-review.md`、`docs/05_Quality/reviews/security/security_review_look.md`（Fixed）、実装から推定（`src/features/look/services/admin-audit.ts`）。IP を残さない理由の記録は無い |

#### 背景

- 管理の LOOK の窓口に監査の記録が無かった（Must Fix）
- 共有の監査の記録は IP を受けられる（`src/lib/audit.ts`）

#### 決定

- LOOK 用の関数は、資源の名前を `look` に決め、対象の ID を文字にし、端末の名乗りを要求から取って共有の記録に渡す（`admin-audit.ts`）
- 窓口は成功の時と、検証・画像・DB の失敗の時に呼ぶ（例 `route.ts`）
- IP は渡さない（`admin-audit.ts` に IP の項目が無い）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 窓口ごとに共有の記録を直に呼ぶ | 資源の名前と項目の詰め方が窓口ごとにずれる（推定） |
| IP も残す | 残さない理由の記録は無い。共有の回数の制限の送り元は偽れる（ADR-0154）ので、記録しても頼れない（推定） |

#### 結果

- 良くなること: 管理の LOOK の変更を、成功も失敗も後から追える
- 悪くなること: SEC-LOOK-020 は「送り元とともに」残すと書くが、送り元は端末の名乗りだけで、乗っ取られた session の変更を送り元の IP から辿れない。SEC-LOOK-020 は満たさないので、上位にしない。Data API から LOOK の表を直に書くと、この記録を通らない（推定）
- 見直す条件: 送り元の IP を信頼できる形で取れるようになった時、DB の側でも変更の記録を残す時
- 2026-10-28: 「送り元の IP を信頼できる形で取れる」条件が `getClientIp`（ADR-0416）で満たされ、`ADR-0462` が IP を残す判断をした。SEC-LOOK-020 は満たすので、構造設計 `ARC-LOOK-002` の上位に入れた。保存期間は法令対応の後回しに従う

## 未確認事項

- IP を残さないことをユーザーが決めた記録（無かった。2026-10-28 に ADR-0462 で、残すことをユーザーが決めた＝決定 Q13）
