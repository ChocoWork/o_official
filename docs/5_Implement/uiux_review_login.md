# LOGIN（ログイン）UI/UX レビュー

- 対象: [src/app/login/page.tsx](../../src/app/login/page.tsx) / 実体 [src/components/LoginModal.tsx](../../src/components/LoginModal.tsx)
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

EC直販の入口。コアペルソナは購買意欲が高くLTVも高いため、**ログインの摩擦は最小化**したい。Google + メールOTP のパスワードレス設計、8桁OTPの優れた入力体験は good。改善は「ページとしての見出し/ブランド枠」「配色」「狭幅でのOTP折返し」。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| LG-1 | ページ構造（[login/page.tsx:19-23](../../src/app/login/page.tsx#L19-L23)） | `LoginModal open={true}` をそのまま全画面に表示。**h1/見出し・ブランド枠が無く**、いきなりGoogleボタンから始まる。視覚的階層/現在地/ブランド適合 | 「LOGIN」見出し(h1) + 一言のウェルカム/ブランド要素で枠付け | Mid | 対応済 |
| LG-2 | 成功/エラー色（[LoginModal.tsx:402-403](../../src/components/LoginModal.tsx#L402-L403)） | `text-green-600`/`text-red-600` の有彩色。特に成功緑は Key Color 外。ブランド適合（モノクローム） | 成功はチェックアイコン+黒文字、エラーは最小限の赤に | Low | 対応済 |
| LG-3 | OTP入力幅（[LoginModal.tsx:342-362](../../src/components/LoginModal.tsx#L342-L362)） | 8桁 × `w-10`(40px)+gap を横並び。375px幅で `max-w-md` 内に収まらず折返し/窮屈の懸念。モバイル最適化/Fitts | 極小幅でボックス幅を可変（clamp）または2段折返しを許容 | Mid | 対応済 |
| LG-4 | パスワード再設定リンク（[LoginModal.tsx:373-383](../../src/components/LoginModal.tsx#L373-L383)） | ログインはOTP/Googleでパスワードレスなのに「パスワードを忘れた方はこちら」。メンタルモデル不一致で混乱 | 文言を実態に合わせる（例: 「サインインできない場合」）か、パスワード方式の位置づけを明確化 | Low | 対応済 |
| LG-5 | メール入力（[LoginModal.tsx:300](../../src/components/LoginModal.tsx#L300)） | 他フォームは `TextField` 共通コンポーネントだが、ここは素の `<input>`。`autoComplete="email"` も未指定。反復/オートフィル | `TextField` へ統一し `autoComplete="email"` 付与 | Low | 対応済 |
| LG-6 | 成功メッセージの行き先 | OTP送信成功メッセージは出るが、OTP欄へのフォーカス移動はするものの、視線誘導（成功→入力）が弱い。連続性 | 成功通知とOTP欄の近接/順序を意識（現状focusはあるので軽微） | Low | 対応済 |

---

## 良い点（維持・他フォームの手本）

- **8桁OTPのセグメント入力**: 貼り付け/Backspace/矢印キー/桁ごと `aria-label`/`inputMode="numeric"`/`autoComplete="one-time-code"`。アクセシブルで高品質。
- 再送カウントダウン、Turnstile ボット検証、`label htmlFor` 紐付け、利用規約/プライバシー同意明示。
- Google + メールOTP のパスワードレスは摩擦が低く、ブランドの「安心感」と整合。

---

## implement-uiux に「あえて従わない」判断

- **ソーシャルログインを増やしすぎない**: スキルは選択肢提供を是とするが、Hick的にはGoogle+メールの2択が最適。ブランドの静けさにも合う（多数の SNS ログインは不要）。
- **成功=緑の慣習を必ずしも採用しない**: モノクローム純度を優先（LG-2）。ただしエラーの赤は可読性のため最小限許容。

---

## 修正反映（2026-06-23）

- **LG-1**: `login/page.tsx` に「LOGIN」h1 + 一言のウェルカムを枠付けで追加（Header のモーダル用途には影響しないようページ側で実装）。
- **LG-2**: success を `text-green-600` → ✓ + 黒文字に。error は `role="alert"` 付与のうえ最小限の赤を維持。
- **LG-3**: OTPボックスを `w-10`（固定40px）→ `flex-1 min-w-0`（可変幅）+ `gap-1.5 sm:gap-2` に変更し、375px幅でも折返さない。
- **LG-4**: 「パスワードを忘れた方はこちら」→「サインインできない場合」に変更（パスワードレス実態と整合）。
- **LG-5**: 素の `<input>` を共通 `TextField` へ統一し `autoComplete="email"` を付与。`emailRef` を制御 state（`email`）へ置換。
- **LG-6**: success に `role="status"` を付与（OTP欄への autofocus は従来どおり維持し、連続性を補強）。
- 実装: [src/components/LoginModal.tsx](../../src/components/LoginModal.tsx) / [src/app/login/page.tsx](../../src/app/login/page.tsx)。

---

## 総評（LOGIN）

OTP入力の作り込みは秀逸。**ページとしての枠付け（LG-1）と狭幅OTP（LG-3）** を整え、配色（LG-2）と文言（LG-4）をブランド/実態に合わせれば完成度が上がる。
