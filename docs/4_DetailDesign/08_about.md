# 1.8 アバウトページ（ABOUT）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ABOUT-001 | ブランド哲学（Brand Philosophy）を紹介するセクションを表示する | IMPL-ABOUT-001 | `src/app/about/page.tsx` | テキストと画像の2カラムグリッドで表示 | 済 |
| FR-ABOUT-002 | `WHY WE MAKE / なぜ、つくるのか` で服づくりの理由と Founder の言葉を伝える | IMPL-ABOUT-002 | `src/app/about/page.tsx` | ブランドの問題意識、シルエットと生地への考え方、Founder の引用をテキスト中心の2カラムで表示 | 済 |
| FR-ABOUT-003 | `OUR COMMITMENTS / 取り組み` にブランドの3原則を掲載する | IMPL-ABOUT-003 | `src/app/about/page.tsx` | `01`〜`03` の番号と英語ラベル、日本語見出し、説明文で、タイムレス・ユニセックス／天然繊維／国内受注生産を表示 | 済 |
| FR-ABOUT-004 | COLLECTIONの設計思想と商品・LOOKへのCTAをレスポンシブ表示する | IMPL-ABOUT-004 | `src/app/about/page.tsx` | `COLLECTION / 商品設計思想` の説明後に `VIEW COLLECTION` と `VIEW LOOKBOOK` を配置。mobileは縦並び、tablet以上は横並び | 済 |
| FR-ABOUT-005 | ページに `h1` を含む見出し階層を明示し `generateMetadata` で `title` / `description` を設定する | IMPL-ABOUT-005 | `src/app/about/page.tsx` | `generateMetadata` で title / description / openGraph を設定済み。現行デザインはセクション見出しが `h2` から始まり、`h1` は未実装 | 一部未 |
| FR-ABOUT-006 | ブランドストーリー後に `COLLECTIONを見る` / `LOOKBOOKを見る` / `CONTACTする` などの CTA を設置する | IMPL-ABOUT-006 | `src/app/about/page.tsx` | `Explore More` セクションを追加し `/item` `/look` `/contact` への CTA を設置 | 済 |
| FR-ABOUT-007 | 装飾アイコンに `aria-hidden="true"` を設定し画像 `alt` 属性をより具体的な説明にする | IMPL-ABOUT-007 | `src/app/about/page.tsx` | 装飾アイコンへ `aria-hidden="true"` を付与。2画像の alt を文脈的で具体的な説明に更新 | 済 |
| FR-ABOUT-008 | 画像を外部動的生成 URL（readdy.ai）から静的ローカルアセットまたは管理された CDN 画像に移行する | IMPL-ABOUT-008 | `src/app/about/page.tsx` | 画像ソースを `readdy.ai` から `/about.png` `/mainphoto.png` のローカル静的アセットへ移行 | 済 |
