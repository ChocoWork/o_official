# AUTH CALLBACK（/auth/callback）UI/UX レビュー

- 対象: [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx)
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

OAuth 後の**遷移専用ページ**。基本は一瞬で次画面へリダイレクトされ、ユーザーが長く留まらない。よって作り込みは最小で妥当だが、**失敗時のみ**は丁寧さが必要。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| AK-1 | 失敗時の導線（[auth/callback/page.tsx:47-49](../../src/app/auth/callback/page.tsx#L47-L49),[50-53](../../src/app/auth/callback/page.tsx#L50-L53)） | 認証失敗/内部エラー時にメッセージのみで**回復CTA（ログインへ戻る）が無い**。エラー回復/Peak-End | 失敗時に「ログインに戻る」ボタンを表示 | Mid | 対応済 |
| AK-2 | 見出し（[auth/callback/page.tsx:64](../../src/app/auth/callback/page.tsx#L64),[77](../../src/app/auth/callback/page.tsx#L77)） | h1 が「OAuth」。開発者用語でユーザーに不親切。文言/ブランドトーン | 「サインインしています…」等のユーザー向け文言に | Low | 対応済 |
| AK-3 | 進行表示（[auth/callback/page.tsx:65](../../src/app/auth/callback/page.tsx#L65)） | 「認証処理中…」テキストのみ。スピナー等の動きが無く固まったように見える懸念。Doherty/フィードバック | 控えめなスピナー/プログレス表示 | Low | 対応済 |
| AK-4 | `aria-live`（本文メッセージ） | 状態文言が動的更新されるが live region でない。スクリーンリーダーに変化が伝わらない。アクセシビリティ | メッセージに `role="status"`/`aria-live="polite"` | Low | 対応済 |

---

## 良い点（維持）

- `next` パラメータをオープンリダイレクト対策（`startsWith('/')`）で検証してから遷移。安全。
- Suspense フォールバックで初期表示も破綻しない。

---

## implement-uiux に「あえて従わない」判断

- **過剰な装飾は不要**: 遷移専用ページなので、成功パスはミニマルで良い。投資は AK-1（失敗時の回復）に集中する。

---

## 修正反映（2026-06-23）

- **AK-1**: `failed` 状態で「ログインに戻る」リンク（/login）を失敗時に表示。
- **AK-2**: h1 を「OAuth」→ 処理中「サインインしています…」/ 失敗時「サインインできませんでした」へ。Suspense フォールバックも統一。
- **AK-3**: モノクロームの `Spinner`（`animate-spin`・border-black）を処理中メッセージ前に表示。
- **AK-4**: 本文メッセージに `role="status"` + `aria-live="polite"` を付与。
- 実装: [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx)。

---

## 総評（AUTH CALLBACK）

遷移ページとして十分。**失敗時の回復CTA（AK-1）** とユーザー向け文言（AK-2）だけ整えれば良い。
