# Graph Report - src\features  (2026-04-29)

## Corpus Check
- 36 files · ~13,707 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 152 nodes · 161 edges · 12 communities detected
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 16|Community 16]]

## God Nodes (most connected - your core abstractions)
1. `enforceRateLimit()` - 5 edges
2. `refreshSession()` - 5 edges
3. `normalizeOptionalText()` - 5 edges
4. `incrementCounter()` - 4 edges
5. `incrementCounterBy()` - 4 edges
6. `normalizePostalCode()` - 4 edges
7. `consumeAdminLookUploadQuota()` - 4 edges
8. `normalizeText()` - 4 edges
9. `enforceStockistAdminRateLimit()` - 4 edges
10. `normalizeCounterTarget()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `enforceAdminLookMutationRateLimit()` --calls--> `enforceRateLimit()`  [INFERRED]
  look\services\admin-rate-limit.ts → auth\middleware\rateLimit.ts
- `enforceStockistAdminRateLimit()` --calls--> `enforceRateLimit()`  [INFERRED]
  stockist\services\admin-security.ts → auth\middleware\rateLimit.ts
- `refreshSession()` --calls--> `findSessionByRefreshHash()`  [INFERRED]
  auth\services\refresh.ts → auth\services\session.ts
- `refreshSession()` --calls--> `revokeAllSessionsForUser()`  [INFERRED]
  auth\services\refresh.ts → auth\services\session.ts
- `refreshSession()` --calls--> `isReplay()`  [INFERRED]
  auth\services\refresh.ts → auth\services\session.ts

## Communities

### Community 1 - "Community 1"
Cohesion: 0.23
Nodes (10): enforceRateLimit(), getIpFromRequest(), extractCounterResult(), incrementCounter(), incrementCounterBy(), normalizeCounterTarget(), buildHourlyBucketIso(), buildRateLimitErrorResponse() (+2 more)

### Community 2 - "Community 2"
Cohesion: 0.23
Nodes (9): fetchAddressByPostalCode(), getCachedAddress(), getDbCachedAddress(), getServiceRoleClient(), isDbCacheFresh(), setDbCachedAddress(), formatPostalCodeInput(), isCompletePostalCode() (+1 more)

### Community 3 - "Community 3"
Cohesion: 0.19
Nodes (6): escapeRegExp(), handleTabChange(), normalizeTab(), readSearchHistory(), renderHighlightedText(), writeSearchHistory()

### Community 4 - "Community 4"
Cohesion: 0.27
Nodes (6): buildSnippet(), executeSearch(), getPopularItems(), normalizeText(), rankText(), tokenizeQuery()

### Community 5 - "Community 5"
Cohesion: 0.29
Nodes (5): normalizeNfkcText(), normalizeOptionalEmail(), normalizeOptionalPhone(), normalizeOptionalPostalCode(), normalizeOptionalText()

### Community 6 - "Community 6"
Cohesion: 0.36
Nodes (7): applyRotatedCsrfCookie(), enforceAdminStockistMutationRateLimit(), enforceAdminStockistReadRateLimit(), enforceStockistAdminRateLimit(), hasMockCsrfBody(), hasRotatedCsrfToken(), toCsrfDenyResponse()

### Community 7 - "Community 7"
Cohesion: 0.36
Nodes (6): refreshSession(), UnauthorizedError, findSessionByRefreshHash(), isReplay(), revokeAllSessionsForUser(), rotateJtiAndSave()

### Community 10 - "Community 10"
Cohesion: 0.67
Nodes (2): calculateCheckoutAmountsFromCartRows(), calculateCheckoutAmountsFromSubtotal()

### Community 12 - "Community 12"
Cohesion: 0.83
Nodes (3): getHomePublicStockists(), getPublicStockists(), toPublicStockists()

### Community 13 - "Community 13"
Cohesion: 1.0
Nodes (2): formatPhoneNumberInput(), normalizePhoneNumber()

### Community 14 - "Community 14"
Cohesion: 1.0
Nodes (2): fetchRelated(), normalizeAllowedCategory()

### Community 16 - "Community 16"
Cohesion: 1.0
Nodes (2): getRequestUserAgent(), logAdminLookAudit()

## Knowledge Gaps
- **1 isolated node(s):** `UnauthorizedError`
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 10`** (4 nodes): `checkout-pricing.service.ts`, `calculateCheckoutAmountsFromCartRows()`, `calculateCheckoutAmountsFromSubtotal()`, `isCheckoutDisplayedAmountsMatched()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 13`** (3 nodes): `profile-format.util.ts`, `formatPhoneNumberInput()`, `normalizePhoneNumber()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 14`** (3 nodes): `fetchRelated()`, `normalizeAllowedCategory()`, `RelatedItems.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 16`** (3 nodes): `admin-audit.ts`, `getRequestUserAgent()`, `logAdminLookAudit()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `enforceRateLimit()` connect `Community 1` to `Community 6`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Why does `enforceStockistAdminRateLimit()` connect `Community 6` to `Community 1`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `enforceRateLimit()` (e.g. with `incrementCounter()` and `enforceAdminLookMutationRateLimit()`) actually correct?**
  _`enforceRateLimit()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `refreshSession()` (e.g. with `findSessionByRefreshHash()` and `revokeAllSessionsForUser()`) actually correct?**
  _`refreshSession()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `UnauthorizedError` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._