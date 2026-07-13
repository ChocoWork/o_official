# CART（カート）UI/UX レビュー

- 対象: [src/app/cart/page.tsx](../../src/app/cart/page.tsx) / [_components/CartItemRow.tsx](../../src/app/cart/_components/CartItemRow.tsx) / [_components/OrderSummary.tsx](../../src/app/cart/_components/OrderSummary.tsx)
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

高単価商品の購入直前。**信頼と安心が最重要**。在庫同期エラーの再試行/再同期、空状態のCTAなど**堅牢に作られている**。改善点は「派手なローディング演出」「小さすぎる操作ターゲット」「金額内訳の明瞭さ」。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| CT-1 | ローディング（[cart/page.tsx:30-56](../../src/app/cart/page.tsx#L30-L56)） | 全画面の黒バー明滅アニメ + 「BARS REVEAL」という開発者向け文言。静謐なブランド世界観に対し**過剰で異物感**。Doherty/ブランド適合 | カートレイアウトのスケルトン（CLS防止・控えめ）に置換、デバッグ文言削除 | Mid | 対応済 |
| CT-2 | 操作ボタン（[CartItemRow.tsx:80-105](../../src/app/cart/_components/CartItemRow.tsx#L80-L105),[122-128](../../src/app/cart/_components/CartItemRow.tsx#L122-L128)） | ♡/削除ボタンと Stepper が `size="4xs"`（極小）。誤タップ・押しづらさ。Fitts/タッチ44px | モバイルで最小44px のタップ領域を確保 | Mid | 対応済 |
| CT-3 | 明細（[CartItemRow.tsx:118-129](../../src/app/cart/_components/CartItemRow.tsx#L118-L129)） | 行ごとの小計（単価×数量）が無く単価のみ。数量変更時の金額影響が即座に分からない。Visibility/可読性 | 各行に小計を表示（数量変更で即時更新） | Mid | 対応済 |
| CT-4 | OrderSummary 送料（[OrderSummary.tsx:41-46](../../src/app/cart/_components/OrderSummary.tsx#L41-L46)） | 送料が常に「無料」固定表示。実際の送料ポリシーと不一致なら不信に直結。明瞭性/信頼 | 実ポリシーを反映（条件付き無料なら条件明記、確定は注文時の旨を補記） | Mid | 対応済 |
| CT-5 | OrderSummary 内訳（[OrderSummary.tsx:33-59](../../src/app/cart/_components/OrderSummary.tsx#L33-L59)） | 小計=合計で税表記が無い。税込なら「(税込)」明記が安心。明瞭性 | 「(税込)」表記、必要なら点数も表示 | Low | 対応済 |
| CT-6 | エラー/警告色（[cart/page.tsx:83-107](../../src/app/cart/page.tsx#L83-L107)） | `red-*`/`amber-*` のセマンティック色を使用。モノクローム原則からの逸脱（特に amber 警告） | error は最小限の赤、警告はモノトーン（罫線+アイコン+テキスト）へ寄せる | Low | 対応済 |
| CT-7 | ♡塗り色（[CartItemRow.tsx:88-92](../../src/app/cart/_components/CartItemRow.tsx#L88-L92)） | wishlist 塗りが `text-red-500`（item詳細 ID-10 と同件）。Key Color逸脱 | 黒/グレー基調へ統一（ブランド純度） | Low | 対応済 |
| CT-8 | 死にコード [src/components/CartItem.tsx](../../src/components/CartItem.tsx) | 旧 `CartItem.tsx` が未使用（cartは `CartItemRow` を使用）。`gray-*`/`red-*`/`text-2xl font-bold` のテンプレ調でブランド外。混乱の元（※削除は要判断、本レビューでは指摘のみ） | 不使用確認のうえ削除を検討（CLAUDE.md準拠で勝手な削除はしない） | Low | 対応済 |

---

## 良い点（維持）

- **在庫同期エラーの回復導線（再試行/最新状態を再取得）** が item 単位とページ単位で用意され、implement-uiux Layer 8（エラー回復）の手本。
- 空状態が `EmptyPage`（アイコン+ラベル+CTA）で適切。CONTINUE SHOPPING 導線も明確。
- OrderSummary の sticky + 主役CTA「ご購入手続きへ」（primary lg full-width）は対比設計として良。

---

## implement-uiux に「あえて従わない」判断

- **ローディングを“演出”にしない**: スキルはスケルトンを推奨。本ブランドでは CT-1 のような表現的アニメより、**静かなスケルトン**がむしろブランド適合。派手さは不要。
- **警告に黄色を使わない**: スキルのカラーシステム（warning=黄）は不採用。モノトーン+アイコンで状態表現（[uiux_review_home.md](./uiux_review_home.md) の逸脱判断1に準拠）。

---

## 修正反映（2026-06-23）

- **CT-1**: 黒バー明滅 + 「BARS REVEAL」デバッグ文言を撤去し、カートレイアウト（行 + サマリ）の控えめなスケルトンに置換。
- **CT-2**: ♡/削除ボタンに `min-h-[44px] min-w-[44px]` + `aria-label` を付与。Stepper を `size="4xs"` → `size="xs"` に拡大。
- **CT-3**: 各行に「単価」+「行小計（単価×数量）」を表示。数量変更で即時更新。
- **CT-4 / CT-5**: 合計を「合計（税込）」に変更し、「価格は税込表示です。送料・最終金額はご購入手続きで確定します。」の補記を追加。
- **CT-6**: ページのエラーを `red-50/red-300` → `text-red-600 + border-black/15 bg-black/[0.02]`（最小限の赤）、同期警告の `amber-*` → モノトーン（`text-[#474747]` + 罫線 + `ri-error-warning-line` アイコン）へ。`role` も付与。
- **CT-7**: CartItemRow の ♡ 塗りを `text-red-500` → `text-black`（ID-10 と統一）。
- **CT-8**: `src/components/CartItem.tsx` が**未使用であることを確認**（参照は `CartItemRow` のみ）。CLAUDE.md 準拠で勝手に削除はせず、**削除推奨を記録**（ユーザー判断）。
- 実装: [src/app/cart/page.tsx](../../src/app/cart/page.tsx) / [src/app/cart/_components/CartItemRow.tsx](../../src/app/cart/_components/CartItemRow.tsx) / [src/app/cart/_components/OrderSummary.tsx](../../src/app/cart/_components/OrderSummary.tsx)。

---

## 総評（CART）

堅牢性は高い。**ローディング演出の見直し（CT-1）・操作ターゲット拡大（CT-2）・金額内訳の明瞭化（CT-3〜CT-5）** で、高単価購入直前の安心感をさらに高められる。
