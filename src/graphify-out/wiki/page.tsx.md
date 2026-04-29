# page.tsx

> 40 nodes · cohesion 0.08

## Key Concepts

- **page.tsx** (11 connections) — `app\account\page.tsx`
- **persistProfile()** (9 connections) — `app\account\page.tsx`
- **page.tsx** (9 connections) — `app\checkout\page.tsx`
- **normalizePostalCode()** (8 connections) — `features\checkout\utils\postal-code.util.ts`
- **formatPhoneNumberInput()** (8 connections) — `features\account\utils\profile-format.util.ts`
- **postal-code.service.ts** (7 connections) — `features\checkout\services\postal-code.service.ts`
- **handleShippingChange()** (5 connections) — `app\checkout\page.tsx`
- **handleShippingNext()** (5 connections) — `app\checkout\page.tsx`
- **fetchAddressByPostalCode()** (5 connections) — `features\checkout\services\postal-code.service.ts`
- **formatPostalCodeInput()** (5 connections) — `features\checkout\utils\postal-code.util.ts`
- **postal-code.util.ts** (4 connections) — `features\checkout\utils\postal-code.util.ts`
- **getCachedAddress()** (4 connections) — `features\checkout\services\postal-code.service.ts`
- **getServiceRoleClient()** (4 connections) — `features\checkout\services\postal-code.service.ts`
- **handleAddressFieldChange()** (3 connections) — `app\account\page.tsx`
- **GET()** (3 connections) — `app\api\checkout\postal-code\route.ts`
- **getDbCachedAddress()** (3 connections) — `features\checkout\services\postal-code.service.ts`
- **isCompletePostalCode()** (3 connections) — `features\checkout\utils\postal-code.util.ts`
- **handleProfileDelete()** (2 connections) — `app\account\page.tsx`
- **handleProfileFieldChange()** (2 connections) — `app\account\page.tsx`
- **handleProfileSave()** (2 connections) — `app\account\page.tsx`
- **handleShippingDelete()** (2 connections) — `app\account\page.tsx`
- **handleShippingSave()** (2 connections) — `app\account\page.tsx`
- **handleTabChange()** (2 connections) — `app\account\page.tsx`
- **normalizeAccountTab()** (2 connections) — `app\account\page.tsx`
- **fetchProfileDefaults()** (2 connections) — `app\checkout\page.tsx`
- *... and 15 more nodes in this community*

## Relationships

- [[route.ts]] (95 shared connections)
- [[POST()]] (3 shared connections)
- [[DELETE()]] (2 shared connections)
- [[clientFetch()]] (2 shared connections)
- [[createServiceRoleClient()]] (1 shared connections)

## Source Files

- `app\account\page.tsx`
- `app\api\checkout\postal-code\route.ts`
- `app\checkout\page.tsx`
- `features\account\utils\profile-format.util.ts`
- `features\checkout\services\postal-code.service.ts`
- `features\checkout\utils\postal-code.util.ts`

## Audit Trail

- EXTRACTED: 94 (71%)
- INFERRED: 38 (29%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*