# 注文詳細（/account/orders/[id]）UI/UX レビュー

- 対象: [src/app/account/orders/[id]/page.tsx](../../src/app/account/orders/[id]/page.tsx)
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

注文後の安心を支えるページ。**前提として ACCOUNT 履歴からの導線が無く到達できない（[uiux_review_account.md](./uiux_review_account.md) AC-1）** ため、まずそこを直すと本ページが活きる。内容（サマリ/商品/配送先）は簡潔で良い。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| OD-1 | 到達性（本ページ全体） | ACCOUNT 購入履歴にリンクが無く、本詳細ページへ到達できない（AC-1）。ナビゲーション | 履歴カードを `detailHref` へリンク（account側の修正） | High | 対応済 |
| OD-2 | タイポトークン（[orders/[id]/page.tsx:104-148](../../src/app/account/orders/[id]/page.tsx#L104-L148)） | `text-sm/lg/xl` 等 Tailwind 既定サイズで、サイト共通の `--lk-size-*` トークンから外れる。反復（一貫性） | 共通トークンへ統一 | Low | 対応済 |
| OD-3 | 商品画像（[orders/[id]/page.tsx:128-138](../../src/app/account/orders/[id]/page.tsx#L128-L138)） | 履歴一覧には商品画像があるが詳細には無く、テキストのみ。期待・一貫性。図と地 | 商品サムネイルを表示し履歴と整合 | Low | 対応済 |
| OD-4 | ステータス（[orders/[id]/page.tsx:115-117](../../src/app/account/orders/[id]/page.tsx#L115-L117)） | `order.status` 生表示。意味が伝わりにくい。可読性 | 日本語ステータス + 進捗の視覚化（受注→発送→配達） | Low | 対応済 |
| OD-5 | 次アクション（本ページ全体） | 再注文・問い合わせ・配送追跡などのアクションが無い。受注生産で「いつ届く」を気にする層に不親切。Peak-End/次アクション | 「お問い合わせ」「再注文」「配送状況」等のCTAを検討 | Low | 対応済 |
| OD-6 | 行小計/内訳 | 合計のみで送料/値引/小計の内訳が無い。明瞭性 | 金額内訳を表示（checkout完了画面と整合） | Low | 対応済 |
| OD-7 | ローディング/エラー（[orders/[id]/page.tsx:99-100](../../src/app/account/orders/[id]/page.tsx#L99-L100)） | テキストのみ。`role="alert"` 無し。Doherty/アクセシビリティ | スケルトン + エラーに `role="alert"` | Low | 対応済 |

---

## 良い点（維持）

- **h1「注文詳細」+ 説明 + 戻りリンク**で現在地が明確（一覧ページが見習うべき）。
- 未ログインゲート（h1+ログインCTA）あり。
- サマリ/商品/配送先のセクション分割が端正で、罫線・余白の使い方がブランド適合。

---

## implement-uiux に「あえて従わない」判断

- **情報を詰め込まない**: 注文詳細は確認用途。装飾や過剰な可視化は不要で、現状の静かな構成は適切。OD-4/OD-5 の追加も最小限に。

---

## 修正反映（2026-06-23）

- **OD-1**: ACCOUNT 購入履歴カードに「注文詳細を見る」リンク（`detailHref`）が追加済み（[account](../../src/app/account/page.tsx) AC-1）。本詳細ページへ到達可能。
- **OD-2**: `text-sm/lg/xl/xs` 等の Tailwind 既定サイズを `--lk-size-*` トークン（`labelStyle/bodyStyle/lgStyle/xlStyle`）に統一。
- **OD-3**: 各注文商品にサムネイル（next/image、`item.imageUrl`）を追加し履歴一覧と整合。
- **OD-4**: ステータスを `formatOrderStatus()` で日本語化し、受注→発送→配達の進捗ステッパー（共通 [order-status.ts](../../src/lib/orders/order-status.ts)）を追加。account とロジック共用。
- **OD-5**: 末尾に「この注文について問い合わせる（→ /contact）」「買い物を続ける（→ /item）」CTAを追加。※再注文・配送追跡は、カート再構築APIや配送業者の追跡データが未整備のため見送り（データ拡張時に対応）。
- **OD-6**: 合計ラベルを「合計（税込・送料込）」に明確化。※小計/送料/値引の行内訳は API が `totalAmount` のみ返却（数値の内訳項目なし）のため、内訳分解はデータ拡張時に対応。
- **OD-7**: ローディングをスケルトンに、エラーに `role="alert"` を付与。
- 実装: [src/app/account/orders/[id]/page.tsx](../../src/app/account/orders/[id]/page.tsx) / [src/lib/orders/order-status.ts](../../src/lib/orders/order-status.ts)。

---

## 総評（注文詳細）

ページ単体の品質は良好。**本質はACCOUNTからの到達性（OD-1）**。それを直したうえで、トークン統一（OD-2）・画像整合（OD-3）・ステータス可読化（OD-4）を行うと体験が締まる。
