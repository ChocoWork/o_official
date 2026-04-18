# Code Review: privacy page
**Ready for Production**: No
**Critical Issues**: 3

## Review Scope
- Spec: `docs/4_DetailDesign/17_privacy.md`
- Page: `src/app/privacy/page.tsx`
- Shared shell: `src/app/layout.tsx`, `src/contexts/Providers.tsx`, `src/components/Header.tsx`, `src/components/Footer.tsx`
- Related runtime/API: `src/contexts/LoginContext.tsx`, `src/contexts/CartContext.tsx`, `src/app/api/cart/route.ts`, `src/app/api/cart/[id]/route.ts`, `src/app/api/wishlist/route.ts`, `src/app/api/wishlist/[id]/route.ts`, `src/proxy.ts`, `src/lib/supabase/client.ts`, `src/lib/redirect.ts`

## Priority 1 (Must Fix) ⛔
- `src/app/layout.tsx`: All routes, including `/privacy`, load third-party Turnstile script unconditionally. This expands third-party script exposure and sends page-view metadata to Cloudflare on a static policy page. Load Turnstile only on routes/components that actually render the challenge.
- `src/contexts/Providers.tsx` + `src/contexts/CartContext.tsx`: `/privacy` triggers session-bound `/api/cart` and `/api/wishlist` requests on mount via shared providers. This is unnecessary backend activity for a static public page and broadens the attack surface. Split public informational routes from commerce providers or lazy-load these calls when cart/wishlist UI is actually needed.
- `src/app/layout.tsx`: Reading `headers()` for nonce forces request-bound rendering in the root layout, so `/privacy` cannot remain effectively static as specified. Move nonce/script handling to route groups that need it, or serve CSP in middleware without route-wide request-bound rendering where possible.

## Recommended Changes
- `src/app/layout.tsx`: The external Remix Icon stylesheet is loaded from jsDelivr without integrity pinning. Prefer self-hosting or add SRI if the CDN response is stable.

## Residual Risk
- `src/app/api/cart/*` and `src/app/api/wishlist/*` use a service-role client behind a session cookie boundary. Current query filters narrow access to `session_id`, but the public informational page should not need to touch these endpoints at all.