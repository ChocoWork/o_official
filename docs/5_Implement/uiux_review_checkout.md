# CHECKOUT（決済）UI/UX レビュー

- 対象: [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx)
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

CV最終地点。高単価（PSM: トップス2.2-2.6万/アウター5.5-6.5万）の決済で、**入力負荷の低さと安心感**が成否を分ける。本ページは Stripe を**ブランドトークンに合わせて作り込み**、住所自動補完・プロフィール連携・保存住所選択・promoコードまで備えた高品質実装。改善は「ステップ表記の明瞭化」「空カードガード」「ローディング表現」。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| CO-1 | ステップ定義（[checkout/page.tsx:115-118](../../src/app/checkout/page.tsx#L115-L118)） | step1 ラベル「注文を確定する」/ step2「ご注文内容の確認」。実体は step1=入力・支払、step2=確認。**ラベルと実態が逆で誤解**。メンタルモデル/連続性 | 「1. 情報入力・お支払い → 2. 確認・注文確定」へ正す | Mid | 対応済 |
| CO-2 | 決済確定の順序（[checkout/page.tsx:1097-1120](../../src/app/checkout/page.tsx#L1097-L1120)） | step1 の「確認へ進む」で `checkout.confirm()` を実行し、その後 step2「確認」を表示。**支払い確定後に確認画面**となり期待と逆。信頼/Peak-End | 確認→確定の順に再設計、または step1/2 の名称を実フローに合わせ「最終確認は支払前」と明示 | Mid | 対応済 |
| CO-3 | 空カードガード（[checkout/page.tsx:1759-1765](../../src/app/checkout/page.tsx#L1759-L1765),[1940-1946](../../src/app/checkout/page.tsx#L1940-L1946)） | カート空でも決済フォームが描画され、サマリだけ「商品がありません」。空状態の次アクションが無い。空状態設計/エラー防止 | カート空なら EmptyPage 相当（カートへ/買い物を続ける）へ誘導 | Mid | 対応済 |
| CO-4 | ローディング（[checkout/page.tsx:1478-1486](../../src/app/checkout/page.tsx#L1478-L1486),[2006-2013](../../src/app/checkout/page.tsx#L2006-L2013)） | カート/Suspense とも「読み込み中...」テキストのみ。高額決済画面で素っ気なく不安。Doherty/Peak-End | レイアウトのスケルトンに置換 | Low | 対応済 |
| CO-5 | 完了画面 h1（[checkout/page.tsx:1500-1505](../../src/app/checkout/page.tsx#L1500-L1505)） | 「Thank you for your order」英語のみ。Peak-End の頂点はブランドトーンの日本語併記でより温かく | 日本語の感謝文を主、英語を従に | Low | 対応済 |
| CO-6 | 注文明細 小計（[checkout/page.tsx:1154-1187](../../src/app/checkout/page.tsx#L1154-L1187)） | OrderItems が単価のみで行小計が無い。数量と単価から暗算が必要。可読性 | 行ごとに小計（単価×数量）を表示 | Low | 対応済 |
| CO-7 | 配色トークン外（[checkout/page.tsx:1761](../../src/app/checkout/page.tsx#L1761),[1942](../../src/app/checkout/page.tsx#L1942)） | `text-gray-500` がブランドの `#474747` トークンから外れる。反復（一貫性） | 既存トークン（muted）へ統一 | Low | 対応済 |
| CO-8 | エラー赤（複数: [1721](../../src/app/checkout/page.tsx#L1721) 等） | `text-red-600` 多用。決済では赤は許容範囲だが、Stripe `colorDanger:#dc2626` とトーンを統一しておくと一貫 | エラー色を1トークンに集約 | Low | 対応済 |

---

## 良い点（維持・他ページの手本）

- **Stripe Payment Element をブランドトークンに合わせて作り込み**（[checkout/page.tsx:35-113](../../src/app/checkout/page.tsx#L35-L113) primary=#000・monochrome）。サードパーティUIのブランド統一は秀逸。
- `autoComplete`（name/email/tel/postal-code/address-level1,2/street-address）と `inputMode`、郵便番号→住所自動補完で**入力負荷を大幅軽減**（implement-uiux フォーム原則の理想形）。
- フィールド単位の `errorText` + `role="alert"`、保存住所選択、promoコード適用/解除、決済セッション再試行。
- 完了画面（注文番号/注文日/次ステップ3カード/継続・履歴CTA）は **Peak-End** を意識した良い設計。

---

## implement-uiux に「あえて従わない」判断

- **ステップ数を無理に増やさない**: スキルは「1画面1ステップ（ウィザード）」を推奨するが、本決済は2ステップ+Stripeで完結度が高い。CO-1/CO-2 は**段数増ではなく“名称と順序の整合”**で解決するのが妥当（過剰分割は離脱増）。
- **Stripeのテーマ色は据え置き**: `colorDanger` の赤は決済の世界標準で、ここは可読性・慣習を優先（モノクローム原則の許容例外）。

---

## 修正反映（2026-06-20）

- **決済手段がカードのみ表示される不具合（対応済）**: 追加で発覚。Custom UI のセッション生成で `payment_method_types` を選択中の1手段（既定=カード）に固定していたため、PaymentElement にカードしか出ていなかった。**`payment_method_types` の指定を撤廃**し、Stripe ダッシュボードで有効化済みの全手段（カード／PayPay／コンビニ）が自動表示されるよう修正。実装: [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts)。
  - **要対応（運用）**: PayPay・コンビニ払いが画面に出るには **Stripe ダッシュボードで両方式の有効化**が必要（Settings → Payment methods）。有効化されていれば自動で選択肢に表示される。
- 銀行振込は不要との判断（コンビニ/PayPayで代替）。TERMS の支払方法も同様に更新（[uiux_review_terms.md](./uiux_review_terms.md) TM-2）。

---

## 修正反映（2026-06-23）

- **CO-1**: `CHECKOUT_STEPS` ラベルを実フローに合わせ「情報入力・お支払い → 確認・完了」に修正。
- **CO-2**: step1 で `checkout.confirm()`（決済確定）を実行するボタン文言「確認へ進む」→「お支払いを確定する」に変更し、実態（このボタンで支払いが確定する）を明示。Stripe フロー自体は再設計せず、名称整合で対応（過剰分割回避・離脱防止）。
- **CO-3**: カート空（かつ Stripe リダイレクト確定処理 `session_id` 中でない）なら `EmptyPage`（CONTINUE SHOPPING → /item）へ早期誘導。リダイレクト確定処理を妨げないようガード条件を限定。
- **CO-4**: カートローディング/Suspense フォールバックを2カラムのスケルトンに置換。
- **CO-5**: 完了見出しを「ご注文ありがとうございます」（日本語・主）+「THANK YOU FOR YOUR ORDER」（英語・従）に。確認メール文言は据え置き（E2E互換）。
- **CO-6**: OrderItems に「単価 ¥X × 数量」+「行小計（単価×数量）」を表示。
- **CO-7**: `text-gray-500`（2箇所）→ `text-[#474747]`（ブランド muted トークン）。
- **CO-8**: ページ内エラーは既に `text-red-600`（= `#dc2626`）で統一済みであることを確認。Stripe の `colorDanger:#dc2626` とトーン一致。散在する red-500/700 等は無し。
- 実装: [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx)。

---

## 修正反映（2026-07-05）— 完了画面のブランド適合（FREQ-74）

完了画面（Thank You）をミニマル・モードへ調整（フォント・フォントサイズ・余白中心。アイコンは安心感のため維持）。

- **見出し階層**: 英語「THANK YOU FOR YOUR ORDER」を Didot のオーバーライン（2xs・tracking 0.35em・グレー）として見出しの上へ移動。日本語 h1 が主のまま（CO-5 維持）、tracking 0.1em・line-height √φ を付与。
- **糸モチーフ**: 見出しと説明文の間に細いヘアライン（h-10 w-px、account ゲートと同一モチーフ）を追加。
- **案内3カード**: 丸型アイコンを 48px→40px に縮小（繊細さ）。カード見出しを Didot（h3 既定）→ acumin-pro（font-brand・md・tracking 0.05em）に変更し、本文は line-height φ で行間を確保。
- **余白**: ブロック間 gap を --gap-section → --gap-layout に拡張し、コンテナに上下 padding（--gap-layout × √φ）を追加（Peak-End の余韻）。
- **モバイル**: 注文番号/注文日を grid-cols-1 sm:grid-cols-2 に変更（390px で縦積み）。注文番号は sm サイズ + break-all で UUID の折返しに対応。
- 検証: E2E [FR-CHECKOUT-013-complete-ui.spec.ts](../../e2e/FR-CHECKOUT-013-complete-ui.spec.ts)（3ビューポート）。実装: [src/app/checkout/page.tsx](../../src/app/checkout/page.tsx)。

### 追補（同日）— 完了画面のスクロール位置・CTA統一・角の方針（FREQ-77）

- **先頭表示**: 確定ボタンがページ下部にあるため、完了画面へ切り替わってもスクロール位置が残り見出しが画面外だった。`completed` 変化時に `window.scrollTo(0, 0)` を実行し先頭から表示。
- **CTA統一**: 「買い物を続ける」「注文履歴を見る」を独自スタイルの Link から共通 Button（primary／secondary・size lg）へ置換。ページ内の他CTA（お支払いを確定する 等）と高さ・書式を統一し、2ボタン間も min-width 220px で幅を揃えた（モバイルは全幅縦積み）。
- **角の方針（角丸 vs 直角）**: **直角を維持**と判断。根拠は (1) 決済直後はユーザーが処理の正当性に最も敏感な瞬間であり、入力画面まで一貫した直角UIが完了画面だけ角丸になると「別の場所に来た」違和感が不安要因になる（Jakob's Law・反復）、(2) ブランドの核（Form Before Decoration・モード・ミニマル）に角丸は不整合、(3) 感情面の柔らかさは丸型アイコン・日本語コピー・余白が既に担保しており、直角フレームとの対比でむしろ効いている。
- 検証: E2E [FR-CHECKOUT-014-complete-scroll-cta.spec.ts](../../e2e/FR-CHECKOUT-014-complete-scroll-cta.spec.ts)（3ビューポート）。

---

## 総評（CHECKOUT）

実装品質は全ページ随一。残る本質は **ステップ表記と確定順序の整合（CO-1/CO-2）** と **空カードガード（CO-3）**。ここを整えれば、高単価決済の信頼体験がさらに強固になる。
