# 1.9 コンタクトページ（CONTACT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-CONTACT-001 | 名前・メールアドレス・件名・メッセージを入力するフォームフィールドを表示する | IMPL-CONTACT-001 | `src/app/contact/page.tsx`, `src/components/ui/TextField.tsx`, `src/components/ui/TextAreaField.tsx` | `TextField`（name, email, subject）と `TextAreaField`（message, maxLength=500）で構築。`h1` "Contact / お問い合わせ" あり | 済 |
| FR-CONTACT-002 | お問い合わせ内容を選択するドロップダウンを表示し問い合わせ種別を選べるようにする | IMPL-CONTACT-002 | `src/app/contact/page.tsx`, `src/components/ui/SingleSelect.tsx` | `SingleSelect` コンポーネントで「商品について / ご注文について / その他」を選択可能 | 済 |
| FR-CONTACT-003 | フォームはクライアントサイドで表示し送信ボタンを備えたインタラクティブなページとする | IMPL-CONTACT-003 | `src/app/contact/page.tsx` | `"use client"` で実装。"SEND MESSAGE" 送信ボタンあり | 済 |
| FR-CONTACT-004 | モバイルとデスクトップの両方で使いやすいレスポンシブ構成とする | IMPL-CONTACT-004 | `src/app/contact/page.tsx` | `max-w-4xl` で幅制限しつつ `px-4 sm:px-6 lg:px-12` でパディング調整 | 済 |
| FR-CONTACT-005 | `form` に `onSubmit` ハンドラを実装し問い合わせデータを API エンドポイントに送信できるようにする | IMPL-CONTACT-005 | `src/app/contact/page.tsx` | `onSubmit` で `/api/contact` へ送信処理を実装。`fetch` とレスポンス分岐を追加 | 済 |
| FR-CONTACT-006 | 送信中のローディング表示・送信成功メッセージ・送信失敗メッセージを実装する | IMPL-CONTACT-006 | `src/app/contact/page.tsx` | `isSubmitting` による `SENDING...` 表示、成功時 `role=status`、失敗時 `role=alert` を実装 | 済 |
| FR-CONTACT-007 | 入力エラー時にユーザー向けの説明表示を行い `aria-describedby` でエラーメッセージを関連付ける | IMPL-CONTACT-007 | `src/app/contact/page.tsx` | フィールドごとのバリデーションとエラー文言を表示。`aria-describedby` でエラーメッセージと関連付け | 済 |
| FR-CONTACT-008 | 問い合わせデータを受け取る API ルートを実装しメール送信処理と問い合わせ履歴の保存を行う | IMPL-CONTACT-008 | `src/app/api/contact/route.ts` | `POST /api/contact` を追加。入力検証、問い合わせ履歴（`audit_logs`）保存、メール送信処理を実装 | 済 |
| FR-CONTACT-009 | `message` フィールドに文字数カウンターを追加し送信ボタンは入力状態・送信中に応じて無効化する | IMPL-CONTACT-009 | `src/app/contact/page.tsx`, `src/components/ui/TextAreaField.tsx` | `message` 文字数カウンター（`x / 500`）を表示。フォーム未充足または送信中は送信ボタンを無効化 | 済 |
| FR-CONTACT-010 | 送信完了後にサンクス画面またはモーダルを表示しユーザーに送信完了を明確に伝える | IMPL-CONTACT-010 | `src/app/contact/page.tsx` | 送信成功時にサンクスモーダル（`role=dialog`）を表示 | 済 |
| FR-CONTACT-011 | 公開問い合わせ API に同一オリジン検証・Bot 対策・レート制限を適用し悪用を抑止する | IMPL-CONTACT-011 | `src/app/api/contact/route.ts`, `src/app/contact/page.tsx`, `e2e/FR-CONTACT-011-security-controls.spec.ts` | `Origin/Referer` 検証、IP/メール単位のレート制限、honeypot フィールド検証を実装 | 済 |
| FR-CONTACT-012 | 問い合わせ本文を監査ログから分離し、audit_logs の記録を最小化する | IMPL-CONTACT-012 | `src/app/api/contact/route.ts`, `migrations/041_create_contact_inquiries.sql` | 本文は `contact_inquiries` に保存し、`audit_logs` には `inquiry_id` と最小分類情報のみ記録 | 済 |
