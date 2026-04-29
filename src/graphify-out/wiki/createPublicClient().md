# createPublicClient()

> 31 nodes · cohesion 0.09

## Key Concepts

- **createPublicClient()** (8 connections) — `lib\supabase\server.ts`
- **generateMetadata()** (7 connections) — `app\news\[id]\page.tsx`
- **getPublishedNews()** (7 connections) — `features\news\services\public.ts`
- **public.ts** (5 connections) — `lib\look\public.ts`
- **news-images.ts** (5 connections) — `lib\storage\news-images.ts`
- **hydrateLooks()** (5 connections) — `lib\look\public.ts`
- **getPublishedNewsDetailById()** (5 connections) — `features\news\services\public.ts`
- **page.tsx** (4 connections) — `app\news\[id]\page.tsx`
- **getPublishedLooks()** (4 connections) — `lib\look\public.ts`
- **signNewsImageFields()** (4 connections) — `lib\storage\news-images.ts`
- **signNewsImageUrl()** (4 connections) — `lib\storage\news-images.ts`
- **page.tsx** (3 connections) — `app\news\page.tsx`
- **public.ts** (3 connections) — `features\news\services\public.ts`
- **getPublishedLookById()** (3 connections) — `lib\look\public.ts`
- **NewsPage()** (3 connections) — `app\news\page.tsx`
- **extractNewsImageObjectPath()** (3 connections) — `lib\storage\news-images.ts`
- **getLatestNews()** (2 connections) — `app\actions\news.ts`
- **page.tsx** (2 connections) — `app\item\[id]\page.tsx`
- **buildDescription()** (2 connections) — `app\news\[id]\page.tsx`
- **resolveCategory()** (2 connections) — `app\news\page.tsx`
- **getPublishedNewsNavigation()** (2 connections) — `features\news\services\public.ts`
- **createSignedUrlByPath()** (2 connections) — `lib\storage\news-images.ts`
- **normalizeObjectPath()** (2 connections) — `lib\storage\news-images.ts`
- **news.ts** (1 connections) — `app\actions\news.ts`
- **page.tsx** (1 connections) — `app\look\[id]\page.tsx`
- *... and 6 more nodes in this community*

## Relationships

- [[page.tsx]] (3 shared connections)
- [[createServiceRoleClient()]] (3 shared connections)
- [[clientFetch()]] (2 shared connections)
- [[NewsForm.tsx]] (1 shared connections)
- [[authorizeAdminPermission()]] (1 shared connections)
- [[DELETE()]] (1 shared connections)

## Source Files

- `app\actions\news.ts`
- `app\item\[id]\page.tsx`
- `app\look\[id]\page.tsx`
- `app\news\[id]\page.tsx`
- `app\news\page.tsx`
- `features\news\services\public.ts`
- `lib\look\public.ts`
- `lib\storage\news-images.ts`
- `lib\supabase\server.ts`

## Audit Trail

- EXTRACTED: 65 (68%)
- INFERRED: 30 (32%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*