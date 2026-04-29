# Graph Report - C:/work/o_official/src  (2026-04-29)

## Corpus Check
- Large corpus: 227 files · ~98,035 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 809 nodes · 1285 edges · 30 communities detected
- Extraction: 68% EXTRACTED · 32% INFERRED · 0% AMBIGUOUS · INFERRED: 412 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 49|Community 49]]

## God Nodes (most connected - your core abstractions)
1. `createServiceRoleClient()` - 52 edges
2. `GET()` - 44 edges
3. `logAudit()` - 36 edges
4. `DELETE()` - 33 edges
5. `authorizeAdminPermission()` - 32 edges
6. `createClient()` - 32 edges
7. `enforceRateLimit()` - 30 edges
8. `GET()` - 26 edges
9. `clientFetch()` - 23 edges
10. `PATCH()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `handleSubmit()` --calls--> `clientFetch()`  [INFERRED]
  app\admin\news\NewsForm.tsx → lib\client-fetch.ts
- `syncCategoryQuery()` --calls--> `DELETE()`  [INFERRED]
  features\news\components\PublicNewsGrid.tsx → app\api\wishlist\[id]\route.ts
- `handleClear()` --calls--> `DELETE()`  [INFERRED]
  features\search\components\SearchPageClient.tsx → app\api\wishlist\[id]\route.ts
- `GET()` --calls--> `signLookImageUrls()`  [INFERRED]
  app\api\orders\[id]\route.ts → lib\storage\look-images.ts
- `fetchProfileDefaults()` --calls--> `clientFetch()`  [INFERRED]
  app\checkout\page.tsx → lib\client-fetch.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (68): sendMail(), GET(), buildRedirectResponse(), classifyConfirmError(), GET(), POST(), getClientIp(), hashText() (+60 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (41): DELETE(), formatCurrency(), formatOrderDate(), GET(), getClientIp(), getRequestUserAgent(), logNewsAudit(), mapCartRpcError() (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (37): GET(), getClientIp(), POST(), getClientIp(), POST(), resolvePaymentMethod(), getClientIp(), POST() (+29 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (26): handleCancelOrder(), handleRefundOrder(), updateProcessingOrder(), fetchLooks(), handleDelete(), handleToggleStatus(), fetchNews(), handleDelete() (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (25): handleAddressFieldChange(), handleProfileDelete(), handleProfileFieldChange(), handleProfileSave(), handleShippingDelete(), handleShippingSave(), handleTabChange(), normalizeAccountTab() (+17 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (27): buildResponse(), GET(), isUserRole(), GET(), buildLegacyProfileUpsertPayload(), buildProfileUpsertPayload(), clearProfileRow(), DELETE() (+19 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (22): GET(), authorizeAdminPermission(), isAppRole(), isMfaVerified(), resolveAclPermissions(), resolveTokenRole(), GET(), POST() (+14 more)

### Community 7 - "Community 7"
Cohesion: 0.09
Nodes (17): getLatestNews(), buildDescription(), generateMetadata(), getPublishedLookById(), getPublishedLooks(), hydrateLooks(), NewsPage(), resolveCategory() (+9 more)

### Community 8 - "Community 8"
Cohesion: 0.24
Nodes (15): applyOrderToAccumulator(), buildRecentSeasonKeys(), createPeriodAccumulator(), formatCurrency(), formatPercent(), GET(), getJstDateParts(), getJstMonthKey() (+7 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (17): ARCH-AUTH-01: Register / Confirm, ARCH-AUTH-02: Login, ARCH-AUTH-03: Refresh / JTI, ARCH-AUTH-04: Password Reset, ARCH-AUTH-05: Logout / Revoke Sessions, ARCH-AUTH-06: OAuth, ARCH-AUTH-07: CSRF / Cookie, ARCH-AUTH-08: Audit Log (+9 more)

### Community 11 - "Community 11"
Cohesion: 0.18
Nodes (9): GET(), buildSnippet(), executeSearch(), getPopularItems(), getSearchSuggestions(), normalizeText(), rankText(), tokenizeQuery() (+1 more)

### Community 12 - "Community 12"
Cohesion: 0.37
Nodes (12): authorizeAsAdmin(), buildDefaultTargetPayload(), buildEditableSeasons(), buildValuesMatrix(), GET(), getJstYearMonth(), getNextSeasonKey(), getPrevSeasonKey() (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.19
Nodes (7): escapeRegExp(), handleClear(), handleTabChange(), normalizeTab(), readSearchHistory(), renderHighlightedText(), writeSearchHistory()

### Community 14 - "Community 14"
Cohesion: 0.22
Nodes (6): Home(), ItemPage(), parsePositiveInt(), parseSort(), getPublishedItems(), getPublishedItemsPage()

### Community 15 - "Community 15"
Cohesion: 0.27
Nodes (8): fetchWishlist(), handleAddToCart(), isColorList(), isSizeList(), isWishlistItem(), parseWishlistResponse(), resolveDefaultColor(), resolveDefaultSize()

### Community 16 - "Community 16"
Cohesion: 0.31
Nodes (7): fetchCart(), handleQuantityChange(), handleResyncFromServer(), handleRetryUpdate(), rollbackToConfirmed(), scheduleUpdate(), sendUpdate()

### Community 17 - "Community 17"
Cohesion: 0.31
Nodes (6): getDefaultFormValues(), getTodayDateString(), handleDrop(), handleFileSelect(), handleSubmit(), updateSelectedImage()

### Community 18 - "Community 18"
Cohesion: 0.36
Nodes (4): focusOtpInput(), handleOtpChange(), handleOtpKeyDown(), handleOtpPaste()

### Community 19 - "Community 19"
Cohesion: 0.43
Nodes (6): fetchJwks(), generateJti(), getSigningConfig(), jwkToPem(), sign(), verify()

### Community 20 - "Community 20"
Cohesion: 0.38
Nodes (4): handleFieldBlur(), handleSubmit(), validate(), validateField()

### Community 23 - "Community 23"
Cohesion: 0.52
Nodes (6): buildCsp(), generateNonce(), isProtectedStateChangingApiRequest(), isSameOriginRequest(), proxy(), resolveRequestOrigin()

### Community 24 - "Community 24"
Cohesion: 0.48
Nodes (6): createSignedUrlByPath(), extractItemImageObjectPath(), normalizeObjectPath(), signItemImageFields(), signItemImageUrl(), signItemImageUrls()

### Community 25 - "Community 25"
Cohesion: 0.33
Nodes (1): syncCategoryQuery()

### Community 26 - "Community 26"
Cohesion: 0.6
Nodes (4): hash(), hashPassword(), verify(), verifyPassword()

### Community 27 - "Community 27"
Cohesion: 0.6
Nodes (4): createSignedUrlByPath(), extractLookImageObjectPath(), signLookImageUrl(), signLookImageUrls()

### Community 32 - "Community 32"
Cohesion: 0.5
Nodes (2): cn(), Button()

### Community 33 - "Community 33"
Cohesion: 0.83
Nodes (3): getRedisConfig(), getRedisJson(), setRedisJson()

### Community 34 - "Community 34"
Cohesion: 0.83
Nodes (3): normalizeSeason(), parseItemCollectionMeta(), toSourceText()

### Community 36 - "Community 36"
Cohesion: 1.0
Nodes (2): buildSessionResponse(), GET()

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (2): fetchRelated(), normalizeAllowedCategory()

## Knowledge Gaps
- **17 isolated node(s):** `UnauthorizedError`, `ARCH-AUTH-01: Register / Confirm`, `ARCH-AUTH-02: Login`, `ARCH-AUTH-03: Refresh / JTI`, `ARCH-AUTH-04: Password Reset` (+12 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 25`** (6 nodes): `fetchNews()`, `isSameSelection()`, `parseCategorySelection()`, `resolveBuildHref()`, `syncCategoryQuery()`, `PublicNewsGrid.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (4 nodes): `Button.tsx`, `cn()`, `utils.ts`, `Button()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (3 nodes): `route.ts`, `buildSessionResponse()`, `GET()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (3 nodes): `fetchRelated()`, `normalizeAllowedCategory()`, `RelatedItems.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GET()` connect `Community 0` to `Community 1`, `Community 2`, `Community 4`, `Community 5`, `Community 7`, `Community 23`, `Community 24`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `createClient()` connect `Community 5` to `Community 0`, `Community 1`, `Community 6`, `Community 7`, `Community 8`, `Community 11`, `Community 14`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `createServiceRoleClient()` connect `Community 0` to `Community 1`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 12`, `Community 14`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Are the 51 inferred relationships involving `createServiceRoleClient()` (e.g. with `GET()` and `POST()`) actually correct?**
  _`createServiceRoleClient()` has 51 INFERRED edges - model-reasoned connections that need verification._
- **Are the 41 inferred relationships involving `GET()` (e.g. with `resolveRequestOrigin()` and `isSameOriginRequest()`) actually correct?**
  _`GET()` has 41 INFERRED edges - model-reasoned connections that need verification._
- **Are the 34 inferred relationships involving `logAudit()` (e.g. with `POST()` and `logNewsAudit()`) actually correct?**
  _`logAudit()` has 34 INFERRED edges - model-reasoned connections that need verification._
- **Are the 20 inferred relationships involving `DELETE()` (e.g. with `authorizeAdminPermission()` and `createServiceRoleClient()`) actually correct?**
  _`DELETE()` has 20 INFERRED edges - model-reasoned connections that need verification._