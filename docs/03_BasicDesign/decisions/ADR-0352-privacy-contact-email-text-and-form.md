# ADR-0352 窓口の節は事業者名とメールを字で出し、お問い合わせフォームへの入口も置く

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/privacy/page.tsx` | 基準コミット: `4e84d5c5`

## 概要

「12. お問い合わせ窓口」に、事業者名とメールの宛先を字で出し、その下に `/contact` のお問い合わせフォームへの内部のリンクを置く。メールの宛先はリンクにしない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY |
| 対応する ID | FREQ-100-REQ-01、DRV-PRIVACY-004 |
| 対象のコード | `src/app/privacy/page.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-100）、`docs/05_Quality/reviews/uiux/uiux_review_privacy.md`（PV-2・PV-3）、`docs/05_Quality/reviews/security/security_review_privacy.md` |
| 試験 | `e2e/FR-PRIVACY-001-policy-content.spec.ts`、`e2e/FR-PRIVACY-003-additional-legal-sections.spec.ts`（窓口のメール）、`tests/unit/components/PrivacyPage.test.tsx` |
| 要件の文書 | `docs/02_Requirements/areas/privacy.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0352 窓口の節は事業者名とメールを字で出し、お問い合わせフォームへの入口も置く

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-100-REQ-01、DRV-PRIVACY-004 |
| 根拠 | 開示などの請求（10 節）の宛先を本人が分かるよう、FREQ-100-REQ-01 は窓口に事業者名とメールを置くと決めた。その前に uiux のレビューで、ユーザーの方針として連絡先をお問い合わせフォームに集めたので、フォームへの入口も残っている（`uiux_review_privacy.md`）。メールをリンクにしない理由の記録は見つけていない |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（ユーザーの依頼）、`docs/05_Quality/reviews/uiux/uiux_review_privacy.md`（ユーザー方針）、実装から推定 |

#### 背景

- 2026-06-20 の uiux のレビューは、窓口のメールと電話が見本の値のように見えると指摘した（PV-2）。リンクにする案（PV-3）も出たが、ユーザーの方針で連絡先を `/contact` に集めた（`uiux_review_privacy.md`）
- その後の FREQ-100 で、同業のブランドの頁に倣い、窓口の節に事業者名とメール窓口を置くことになった（`requirements.md`、FREQ-100-AC-02 はメールの字が出ることを求める）

#### 決定

- 12 節に「事業者名：Le Fil des Heures」と「お問い合わせ先：privacy@lefildesheures.com」を、一覧の字として出す（`page.tsx`）
- その下に `/contact` への内部のリンク「お問い合わせフォーム」を置く（`page.tsx`）
- メールの宛先は `mailto:` のリンクにしない。電話は出さない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| フォームだけにする（2026-06-20 の方針） | FREQ-100-REQ-01 がメール窓口を求める。開示などの請求の宛先として、メールの字が要る |
| メールを `mailto:` のリンクにする（PV-3 の提案） | 退けた理由の記録は無い（推定）。security のレビューは平文のメールが機械に集められやすいと指摘したが（`security_review_privacy.md`）、リンクにするかどうかとの関係は書いていない |

#### 結果

- 良くなること: 本人がメールとフォームのどちらからでも請求や問い合わせができる
- 悪くなること: メールの字は機械に集められやすく、迷惑メールが増えうる（THR-PRIVACY-010、SEC-PRIVACY-018）
- 悪くなること: `privacy@lefildesheures.com` を受け取る箱が在るか、受け手と応える期間はどの文書にも無い（SEC-PRIVACY-017）
- 文書: uiux のレビューは PV-2・PV-3 を「メールを撤廃しフォームへ集約」で対応済とするが、今はメールも出す
- 見直す条件: 窓口のメール箱と運用の手順を決める時、迷惑メールが増えた時

## 未確認事項

- メールをリンクにしないのが決めた事か、FREQ-100 を足した時の成り行きか
- 本番に窓口のメール箱が在るか
