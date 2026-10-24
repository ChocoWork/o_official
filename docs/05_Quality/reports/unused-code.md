# 使われていないコードの候補

> 状態: 自動生成 | 生成日: 2026-10-24 | 対象: NEWS・HOME・LOOK・ABOUT・STOCKIST・SEARCH・PRIVACY・AUTH・ADMIN

## 概要

どこからも呼ばれていないコードの候補と、残すか消すかの判断。

`npm run trace:report` が作る。手で直さない（「判断」の列だけはユーザーが書き、生成し直しても残る。候補は消さずに載せる）。

| 場所 | 記号 | 見つけ方 | 確かめた方法 | 消した時の影響 | 範囲 | 判断 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/app/news/NewsCategoryTabs.tsx` | `NewsCategoryTabsProps` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（このファイルを指す 2 件のどれも NewsCategoryTabsProps を import しない）。文字の検索「NewsCategoryTabsProps」: ほかのファイルに 0 件 | ファイルの外から使われない（ファイルの中では残る）。文書の参照: なし | 範囲内 |  |
| `src/components/AuthTabs.tsx` | `AuthTab` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（このファイルを指す 5 件のどれも AuthTab を import しない）。文字の検索「AuthTab」: ほかのファイルに 6 件 | ファイルの外から使われない（ファイルの中では残る）。文書の参照: 6 件（docs/02_Requirements/areas/auth.md、docs/03_BasicDesign/areas/auth.md、docs/03_BasicDesign/decisions/ADR-0410-login-register-single-page-tabs.md ほか 3 件） | 範囲内 |  |
| `src/features/stockist/region.ts` | `StockistRegion` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（このファイルを指す 3 件のどれも StockistRegion を import しない）。文字の検索「StockistRegion」: ほかのファイルに 0 件 | ファイルの外から使われない（ファイルの中では残る）。文書の参照: 2 件（docs/03_BasicDesign/areas/stockist.md、docs/04_DetailDesign/pages/10_stockist.md） | 範囲内 |  |
| `src/components/CartItem.tsx` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「components/CartItem」か「./CartItem」で終わる文字列）: ほかのファイルに 0 件 | import する試験: なし。文書の参照: 2 件（docs/04_DetailDesign/pages/12_cart.md、docs/05_Quality/reviews/uiux/uiux_review_cart.md） | 範囲外 |  |
| `src/components/ContactSection.tsx` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「components/ContactSection」か「./ContactSection」で終わる文字列）: ほかのファイルに 2 件（scripts/trace/unused.ts、tests/unit/scripts/trace/unused.test.ts） | import する試験: なし。文書の参照: 4 件（docs/02_Requirements/areas/admin.md、docs/03_BasicDesign/areas/admin.md、docs/04_DetailDesign/pages/16-2_admin_misc.md ほか 1 件） | 範囲外 |  |
| `src/components/ShareButtons.tsx` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「components/ShareButtons」か「./ShareButtons」で終わる文字列）: ほかのファイルに 0 件 | import する試験: なし。文書の参照: 3 件（docs/03_BasicDesign/architecture/system-overview.md、docs/05_Quality/reviews/uiux/uiux_review_look_id.md、docs/05_Quality/reviews/uiux/uiux_review_news_id.md） | 範囲外 |  |
| `src/components/ui/InputChangeEvent.ts` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「components/ui/InputChangeEvent」か「./InputChangeEvent」で終わる文字列）: ほかのファイルに 0 件 | import する試験: なし。文書の参照: なし | 範囲外 |  |
| `src/components/ui/shared.ts` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「components/ui/shared」か「./shared」で終わる文字列）: ほかのファイルに 0 件 | import する試験: なし。文書の参照: なし | 範囲外 |  |
| `src/lib/cache/redis-cache.ts` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「lib/cache/redis-cache」か「./redis-cache」で終わる文字列）: ほかのファイルに 1 件（tests/unit/scripts/trace/unused.test.ts） | import する試験: なし。文書の参照: 1 件（docs/03_BasicDesign/architecture/system-overview.md） | 範囲外 |  |
| `src/utils/supabase/server.ts` | `<file>` | 参照なし | src/・tests/・e2e/・scripts/・直下の設定 2089 ファイルの import・export from・import()・require・jest.mock を解決（指す所 0 件）。文字の検索（「utils/supabase/server」か「./server」で終わる文字列）: ほかのファイルに 1 件（scripts/trace/unused.ts） | import する試験: なし。文書の参照: なし | 範囲外 |  |
