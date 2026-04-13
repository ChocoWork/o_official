# 1.8 アバウトページ（ABOUT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ABOUT-001 | ブランド哲学（Brand Philosophy）を紹介するセクションを表示する | IMPL-ABOUT-001 | `src/app/about/page.tsx` | テキストと画像の2カラムグリッドで表示 | 済 |
| FR-ABOUT-002 | 品質・クラフトマンシップ（Quality & Craftsmanship）を紹介するセクションを表示する | IMPL-ABOUT-002 | `src/app/about/page.tsx` | 2セクション目として画像とテキストを逆順配置で表示 | 済 |
| FR-ABOUT-003 | `Timeless` / `Sustainable` / `Thoughtful` の価値観をアイコン付き3カラムで掲載する | IMPL-ABOUT-003 | `src/app/about/page.tsx` | Remixicon アイコン（`ri-time-line`, `ri-leaf-line`, `ri-heart-line`）付きで3カラム表示 | 済 |
| FR-ABOUT-004 | 画像とテキストを交互に配置したレスポンシブレイアウトでブランドストーリーを伝える | IMPL-ABOUT-004 | `src/app/about/page.tsx` | 1セクション目は画像左・テキスト右、2セクション目は `lg:order-2` / `lg:order-1` で逆順 | 済 |
| FR-ABOUT-005 | ページに `h1` を含む見出し階層を明示し `generateMetadata` で `title` / `description` を設定する | IMPL-ABOUT-005 | `src/app/about/page.tsx` | `h1` を追加し `generateMetadata` を実装。title / description / openGraph を設定 | 済 |
| FR-ABOUT-006 | ブランドストーリー後に `COLLECTIONを見る` / `LOOKBOOKを見る` / `CONTACTする` などの CTA を設置する | IMPL-ABOUT-006 | `src/app/about/page.tsx` | `Explore More` セクションを追加し `/item` `/look` `/contact` への CTA を設置 | 済 |
| FR-ABOUT-007 | 装飾アイコンに `aria-hidden="true"` を設定し画像 `alt` 属性をより具体的な説明にする | IMPL-ABOUT-007 | `src/app/about/page.tsx` | 装飾アイコンへ `aria-hidden="true"` を付与。2画像の alt を文脈的で具体的な説明に更新 | 済 |
| FR-ABOUT-008 | 画像を外部動的生成 URL（readdy.ai）から静的ローカルアセットまたは管理された CDN 画像に移行する | IMPL-ABOUT-008 | `src/app/about/page.tsx` | 画像ソースを `readdy.ai` から `/about.png` `/mainphoto.png` のローカル静的アセットへ移行 | 済 |
