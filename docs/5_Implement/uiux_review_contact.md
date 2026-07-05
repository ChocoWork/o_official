# CONTACT（お問い合わせ）UI/UX レビュー

- 対象: [src/app/contact/page.tsx](../../src/app/contact/page.tsx)
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

「作り手とつながりたい」層には問い合わせ体験も信頼の一部。フォームは**バリデーション・アクセシビリティが非常に丁寧**で全ページ随一。改善は「エラー二重表示」「モーダルのフォーカス管理」「配色」程度。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| CN-1 | エラー二重表示（[contact/page.tsx:204-208](../../src/app/contact/page.tsx#L204-L208) 他） | `TextField` の `errorText` と、その下の `<p role="alert">` で**同じエラーが2回**描画される可能性。視覚ノイズ/反復 | どちらか一方に統一（TextField内に集約推奨） | Mid | 対応済 |
| CN-2 | サンクスモーダル（[contact/page.tsx:296-306](../../src/app/contact/page.tsx#L296-L306)） | `role="dialog"`/`aria-modal` は付くが、**フォーカス移動・フォーカストラップ・Escで閉じる**が無い。背景クリックでも閉じない。WCAG/インタラクション | 開いたら閉じるボタンへフォーカス、Tabトラップ、Esc/背景クリックで閉じる | Mid | 対応済 |
| CN-3 | 成功色（[contact/page.tsx:287](../../src/app/contact/page.tsx#L287)） | `text-green-700` の有彩色。Key Color外。ブランド適合 | 成功はチェックアイコン+黒文字へ | Low | 対応済 |
| CN-4 | 代替連絡手段（ページ全体） | フォームのみで、想定回答期間・メール・SNS等の代替が無い。安心/信頼（作り手との距離） | 「通常N営業日以内に返信」等の一文 + 必要なら代替チャネル | Low | 対応済 |
| CN-5 | SingleSelect name（[contact/page.tsx:228](../../src/app/contact/page.tsx#L228)） | `name="inquiry"` だが state は `inquiryType`。属性の不一致（実害軽微だが整合性） | name を `inquiryType` に揃える | Low | 対応済 |

---

## 良い点（維持・他フォームの手本）

- **ハニーポット（website 隠しフィールド）** によるスパム対策。
- フィールド単位の onBlur バリデーション + `aria-describedby`/`aria-invalid`/`role="alert"`、文字数カウンタ（`message-counter` を aria に連結）。implement-uiux のフォーム原則を高水準で満たす。
- 送信ボタンは入力完了まで `disabled`（エラー予防）、送信中ラベル変化（フィードバック）。
- h1 + 説明、`max-w-[680px]` の読みやすい幅。

---

## implement-uiux に「あえて従わない」判断

- **問い合わせ種別を増やしすぎない**: 現状3択（商品/注文/その他）は Hick 的に適切。細分化しない。
- 成功=緑は不採用（CN-3）。モノクローム純度を優先。

---

## 修正反映（2026-06-23）

- **CN-1**: name/email/subject の外側 `<p role="alert">`（TextField の `errorText` と二重）を削除し、`TextField` 内蔵エラーに集約。`aria-describedby` は同一 id を指すため整合維持。
- **CN-2**: サンクスモーダルに フォーカス移動（閉じるボタン）・Tabトラップ・Escで閉じる・背景クリックで閉じる・閉じたら元要素へフォーカス復帰 を実装。`role/aria-modal/aria-labelledby` を内側ダイアログへ移動。
- **CN-3**: 成功メッセージを `text-green-700` → ✓ + 黒文字へ。
- **CN-4**: 導入文に「通常3営業日以内にご返信」+ 迷惑メール確認の一文を追加。
- **CN-5**: `name="inquiry"` → `name="inquiryType"`（state と整合）。
- 実装: [src/app/contact/page.tsx](../../src/app/contact/page.tsx)。

---

## 総評（CONTACT）

完成度が高い。**エラー二重表示の解消（CN-1）とモーダルのフォーカス管理（CN-2）** を直せば、アクセシビリティ面もほぼ理想形。
