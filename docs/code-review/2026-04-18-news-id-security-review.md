# Code Review: news/[id] security

**Ready for Production**: No
**Critical Issues**: 2

## Scope

- src/app/news/[id]/page.tsx
- src/app/api/news/route.ts
- src/features/news/services/public.ts
- src/features/news/components/PublicNewsGrid.tsx
- src/features/news/types.ts
- migrations/012_create_news_articles.sql
- migrations/013_create_news_images_bucket.sql
- migrations/014_rename_draft_to_private.sql
- migrations/015_add_news_articles_rls.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql

## Review Basis

- docs/4_DetailDesign/03_news_detail.md

## Pass Summary

- Pass 1: Frontend, id parameter, rich text, XSS
  - No material XSS issue found in the current detail renderer. The page renders article text as React text nodes and does not use HTML injection.
- Pass 2: API, backend, input validation, authorization, rate limiting
  - Public news API has no rate limiting and no upper bound for the user-controlled limit parameter.
- Pass 3: DB, RLS, publication conditions, image exposure, audit
  - News images are stored in a fully public bucket, so unpublished article assets can be exposed outside the published-article RLS boundary.

## Priority 1 (Must Fix)

1. Public news API is missing abuse controls in src/app/api/news/route.ts and src/features/news/services/public.ts.
   - The endpoint is unauthenticated, accepts a caller-controlled limit, and does not apply any rate limiting.
   - This allows trivial bulk scraping and unnecessary database load amplification.
   - Fix: apply the existing rate-limit middleware to this route and clamp limit to a small maximum. Reject invalid or oversized values with 400, or silently clamp to a documented cap.

2. News image storage is publicly exposed in migrations/013_create_news_images_bucket.sql.
   - The news-images bucket is created with public = true, while article visibility is controlled separately by news_articles.status and RLS.
   - As a result, assets uploaded for private articles can remain internet-accessible if their URL is known or leaked, which breaks the intended publication boundary.
   - Fix: store news images in a private bucket and deliver only published assets through signed URLs or a server-side proxy. If public delivery is required, separate draft/private and published assets into different buckets and move objects on publish.

## Residual Risk

- The current review did not find a stored/reflected XSS sink in the public news detail path because detailed_content is rendered as plain text, but this should be re-reviewed if rich text HTML rendering is introduced later.