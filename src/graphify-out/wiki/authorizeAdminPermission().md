# authorizeAdminPermission()

> 34 nodes · cohesion 0.09

## Key Concepts

- **authorizeAdminPermission()** (32 connections) — `lib\auth\admin-rbac.ts`
- **GET()** (9 connections) — `app\api\items\route.ts`
- **GET()** (9 connections) — `app\api\news\route.ts`
- **POST()** (6 connections) — `app\api\admin\news\route.ts`
- **route.ts** (5 connections) — `app\api\admin\users\route.ts`
- **POST()** (5 connections) — `app\api\admin\items\route.ts`
- **admin-rbac.ts** (5 connections) — `lib\auth\admin-rbac.ts`
- **POST()** (5 connections) — `app\api\admin\orders\[id]\status\route.ts`
- **GET()** (5 connections) — `app\api\admin\users\route.ts`
- **PATCH()** (5 connections) — `app\api\admin\users\route.ts`
- **route.ts** (4 connections) — `app\api\admin\news\route.ts`
- **resolveTokenRole()** (4 connections) — `lib\auth\admin-rbac.ts`
- **logNewsAudit()** (4 connections) — `app\api\admin\news\route.ts`
- **route.ts** (3 connections) — `app\api\admin\items\route.ts`
- **GET()** (3 connections) — `app\api\admin\audit-logs\route.ts`
- **resolveAclPermissions()** (3 connections) — `lib\auth\admin-rbac.ts`
- **GET()** (3 connections) — `app\api\admin\item-color-presets\route.ts`
- **POST()** (3 connections) — `app\api\admin\item-color-presets\route.ts`
- **GET()** (3 connections) — `app\api\admin\kpi\migration-status\route.ts`
- **getRequestUserAgent()** (3 connections) — `app\api\admin\news\route.ts`
- **GET()** (3 connections) — `app\api\admin\orders\[id]\status\route.ts`
- **route.ts** (2 connections) — `app\api\admin\item-color-presets\route.ts`
- **route.ts** (2 connections) — `app\api\admin\orders\[id]\status\route.ts`
- **route.ts** (2 connections) — `app\api\items\route.ts`
- **isAppRole()** (2 connections) — `lib\auth\admin-rbac.ts`
- *... and 9 more nodes in this community*

## Relationships

- [[createServiceRoleClient()]] (12 shared connections)
- [[DELETE()]] (12 shared connections)
- [[clientFetch()]] (7 shared connections)
- [[SearchPageClient.tsx]] (2 shared connections)
- [[Auth Detailed Design Stub]] (1 shared connections)
- [[getPublishedItemsPage()]] (1 shared connections)
- [[page.tsx]] (1 shared connections)
- [[NewsForm.tsx]] (1 shared connections)
- [[createPublicClient()]] (1 shared connections)

## Source Files

- `app\api\admin\audit-logs\route.ts`
- `app\api\admin\item-color-presets\route.ts`
- `app\api\admin\items\route.ts`
- `app\api\admin\kpi\migration-status\route.ts`
- `app\api\admin\news\route.ts`
- `app\api\admin\orders\[id]\status\route.ts`
- `app\api\admin\users\route.ts`
- `app\api\items\route.ts`
- `app\api\news\route.ts`
- `lib\auth\admin-rbac.ts`

## Audit Trail

- EXTRACTED: 80 (56%)
- INFERRED: 63 (44%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*