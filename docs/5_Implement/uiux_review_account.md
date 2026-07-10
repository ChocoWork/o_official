# ACCOUNT（会員情報）UI/UX レビュー

- 対象: [src/app/account/page.tsx](../../src/app/account/page.tsx)
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

高LTVのリピート顧客の拠点（プロフィール/配送先/購入履歴）。受注生産で「いつ届くか」を気にする層には**購入履歴の追跡性**が重要。タブ構成・住所CRUD・郵便番号補完など機能は充実。改善は「履歴→詳細の導線欠落」「フォームのラベル紐付け」「破壊的操作の確認」。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| AC-1 | 購入履歴カード（[account/page.tsx:1033-1092](../../src/app/account/page.tsx#L1033-L1092)） | `OrderSummary.detailHref` が型に在るのにカードから**注文詳細へのリンクが無い**。詳細ページ（/account/orders/[id]）がUIから到達不能。メンタルモデル/ナビゲーション | カードを `detailHref` へのリンク化、または「詳細を見る」CTA追加 | High | 対応済 |
| AC-2 | 編集フォームのラベル（[account/page.tsx:773-808](../../src/app/account/page.tsx#L773-L808),[938-989](../../src/app/account/page.tsx#L938-L989)） | 項目名が `<p className="account-label">` で、`TextField` の input と**プログラム的に紐付いていない**（label/for無し）。WCAG 1.3.1/3.3.2/4.1.2 | `TextField` の `label`/`htmlFor` を用いて紐付け（checkoutは label prop 使用済みで手本） | Mid | 対応済 |
| AC-3 | プロフィール削除（[account/page.tsx:542-568](../../src/app/account/page.tsx#L542-L568),[757-763](../../src/app/account/page.tsx#L757-L763)） | 「削除する」で氏名/カナ/電話を**確認なしで消去**。破壊的操作の確認欠如。エラー防止（Layer 8） | 確認ダイアログを挟む。文言も「情報を消去」等、実態に合わせる | Mid | 対応済 |
| AC-4 | 住所削除（[account/page.tsx:570-591](../../src/app/account/page.tsx#L570-L591),[907-915](../../src/app/account/page.tsx#L907-L915)） | 住所「削除する」も確認なし。破壊的操作の確認欠如 | 確認ダイアログを挟む | Mid | 対応済 |
| AC-5 | ログイン後の見出し（[account/page.tsx:659-713](../../src/app/account/page.tsx#L659-L713)） | 未ログイン時は h1「会員情報」が在るが、**ログイン後の本体にはh1が無く**タブだけ。現在地/視覚的階層 | ログイン後も「ACCOUNT / 会員情報」h1 を表示 | Mid | 対応済 |
| AC-6 | 成功色（[account/page.tsx:721](../../src/app/account/page.tsx#L721),[849](../../src/app/account/page.tsx#L849)） | `text-green-700` の有彩色。Key Color外。ブランド適合 | 成功はチェックアイコン+黒文字へ | Low | 対応済 |
| AC-7 | フィードバック領域（[account/page.tsx:720-727](../../src/app/account/page.tsx#L720-L727) 等） | 成功/エラーがセクション先頭に出る。長い編集フォームでは操作箇所から離れ気づきにくい。近接/Visibility | 操作ボタン近傍 or トーストで通知 | Low | 対応済 |
| AC-8 | ローディング（[account/page.tsx:717-719](../../src/app/account/page.tsx#L717-L719) 等） | 「読み込み中...」テキストのみ。Doherty/反復 | カード/フォームのスケルトンに | Low | 対応済 |
| AC-9 | ステータス表示（[account/page.tsx:1077](../../src/app/account/page.tsx#L1077)） | `order.status` を生表示。英語enum等だと意味不明の恐れ。可読性 | 日本語ステータス（処理中/発送済み等）にマッピング | Low | 対応済 |

---

## 良い点（維持）

- 未ログイン時のゲート（アイコン+h1+ログインCTA）が明確。空状態（履歴なし/住所なし）に説明文あり。
- 住所の CRUD・メイン設定・郵便番号自動補完・`autoComplete`（name/tel/postal-code/address-level1,2/street-address）。
- タブのURL同期、デスクトップ縦タブ/モバイル標準タブの出し分け。
- メールは readonly で誤変更を防止。

---

## implement-uiux に「あえて従わない」判断

- **タブUIの採用は妥当**（プロフィール/配送/履歴の3区分は Miller 的にも適切）。無理にウィザード化しない。
- **成功=緑は不採用**（AC-6、モノクローム純度優先）。エラー赤のみ最小限許容。

---

## 修正反映（2026-06-20）

- **AC-1（対応済）**: 購入履歴カードに「注文詳細を見る」ボタン（`order.detailHref` リンク）を追加。注文詳細ページへ到達可能に。実装: [src/app/account/page.tsx](../../src/app/account/page.tsx)。

---

## 修正反映（2026-06-23）

- **AC-2**: プロフィール/住所の編集フォームで `<p className="account-label">` を `<label className="account-label" htmlFor="...">` に変更し、`TextField`（id=name）と紐付け。都道府県 `SingleSelect` には `aria-label` を付与。
- **AC-3**: プロフィール「削除する」を確認ダイアログ（新規 [ConfirmDialog.tsx](../../src/components/ConfirmDialog.tsx)、フォーカストラップ/Esc/背景クリック対応）経由に変更。文言も「プロフィール情報を消去しますか？」と実態（氏名/フリガナ/電話の消去）に合わせた。
- **AC-4**: 住所「削除する」も同 `ConfirmDialog` 経由に。
- **AC-5**: ログイン後の本体上部に「ACCOUNT」h1 を追加。
- **AC-6**: 成功フィードバックの `text-green-700` を撤去（✓ + 黒文字のトーストへ）。
- **AC-7**: 成功/エラーをセクション先頭の固定文から、画面下中央の固定トースト（成功=✓黒、エラー=`role="alert"`）に変更し操作地点との距離を縮小。
- **AC-8**: profile/shipping/orders の「読み込み中...」をカード/フォームのスケルトンに置換。
- **AC-9**: `order.status` を `formatOrderStatus()`（pending/paid/shipped 等→日本語）でマッピング表示。
- 実装: [src/app/account/page.tsx](../../src/app/account/page.tsx) / [src/components/ConfirmDialog.tsx](../../src/components/ConfirmDialog.tsx)。

---

## 総評（ACCOUNT）

機能は充実。最優先は**履歴→詳細の導線復旧（AC-1）**＝既存の詳細ページが使えていない致命点。次いで**フォームのラベル紐付け（AC-2）**と**破壊的操作の確認（AC-3/AC-4）**。
