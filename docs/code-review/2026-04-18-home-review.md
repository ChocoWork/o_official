# Code Review: Home Page

**Ready for Production**: No
**Critical Issues**: 3

## Scope

- Entry point: src/app/page.tsx
- Pass 1: Frontend rendering, input handling, XSS, information exposure
- Pass 2: API, backend, authn/authz, CSRF, rate limiting
- Pass 3: DB, RLS, secrets, audit, cache, data flow

## Related Files

- src/app/page.tsx
- src/features/search/components/SearchHomePreview.tsx
- src/app/api/search/route.ts
- src/features/search/services/search.service.ts
- src/lib/items/public.ts
- src/features/news/services/public.ts
- src/lib/look/public.ts
- src/features/stockist/services/public.ts
- src/features/items/components/PublicItemGrid.tsx
- src/features/look/components/PublicLookGrid.tsx
- src/features/news/components/PublicNewsGrid.tsx
- src/features/stockist/components/PublicStockistGrid.tsx
- src/lib/supabase/server.ts
- src/proxy.ts
- docs/4_DetailDesign/01_home.md
- docs/3_ArchitectureDesign/auth-structure.md
- docs/3_ArchitectureDesign/hybrid-rbac.md
- docs/4_DetailDesign/01_auth_seq.md
- migrations/015_add_news_articles_rls.sql
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/018_create_looks_and_look_images_bucket.sql
- migrations/019_add_public_select_policy_to_look_items.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql
- migrations/027_create_stockists_and_acl.sql

## Priority 1 (Must Fix) ⛔

- src/lib/supabase/server.ts | Cookie header と認証関連 Cookie の一部を console.log / console.warn に出しており、ホーム表示や検索 API 経由の通常アクセスでセッショントークン断片がサーバログへ露出する | 認証トークン、Cookie 値、Authorization ヘッダーに関するログを削除し、必要なら request id や cookie 件数だけをマスク済みで出力する
- src/lib/look/public.ts | 公開 LOOK の関連商品取得で items に status='published' 条件を付けておらず、viewer のセッション権限が有効な場合に非公開商品メタデータを公開ページ経路で取得し得る | 公開用途の関連商品取得は必ず .eq('status', 'published') を追加し、可能なら公開ページ用は認証セッションを引き継がない anon 前提クライアントへ分離する
- src/app/api/search/route.ts | ホームの SearchHomePreview が直接叩く公開検索 API にレート制限がなく、認証仕様で要求される一般 API の濫用対策とも整合していないため、列挙・負荷増大・全文検索悪用の入口になる | enforceRateLimit を導入して IP またはセッション単位の制限を付け、必要なら preview=true にはより厳しい上限と no-store を設定する

## Residual Risks

- src/proxy.ts により CSP、Referrer-Policy、nosniff、DENY、HSTS は付与されている
- items、news_articles、looks、look_items、stockists は migration 上で RLS 有効化を確認した
- 今回の範囲では dangerouslySetInnerHTML や生 HTML 描画は確認できなかった