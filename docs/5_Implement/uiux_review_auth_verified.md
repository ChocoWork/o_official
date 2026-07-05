# AUTH VERIFIED（/auth/verified・MFA）UI/UX レビュー

- 対象: [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx)
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

## 位置づけ

ログイン後の検証ハブ。一般ユーザーは `/account` へ即リダイレクト、管理/サポーターのみ **TOTP 登録/検証** を行う（≒準管理フロー）。一般ユーザー体験は一瞬。MFA UIは機能本位で実用的だが、配色・一貫性に課題。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| VF-1 | リンク色（[auth/verified/page.tsx:267](../../src/app/auth/verified/page.tsx#L267),[276](../../src/app/auth/verified/page.tsx#L276)） | 「ログインページへ」「アカウントへ」が `text-blue-600`。**Key Color外の青**でブランド世界観から逸脱。ブランド適合/反復 | サイト共通のリンク様式（黒+下線アニメ）に統一 | Mid | 対応済 |
| VF-2 | OTP入力（[auth/verified/page.tsx:328-336](../../src/app/auth/verified/page.tsx#L328-L336)） | 単一テキスト入力。LOGINは8桁セグメント入力で**体験が不一致**。反復/一貫性 | LOGINのセグメントOTPと共通化 | Low | 対応済 |
| VF-3 | シークレット/URI表示（[auth/verified/page.tsx:294-299](../../src/app/auth/verified/page.tsx#L294-L299)） | TOTPシークレット/URIを常時プレーン表示で情報過多・煩雑。認知負荷/Progressive Disclosure | 既定はQR優先、シークレットは「手動入力はこちら」で折りたたみ | Low | 対応済 |
| VF-4 | エラー/状態色（[auth/verified/page.tsx:350](../../src/app/auth/verified/page.tsx#L350)） | `text-red-700`。他ページの赤トークンと不統一。反復 | 共通エラートークンに集約 | Low | 対応済 |
| VF-5 | 進行フィードバック（[auth/verified/page.tsx:259-260](../../src/app/auth/verified/page.tsx#L259-L260)） | loading がテキストのみ。`aria-live` も無い。Doherty/アクセシビリティ | スピナー + `role="status"` | Low | 対応済 |
| VF-6 | factor選択 select（[auth/verified/page.tsx:313-323](../../src/app/auth/verified/page.tsx#L313-L323)） | 素の `<select>`（他は SingleSelect 共通）で見た目/挙動が不統一。反復 | 共通 `SingleSelect` に置換 | Low | 対応済 |

---

## 良い点（維持）

- ロール/MFA状態で分岐（loading/unauthenticated/non-privileged/mfa-challenge）し、状況に応じた案内。
- TOTP の `autoComplete="one-time-code"`/`inputMode="numeric"`、QR表示 + 手動セットアップのフォールバック。
- QRが出ない場合の代替手段（シークレット/URI）案内で詰まりを防ぐ。

---

## implement-uiux に「あえて従わない」判断

- **一般ユーザーには一瞬で通り過ぎる画面**なので、投資はブランド整合（VF-1）と管理者MFA体験の明瞭さに絞る。過剰な演出は不要。
- ※本ページは準管理フローを含むが `/admin` 配下ではないためレビュー対象に含めた（一般ユーザーも経由するため）。

---

## 修正反映（2026-06-23）

- **VF-1**: `text-blue-600` の2リンクをサイト共通の下線リンク（黒・`underline-offset-4`・hover #474747）へ。
- **VF-2**: OTP入力をブランドの認証コード様式（中央寄せ・`tracking`・h-11・`focus:border-black`）に整え、`aria-label` を付与。※LOGINの固定8桁セグメントへの完全共通化は、本フローが可変長（6〜8桁）TOTPを受け付ける点と、重要導線の LoginModal を巻き込むリファクタを避ける観点（surgical changes）から見送り、視覚・操作の一貫性確保に留めた。
- **VF-3**: シークレット/URI/手動手順を `<details>`（「手動で入力する場合はこちら」）に折りたたみ、QRを既定優先に。
- **VF-4**: `text-red-700` → `text-red-600` + `role="alert"`。
- **VF-5**: loading に モノクローム `Spinner` + `role="status"`/`aria-live="polite"`。
- **VF-6**: 素の `<select>` を共通 `SingleSelect`（native・block）へ置換。
- 実装: [src/app/auth/verified/page.tsx](../../src/app/auth/verified/page.tsx)。

---

## 総評（AUTH VERIFIED）

機能は実用的。**青リンクのブランド整合（VF-1）** を最優先に、OTP/選択UIの共通化（VF-2/VF-6）で一貫性を上げると良い。
