# ITEM 詳細（/item/[id]）UI/UX レビュー

- 対象: [src/app/item/[id]/page.tsx](../../src/app/item/[id]/page.tsx) / [src/app/item/[id]/ItemDetailClient.tsx](../../src/app/item/[id]/ItemDetailClient.tsx)
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

**購入の最終意思決定ページ**。コアペルソナは「天然繊維100%・洗える・シルエット・素材の正確な情報」で価格を正当化する（PSM分析の高単価が成立する場所）。実装の作り込みは全ページ中で最も高い（breadcrumb / skeleton / 在庫バッジ / aria-pressed / インラインエラー / モバイル固定CTA）。**残る課題はブランド差別化情報の表出と、カラー選択・成功体験の磨き込み**。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| ID-1 | PRODUCT DETAILS / DESCRIPTION（[ItemDetailClient.tsx:523-574](../../src/app/item/[id]/ItemDetailClient.tsx#L523-L574)） | ブランドの中核訴求（天然繊維100%・洗濯機OK・受注生産・産地/素材）が自由記述任せで構造化されていない。購入の正当化情報が弱い。ブランド適合（刺さる言葉） | 「素材/ケア（洗濯可否）/原産/受注生産」を定型スペック表として常時表示 | High | 対応済 |
| ID-2 | PRODUCT DETAILS object 描画（[ItemDetailClient.tsx:559-571](../../src/app/item/[id]/ItemDetailClient.tsx#L559-L571)） | オブジェクト型詳細を `String(value)` で**値のみ**描画し key（項目名）が消える。例「素材: 綿100%」が「綿100%」だけに。情報設計/可読性 | `key: value` 形式の定義リスト（`<dl>`）で表示 | High | 対応済 |
| ID-3 | カラー選択（[ItemDetailClient.tsx:453-475](../../src/app/item/[id]/ItemDetailClient.tsx#L453-L475)） | `colors` に hex があるのに**色名テキストボタンのみ**でスウォッチ非表示。一覧フィルタはスウォッチ表示で**不整合**。認知（recognition>recall）/反復 | カラーボタンに実色スウォッチを併記 | Mid | 対応済 |
| ID-4 | 成功フィードバック（[ItemDetailClient.tsx:173-174](../../src/app/item/[id]/ItemDetailClient.tsx#L173-L174)） | カート追加成功が「ADDED」2秒のみで、カートへの導線が出ない。Peak-End（購入の山場）の取りこぼし | 「カートを見る」リンク or ミニ通知（数量・小計）を提示 | Mid | 対応済 |
| ID-5 | サイズ選択（[ItemDetailClient.tsx:480-502](../../src/app/item/[id]/ItemDetailClient.tsx#L480-L502)） | サイズガイド/実寸リンクが無い。コアペルソナは「シルエットに異常にこだわる」。エラー防止/情報設計 | 「サイズガイド」リンク（モーダル/別表）を SIZE 近傍に追加 | Mid | 対応済 |
| ID-6 | オプションボタン（[ItemDetailClient.tsx:460-499](../../src/app/item/[id]/ItemDetailClient.tsx#L460-L499)） | カラー/サイズ Button が `size="xs"`。モバイルでタップターゲット 44px 未満の懸念。Fitts/タッチ | モバイルで最小44px高を確保（xsでも min-height 担保） | Mid | 対応済 |
| ID-7 | 数量（[ItemDetailClient.tsx:508-513](../../src/app/item/[id]/ItemDetailClient.tsx#L508-L513)） | Stepper に在庫上限（max）が無く、在庫超過数量を選べる。エラー防止 | 在庫数に応じ `max` を設定（low_stock時に注意喚起） | Low | 対応済 |
| ID-8 | breadcrumb（[ItemDetailClient.tsx:285-324](../../src/app/item/[id]/ItemDetailClient.tsx#L285-L324)） | 起点が ITEM で HOME が無い。Jakob（パンくずはHome起点が一般的） | 先頭に HOME を追加 | Low | 対応済 |
| ID-9 | 関連商品（[ItemDetailClient.tsx:625](../../src/app/item/[id]/ItemDetailClient.tsx#L625) RelatedItems） | 同カテゴリ機械推薦のみ。コーディネート文脈（このアイテムを使うLOOK）への送客が無い。クロスセル | 「このアイテムを使用したLOOK」への導線を併設 | Low | 対応済 |

---

## ブランド配色に関する判断（赤の使用）

| # | 指摘場所 | 内容 | 提案 | 優先度 | ステータス |
|---|---|---|---|---|---|
| ID-10 | wishlist ♡（[ItemDetailClient.tsx:611-617](../../src/app/item/[id]/ItemDetailClient.tsx#L611-L617),[669-673](../../src/app/item/[id]/ItemDetailClient.tsx#L669-L673)）/「残りわずか」（[ItemDetailClient.tsx:33-42](../../src/app/item/[id]/ItemDetailClient.tsx#L33-L42)） | `text-red-500`/赤枠は Key Color（黒・グレー・白）から逸脱。準ペルソナAは「色展開が派手」を嫌う | ♡塗りと「残りわずか」を黒/グレー基調へ。SOLD OUTバッジ（黒）の作法に統一 | Low | 対応済 |

---

## 良い点（維持）

- breadcrumb（aria-current）、skeleton、在庫バッジ（SOLD OUTは黒でブランド適合）、`aria-pressed`、`role="alert"` インラインエラー、モバイル固定CTA（Thumb-zone）— **UX原則の手本**。
- 画像はモバイル=スナップ式カルーセル+ドット、デスクトップ=メイン+サムネ（aria-label付）で操作性良好。`object-contain` で作品性を損なわない。
- 在庫切れ時は CTA を `SOLD OUT` で無効化（アフォーダンス明確）。

---

## implement-uiux に「あえて従わない」判断

- **CTAは黒ベタ1つ（ADD TO CART）に集中、ウィッシュは枠線アイコンで従**の現状は、スキルの「1画面1主役CTA」とブランド抑制の両立として理想的。**派手な色強調は不要**。
- **赤の扱い（ID-10）**: Jakob 的には「赤い♡」は強い慣習。ブランド純度を取るか慣習を取るかは**ブランド意思決定事項**。本レビューは「ブランド純度（モノクローム）優先」を推奨するが、機能上は現状でも可（必須修正ではない）。

---

## 修正反映（2026-06-20）

ユーザー判断により、PDPの製品情報を**構造化（素材／原産国／縫製地域／ケア）**し、コレクションは**SS/AWのみ**（年は廃止）に再設計。DB追加・管理画面・API・一覧フィルタ・PDPに跨る実装を実施。

- **ID-1（対応済）**: PDPに構造化スペックを常時表示。表示形式（`<dl>`、表組みなし）:
  - 素材：&lt;素材名&gt;（&lt;原産国&gt;）
  - 縫製地域：&lt;地域名&gt;
  - ケア：&lt;ケア方法&gt;
- **ID-2（対応済）**: 旧データのオブジェクト表示を `key: value` に修正（フォールバック経路）。新データは構造化カラムで表示。
- **ID-10（補足）**: 在庫「残りわずか」「♡」の赤は別件として未対応（ブランド純度の判断事項）。
- **コレクション**: ITEM/PDPから「年」を撤廃。SS/AW のみ管理画面で入力し、`season` カラムでフィルタ（[uiux_review_item.md] の SEASON フィルタも item.season 参照に変更）。

### 変更ファイル
- DBマイグレーション: [migrations/055_add_item_structured_details.sql](../../migrations/055_add_item_structured_details.sql)（material/origin/sewing_region/care/season 追加・追加のみで後方互換）
- 型: [src/types/item.ts](../../src/types/item.ts) / [src/app/admin/item/types.ts](../../src/app/admin/item/types.ts)
- 管理画面: [src/app/admin/item/ItemForm.tsx](../../src/app/admin/item/ItemForm.tsx)（4項目＋SS/AW入力）/ [edit/[id]/page.tsx](../../src/app/admin/item/edit/[id]/page.tsx)
- API: [api/admin/items/route.ts](../../src/app/api/admin/items/route.ts) / [api/admin/items/[id]/route.ts](../../src/app/api/admin/items/[id]/route.ts) / [api/items/route.ts](../../src/app/api/items/route.ts) / [api/items/[id]/route.ts](../../src/app/api/items/[id]/route.ts) / [lib/items/public.ts](../../src/lib/items/public.ts)
- PDP: [src/app/item/[id]/ItemDetailClient.tsx](../../src/app/item/[id]/ItemDetailClient.tsx)
- 一覧フィルタ: [src/features/items/components/PublicItemGrid.tsx](../../src/features/items/components/PublicItemGrid.tsx)（SEASONを item.season 参照に）

### 要対応（デプロイ前）
- **マイグレーション 055 の適用が必須**（未適用だと `season` 等の列が無く API がエラー）。本番DBへの適用は未実施。適用方法（手動 / Supabase）をご指示ください。
- 既存ITEMは新フィールドが空 → 旧 `product_details` テキストでフォールバック表示。管理画面から順次再入力で構造化表示に切替。
- TypeScript 型チェック（`tsc --noEmit`）で本変更のエラーが無いことを確認済み。

---

## 修正反映（2026-06-23）

- **ID-3**: カラーボタンに hex スウォッチ（`/^#[0-9a-fA-F]{6}$/` 検証）を併記。一覧フィルタのスウォッチ表示と整合。
- **ID-4**: カート追加成功時に `role="status"` のインライン通知（✓「カートに追加しました」+「カートを見る」→ /cart）を表示。
- **ID-5**: SIZE 見出し横に「サイズガイド」`<details>` を追加（採寸の目安 + お問い合わせ導線）。
- **ID-6**: カラー/サイズの `size="xs"` ボタンに `min-h-[44px]` を付与しタップターゲットを確保。
- **ID-7**: Stepper に `max` を設定。`stock_quantity`（あれば）または `stockStatus==='low_stock'` 時は 4 を上限に（在庫はAPIが `stockStatus` のみ公開＝数量秘匿のため low_stock は閾値4で best-effort、最終検証はサーバ側カートで担保）。
- **ID-8**: breadcrumb 先頭に HOME を追加（HOME > ITEM > カテゴリ > 商品名）。
- **ID-9**: 商品詳細ページ（server）に「FEATURED IN LOOK」セクションを追加。`getPublishedlooks` から当該アイテムを含む LOOK を最大4件抽出して送客。
- **ID-10**: wishlist ♡（PC/モバイル）の `text-red-500` → `text-black`、「残りわずか」バッジの `text-red-600 border-red-400` → `text-[#474747] border-black/30` にしモノクローム統一。
- 実装: [src/app/item/[id]/ItemDetailClient.tsx](../../src/app/item/[id]/ItemDetailClient.tsx) / [src/app/item/[id]/page.tsx](../../src/app/item/[id]/page.tsx)。

---

## 総評（ITEM 詳細）

実装品質は高水準。**最優先はブランド差別化情報の構造化表示（ID-1/ID-2）**＝高単価を正当化する情報。次いでカラースウォッチ（ID-3）・成功体験（ID-4）・サイズガイド（ID-5）で、吟味して買う層のCVを引き上げられる。
