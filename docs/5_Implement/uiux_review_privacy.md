# PRIVACY（プライバシーポリシー）UI/UX レビュー

- 対象: [src/app/privacy/page.tsx](../../src/app/privacy/page.tsx)
- 共通 Header/Footer は [uiux_review_home.md](./uiux_review_home.md) を参照
- レビュー基準: `implement-uiux` + ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| 未対応 | 未着手 |
| 対応中 | 一部対応・設計検討中 |
| 対応済 | 修正完了 |

---

## ペルソナ適合サマリー

透明性を重んじる層には、プライバシー方針の**正確さと連絡先の実在性**が信頼に効く。体裁は terms と同様に端正だが、見出し階層・プレースホルダ連絡先・日付に課題（terms と共通）。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| PV-1 | 見出し階層（[privacy/page.tsx:27](../../src/app/privacy/page.tsx#L27),[31](../../src/app/privacy/page.tsx#L31) 他） | ページ題が `h2`、各節が `h5`。**h1不在 + 階層飛び**。WCAG 1.3.1/2.4.6/SEO | ページ題を h1、各節を h2 へ | Mid | 対応済 |
| PV-2 | 連絡先（[privacy/page.tsx:86-88](../../src/app/privacy/page.tsx#L86-L88)） | `privacy@lefildesheures.com` / `Tel: 03-1234-5678` がプレースホルダ風。実在性が疑われ信頼低下。正確性 | 実際の窓口情報に更新 | Mid | 対応済 |
| PV-3 | 連絡先リンク化（[privacy/page.tsx:87-88](../../src/app/privacy/page.tsx#L87-L88)） | メール/電話がテキストのみ（`mailto:`/`tel:` 無し）。Fitts/モバイル | `mailto:`/`tel:` リンク化 | Low | 対応済 |
| PV-4 | 制定/改定日（[privacy/page.tsx:92](../../src/app/privacy/page.tsx#L92)） | 「2024年1月1日」でブランド設立(2026)と矛盾。正確性 | 実際の日付に更新 | Low | 対応済 |
| PV-5 | Cookie/解析の記載 | EC直販でアクセス解析・決済（Stripe）等を使う想定だが、Cookie/第三者ツールの記述が薄い。正確性/透明性 | Cookie・解析・決済処理者（Stripe等）の取扱いを追記 | Low | 対応済 |
| PV-6 | 目次/読み幅（[privacy/page.tsx:26](../../src/app/privacy/page.tsx#L26)） | 長文に目次無し・`max-w-4xl` で行長やや長い。可読性/探索負荷 | 目次アンカー + 本文の行長最適化 | Low | 対応済 |

---

## 良い点（維持）

- 節構造・箇条書き・余白リズムが端正でモノクロームの落ち着いた可読性。`--lk-size-*` トークン使用で一貫。

---

## implement-uiux に「あえて従わない」判断

- 法務本文の小型タイポは許容（editorial 方針）。装飾は不要。ただし**行長と見出し階層は最適化**（可読性・アクセシビリティは死守）。

---

## 修正反映（2026-06-20）

- **PV-1（対応済）**: ページ題を h1、各節を h2 に修正。
- **PV-2 / PV-3（対応済）**: プレースホルダのメール/電話を撤廃し、**お問い合わせフォーム（/contact）へ集約**（ユーザー方針）。
- **PV-4（対応済）**: 制定日・最終改定日を 2026年6月20日 に更新。
- **PV-5（対応済）**: 「Cookie 及び外部サービスの利用」節を新設（Cookie＝ログイン保持/カート、決済処理は Stripe へ提供）。
- **PV-6（対応済 / 2026-06-23）**: h1 直下に目次（7節へのアンカー）を新設し、各節へ `id`（`privacy-1`〜`-7`）+ `scroll-mt-24` を付与。本文・目次の読み幅を `max-w-[68ch]` に絞り行長を最適化。
- 実装: [src/app/privacy/page.tsx](../../src/app/privacy/page.tsx)。

---

## 総評（PRIVACY）

terms と同じく**見出し階層（PV-1）と正確性（PV-2/PV-4/PV-5）** が要点。透明性を売りにするブランドだからこそ、プレースホルダの連絡先・日付は早期に実データへ。
