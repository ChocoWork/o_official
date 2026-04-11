# 1.5 商品詳細ページ（ITEM DETAIL）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ITEM-DETAIL-001 | クライアントサイドで `/api/items/[id]` から商品データを読み込みページを構成する | IMPL-ITEM-DETAIL-001 | `src/app/item/[id]/page.tsx`, `src/app/api/items/` | `"use client"` コンポーネントで `useEffect` から `fetch('/api/items/${id}')` を実行 | 済 |
| FR-ITEM-DETAIL-002 | 画像カルーセルを表示しモバイルでは横スクロール・デスクトップではサムネイル選択 UI を提供する | IMPL-ITEM-DETAIL-002 | `src/app/item/[id]/page.tsx` | `carouselRef` で横スクロールを実装し `handleCarouselScroll` でインデックスを追従。サムネイルクリックで画像切替 | 済 |
| FR-ITEM-DETAIL-003 | カラー・サイズ・数量をユーザーが選択でき選択状態を明確に表示する | IMPL-ITEM-DETAIL-003 | `src/app/item/[id]/page.tsx`, `src/components/ui/Stepper.tsx` | カラー・サイズのボタン選択 + `Stepper` コンポーネントで数量指定 | 済 |
| FR-ITEM-DETAIL-004 | カート追加ボタンとウィッシュリスト切替ボタンを提供し状態変更時に適切なフィードバックを返す | IMPL-ITEM-DETAIL-004 | `src/app/item/[id]/page.tsx`, `src/app/api/cart/route.ts`, `src/app/api/wishlist/route.ts` | カート追加・ウィッシュリスト切替ともに実装済み。フィードバックは `alert()` を使用（Toast 等への改善推奨） | 済 |
| FR-ITEM-DETAIL-005 | 読み込み中はローディング表示・404 時にはエラーメッセージと戻るボタンを表示する | IMPL-ITEM-DETAIL-005 | `src/app/item/[id]/page.tsx` | ローディング中は「読み込み中...」テキスト表示。エラー時は "BACK TO ITEMS" ボタンを表示 | 済 |
| FR-ITEM-DETAIL-006 | レスポンシブレイアウトを採用しモバイルでは固定フッターボタンを含む操作領域を維持する | IMPL-ITEM-DETAIL-006 | `src/app/item/[id]/page.tsx` | デスクトップは `md:sticky` で粘着配置。モバイルは `fixed bottom-0` の固定フッターボタンを `IntersectionObserver` で制御 | 済 |
| FR-ITEM-DETAIL-007 | 在庫状態を表示しサイズ・カラー選択時に「残りわずか」「売り切れ」情報を明示する。選択不可バリエーションは無効化する | IMPL-ITEM-DETAIL-007 | `src/app/item/[id]/page.tsx` | 在庫状態の表示ロジックがなく品切れバリアントの無効化も未実装 | 未 |
| FR-ITEM-DETAIL-008 | カラー・サイズのボタンに `aria-pressed` を付与しエラーメッセージには `role="alert"` を含める | IMPL-ITEM-DETAIL-008 | `src/app/item/[id]/page.tsx` | カラー・サイズボタンに `aria-pressed` なし。エラーメッセージに `role="alert"` なし | 未 |
| FR-ITEM-DETAIL-009 | `generateMetadata` で SEO メタ情報を設定する（Server Component ラッパーへの切り出しが必要） | IMPL-ITEM-DETAIL-009 | `src/app/item/[id]/page.tsx` | ページ全体が `"use client"` で `generateMetadata` エクスポート不可。SEO 未対応 | 未 |
| FR-ITEM-DETAIL-010 | パンくずナビゲーションと「ITEM一覧へ戻る」の明示的リンクを設ける | IMPL-ITEM-DETAIL-010 | `src/app/item/[id]/page.tsx` | エラー時のみ "BACK TO ITEMS" ボタンが表示される。正常時にパンくずも `/item` 固定リンクも存在しない | 未 |
| FR-ITEM-DETAIL-011 | `compare_at_price` / セール価格対応や「NEW」「SALE」「SOLD OUT」バッジ表示を追加する | IMPL-ITEM-DETAIL-011 | `src/app/item/[id]/page.tsx`, `src/types/item.ts` | 未実装。価格は `¥{item.price.toLocaleString()}` のみ | 未 |
| FR-ITEM-DETAIL-012 | 同カテゴリ・おすすめルックなどの関連商品提案セクションを設ける | IMPL-ITEM-DETAIL-012 | `src/app/item/[id]/page.tsx` | 未実装 | 未 |
| FR-ITEM-DETAIL-013 | 画像の alt テキストは商品名だけでなく色・角度などを含めて付与する | IMPL-ITEM-DETAIL-013 | `src/app/item/[id]/page.tsx` | メイン画像の alt は `item.name` のみ。カルーセル画像は `${item.name} ${index + 1}` の連番のみ | 未 |

---

## 実装タスク管理 (ITEMS-01 PDP)

**タスクID**: ITEMS-01  
**ステータス**: 一部実装済  
**元ファイル**: `docs/tasks/02_items_ticket.md`

### PDP チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| ITEMS-01-PDP-001 | `GET /api/items/:id` PDP データ取得（SKU 単位価格・在庫） | IMPL-ITEMS-DETAIL-API-01 | `src/app/api/items/[id]/route.ts` | API 実装済み。在庫表示は未実装 | 一部未 |
| ITEMS-01-PDP-002 | SKU バリアント（サイズ・カラー）選択と在庫ステータス表示 | IMPL-ITEMS-VARIANT-01 | `src/app/item/[id]/page.tsx` | 未実装（FR-ITEM-DETAIL-007） | 未 |
| ITEMS-01-PDP-003 | `next/image` による画像最適化 | IMPL-ITEMS-IMAGE-01 | `src/app/item/[id]/page.tsx` | 未実装（通常 `<img>` タグ使用） | 未 |
| ITEMS-01-PDP-004 | 入荷通知 `POST /api/items/:id/notify` | IMPL-ITEMS-NOTIFY-01 | `src/app/api/items/[id]/notify/route.ts` | 未実装 | 未 |

---

## 在庫予約フロー設計（ITEMS-RESERVATION）

> 元ファイル: `docs/2_Specs/02_items.md`

### 方式比較

| 方式 | フロー | メリット | デメリット | 採用 |
|-----|-------|---------|----------|------|
| 悲観的ロック | トランザクション内で `SELECT FOR UPDATE` し在庫デクリメント | 強い整合性 | 長時間ロックでスループット低下・分散環境で非推奨 | ❌ |
| **楽観的ロック + 補償**（推奨） | `reservation` レコードを作成し在庫を一時確保（TTL あり）→ 注文確定で正式デクリメント | スケーラブル・高パフォーマンス | 補償ロジックとリコンシリエーションが必要 | ✅ |

### 楽観的ロック実装方針

1. `skus` テーブルに `version` カラムを追加。
2. 在庫確保時: `UPDATE skus SET reserved = reserved + qty, version = version + 1 WHERE id = ? AND version = ?`。
3. 失敗時（バージョン不一致）: 再試行 または `409 Conflict` を返す。
4. Reservation TTL: 15 分（設定可）。期限切れは自動でリリース（クリーンアップジョブ）。
5. 注文確定時: reservation を confirmed 状態にして在庫を正式デクリメント。

### 注意事項

- 注文フローの在庫チェックは必ず DB で行う。検索インデックスの在庫は参考表示のみ。
- 在庫不整合が発生した場合はユーザーに明確なエラー / 案内を表示する。
