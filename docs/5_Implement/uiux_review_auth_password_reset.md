# PASSWORD RESET（/auth/password-reset）UI/UX レビュー

- 対象: [src/app/auth/password-reset/page.tsx](../../src/app/auth/password-reset/page.tsx)
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

困っているユーザーの回復導線。摩擦と不安を最小化したい。申請/確定の2モード、Turnstile、h1ありと基本は良好。改善はパスワード入力体験と配色。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| PR-1 | 新パスワード入力（[password-reset/page.tsx:192-200](../../src/app/auth/password-reset/page.tsx#L192-L200)） | 表示/非表示トグルが無く、要件（最小文字数等）も非表示。入力ミス・不安。エラー防止/認知負荷 | show/hideトグル + 要件のヒント表示（schemaの条件を明示） | Mid | 対応済 |
| PR-2 | 成功色（[password-reset/page.tsx:219](../../src/app/auth/password-reset/page.tsx#L219)） | `text-green-600` の有彩色。Key Color外。ブランド適合 | 成功はチェックアイコン+黒文字へ | Low | 対応済 |
| PR-3 | autoComplete（[password-reset/page.tsx:182-200](../../src/app/auth/password-reset/page.tsx#L182-L200)） | email/new password に `autoComplete`（email / new-password）未指定。パスワードマネージャ連携/オートフィル | `autoComplete="email"`/`"new-password"` 付与 | Low | 対応済 |
| PR-4 | 成功後の導線（[password-reset/page.tsx:156-159](../../src/app/auth/password-reset/page.tsx#L156-L159)） | 更新成功後「ログインしてください」表示のみで**ログインへのリンク/ボタンが無い**。次アクション/Peak-End | 「ログインへ」CTAを表示 | Mid | 対応済 |
| PR-5 | 状態通知の aria（[password-reset/page.tsx:218-219](../../src/app/auth/password-reset/page.tsx#L218-L219)） | error/message に `role="alert"`/`role="status"` 無し。アクセシビリティ | 役割属性を付与 | Low | 対応済 |
| PR-6 | エラー集約表示（[password-reset/page.tsx:90-95](../../src/app/auth/password-reset/page.tsx#L90-L95)） | Zodのissuesを space 連結で1行表示。複数エラーが読みづらい。可読性 | フィールド単位 or 箇条書きで表示 | Low | 対応済 |

---

## 良い点（維持）

- 申請（request）/確定（confirm）の2モードをセッション解決で自動判定し、1ページで完結。
- `TextField`（共通コンポーネント）+ h1 + Turnstile ボット検証。送信中ラベル変化。
- 確定モードでは email を読み取り専用化し誤操作防止。

---

## implement-uiux に「あえて従わない」判断

- 成功=緑は不採用（PR-2）。モノクローム純度を優先（エラー赤のみ最小限許容）。
- ボット検証(Turnstile)はブランド表現より**安全性優先**で維持。

---

## 修正反映（2026-06-23）

- **PR-1**: NEW PASSWORD に `helperText="8文字以上128文字以内"`（schema要件）を表示し、直下に「パスワードを表示／非表示」トグル（`aria-pressed`、`type` 切替）を追加。
- **PR-2**: 成功メッセージを `text-green-600` から ✓（`aria-hidden`）+ 黒文字へ。
- **PR-3**: email に `autoComplete="email"`、新パスワードに `autoComplete="new-password"` を付与。
- **PR-4**: 確定成功後に `resetComplete` で「ログインへ」リンク（/login）を表示。文言は「パスワードを更新しました。」に簡素化。
- **PR-5**: error に `role="alert"`、message に `role="status"` を付与。
- **PR-6**: Zod issues を `'\n'` 連結 + `whitespace-pre-line` で改行表示に変更。
- 実装: [src/app/auth/password-reset/page.tsx](../../src/app/auth/password-reset/page.tsx)。

---

## 総評（PASSWORD RESET）

基盤は良好。**パスワード入力体験（PR-1）と成功後のログイン導線（PR-4）** を足し、配色（PR-2）を整えれば回復フローとして十分。
