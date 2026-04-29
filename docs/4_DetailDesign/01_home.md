# 1.1 ホームページ（HOME）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-HOME-001 | ヒーローセクションにブランドの世界観を伝える大型バナーを全画面表示する | IMPL-HOME-001 | `src/app/page.tsx` | `/mainphoto.png` を `<Image>` コンポーネントでフルスクリーン表示。グラデーションオーバーレイと `h1` ブランド名を重ねて表示 | 済 |
| FR-HOME-002 | ITEM・LOOK・NEWS・ABOUT の4セクションをスクロールで掲載する | IMPL-HOME-002 | `src/app/page.tsx` | `PublicItemGrid` / `PublicLookGrid` / `PublicNewsGrid` / インライン ABOUT セクション + `PublicStockistGrid` を順次レイアウト | 済 |
| FR-HOME-003 | ABOUT セクションに `/about` ページへの導線リンクを設ける | IMPL-HOME-003 | `src/app/page.tsx` | ABOUT セクションは存在するが `/about` への `<Link>` CTA ボタンが未設置 | 不要 |
| FR-HOME-004 | ITEM・LOOK・NEWS 各セクション末尾に「もっと見る」ボタンを配置する | IMPL-HOME-004 | `src/features/items/components/PublicItemGrid.tsx`, `src/features/look/components/PublicLookGrid.tsx`, `src/features/news/components/PublicNewsGrid.tsx` | "VIEW ALL ITEMS" / "VIEW LOOKBOOK" / "VIEW ALL NEWS" ボタンを各グリッドコンポーネントに実装 | 済 |
| FR-HOME-005 | STOCKIST セクションをホームに追加し `PublicStockistGrid variant="home"` で最大6件を表示する | IMPL-HOME-005 | `src/app/page.tsx`, `src/features/stockist/components/PublicStockistGrid.tsx` | `<PublicStockistGrid variant="home" />` をページ末尾に設置。`getHomePublicStockists()` で最大6件取得 | 済 |
| FR-HOME-006 | `generateMetadata` を実装しホームページ固有の `title` / `description` を設定する | IMPL-HOME-006 | `src/app/page.tsx`, `src/app/layout.tsx` | `src/app/page.tsx` に `generateMetadata` を追加し、ホーム固有の `title` / `description` / Open Graph を設定。`layout.tsx` の既定 description もブランド用文言へ更新 | 済 |
| FR-HOME-007 | ヒーロー画像に `priority` を設定してプリロードし LCP を最小化する | IMPL-HOME-007 | `src/app/page.tsx` | ヒーロー画像に `priority` と `sizes="100vw"` を設定し、初回表示で優先的に読み込むよう修正 | 済 |
| FR-HOME-008 | ABOUT セクション画像を静的ローカルアセットまたは管理された CDN 画像に置き換える | IMPL-HOME-008 | `src/app/page.tsx` | ABOUT セクション画像が `readdy.ai` 外部動的生成 URL を使用。サービス停止時にページが壊れるリスクあり | 済 |
| FR-HOME-009 | `h1` 要素を1つ配置し各セクション見出しを `h2` として構造化する | IMPL-HOME-009 | `src/app/page.tsx` | ヒーローに `h1`（ブランド名）、各セクションに `SectionTitle`（`h2` 相当）を使用。見出し階層は適切 | 済 |
| NFR-HOME-001 | ホームページの初回表示速度を2秒以内に収める | IMPL-HOME-010 | `src/app/page.tsx` | `priority` 未設定・外部画像依存のため目標達成が不確定 | 済 |
| NFR-HOME-002 | WCAG 2.1 AA を満たす色彩コントラストを確保する | IMPL-HOME-011 | `src/app/page.tsx`, `src/components/Header.tsx`, `src/styles/globals.css`, `e2e/NFR-HOME-002-wcag-accessibility.spec.ts`, `e2e/FR-HOME-006-007-011-home-quality.spec.ts` | ヒーロー見出しの高コントラスト表示を維持し、装飾グラデーションを `aria-hidden` 化。共通ヘッダーの `h1` を通常テキストへ変更してページ内 `h1` を 1 つに整理し、Playwright で contrast・見出し構造・表示崩れを確認 | 済 |

## 運用メモ

- BUG-PUBLIC-001: `migrations/049_set_wishlist_session_context_pre_request.sql` の `private.set_request_context` は PostgREST の全リクエスト前に実行されるため、`private` schema の `USAGE` 権限が欠けると HOME を含む全公開ページの DB 読み取りが空になる。復旧には `migrations/050_restore_public_read_access_after_pre_request_hook.sql` の適用が必須。
