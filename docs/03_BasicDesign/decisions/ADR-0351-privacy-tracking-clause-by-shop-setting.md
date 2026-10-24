# ADR-0351 委託の一覧の 17TRACK の一文は、鍵の有無でなくショップの追跡の設定がオンの時だけ出す

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/privacy/page.tsx` | 基準コミット: `4e84d5c5`

## 概要

「5. 個人情報の取扱いの委託」の一覧に配送の追跡（17TRACK）の一文を出す条件は、ショップの設定のオン・オフだけにする。17TRACK の鍵が設けてあるかは条件にしない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 対応する ID | SEC-PRIVACY-006、DRV-PRIVACY-002、FREQ-495-REQ-01（範囲外）、FREQ-490-REQ-01（範囲外） |
| 対象のコード | `src/app/privacy/page.tsx`、`src/lib/orders/tracking/delivery-store.ts`（範囲外の配送の追跡の部品。鍵の欄を返さない） |
| 関連文書 | `docs/superpowers/specs/2026-10-21-delivery-status-design.md`（決定 24・25）、`docs/superpowers/plans/2026-10-21-delivery-status.md`、`docs/04_DetailDesign/pages/17_privacy.md` |
| 試験 | `tests/unit/components/PrivacyPage.test.tsx`、範囲外の E2E `e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/privacy.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0351 委託の一覧の 17TRACK の一文は、鍵の有無でなくショップの追跡の設定がオンの時だけ出す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-006、DRV-PRIVACY-002、FREQ-495-REQ-01（範囲外）、FREQ-490-REQ-01（範囲外） |
| 根拠 | 17TRACK に配送事業者名と伝票番号を渡すのは、追跡がオンの間だけ（FREQ-490-REQ-01（範囲外）の「初期オフとし、オンの時だけ登録・読み直し・期限を処理」）。渡していない時に渡すと書かないため（配送の追跡の追加の設計の決定 25）。鍵があってもオフなら渡さず、鍵の有無では実際に渡すかが決まらない |
| 状態 | 現行 |
| 出どころ | `docs/superpowers/specs/2026-10-21-delivery-status-design.md`（決定 25）、`docs/04_DetailDesign/pages/17_privacy.md`、`docs/superpowers/plans/2026-10-21-delivery-status.md` |

#### 背景

- 配送の追跡の追加で 17TRACK による配送の追跡を足した。追跡は初期オフで、店長が管理の画面で切り替える（FREQ-495-REQ-01（範囲外））
- 鍵が無い時は設定の窓口がオンを断る（決定 24、`2026-10-21-delivery-status-design.md`）。それでも、鍵を後から外すなどで「オンで鍵が無い」状態はありうる

#### 決定

- 一文は `page.tsx` の定数に持ち、ショップの設定の `enabled` が真の時だけ一覧の2番目の項目として出す（`page.tsx`）。オフの時の一覧は今の3項目のまま
- 頁が読む設定の形は、鍵の欄（`keyConfigured`）を外した物（`delivery-store.ts`）なので、頁は鍵の有無を見られない
- 文は「配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません」と、渡す中身を限って書く

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 鍵が設けてあれば一文を出す | 鍵があってもオフなら 17TRACK に渡さない。渡していない先を公表する（`17_privacy.md`、計画 `docs/superpowers/plans/2026-10-21-delivery-status.md` の「鍵なしでもONなら委託文を出す」） |
| 追跡の有無に依らず一文を常に出す | 決定 25 の「渡していない時に、渡すと書かない」に反する |

#### 結果

- 良くなること: 公表する委託の一覧が、実際に 17TRACK へ渡しているかと合う
- 悪くなること: 一覧の中身が設定で変わるので、頁を request のたびに描く必要がある（ADR-0350）。一覧が変わっても「最終改定日：2026年7月11日」は固定の字のまま変わらない（`page.tsx`、SEC-PRIVACY-012）
- 17TRACK の運営会社名と国を委託・国外移転の文に入れるかは、ユーザーの開店前の確認を待っている（`17_privacy.md`、`2026-10-21-delivery-status-design.md`）
- 見直す条件: 追跡をオンにして開店する時、委託先の書き方を法務が決めた時

## 未確認事項

- 追跡を切り替える E2E は店全体の設定を変えるので、`/privacy` の一覧を見る E2E を足す時は並列の揺れに注意が要る（`e2e/FR-ACCOUNT-043-delivery-visibility.spec.ts`）
