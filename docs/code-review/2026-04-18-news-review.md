# Code Review: News Page Security
**Ready for Production**: No
**Critical Issues**: 4

## Review Scope
- Spec: docs/4_DetailDesign/02_news_list.md
- Frontend: src/app/news/page.tsx, src/app/news/NewsCategoryTabs.tsx, src/features/news/**, src/app/news/[id]/page.tsx
- API: src/app/api/news/**
- Related backend/storage/admin evidence: src/app/api/admin/news/**, src/lib/supabase/server.ts, src/lib/audit.ts
- DB/Migrations: migrations/012_create_news_articles.sql, migrations/013_create_news_images_bucket.sql, migrations/014_rename_draft_to_private.sql, migrations/015_add_news_articles_rls.sql, migrations/023_add_acl_rbac_tables_and_policies.sql

## Pass 1: Frontend / Rendering / XSS
- No critical XSS issue found in the public news list or detail rendering path.
- News text is rendered as plain text in React and detail paragraphs are split on line breaks rather than inserted as raw HTML.

## Pass 2: API / Backend / Validation / Authorization / Rate Limit

### Priority 1 (Must Fix) ⛔
- src/lib/supabase/server.ts logs Authorization-derived state and raw cookie fragments while being used by the public news page and API path. This creates a token/session leakage risk in server logs.
- src/app/api/news/route.ts exposes a public enumeration endpoint with no rate limiting and no upper bound on limit. The project already has a reusable rate limiter, but this route does not use it.

## Pass 3: DB / RLS / Publication / Storage / Audit

### Priority 1 (Must Fix) ⛔
- migrations/013_create_news_images_bucket.sql creates the news-images bucket as fully public. Private/unpublished news can therefore reference assets that are world-readable once uploaded if their URL is disclosed or guessed.
- No audit trail is attached to news article create/update/publish/delete operations or related storage uploads. src/lib/audit.ts exists, but the news admin routes do not call it and the DB migrations do not add audit triggers for news_articles.

## Suggested Fixes
- Remove sensitive logging from src/lib/supabase/server.ts, especially cookie/header dumps and token-presence logs.
- Apply enforceRateLimit to src/app/api/news/route.ts and clamp limit to a small safe maximum.
- Change news image delivery to private storage plus signed URLs, or separate unpublished assets from public published assets using path-based controls.
- Add audit logging for admin news CRUD and publication state changes, including actor, resource id, outcome, and storage object path.