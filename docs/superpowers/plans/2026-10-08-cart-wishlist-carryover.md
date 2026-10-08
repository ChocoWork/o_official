# カートとお気に入りの引き継ぎ 実装計画

> 2026-10-08追記（FREQ-428〜432）: 本計画の `source_cart_id` は、移行前の下書きの写し・旧コード、またはその置き換え対象を説明するために残す過去の記録。現行の下書きの明細参照は `source_cart_line_id`（`cart_lines.id`）、所有カートは `checkout_drafts.cart_id`。実装時の契約は [カートとお気に入りの引き継ぎ設計](../specs/2026-10-08-cart-wishlist-carryover-design.md)を参照する。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ゲストのカートとお気に入りをログインで失わないようにし、会員の分はサーバーに保存してログアウトしても次のログインで戻す。カートの窓口は Shopify の Ajax Cart API の形にする。

**Architecture:** 古い `carts`（1行＝1商品・`session_id` が鍵）と `wishlist` の表を、持ち主の表（会員の ID かゲストの印のハッシュのどちらか1つ）＋明細の表（カートはバリアント、お気に入りは商品）に置き換える。サーバーには持ち主を決める部品を1つ置き、カート・お気に入り・決済・ログインの全部が使う。ログインの共通の関数が、ゲストの分を DB の関数1本で会員の分へ合わせる。画面は、新しい窓口の返す中身を今の画面用の形に直す変換を1か所に置き、カートの画面の部品はそのまま使う。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Supabase（Postgres 17、SECURITY DEFINER RPC、トリガー、pg_cron）、Jest（ts-jest・Testing Library）＋`pg`、Playwright

**Spec:** [docs/superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md](../specs/2026-10-08-cart-wishlist-carryover-design.md)（ユーザー承認 2026-10-08）

## Global Constraints

- ユーザーの方針: Shopify と同じ構造に近づける。Shopify に無い部分は世界の業界標準に従う。計画に無い判断が要る時もこの順で決める
- 画面と断りの文言（設計書のとおり。一字も変えない）:
  - 422: `1つの商品は20個までです。`／`カートに入れられるのは50種類までです。`
  - 404: `選んだ色・サイズは現在お求めいただけません。`／`カートの商品が見つかりません。ページを読み込み直してください。`
  - 400: `送った内容を確認できませんでした。`
  - 再注文で入れられない: `この商品は現在お求めいただけません。`
  - 決済の途中でログインした時（今のまま）: `ログインの状態が変わりました。もう一度「確認へ進む」を押してください。`
- カートの断りの形は Shopify と同じ `{ "status": <数>, "message": "Cart Error", "description": "<上の文言>" }`。思いがけない失敗（500）の `description` は `カートを更新できませんでした。時間をおいてもう一度お試しください。`（本計画の決め事 P6）。401 `{ error: 'auth_expired' }`・CSRF の 403・回数の制限の 429・503 は今の形のまま
- Cookie: 名前 `cart`・`wishlist`。値は 256 ビットの乱数の base64url（43文字、`/^[A-Za-z0-9_-]{43}$/`）。属性は `getBaseCookieOptions()`（HttpOnly・SameSite=Lax・Path=/・本番だけ Secure）＋ Max-Age 1209600（2週間）。DB には `tokenHashSha256`（`src/lib/hash.ts`、64桁の16進）だけを入れる。印そのものを DB・監査の記録・ログ・応答に出さない
- 上限: 1明細の数量 1〜20（`MAX_CART_ITEM_QUANTITY`）、1カート50種類（`MAX_CART_LINES`）、1回の追加 1〜10件
- 合わせる規則: 会員に分が無ければゲストの持ち主を付け替える。両方あれば、違うバリアントは入れた順（`added_at`、同じなら `id`）に50種類まで移し、同じバリアントは大きい方の数量。お気に入りは同じ商品を1つにする。お知らせは出さない
- DB の名前と形（設計書第3章・第6章）: 表 `public.carts`・`public.cart_lines`・`public.wishlists`・`public.wishlist_lines`、`checkout_drafts.cart_id`。関数 `public.cart_add_lines(_cart_id uuid, _lines jsonb)`、`public.cart_change_line(_cart_id uuid, _line_id uuid, _quantity integer)`、`public.merge_guest_into_member(_user_id uuid, _cart_token_hash text, _wishlist_token_hash text)`、`public.claim_checkout_draft(..., _buyer_user_id uuid, _cart_id uuid)`（15引数、既定値なし）、`public.place_order_from_checkout_draft`（10引数のまま）、`private.clear_cart_for_order(uuid)`、`private.checkout_cart_lines_gone(uuid, jsonb)`。毎日の処理 `guest-shopping-retention`
- 下書きの明細の参照のキーは `source_cart_line_id`（`cart_lines.id`）。`source_cart_id` は使わない
- 移行は2本（本計画の決め事 P1）: `supabase/migrations/20261008130000_cart_wishlist_ownership.sql`（1回だけ当てる）と `supabase/migrations/20261008130100_cart_checkout_rpcs.sql`（何度当てても同じ結果）。どちらも `BEGIN;`〜`COMMIT;`。関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名。`PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、`service_role` だけに与える（`private` の関数は `PUBLIC` から外す）。最後に `NOTIFY pgrst, 'reload schema';`
- `supabase/pending/` は触らない。本番 DB へは、全タスクの後、ユーザーの push の後で許可を得て Supabase MCP の `apply_migration` で2本を順に当て、当てた版にファイル名と文書の版を直す
- 画面と機能の変更は `docs/02_Requirements/requirements.md` に FREQ-428〜432 の行を足す（Task 10。番号は `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` が FREQ-427 であることを確かめる）。新しい E2E は `e2e/FR-CART-023-…`・`e2e/FR-CART-024-…`・`e2e/FR-CHECKOUT-047-…`・`e2e/FR-WISHLIST-016-…`（`ls e2e | grep FR-CART- | sort -V | tail -1` などで次の番号であることを確かめる）
- E2E は本番ビルド（`next build && next start`）・手元の Supabase（`npx supabase db reset` の直後）で、mobile（390px）・tablet（768px）・desktop（1280px）の3つの画面幅で流す。流す前に3000番に何も無いことを `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめる。DB 結合テストの直後に E2E を流さない
- DB 結合テストは `npx supabase db reset` の後に、フォルダ全体を `--runInBand` で流す: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`。PostgREST を使う3本（`reconciler_postgrest`・`reconciler_composed`・`refund_failure_exception_postgrest`）は `LOCAL_SUPABASE_URL`・`LOCAL_SUPABASE_SERVICE_ROLE_KEY`（`npx supabase status -o env` の `API_URL`・`SERVICE_ROLE_KEY`。値は画面に出さない）を付けると流れる
- 実装は Codex（`--model gpt-6.1-sol`、コミットしない。E2E と DB 結合テストは controller が流す）。controller がタスクのファイルだけを名指しでコミットし、レビューは Opus。master に直接コミットし、push しない。`--no-verify` を使わない。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 秘密の値（`.env.local` の鍵・JWT_SECRET・パスワード・印）を画面・ログ・文書・報告に出さない
- 返答・文書・コメントは日本語。コードのコメントは周りに合わせる（理由を書く。何をしているかの繰り返しは書かない）

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **会員のアクセストークンの期限が切れた後にカートを開く・入れる**: 401 `auth_expired` → 画面が印を1回だけ新しくして送り直し、会員のカートが出る。空のゲストのカートを見せない（Task 3 の「期限切れは 401」、Task 8 の「401 で新しくして1回だけ送り直す」）
2. **ゲストの印の Cookie が壊れている・DB に無い（30日で消えた）**: 読むと空のカート、入れると持ち主が作られ Cookie が付く。500 にならない（Task 3 の「ゲストで形の違う印は印なし」「印の無いゲストが書く時は、新しい印で持ち主を作り Cookie を付ける」、Task 4 の `cart-get.test.ts` の「持ち主の行が無い時は空」と `cart-add.test.ts` の「`ensureOwnerId()` の後に足す」）
3. **ログインの直後のヘッダーの数**: 合わせた後の数になる（ログインの後に読み直す。Task 8 の「ログインの状態が変わったら読み直す」）
4. **2つのタブで同時に同じ商品を入れる**: 同じ明細に足され、20 を超える方は断られる（Task 1 の「同時に足すと後の方が上限で断られる」）
5. **非公開になった商品・取り扱いを終えた色やサイズがカートに残っている**: 一覧に出ず、「確認へ進む」で買えないと断られる（Task 4 の「販売中でない明細は出さない」、Task 7 の「取り扱い終了のバリアントは買えない」）

---

## 本計画の決め事（設計書の書いていないところ）

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | 移行を2本に分ける。A（`_cart_wishlist_ownership.sql`）は表・決まり・カートの関数・期限・片付け、B（`_cart_checkout_rpcs.sql`）は「確認へ進む」「注文する」「支払いの後」の関数の作り直しだけ。B は何度当てても同じ結果になるように書き、`checkout_session_claim` の結合テストの後片付けで、グループ C の移行の後に当て直す | 設計書 9 章は「移行1本」だが、その結合テストは終わる時に「下書きと受付の関数を作り直す移行」を当て直して DB を戻す。1本だと表を消す処理まで当て直してしまう。本番には A・B を続けて当てるので、結果は1本と同じ |
| P2 | 持ち主を決める部品は `openShoppingContext(request, kind, supabase, { write })`（`src/features/cart/services/shopping-context.ts`）。ログインの確かめはグループ C の `resolveCheckoutBuyer` をそのまま使う | 設計書 4-2。判定の規則を1か所にする |
| P3 | 会員の要求にゲストの印が残っていたら、`openShoppingContext` と決済の `findCartIdForBuyer` が合わせる（予備の経路）。Cookie を消すのは `openShoppingContext` の応答だけ（決済の窓口は消さず、次のカートの読み込みが消す） | 設計書 5-1。決済の窓口は応答の出口が多く、消し忘れても次の読み込みで消える |
| P4 | ゲストの印が形として正しく DB に無い時（期限で消えた等）、読む窓口は空を返し、書く窓口は同じ印のハッシュで持ち主を作り直す | Shopify の cart Cookie と同じく、印はブラウザの物。作り直しで Cookie を替える意味は無い（どの印でも作れるので） |
| P5 | 回数の制限の subject は会員 `member:<会員の ID>`、ゲスト `guest:<印のハッシュ>`。回数は今の値（`cart:add` IP 60回・持ち主 30回／60秒、`cart:change` IP 120回・持ち主 60回／60秒、`wishlist:get` IP 120回・持ち主 60回、`wishlist:add`・`wishlist:delete` IP 60回・持ち主 30回、すべて60秒） | 今の `session_id` の制限と同じ強さを保つ |
| P6 | カートの窓口の思いがけない失敗（DB の失敗など）は 500 `{ status: 500, message: 'Cart Error', description: 'カートを更新できませんでした。時間をおいてもう一度お試しください。' }` | 設計書は 400・404・422 の文言だけを決めている。画面が `description` をそのまま出すので、意味の通る文にする |
| P7 | `GET /api/cart` は今と同じく回数の制限を掛けない。CSRF の確かめは書き換え（`POST`・`DELETE`）だけで、`requireCsrfOrDeny()`（更新の印が無いゲストは素通り）を使う | 今と同じ。決済の窓口と同じ規則 |
| P8 | カートの画面・決済の画面・ヘッダーは、`GET /api/cart` の返す中身を `toCartEntries()`（`src/features/cart/client/cart-api.ts`）で今の画面用の形（`CartEntry`）に直してから使う | 画面の部品（`CartItemRow`・`OrderSummary`・`cart-notice`）を変えずに済む |
| P9 | 画面からカート・お気に入りの窓口を呼ぶ時は `clientFetch` を使わず、`sendShoppingRequest()`（`cart-api.ts`）を使う。読める CSRF の Cookie がある時だけ合言葉を付け、401 `auth_expired` と CSRF の 403 では `refreshSessionOnce()` で1回だけ印を新しくして送り直す | `clientFetch` は CSRF の Cookie が無いと必ず印の更新を呼ぶので、ゲストがカートに入れるたびに無駄な更新と「ログインが切れた」知らせが走る |
| P10 | 商品の窓口の `variantAvailability` の各要素に `variantId`（バリアントの番号）を足す。商品詳細はこの中から選んだ色・サイズの番号を探して送る（無ければ送らずに `選んだ色・サイズは現在お求めいただけません。`）。比べ方は `DeliveryNote` と同じ（`(colorName ?? '') === (color ?? '')`） | 設計書 8 章。Shopify もバリアントの番号を公開している |
| P11 | お気に入りの一覧の各行に `variants: Array<{ id: number; color: string \| null; size: string \| null }>`（販売中のバリアントだけ）を足す。注文の明細の窓口（`GET /api/orders/[id]`）の各明細に `variantId: number \| null` を足す | お気に入りの画面と再注文が、バリアントの番号でカートに入れるため（設計書 6-2・8 章） |
| P12 | カートの明細の表示の名前は `options_with_values` の `name` を `カラー`・`サイズ` にする（`CART_OPTION_NAMES`）。画面用の形に直す時もこの名前で色・サイズを取り出す | 設計書 6-1 の例と同じ |
| P13 | ログイン・ログアウトの後の読み直しは、`LoginProvider` の内側に置く小さな部品 `CartLoginSync`（`src/contexts/CartLoginSync.tsx`）が `isLoggedIn` の変化を見て `refreshShopping()` を呼ぶ | `CartProvider` は `LoginProvider` の外側にあり、`useLogin()` を使えない |
| P14 | 取り扱いを終えたバリアント（`is_active = false`）の明細は、`GET /api/cart` に出さず、「確認へ進む」と割引コードの確かめでは `collectInventoryIssues` が「買えない」に数える | 設計書 6-1 の「出さない明細」と、今の非公開の商品の扱い（FREQ-401）をそろえる |
| P15 | DB 結合テストの試験データ `createDraft` は、ゲストのカートと明細を作って下書きに `cart_id` と `source_cart_line_id` を入れ、`{ cartId（持ち主の番号）, cartLineId（最初の明細の番号） }` を返す。色・サイズがバリアントに当たらない明細は参照を空にする | 今のテストは `cartId` を「カートの行」として消している。新しい形でも同じ確かめを書けるようにする |
| P16 | `src/lib/client-fetch.ts` の `getCsrfTokenFromCookie` を `export` する（中身は変えない） | P9 の部品が同じ読み方を使う |

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20261008130000_cart_wishlist_ownership.sql`（新規） | 古い表と関数の片付け、新しい4つの表・決まり・トリガー・拒否、`checkout_drafts.cart_id`、カートの関数3本、期限の処理（Task 1） |
| `supabase/migrations/20261008130100_cart_checkout_rpcs.sql`（新規） | 下書きを取る関数（15引数）・受付の関数・支払い後の関数の作り直し（Task 2） |
| `tests/integration/db/cart_wishlist_ownership.integration.test.ts`（新規） | 表・関数・合わせる処理・期限の結合テスト（Task 1） |
| `tests/integration/db/cart_checkout_rpcs.integration.test.ts`（新規） | 下書き・受付・支払い後の結合テスト（Task 2） |
| `tests/integration/db/helpers/order-fixtures.ts` ほか DB 結合の5本 | 新しいカートで試験データを作る（Task 2） |
| `src/lib/cookie.ts` | `cart`・`wishlist` の名前と属性（Task 3） |
| `src/features/cart/services/guest-shopping-token.ts`（新規） | 印の作成・形の確かめ・ハッシュ・Cookie の付け外し（Task 3） |
| `src/features/cart/services/shopping-owner.repository.ts`（新規） | 持ち主の行を探す・作る（Task 3） |
| `src/features/cart/services/guest-shopping-merge.ts`（新規） | ログインで合わせる DB の関数を呼ぶ（Task 3） |
| `src/features/cart/services/shopping-context.ts`（新規） | 窓口の持ち主の決め方、決済の `findCartIdForBuyer`、CSRF の確かめ（Task 3） |
| `src/features/cart/types/cart-json.ts`（新規） | Shopify の形の返す中身の型（サーバーと画面で共有。Task 4） |
| `src/features/cart/services/cart-view.ts`（新規） | DB からカート全体の返す中身を組み立てる（Task 4） |
| `src/features/cart/services/cart-errors.ts`（新規） | Shopify の形の断り（Task 4） |
| `src/features/cart/services/cart-stock.ts` | 送る中身の形の確かめを新しい窓口に替える、取り扱い終了のバリアント（Task 4・Task 7） |
| `src/app/api/cart/route.ts`・`add/route.ts`（新規）・`change/route.ts`（新規）、`[id]/route.ts`（削除） | カートの窓口（Task 4） |
| `src/app/api/wishlist/route.ts`・`[id]/route.ts` | お気に入りの窓口（Task 5） |
| `src/features/auth/services/register.ts` と入口4か所、`src/app/api/auth/logout/route.ts` | ログインで合わせる・ログアウトで消す（Task 6） |
| `src/features/checkout/services/checkout-draft.service.ts`・`checkout-cart.service.ts`、`src/app/api/checkout/create-session/route.ts`・`promotion-code/route.ts` ほか | 決済のつなぎ（Task 7） |
| `src/features/cart/client/cart-api.ts`（新規）、`src/contexts/CartContext.tsx`・`CartLoginSync.tsx`（新規）・`Providers.tsx`、`src/app/cart/_hooks/useCartItems.ts`、`src/app/checkout/page.tsx`、`src/app/item/[id]/ItemDetailClient.tsx`、`src/lib/items/availability.ts`、`src/types/item.ts`、`src/app/wishlist/page.tsx`、`src/features/account/hooks/useReorder.ts`、`src/app/api/orders/[id]/route.ts`、`src/app/account/orders/[id]/page.tsx` | 画面（Task 8） |
| `e2e/shop-test-utils.ts`・`e2e/checkout-flow-helpers.ts` と既存の spec | 既存の E2E の直し（Task 9） |
| `e2e/FR-CART-023-…`・`FR-CART-024-…`・`FR-CHECKOUT-047-…`・`FR-WISHLIST-016-…`（新規）、要求表と文書 | 新しい E2E・要求・文書（Task 10） |

---

### Task 1: 新しい4つの表と DB の関数（移行 A）

**Files:**
- Create: `supabase/migrations/20261008130000_cart_wishlist_ownership.sql`
- Create: `tests/integration/db/cart_wishlist_ownership.integration.test.ts`
- Delete: `tests/integration/db/guest_rpc_item_id_type.integration.test.ts`（消す古い関数5本を試している）

**Interfaces:**
- Consumes: なし（`public.items`・`public.item_variants`・`public.item_colors`・`public.item_sizes`・`public.profiles` は既存）
- Produces:
  - 表 `public.carts(id uuid PK, user_id uuid UNIQUE NULL → profiles ON DELETE CASCADE, guest_token_hash text UNIQUE NULL, created_at, updated_at)`、`public.cart_lines(id uuid PK, cart_id uuid → carts CASCADE, variant_id bigint → item_variants CASCADE, quantity 1..20, added_at, updated_at, UNIQUE(cart_id, variant_id))`、`public.wishlists`（carts と同じ持ち主の形）、`public.wishlist_lines(id, wishlist_id → wishlists CASCADE, item_id bigint → items CASCADE, added_at, UNIQUE(wishlist_id, item_id))`、`checkout_drafts.cart_id uuid → carts ON DELETE SET NULL`
  - `public.cart_add_lines(_cart_id uuid, _lines jsonb) RETURNS SETOF public.cart_lines`。`_lines` は `[{"variant_id": <正の整数>, "quantity": <1〜20>}]`（1〜10件）。断り（`RAISE EXCEPTION` の文がそのまま `error.message` になる）: `CART_INVALID_INPUT`・`CART_NOT_FOUND`・`CART_VARIANT_UNAVAILABLE`・`CART_LINE_QUANTITY_LIMIT`・`CART_LINE_LIMIT`
  - `public.cart_change_line(_cart_id uuid, _line_id uuid, _quantity integer) RETURNS void`。0 で削除。断り: `CART_INVALID_INPUT`・`CART_LINE_QUANTITY_LIMIT`・`CART_LINE_NOT_FOUND`
  - `public.merge_guest_into_member(_user_id uuid, _cart_token_hash text, _wishlist_token_hash text) RETURNS TABLE (cart_lines_moved integer, cart_lines_dropped integer, wishlist_lines_moved integer)`。断り: `MERGE_INVALID_INPUT`。`cart_lines_moved` は会員のカートへ移した明細と、同じバリアントで数量をそろえた明細の合計
  - cron ジョブ `guest-shopping-retention`（毎日 03:45）

- [ ] **Step 1: 結合テストを書く**

`tests/integration/db/cart_wishlist_ownership.integration.test.ts`:

```ts
/** @jest-environment node */
import { createHash } from 'crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, uniqueSuffix } from './helpers/order-fixtures';

const hashOf = (label: string) => createHash('sha256').update(label).digest('hex');

async function createMember(db: PgClient, label: string): Promise<string> {
  const result = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`cart-carryover-${label}-${uniqueSuffix()}@example.com`],
  );
  return result.rows[0].id as string;
}

async function createGuestCart(db: PgClient): Promise<{ cartId: string; tokenHash: string }> {
  const tokenHash = hashOf(`guest-cart-${uniqueSuffix()}`);
  const result = await db.query('insert into public.carts (guest_token_hash) values ($1) returning id', [tokenHash]);
  return { cartId: result.rows[0].id as string, tokenHash };
}

async function createMemberCart(db: PgClient, userId: string): Promise<string> {
  const result = await db.query('insert into public.carts (user_id) values ($1) returning id', [userId]);
  return result.rows[0].id as string;
}

async function insertLine(db: PgClient, cartId: string, variantId: number, quantity: number, addedAt?: string): Promise<string> {
  const result = await db.query(
    `insert into public.cart_lines (cart_id, variant_id, quantity, added_at)
     values ($1, $2, $3, coalesce($4::timestamptz, now())) returning id`,
    [cartId, variantId, quantity, addedAt ?? null],
  );
  return result.rows[0].id as string;
}

/** 1つの商品にサイズ違いのバリアントを count 個作る（50種類の上限の確かめに使う） */
async function createVariants(db: PgClient, count: number): Promise<number[]> {
  const item = await db.query(
    `insert into public.items (name, description, price, category, image_url, status)
     values ('fx-many-' || $1::text, '上限テスト', 1000, 'TOPS', 'https://example.com/item.png', 'published')
     returning id`,
    [uniqueSuffix()],
  );
  const itemId = Number(item.rows[0].id);
  await db.query(
    `insert into public.item_sizes (item_id, label, position)
     select $1, 'S' || g, g from generate_series(1, $2) as g`,
    [itemId, count],
  );
  const variants = await db.query(
    `insert into public.item_variants (item_id, color_id, size_id, is_active)
     select $1, null, s.id, true from public.item_sizes as s where s.item_id = $1 order by s.position
     returning id`,
    [itemId],
  );
  return variants.rows.map((row) => Number(row.id));
}

function addLines(db: PgClient, cartId: string, lines: Array<{ variant_id: unknown; quantity: unknown }> | unknown) {
  return db.query('select * from public.cart_add_lines($1, $2::jsonb)', [cartId, JSON.stringify(lines)]);
}

async function quantityOf(db: PgClient, cartId: string, variantId: number): Promise<number | null> {
  const result = await db.query('select quantity from public.cart_lines where cart_id = $1 and variant_id = $2', [cartId, variantId]);
  return result.rows[0]?.quantity ?? null;
}

async function expectDenied(db: PgClient, role: 'anon' | 'authenticated', sql: string, params: unknown[] = []) {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await expect(db.query(sql, params)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await db.query('rollback');
  }
}

function merge(db: PgClient, userId: string | null, cartTokenHash: string | null, wishlistTokenHash: string | null) {
  return db.query('select * from public.merge_guest_into_member($1, $2, $3)', [userId, cartTokenHash, wishlistTokenHash]);
}

describeLocalDb('integration: カートとお気に入りの持ち主と明細', (db) => {
  describe('表の決まり', () => {
    test('持ち主は会員か印のハッシュのどちらか1つだけ', async () => {
      const member = await createMember(db(), 'owner');
      await expect(
        db().query('insert into public.carts (user_id, guest_token_hash) values ($1, $2)', [member, hashOf('both')]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(db().query('insert into public.carts default values')).rejects.toMatchObject({ code: '23514' });
      await expect(
        db().query('insert into public.wishlists (user_id, guest_token_hash) values ($1, $2)', [member, hashOf('both-w')]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    test('印のハッシュは64桁の16進だけ', async () => {
      await expect(
        db().query("insert into public.carts (guest_token_hash) values ('not-a-hash')"),
      ).rejects.toMatchObject({ code: '23514' });
    });

    test('数量は1〜20で、同じカートに同じバリアントは1行だけ', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await expect(insertLine(db(), cartId, fx.variantId, 0)).rejects.toMatchObject({ code: '23514' });
      await expect(insertLine(db(), cartId, fx.variantId, 21)).rejects.toMatchObject({ code: '23514' });
      await insertLine(db(), cartId, fx.variantId, 1);
      await expect(insertLine(db(), cartId, fx.variantId, 1)).rejects.toMatchObject({ code: '23505' });
    });

    test('明細が変わると持ち主の最後に使った日時が進む', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await db().query("update public.carts set updated_at = now() - interval '40 days' where id = $1", [cartId]);
      await insertLine(db(), cartId, fx.variantId, 1);
      const touched = await db().query("select updated_at > now() - interval '1 minute' as recent from public.carts where id = $1", [cartId]);
      expect(touched.rows[0].recent).toBe(true);
    });

    test.each(['carts', 'cart_lines', 'wishlists', 'wishlist_lines'])('%s は anon と authenticated から読めず書けない', async (table) => {
      for (const role of ['anon', 'authenticated'] as const) {
        await expectDenied(db(), role, `select 1 from public.${table} limit 1`);
        await expectDenied(db(), role, `delete from public.${table}`);
      }
    });

    test('古い表と古い関数9本は残っていない', async () => {
      const functions = await db().query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[])`,
        [[
          'add_guest_cart_item', 'update_guest_cart_item_quantity', 'delete_guest_cart_item', 'list_guest_cart',
          'add_guest_wishlist_item', 'delete_guest_wishlist_item', 'list_guest_wishlist',
          'update_cart_item_quantity_secure', 'delete_cart_item_secure',
        ]],
      );
      expect(functions.rows).toEqual([]);
      const columns = await db().query(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'carts' order by column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(['created_at', 'guest_token_hash', 'id', 'updated_at', 'user_id']);
      const oldWishlist = await db().query("select to_regclass('public.wishlist') as old");
      expect(oldWishlist.rows[0].old).toBeNull();
    });

    test('3つの関数は service_role だけが実行できる', async () => {
      for (const signature of [
        'public.cart_add_lines(uuid,jsonb)',
        'public.cart_change_line(uuid,uuid,integer)',
        'public.merge_guest_into_member(uuid,text,text)',
      ]) {
        const result = await db().query(
          `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', $1, 'EXECUTE') as service`,
          [signature],
        );
        expect(result.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
      }
    });
  });

  describe('cart_add_lines', () => {
    test('新しいバリアントは明細を作り、同じバリアントは数量を足す', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const first = await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 2 }]);
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]).toMatchObject({ cart_id: cartId, variant_id: String(fx.variantId), quantity: 2 });
      await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 3 }]);
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(5);
    });

    test('20を超える時は断り、数量を変えない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 19 }]);
      await expect(addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 2 }])).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(19);
    });

    test('51種類目は断る', async () => {
      const variants = await createVariants(db(), 51);
      const { cartId } = await createGuestCart(db());
      for (const variantId of variants.slice(0, 50)) {
        await insertLine(db(), cartId, variantId, 1);
      }
      await expect(addLines(db(), cartId, [{ variant_id: variants[50], quantity: 1 }])).rejects.toMatchObject({ message: 'CART_LINE_LIMIT' });
      // 既にある種類は50種類でも足せる
      await addLines(db(), cartId, [{ variant_id: variants[0], quantity: 1 }]);
      expect(await quantityOf(db(), cartId, variants[0])).toBe(2);
    });

    test('取り扱い終了・非公開・無いバリアントは断る', async () => {
      const inactive = await createCatalogFixture(db(), { stock: 0, isActive: false });
      const hidden = await createCatalogFixture(db(), { stock: 0, itemStatus: 'private' });
      const { cartId } = await createGuestCart(db());
      for (const variantId of [inactive.variantId, hidden.variantId, 999999999]) {
        await expect(addLines(db(), cartId, [{ variant_id: variantId, quantity: 1 }])).rejects.toMatchObject({ message: 'CART_VARIANT_UNAVAILABLE' });
      }
    });

    test('1件でも断れば何も入れない', async () => {
      const ok = await createCatalogFixture(db(), { stock: 0 });
      const ng = await createCatalogFixture(db(), { stock: 0, isActive: false });
      const { cartId } = await createGuestCart(db());
      await expect(
        addLines(db(), cartId, [{ variant_id: ok.variantId, quantity: 1 }, { variant_id: ng.variantId, quantity: 1 }]),
      ).rejects.toMatchObject({ message: 'CART_VARIANT_UNAVAILABLE' });
      expect(await quantityOf(db(), cartId, ok.variantId)).toBeNull();
    });

    test('形の違う入力は CART_INVALID_INPUT', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const invalid: unknown[] = [
        [],
        Array.from({ length: 11 }, () => ({ variant_id: fx.variantId, quantity: 1 })),
        [{ variant_id: fx.variantId, quantity: 0 }],
        [{ variant_id: String(fx.variantId), quantity: 1 }],
        [{ variant_id: fx.variantId }],
        [7],
        { variant_id: fx.variantId, quantity: 1 },
      ];
      for (const lines of invalid) {
        await expect(addLines(db(), cartId, lines)).rejects.toMatchObject({ message: 'CART_INVALID_INPUT' });
      }
    });

    test('同時に同じバリアントを足すと、後の方が上限で断られる', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const { cartId } = await createGuestCart(db());
      const other = await connectLocalDb();
      try {
        await db().query('begin');
        await addLines(db(), cartId, [{ variant_id: fx.variantId, quantity: 15 }]);
        const second = addLines(other, cartId, [{ variant_id: fx.variantId, quantity: 15 }]);
        await db().query('commit');
        await expect(second).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      } finally {
        await other.end();
      }
      expect(await quantityOf(db(), cartId, fx.variantId)).toBe(15);
    });
  });

  describe('cart_change_line', () => {
    test('数量を変え、0 で消し、他のカートの明細は見つからない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const mine = await createGuestCart(db());
      const theirs = await createGuestCart(db());
      const lineId = await insertLine(db(), mine.cartId, fx.variantId, 1);
      await db().query('select public.cart_change_line($1, $2, 5)', [mine.cartId, lineId]);
      expect(await quantityOf(db(), mine.cartId, fx.variantId)).toBe(5);
      await expect(db().query('select public.cart_change_line($1, $2, 1)', [theirs.cartId, lineId])).rejects.toMatchObject({ message: 'CART_LINE_NOT_FOUND' });
      await expect(db().query('select public.cart_change_line($1, $2, 21)', [mine.cartId, lineId])).rejects.toMatchObject({ message: 'CART_LINE_QUANTITY_LIMIT' });
      await db().query('select public.cart_change_line($1, $2, 0)', [mine.cartId, lineId]);
      expect(await quantityOf(db(), mine.cartId, fx.variantId)).toBeNull();
    });
  });

  describe('merge_guest_into_member', () => {
    test('ゲストの分が無ければ何もしない', async () => {
      const member = await createMember(db(), 'none');
      const result = await merge(db(), member, hashOf(`missing-${uniqueSuffix()}`), null);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
    });

    test('会員にカートが無ければ、ゲストのカートをそのまま会員のものにする', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'convert');
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, fx.variantId, 2);
      const result = await merge(db(), member, guest.tokenHash, null);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 1, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
      const cart = await db().query('select id, user_id, guest_token_hash from public.carts where id = $1', [guest.cartId]);
      expect(cart.rows[0]).toEqual({ id: guest.cartId, user_id: member, guest_token_hash: null });
      expect(await quantityOf(db(), guest.cartId, fx.variantId)).toBe(2);
    });

    test('両方あれば、同じバリアントは大きい方の数量、違うバリアントは移し、ゲストのカートを消す', async () => {
      const shared = await createCatalogFixture(db(), { stock: 0 });
      const memberHigher = await createCatalogFixture(db(), { stock: 0 });
      const guestOnly = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'combine');
      const memberCart = await createMemberCart(db(), member);
      const guest = await createGuestCart(db());
      await insertLine(db(), memberCart, shared.variantId, 1);
      await insertLine(db(), guest.cartId, shared.variantId, 3);
      await insertLine(db(), memberCart, memberHigher.variantId, 4);
      await insertLine(db(), guest.cartId, memberHigher.variantId, 1);
      await insertLine(db(), guest.cartId, guestOnly.variantId, 2);

      const result = await merge(db(), member, guest.tokenHash, null);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 3, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
      expect(await quantityOf(db(), memberCart, shared.variantId)).toBe(3);
      expect(await quantityOf(db(), memberCart, memberHigher.variantId)).toBe(4);
      expect(await quantityOf(db(), memberCart, guestOnly.variantId)).toBe(2);
      const gone = await db().query('select 1 from public.carts where id = $1', [guest.cartId]);
      expect(gone.rowCount).toBe(0);
    });

    test('50種類を超える分は、会員の明細を先に残し、ゲストの明細を入れた順に移す', async () => {
      const variants = await createVariants(db(), 52);
      const member = await createMember(db(), 'overflow');
      const memberCart = await createMemberCart(db(), member);
      for (const variantId of variants.slice(0, 49)) {
        await insertLine(db(), memberCart, variantId, 1);
      }
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, variants[51], 1, '2026-10-01T00:00:03Z');
      await insertLine(db(), guest.cartId, variants[49], 1, '2026-10-01T00:00:01Z');
      await insertLine(db(), guest.cartId, variants[50], 1, '2026-10-01T00:00:02Z');

      const result = await merge(db(), member, guest.tokenHash, null);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 1, cart_lines_dropped: 2, wishlist_lines_moved: 0 });
      expect(await quantityOf(db(), memberCart, variants[49])).toBe(1);
      expect(await quantityOf(db(), memberCart, variants[50])).toBeNull();
      expect(await quantityOf(db(), memberCart, variants[51])).toBeNull();
    });

    test('お気に入りは同じ商品を1つにして合わせ、ゲストのお気に入りを消す', async () => {
      const both = await createCatalogFixture(db(), { stock: 0 });
      const guestOnly = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'wishlist');
      const memberList = await db().query('insert into public.wishlists (user_id) values ($1) returning id', [member]);
      const guestHash = hashOf(`guest-wishlist-${uniqueSuffix()}`);
      const guestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [guestHash]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2)', [memberList.rows[0].id, both.itemId]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2), ($1, $3)', [guestList.rows[0].id, both.itemId, guestOnly.itemId]);

      const result = await merge(db(), member, null, guestHash);

      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 1 });
      const items = await db().query('select item_id from public.wishlist_lines where wishlist_id = $1 order by item_id', [memberList.rows[0].id]);
      expect(items.rows.map((row) => Number(row.item_id))).toEqual([both.itemId, guestOnly.itemId].sort((a, b) => a - b));
      const gone = await db().query('select 1 from public.wishlists where id = $1', [guestList.rows[0].id]);
      expect(gone.rowCount).toBe(0);
    });

    test('会員にお気に入りが無ければ、ゲストのお気に入りをそのまま会員のものにする', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'wishlist-convert');
      const guestHash = hashOf(`guest-wishlist-${uniqueSuffix()}`);
      const guestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [guestHash]);
      await db().query('insert into public.wishlist_lines (wishlist_id, item_id) values ($1, $2)', [guestList.rows[0].id, fx.itemId]);
      const result = await merge(db(), member, null, guestHash);
      expect(result.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 1 });
      const owner = await db().query('select user_id, guest_token_hash from public.wishlists where id = $1', [guestList.rows[0].id]);
      expect(owner.rows[0]).toEqual({ user_id: member, guest_token_hash: null });
    });

    test('同じ印で2回合わせても、2回目は何もしない', async () => {
      const fx = await createCatalogFixture(db(), { stock: 0 });
      const member = await createMember(db(), 'twice');
      const guest = await createGuestCart(db());
      await insertLine(db(), guest.cartId, fx.variantId, 1);
      await merge(db(), member, guest.tokenHash, null);
      const second = await merge(db(), member, guest.tokenHash, null);
      expect(second.rows[0]).toEqual({ cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 });
    });

    test('形の違う入力は MERGE_INVALID_INPUT', async () => {
      const member = await createMember(db(), 'invalid');
      await expect(merge(db(), null, hashOf('x'), null)).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
      await expect(merge(db(), member, 'short', null)).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
      await expect(merge(db(), member, null, 'short')).rejects.toMatchObject({ message: 'MERGE_INVALID_INPUT' });
    });
  });

  describe('ゲストの分の期限', () => {
    test('最後に使ってから30日を過ぎたゲストの分だけを消す', async () => {
      const job = await db().query("select command, schedule from cron.job where jobname = 'guest-shopping-retention'");
      expect(job.rows).toHaveLength(1);
      expect(job.rows[0].schedule).toBe('45 3 * * *');

      const member = await createMember(db(), 'retention');
      const oldGuest = await createGuestCart(db());
      const recentGuest = await createGuestCart(db());
      const oldMember = await createMemberCart(db(), member);
      const oldGuestList = await db().query('insert into public.wishlists (guest_token_hash) values ($1) returning id', [hashOf(`old-list-${uniqueSuffix()}`)]);
      await db().query("update public.carts set updated_at = now() - interval '31 days' where id = any($1::uuid[])", [[oldGuest.cartId, oldMember]]);
      await db().query("update public.carts set updated_at = now() - interval '29 days' where id = $1", [recentGuest.cartId]);
      await db().query("update public.wishlists set updated_at = now() - interval '31 days' where id = $1", [oldGuestList.rows[0].id]);

      await db().query(job.rows[0].command);

      const carts = await db().query('select id from public.carts where id = any($1::uuid[]) order by id', [[oldGuest.cartId, recentGuest.cartId, oldMember]]);
      expect(carts.rows.map((row) => row.id).sort()).toEqual([recentGuest.cartId, oldMember].sort());
      const lists = await db().query('select 1 from public.wishlists where id = $1', [oldGuestList.rows[0].id]);
      expect(lists.rowCount).toBe(0);
    });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/cart_wishlist_ownership.integration.test.ts --runInBand`
Expected: FAIL（`relation "public.cart_lines" does not exist` など）

- [ ] **Step 3: 移行 A を書く**

`supabase/migrations/20261008130000_cart_wishlist_ownership.sql`:

```sql
-- カートとお気に入りの持ち主と明細（docs/superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md 第3章・第5章・第6章）
-- 古い表を消して作り直すので、1回だけ当てる。「確認へ進む」「注文する」「支払いの後」の関数は
-- 別の移行（_cart_checkout_rpcs.sql）に分けた。そちらは何度当てても同じ結果になる。
BEGIN;

-- 古い関数9本は古い表を使うので、表より先に消す
DROP FUNCTION IF EXISTS public.add_guest_cart_item(text, bigint, integer, text, text);
DROP FUNCTION IF EXISTS public.update_guest_cart_item_quantity(text, uuid, integer);
DROP FUNCTION IF EXISTS public.delete_guest_cart_item(text, uuid);
DROP FUNCTION IF EXISTS public.list_guest_cart(text);
DROP FUNCTION IF EXISTS public.add_guest_wishlist_item(text, bigint);
DROP FUNCTION IF EXISTS public.delete_guest_wishlist_item(text, uuid);
DROP FUNCTION IF EXISTS public.list_guest_wishlist(text);
DROP FUNCTION IF EXISTS public.update_cart_item_quantity_secure(uuid, text, integer);
DROP FUNCTION IF EXISTS public.delete_cart_item_secure(uuid, text);

-- 1行＝1商品で session_id を鍵にした古い表。行は捨てる（本番は未公開。設計書 3-4）
DROP TABLE IF EXISTS public.carts;
DROP TABLE IF EXISTS public.wishlist;

-- カートの持ち主（Shopify の Cart）。会員かゲストの印のどちらか1つ。会員1人・印1つにつき1つ
CREATE TABLE public.carts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  guest_token_hash text UNIQUE CHECK (guest_token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_single_owner CHECK (num_nonnulls(user_id, guest_token_hash) = 1)
);
COMMENT ON COLUMN public.carts.guest_token_hash IS
  'ゲストの cart Cookie の印の SHA-256（16進）。印そのものは保存しない。updated_at から30日で毎日の処理が消す。';

-- カートの明細（Shopify の CartLine）。バリアントと数量
CREATE TABLE public.cart_lines (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id    uuid    NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  variant_id bigint  NOT NULL REFERENCES public.item_variants(id) ON DELETE CASCADE,
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  added_at   timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);
CREATE INDEX cart_lines_variant_id_idx ON public.cart_lines (variant_id);

-- お気に入りの持ち主。カートと同じ形
CREATE TABLE public.wishlists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  guest_token_hash text UNIQUE CHECK (guest_token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wishlists_single_owner CHECK (num_nonnulls(user_id, guest_token_hash) = 1)
);

-- お気に入りの明細。色・サイズを決める前の商品単位（2026-09-06 設計書 3 章と同じ）
CREATE TABLE public.wishlist_lines (
  id          uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  wishlist_id uuid   NOT NULL REFERENCES public.wishlists(id) ON DELETE CASCADE,
  item_id     bigint NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wishlist_id, item_id)
);
CREATE INDEX wishlist_lines_item_id_idx ON public.wishlist_lines (item_id);

-- 明細が変わったら持ち主の「最後に使った日時」を進める。ゲストの分の30日はこれで数える（設計書 3-1・3-3）
CREATE OR REPLACE FUNCTION private.touch_cart_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.carts AS c SET updated_at = pg_catalog.now() WHERE c.id = NEW.cart_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.carts AS c SET updated_at = pg_catalog.now() WHERE c.id = OLD.cart_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.touch_cart_owner() FROM PUBLIC;

CREATE TRIGGER cart_lines_touch_owner
  AFTER INSERT OR UPDATE OR DELETE ON public.cart_lines
  FOR EACH ROW EXECUTE FUNCTION private.touch_cart_owner();

CREATE OR REPLACE FUNCTION private.touch_wishlist_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE public.wishlists AS w SET updated_at = pg_catalog.now() WHERE w.id = NEW.wishlist_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.wishlists AS w SET updated_at = pg_catalog.now() WHERE w.id = OLD.wishlist_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.touch_wishlist_owner() FROM PUBLIC;

CREATE TRIGGER wishlist_lines_touch_owner
  AFTER INSERT OR UPDATE OR DELETE ON public.wishlist_lines
  FOR EACH ROW EXECUTE FUNCTION private.touch_wishlist_owner();

-- ブラウザ（anon・authenticated）からは一切読めず書けない。読み書きはサーバーの API（service role）だけ（設計書 3-2）
ALTER TABLE public.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wishlist_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny direct client access" ON public.carts
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.cart_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.wishlists
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.wishlist_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.carts, public.cart_lines, public.wishlists, public.wishlist_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.carts, public.cart_lines, public.wishlists, public.wishlist_lines TO service_role;

-- 下書きを作ったカート。「注文する」の「カートが変わった」と、支払いの後に消す明細の範囲に使う（設計書第7章）
ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS cart_id uuid REFERENCES public.carts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS checkout_drafts_cart_id_idx ON public.checkout_drafts (cart_id);

-- 明細を足す（Shopify の /cart/add.js）。同じバリアントは同じ明細の数量を足す。全部入れるか何も入れない
CREATE OR REPLACE FUNCTION public.cart_add_lines(_cart_id uuid, _lines jsonb)
RETURNS SETOF public.cart_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_lines integer;
  new_variants integer;
BEGIN
  IF _cart_id IS NULL
     OR _lines IS NULL
     OR pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 10
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
       WHERE pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(e.value->'variant_id') IS DISTINCT FROM 'number'
          OR pg_catalog.jsonb_typeof(e.value->'quantity') IS DISTINCT FROM 'number'
          OR COALESCE(e.value->>'variant_id', '') !~ '^[1-9][0-9]{0,17}$'
          OR COALESCE(e.value->>'quantity', '') !~ '^[1-9][0-9]?$'
     ) THEN
    RAISE EXCEPTION 'CART_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  -- 同じカートへの足す・変える・合わせるを順番にする（上限を正しく数えるため）
  PERFORM 1 FROM public.carts AS c WHERE c.id = _cart_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 販売中（バリアントが有効で、商品が公開中）のバリアントだけを入れる
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT (e.value->>'variant_id')::bigint AS variant_id
      FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    ) AS i
    LEFT JOIN public.item_variants AS v ON v.id = i.variant_id
    LEFT JOIN public.items AS it ON it.id = v.item_id
    WHERE v.id IS NULL OR NOT v.is_active OR it.status IS DISTINCT FROM 'published'
  ) THEN
    RAISE EXCEPTION 'CART_VARIANT_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT (e.value->>'variant_id')::bigint AS variant_id,
             pg_catalog.sum((e.value->>'quantity')::integer) AS quantity
      FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
      GROUP BY 1
    ) AS i
    LEFT JOIN public.cart_lines AS l ON l.cart_id = _cart_id AND l.variant_id = i.variant_id
    WHERE COALESCE(l.quantity, 0) + i.quantity > 20
  ) THEN
    RAISE EXCEPTION 'CART_LINE_QUANTITY_LIMIT' USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO current_lines
  FROM public.cart_lines AS l
  WHERE l.cart_id = _cart_id;

  SELECT pg_catalog.count(*)::integer INTO new_variants
  FROM (
    SELECT DISTINCT (e.value->>'variant_id')::bigint AS variant_id
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
  ) AS i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cart_lines AS l WHERE l.cart_id = _cart_id AND l.variant_id = i.variant_id
  );

  IF current_lines + new_variants > 50 THEN
    RAISE EXCEPTION 'CART_LINE_LIMIT' USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT (e.value->>'variant_id')::bigint AS variant_id,
           pg_catalog.sum((e.value->>'quantity')::integer)::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    GROUP BY 1
  ),
  saved AS (
    INSERT INTO public.cart_lines AS l (cart_id, variant_id, quantity)
    SELECT _cart_id, r.variant_id, r.quantity
    FROM requested AS r
    ON CONFLICT (cart_id, variant_id) DO UPDATE
      SET quantity = l.quantity + EXCLUDED.quantity,
          updated_at = pg_catalog.now()
    RETURNING l.*
  )
  SELECT * FROM saved;
END;
$$;

-- 明細の数量を変える（Shopify の /cart/change.js）。0 で消す。他のカートの明細は見つからない扱い
CREATE OR REPLACE FUNCTION public.cart_change_line(_cart_id uuid, _line_id uuid, _quantity integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _cart_id IS NULL OR _line_id IS NULL OR _quantity IS NULL OR _quantity < 0 THEN
    RAISE EXCEPTION 'CART_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  IF _quantity > 20 THEN
    RAISE EXCEPTION 'CART_LINE_QUANTITY_LIMIT' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.carts AS c WHERE c.id = _cart_id FOR UPDATE;

  IF _quantity = 0 THEN
    DELETE FROM public.cart_lines AS l WHERE l.id = _line_id AND l.cart_id = _cart_id;
  ELSE
    UPDATE public.cart_lines AS l
    SET quantity = _quantity, updated_at = pg_catalog.now()
    WHERE l.id = _line_id AND l.cart_id = _cart_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_LINE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

-- ログインでゲストの分を会員の分へ合わせる（設計書 5-2）。カートとお気に入りを1つの取引で処理する
CREATE OR REPLACE FUNCTION public.merge_guest_into_member(
  _user_id uuid,
  _cart_token_hash text,
  _wishlist_token_hash text
)
RETURNS TABLE (cart_lines_moved integer, cart_lines_dropped integer, wishlist_lines_moved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  guest_cart_id uuid;
  member_cart_id uuid;
  guest_list_id uuid;
  member_list_id uuid;
  member_line_count integer;
  moved integer := 0;
  dropped integer := 0;
  list_moved integer := 0;
  guest_line record;
BEGIN
  IF _user_id IS NULL
     OR (_cart_token_hash IS NOT NULL AND _cart_token_hash !~ '^[0-9a-f]{64}$')
     OR (_wishlist_token_hash IS NOT NULL AND _wishlist_token_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'MERGE_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  IF _cart_token_hash IS NOT NULL THEN
    -- 2つの持ち主の行を番号の小さい順にロックする（足す・変える関数と同じ行をロックし、行き詰まりを防ぐ）
    PERFORM 1
    FROM public.carts AS c
    WHERE c.guest_token_hash = _cart_token_hash OR c.user_id = _user_id
    ORDER BY c.id
    FOR UPDATE;

    SELECT c.id INTO guest_cart_id FROM public.carts AS c WHERE c.guest_token_hash = _cart_token_hash;
    IF guest_cart_id IS NOT NULL THEN
      SELECT c.id INTO member_cart_id FROM public.carts AS c WHERE c.user_id = _user_id;
      IF member_cart_id IS NULL THEN
        -- 会員に有効なカートが無ければ、ゲストのカートがそのまま会員のカートになる（commercetools と同じ）
        UPDATE public.carts AS c
        SET user_id = _user_id, guest_token_hash = NULL, updated_at = pg_catalog.now()
        WHERE c.id = guest_cart_id;
        SELECT pg_catalog.count(*)::integer INTO moved FROM public.cart_lines AS l WHERE l.cart_id = guest_cart_id;
      ELSE
        -- 同じバリアントは大きい方の数量（commercetools の既定。2台で同じ物を入れても倍にしない）
        WITH combined AS (
          UPDATE public.cart_lines AS m
          SET quantity = GREATEST(m.quantity, g.quantity), updated_at = pg_catalog.now()
          FROM public.cart_lines AS g
          WHERE m.cart_id = member_cart_id
            AND g.cart_id = guest_cart_id
            AND g.variant_id = m.variant_id
          RETURNING m.id
        )
        SELECT pg_catalog.count(*)::integer INTO moved FROM combined;

        SELECT pg_catalog.count(*)::integer INTO member_line_count
        FROM public.cart_lines AS l
        WHERE l.cart_id = member_cart_id;

        FOR guest_line IN
          SELECT g.id
          FROM public.cart_lines AS g
          WHERE g.cart_id = guest_cart_id
            AND NOT EXISTS (
              SELECT 1 FROM public.cart_lines AS m
              WHERE m.cart_id = member_cart_id AND m.variant_id = g.variant_id
            )
          ORDER BY g.added_at, g.id
        LOOP
          IF member_line_count < 50 THEN
            UPDATE public.cart_lines AS l
            SET cart_id = member_cart_id, updated_at = pg_catalog.now()
            WHERE l.id = guest_line.id;
            member_line_count := member_line_count + 1;
            moved := moved + 1;
          ELSE
            dropped := dropped + 1;
          END IF;
        END LOOP;

        -- 移さなかった明細（同じバリアント・上限を超えた分）はゲストのカートと一緒に消える
        DELETE FROM public.carts AS c WHERE c.id = guest_cart_id;
      END IF;
    END IF;
  END IF;

  IF _wishlist_token_hash IS NOT NULL THEN
    PERFORM 1
    FROM public.wishlists AS w
    WHERE w.guest_token_hash = _wishlist_token_hash OR w.user_id = _user_id
    ORDER BY w.id
    FOR UPDATE;

    SELECT w.id INTO guest_list_id FROM public.wishlists AS w WHERE w.guest_token_hash = _wishlist_token_hash;
    IF guest_list_id IS NOT NULL THEN
      SELECT w.id INTO member_list_id FROM public.wishlists AS w WHERE w.user_id = _user_id;
      IF member_list_id IS NULL THEN
        UPDATE public.wishlists AS w
        SET user_id = _user_id, guest_token_hash = NULL, updated_at = pg_catalog.now()
        WHERE w.id = guest_list_id;
        SELECT pg_catalog.count(*)::integer INTO list_moved FROM public.wishlist_lines AS l WHERE l.wishlist_id = guest_list_id;
      ELSE
        WITH inserted AS (
          INSERT INTO public.wishlist_lines AS l (wishlist_id, item_id, added_at)
          SELECT member_list_id, g.item_id, g.added_at
          FROM public.wishlist_lines AS g
          WHERE g.wishlist_id = guest_list_id
          ON CONFLICT (wishlist_id, item_id) DO NOTHING
          RETURNING l.id
        )
        SELECT pg_catalog.count(*)::integer INTO list_moved FROM inserted;
        DELETE FROM public.wishlists AS w WHERE w.id = guest_list_id;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT moved, dropped, list_moved;
END;
$$;

REVOKE ALL ON FUNCTION public.cart_add_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cart_add_lines(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cart_change_line(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cart_change_line(uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.merge_guest_into_member(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_into_member(uuid, text, text) TO service_role;

-- ゲストの分は最後に使ってから30日で消す（設計書 3-3。Shopify も使われないカートを30日で消す）。会員の分は退会まで残す
-- 同名ジョブは置き換えられる（cron.schedule はジョブ名で上書きする）
SELECT cron.schedule(
  'guest-shopping-retention',
  '45 3 * * *',
  $$
    delete from public.carts
    where guest_token_hash is not null
      and updated_at < now() - interval '30 days';
    delete from public.wishlists
    where guest_token_hash is not null
      and updated_at < now() - interval '30 days';
  $$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx supabase db reset` の後に Step 2 と同じコマンド
Expected: PASS（全部）。このタスクの時点では、決済の結合テスト（place_order・mark_order_payment など）は古い表を使う関数のままなので落ちる。Task 2 で直す。フォルダ全体はまだ流さない

- [ ] **Step 5: 古い関数の試験を消してコミットする**

```bash
git rm tests/integration/db/guest_rpc_item_id_type.integration.test.ts
git add supabase/migrations/20261008130000_cart_wishlist_ownership.sql tests/integration/db/cart_wishlist_ownership.integration.test.ts
git commit -m "feat(db): カートとお気に入りを持ち主の表と明細の表に作り直し、ログインで合わせる関数を足す"
```

---

### Task 2: 決済の関数の作り直し（移行 B）と DB 結合テストの試験データ

**Files:**
- Create: `supabase/migrations/20261008130100_cart_checkout_rpcs.sql`
- Create: `tests/integration/db/cart_checkout_rpcs.integration.test.ts`
- Modify: `tests/integration/db/helpers/order-fixtures.ts:50-136`（`createDraft`）
- Modify: `tests/integration/db/checkout_session_claim.integration.test.ts:34-42,103-114`（後片付けで移行 B を当て直す）
- Modify: `tests/integration/db/checkout_order_owner_binding.integration.test.ts`（下書きを取る関数を15引数で呼ぶ・権限の署名）
- Modify: `tests/integration/db/place_order_from_checkout_draft.integration.test.ts:58-60,103`、`tests/integration/db/mark_order_payment.integration.test.ts:49-63,150`、`tests/integration/db/place_order_shown_stock.integration.test.ts:137-268,350-368`（新しいカートの明細で確かめる）

**Interfaces:**
- Consumes: Task 1 の表と `checkout_drafts.cart_id`
- Produces:
  - `public.claim_checkout_draft(_session_id text, _request_version smallint, _request_fingerprint text, _checkout_ui_mode text, _checkout_origin text, _payment_method text, _currency text, _subtotal_amount integer, _tax_amount integer, _shipping_amount integer, _total_amount integer, _shipping_snapshot jsonb, _items_snapshot jsonb, _buyer_user_id uuid, _cart_id uuid)`（15引数、既定値なし）。同じ下書きを違うカートで取ろうとすると `CHECKOUT_DRAFT_CART_MISMATCH`（23514）
  - `public.place_order_from_checkout_draft`（10引数のまま）は、下書きの `cart_id` と写しの `source_cart_line_id` で「カートが変わった」（`cart_changed`）を決める
  - `private.clear_cart_for_order(uuid)` は下書きのカートから写しの明細だけを消す
  - `private.checkout_cart_lines_gone(_cart_id uuid, _items_snapshot jsonb) RETURNS boolean`
  - `createDraft(db, options)` は `{ draftId, cartSessionId, checkoutSessionId, cartId, cartLineId, totalAmount }` を返す（`cartId` は持ち主の番号、`cartLineId` は最初の明細の番号。バリアントに当たらない明細だけなら `null`）

- [ ] **Step 1: 結合テストを書く**

`tests/integration/db/cart_checkout_rpcs.integration.test.ts`:

```ts
/** @jest-environment node */
import { createHash } from 'crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, PRICE, uniqueSuffix } from './helpers/order-fixtures';

function fingerprint(seed: string): string {
  return `v3:${createHash('sha256').update(seed).digest('hex')}`;
}

function claim(db: PgClient, params: { sessionId: string; seed: string; cartId: string | null; items: unknown[] }) {
  return db.query(
    `select * from public.claim_checkout_draft(
       _session_id => $1, _request_version => 3::smallint, _request_fingerprint => $2,
       _checkout_ui_mode => 'custom', _checkout_origin => 'http://localhost:3000', _payment_method => 'stripe_card',
       _currency => 'jpy', _subtotal_amount => $3, _tax_amount => 0, _shipping_amount => 0, _total_amount => $3,
       _shipping_snapshot => '{}'::jsonb, _items_snapshot => $4::jsonb, _buyer_user_id => null, _cart_id => $5)`,
    [params.sessionId, fingerprint(params.seed), PRICE, JSON.stringify(params.items), params.cartId],
  );
}

function placeFromFinalScreen(db: PgClient, draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number }) {
  return db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null,
       _shown_in_stock_variant_ids => array[]::bigint[], _buyer_user_id => null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
}

describeLocalDb('integration: 新しいカートと決済の関数', (db) => {
  test('下書きを取る関数は cart_id を記録し、同じ下書きを違うカートで取ると断る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const first = await db().query("insert into public.carts (guest_token_hash) values (encode(sha256(convert_to($1, 'UTF8')), 'hex')) returning id", [`a-${uniqueSuffix()}`]);
    const second = await db().query("insert into public.carts (guest_token_hash) values (encode(sha256(convert_to($1, 'UTF8')), 'hex')) returning id", [`b-${uniqueSuffix()}`]);
    const items = [{ item_id: fx.itemId, item_name: '照合テスト', item_price: PRICE, item_image_url: null, color: fx.colorName, size: fx.sizeLabel, quantity: 1, line_total: PRICE, source_cart_line_id: null }];
    const sessionId = `claim-cart-${uniqueSuffix()}`;
    const claimed = await claim(db(), { sessionId, seed: sessionId, cartId: first.rows[0].id, items });
    const draft = await db().query('select cart_id from public.checkout_drafts where id = $1', [claimed.rows[0].id]);
    expect(draft.rows[0].cart_id).toBe(first.rows[0].id);
    await expect(claim(db(), { sessionId, seed: sessionId, cartId: second.rows[0].id, items })).rejects.toMatchObject({ message: 'CHECKOUT_DRAFT_CART_MISMATCH' });
  });

  test('下書きを取る関数は15引数の1本だけで、service_role だけが実行できる', async () => {
    const versions = await db().query(
      `select p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'claim_checkout_draft'`,
    );
    expect(versions.rows.map((row) => row.signature)).toEqual([
      'claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)',
    ]);
    const signature = 'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)';
    const privileges = await db().query(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service`,
      [signature],
    );
    expect(privileges.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });

  test('「注文する」は、下書きの明細がカートに残っていれば受け付け、消えていれば cart_changed', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const kept = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const keptResult = await placeFromFinalScreen(db(), kept);
    expect(keptResult.rows[0]).toMatchObject({ created: true, rejection: null });

    const removed = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('delete from public.cart_lines where id = $1', [removed.cartLineId]);
    const removedResult = await placeFromFinalScreen(db(), removed);
    expect(removedResult.rows[0]).toMatchObject({ order_id: null, created: false, rejection: 'cart_changed' });
  });

  test('cart_id の無い下書きで明細の参照があれば cart_changed', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    await db().query('update public.checkout_drafts set cart_id = null where id = $1', [draft.draftId]);
    const result = await placeFromFinalScreen(db(), draft);
    expect(result.rows[0]).toMatchObject({ created: false, rejection: 'cart_changed' });
  });

  test('支払いの後は、下書きのカートから写しの明細だけを消し、後から足した明細は残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const later = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const extra = await db().query('insert into public.cart_lines (cart_id, variant_id, quantity) values ($1, $2, 1) returning id', [draft.cartId, later.variantId]);
    const placed = await placeFromFinalScreen(db(), draft);
    await db().query(
      "select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, $3::text)",
      [placed.rows[0].order_id, `pi_${uniqueSuffix()}`, null],
    );
    const lines = await db().query('select id from public.cart_lines where cart_id = $1', [draft.cartId]);
    expect(lines.rows.map((row) => row.id)).toEqual([extra.rows[0].id]);
  });
});
```

- [ ] **Step 2: 試験データ `createDraft` を新しいカートに替える**

`tests/integration/db/helpers/order-fixtures.ts` の先頭に `import { createHash } from 'crypto';` を足し、`createDraft`（:50-136）を次に置き換える。

```ts
type DraftLine = { quantity: number; colorName?: string | null; sizeLabel?: string | null };

/**
 * Session を付けた下書き（status = created）を作る。ゲストのカートと明細も作り、下書きの cart_id と
 * 写しの source_cart_line_id で結ぶ。カートは同じバリアントを1行にまとめる（数量は明細の合計）ので、
 * 色・サイズが同じ明細は同じ明細の参照を持つ。色・サイズがバリアントに当たらない明細は参照を空にする。
 * lines を省くと quantity・colorName・sizeLabel の1明細になる。色・サイズの既定は BLACK・M（createCatalogFixture と同じ）。
 */
export async function createDraft(
  db: PgClient,
  options: {
    itemId: number;
    quantity?: number;
    colorName?: string | null;
    sizeLabel?: string | null;
    lines?: DraftLine[];
    kanaName?: string | null;
    buyerUserId?: string | null;
  },
): Promise<{
  draftId: string;
  cartSessionId: string;
  checkoutSessionId: string;
  cartId: string;
  cartLineId: string | null;
  totalAmount: number;
}> {
  const suffix = uniqueSuffix();
  const cartSessionId = `fx-session-${suffix}`;
  const checkoutSessionId = `cs_fx_${suffix}`;
  const lines: DraftLine[] = options.lines ?? [
    { quantity: options.quantity ?? 1, colorName: options.colorName, sizeLabel: options.sizeLabel },
  ];
  const colorOf = (line: DraftLine) => (line.colorName === undefined ? 'BLACK' : line.colorName);
  const sizeOf = (line: DraftLine) => (line.sizeLabel === undefined ? 'M' : line.sizeLabel);
  const totalAmount = lines.reduce((sum, line) => sum + PRICE * line.quantity, 0);

  const cart = await db.query('insert into public.carts (guest_token_hash) values ($1) returning id', [
    createHash('sha256').update(`fx-cart-${suffix}`).digest('hex'),
  ]);
  const cartId = cart.rows[0].id as string;

  const variantIds: Array<number | null> = [];
  for (const line of lines) {
    const variant = await db.query(
      `select v.id from public.item_variants as v
       left join public.item_colors as c on c.id = v.color_id
       left join public.item_sizes as z on z.id = v.size_id
       where v.item_id = $1
         and coalesce(c.name, '') = coalesce($2, '')
         and coalesce(z.label, '') = coalesce($3, '')
       limit 1`,
      [options.itemId, colorOf(line), sizeOf(line)],
    );
    variantIds.push(variant.rows[0] ? Number(variant.rows[0].id) : null);
  }

  const quantityByVariant = new Map<number, number>();
  lines.forEach((line, index) => {
    const variantId = variantIds[index];
    if (variantId !== null) {
      quantityByVariant.set(variantId, (quantityByVariant.get(variantId) ?? 0) + line.quantity);
    }
  });
  const lineIdByVariant = new Map<number, string>();
  for (const [variantId, quantity] of quantityByVariant) {
    const saved = await db.query(
      'insert into public.cart_lines (cart_id, variant_id, quantity) values ($1, $2, $3) returning id',
      [cartId, variantId, quantity],
    );
    lineIdByVariant.set(variantId, saved.rows[0].id as string);
  }
  const lineIds = variantIds.map((variantId) => (variantId === null ? null : lineIdByVariant.get(variantId) ?? null));

  const draft = await db.query(
    `insert into public.checkout_drafts
       (session_id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, discount_amount,
        total_amount, currency, shipping_snapshot, items_snapshot, buyer_user_id, cart_id)
     values ($1, $2, 'stripe_card', $3, 0, 0, $3, 'jpy', $4::jsonb, $5::jsonb, $6, $7)
     returning id`,
    [
      cartSessionId,
      checkoutSessionId,
      totalAmount,
      JSON.stringify({
        email: 'fixture@example.com',
        fullName: '山田 花子',
        kanaName: options.kanaName === undefined ? 'ヤマダ ハナコ' : options.kanaName,
        postalCode: '1500001',
        prefecture: '東京都',
        city: '渋谷区',
        address: '神宮前1-1-1',
        building: null,
        phone: '0311112222',
      }),
      JSON.stringify(
        lines.map((line, index) => ({
          item_id: options.itemId,
          item_name: '照合テスト',
          item_price: PRICE,
          item_image_url: 'https://example.com/item.png',
          color: colorOf(line),
          size: sizeOf(line),
          quantity: line.quantity,
          line_total: PRICE * line.quantity,
          source_cart_line_id: lineIds[index],
        })),
      ),
      options.buyerUserId ?? null,
      cartId,
    ],
  );
  return {
    draftId: draft.rows[0].id as string,
    cartSessionId,
    checkoutSessionId,
    cartId,
    cartLineId: lineIds.find((id): id is string => id !== null) ?? null,
    totalAmount,
  };
}
```

- [ ] **Step 3: 既存の DB 結合テストを新しいカートの明細に合わせる**

1. `tests/integration/db/place_order_from_checkout_draft.integration.test.ts:58-60` と `tests/integration/db/mark_order_payment.integration.test.ts:49-52` の `cartExists` を次に替え、呼び出し（`cartExists(db(), draft.cartId)`）を `cartLineExists(db(), draft.cartLineId)` に替える。

```ts
async function cartLineExists(db: PgClient, cartLineId: string | null): Promise<boolean> {
  if (cartLineId === null) return false;
  const res = await db.query('select 1 from public.cart_lines where id = $1', [cartLineId]);
  return res.rowCount > 0;
}
```

2. `tests/integration/db/place_order_shown_stock.integration.test.ts` の `delete from public.carts where id = $1', [draft.cartId]`（:145,165,194,218,235,250）を `delete from public.cart_lines where id = $1', [draft.cartLineId]` に、:195・:261・:355 の `select id from public.carts where id = $1 and ...` を `select id from public.cart_lines where id = $1 and cart_id = $2`（引数 `[draft.cartLineId, draft.cartId]`）に替える。:211-230 の試験は `source_cart_id` を `source_cart_line_id` に替える（`jsonb_set(items_snapshot, '{0,source_cart_line_id}', 'null'::jsonb)`）。題名の `source_cart_id` も `source_cart_line_id` にする

3. `tests/integration/db/checkout_order_owner_binding.integration.test.ts`: 下書きを取る関数を名前付きで呼ぶ所に `_cart_id => null` を足す。権限・形を確かめる署名の文字列 `(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid)` を `(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb,uuid,uuid)` に替える（:197-210・:280-284 ほか、`grep -n "jsonb,uuid" tests/integration/db/checkout_order_owner_binding.integration.test.ts` で全部を見つける）

4. `tests/integration/db/checkout_session_claim.integration.test.ts`: `OWNER_BINDING_SQL`（:34-42）の後に次を足し、`afterAll` の `await clientA.query(OWNER_BINDING_SQL);` の直後で `await clientA.query(CART_CHECKOUT_RPCS_SQL);` を呼ぶ。`afterAll` のコメントの「元の移行＋グループ C の移行」を「元の移行＋グループ C の移行＋カートの引き継ぎの決済の関数の移行」に直す

```ts
const CART_CHECKOUT_RPCS_SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations",
    fs.readdirSync(path.join(process.cwd(), "supabase/migrations"))
      .find((name: string) => name.endsWith("_cart_checkout_rpcs.sql")),
  ),
  "utf8",
);
```

- [ ] **Step 4: 失敗を確かめる**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/cart_checkout_rpcs.integration.test.ts --runInBand`
Expected: FAIL（`claim_checkout_draft` に `_cart_id` が無い、`cart_changed` にならない）

- [ ] **Step 5: 移行 B を書く**

`supabase/migrations/20261008130100_cart_checkout_rpcs.sql`。`claim_checkout_draft` と `place_order_from_checkout_draft` の本文は、`supabase/migrations/20261008055720_checkout_order_owner_binding.sql` の定義（:62-237 と :250-579）を写し、次の差分だけを入れる。

```sql
-- 「確認へ進む」「注文する」「支払いの後」の関数を新しいカート（carts・cart_lines）に合わせる
-- （docs/superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md 第7章）。
-- 何度当てても同じ結果になるように書く。checkout_session_claim の結合テストが後片付けで、
-- グループ C の移行（_checkout_order_owner_binding.sql）の後にこの移行を当て直す。
BEGIN;

-- 下書きの明細の参照が、まだ下書きのカートに残っているか。参照が空の明細は確かめない（前からの決まり）
CREATE OR REPLACE FUNCTION private.checkout_cart_lines_gone(_cart_id uuid, _items_snapshot jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(_items_snapshot) AS e(value)
    WHERE e.value->>'source_cart_line_id' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.cart_lines AS l
        WHERE l.id = (e.value->>'source_cart_line_id')::uuid
          AND l.cart_id = _cart_id
      )
  );
$$;
REVOKE ALL ON FUNCTION private.checkout_cart_lines_gone(uuid, jsonb) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb, uuid
);
-- （ここに 20261008055720 の claim_checkout_draft を写す。差分は次の4つ）
--  1. 引数の最後に「, _cart_id uuid」を足す（既定値なし。古い版と呼び分けが決まるように）
--  2. INSERT の列に cart_id、VALUES に _cart_id を足す
--  3. 買い手の比べ（CHECKOUT_DRAFT_BUYER_MISMATCH）の直後に次を足す:
--       IF claimed.cart_id IS DISTINCT FROM _cart_id THEN
--         RAISE EXCEPTION 'CHECKOUT_DRAFT_CART_MISMATCH' USING ERRCODE = '23514';
--       END IF;
--  4. REVOKE・GRANT の署名を「..., jsonb, jsonb, uuid, uuid」にする

-- （ここに 20261008055720 の place_order_from_checkout_draft を CREATE OR REPLACE で写す。引数の形は変えない。差分は2か所）
--  1. 既存の注文を返す前の「別の画面の支払いでカートが空になった後」の EXISTS (... public.carts AS c ... c.session_id = draft_row.session_id) を
--       private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot)
--     に替える
--  2. 「別の注文がカートを空にした後の下書き」の EXISTS (... public.carts AS c ...) を同じく
--       private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot)
--     に替える
--  REVOKE・GRANT は今のまま（10引数）

CREATE OR REPLACE FUNCTION private.clear_cart_for_order(_order_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.cart_lines AS l
  USING public.orders AS o,
        public.checkout_drafts AS d,
        pg_catalog.jsonb_array_elements(d.items_snapshot) AS s(value)
  WHERE o.id = _order_id
    AND d.checkout_session_id = o.checkout_session_id
    AND d.cart_id IS NOT NULL
    AND (s.value->>'source_cart_line_id') IS NOT NULL
    AND l.id = (s.value->>'source_cart_line_id')::uuid
    AND l.cart_id = d.cart_id;
$$;
REVOKE ALL ON FUNCTION private.clear_cart_for_order(uuid) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
```

写した後のファイルに `public.carts AS c` と `session_id = draft_row.session_id`（カートの確かめ）が残っていないことを `grep -n "public.carts" supabase/migrations/20261008130100_cart_checkout_rpcs.sql` で確かめる（残ってよいのは無し）。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`（PostgREST の3本は Global Constraints の環境変数を付ける）
Expected: PASS（全部。`checkout_session_claim` の後に流れる試験も含む）。流し終えたら `npx supabase db reset` で戻す

- [ ] **Step 7: コミットする**

```bash
git add supabase/migrations/20261008130100_cart_checkout_rpcs.sql tests/integration/db/cart_checkout_rpcs.integration.test.ts tests/integration/db/helpers/order-fixtures.ts tests/integration/db/checkout_session_claim.integration.test.ts tests/integration/db/checkout_order_owner_binding.integration.test.ts tests/integration/db/place_order_from_checkout_draft.integration.test.ts tests/integration/db/mark_order_payment.integration.test.ts tests/integration/db/place_order_shown_stock.integration.test.ts
git commit -m "feat(db): 下書き・受付・支払い後の関数を新しいカートの明細で確かめる形に作り直す"
```

---

### Task 3: サーバーの共通部品（印・持ち主・合わせる処理）

**Files:**
- Modify: `src/lib/cookie.ts`（名前と属性を足す）
- Create: `src/features/cart/services/guest-shopping-token.ts`
- Create: `src/features/cart/services/shopping-owner.repository.ts`
- Create: `src/features/cart/services/guest-shopping-merge.ts`
- Create: `src/features/cart/services/shopping-context.ts`
- Test: `tests/unit/features/cart/services/guest-shopping-token.test.ts`、`tests/unit/features/cart/services/guest-shopping-merge.test.ts`、`tests/unit/features/cart/services/shopping-context.test.ts`

**Interfaces:**
- Consumes: Task 1 の表と `merge_guest_into_member`、`resolveCheckoutBuyer(request: NextRequest): Promise<CheckoutBuyerResolution>` と `checkoutBuyerFailureResponse(kind)`（`src/features/checkout/services/checkout-buyer.ts`）、`extractCookieValue(cookieHeader, name)`（`src/lib/auth/request-token.ts`）、`tokenHashSha256`、`logAudit`、`requireCsrfOrDeny`
- Produces:
  - `src/lib/cookie.ts`: `cartCookieName = 'cart'`、`wishlistCookieName = 'wishlist'`、`guestShoppingCookieMaxAgeSeconds = 1209600`、`cookieOptionsForGuestShopping(maxAgeSeconds?: number)`
  - `guest-shopping-token.ts`: `type GuestShoppingKind = 'cart' | 'wishlist'`、`type GuestShoppingTokens = { cartToken: string | null; wishlistToken: string | null }`、`generateGuestShoppingToken(): string`、`parseGuestShoppingToken(value): string | null`、`hashGuestShoppingToken(token): Promise<string>`、`readGuestShoppingTokens(cookieHeader: string | null): GuestShoppingTokens`、`setGuestShoppingCookie(res, kind, token): void`、`clearGuestShoppingCookies(res): void`
  - `shopping-owner.repository.ts`: `type ShoppingOwnerTable = 'carts' | 'wishlists'`、`type ShoppingOwnerRef = { kind: 'member'; userId: string } | { kind: 'guest'; tokenHash: string }`、`findOwnerRowId(supabase, table, owner): Promise<string | null>`、`ensureOwnerRowId(supabase, table, owner): Promise<string>`
  - `guest-shopping-merge.ts`: `type GuestMergeResult = { ok: true; cartLinesMoved: number; cartLinesDropped: number; wishlistLinesMoved: number } | { ok: false }`、`mergeGuestShoppingIntoMember(supabase, { userId, cartToken, wishlistToken }): Promise<GuestMergeResult>`（投げない）
  - `shopping-context.ts`: `type ShoppingContext`、`openShoppingContext(request, kind, supabase, { write }): Promise<{ ok: true; context: ShoppingContext } | { ok: false; response: NextResponse }>`、`findCartIdForBuyer(supabase, request, buyer: CheckoutBuyer): Promise<string | null>`、`denyIfCsrfInvalid(): Promise<NextResponse | null>`

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/features/cart/services/guest-shopping-token.test.ts`:

```ts
import { NextResponse } from 'next/server';
import {
  clearGuestShoppingCookies,
  generateGuestShoppingToken,
  hashGuestShoppingToken,
  parseGuestShoppingToken,
  readGuestShoppingTokens,
  setGuestShoppingCookie,
} from '@/features/cart/services/guest-shopping-token';

describe('ゲストの印', () => {
  test('256ビットの乱数を43文字の base64url にする', () => {
    const token = generateGuestShoppingToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateGuestShoppingToken()).not.toBe(token);
  });

  test('形の違う印は印なしとして扱う', () => {
    expect(parseGuestShoppingToken('x'.repeat(43))).toBe('x'.repeat(43));
    for (const value of [undefined, null, '', 'short', 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(42)}/`]) {
      expect(parseGuestShoppingToken(value)).toBeNull();
    }
  });

  test('ハッシュは SHA-256 の64桁の16進', async () => {
    expect(await hashGuestShoppingToken('a'.repeat(43))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Cookie の見出しから2つの印を読み、形の違う値は空にする', () => {
    const cart = 'c'.repeat(43);
    expect(readGuestShoppingTokens(`session_id=s; cart=${cart}; wishlist=bad`)).toEqual({ cartToken: cart, wishlistToken: null });
    expect(readGuestShoppingTokens(null)).toEqual({ cartToken: null, wishlistToken: null });
  });

  test('Cookie は HttpOnly・SameSite=Lax・Path=/・2週間で付け、消す時は2つとも消す', () => {
    const res = NextResponse.json({});
    setGuestShoppingCookie(res, 'cart', 'c'.repeat(43));
    const cookie = res.cookies.get('cart');
    expect(cookie).toMatchObject({ value: 'c'.repeat(43), httpOnly: true, sameSite: 'lax', path: '/', maxAge: 1209600 });
    clearGuestShoppingCookies(res);
    expect(res.cookies.get('cart')?.value).toBe('');
    expect(res.cookies.get('wishlist')?.value).toBe('');
  });
});
```

`tests/unit/features/cart/services/guest-shopping-merge.test.ts`:

```ts
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import { logAudit } from '@/lib/audit';

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

const CART = 'c'.repeat(43);
const WISHLIST = 'w'.repeat(43);

function supabaseReturning(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn().mockResolvedValue(result) } as never;
}

describe('ログインで合わせる', () => {
  beforeEach(() => jest.clearAllMocks());

  test('印が2つとも無ければ DB を呼ばない', async () => {
    const supabase = supabaseReturning({ data: [], error: null });
    await expect(mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: null, wishlistToken: null })).resolves.toEqual({
      ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0,
    });
    expect((supabase as unknown as { rpc: jest.Mock }).rpc).not.toHaveBeenCalled();
  });

  test('印のハッシュだけを DB に渡し、件数を監査に残す（印は残さない）', async () => {
    const supabase = supabaseReturning({ data: [{ cart_lines_moved: 2, cart_lines_dropped: 1, wishlist_lines_moved: 3 }], error: null });
    const result = await mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: CART, wishlistToken: WISHLIST });
    expect(result).toEqual({ ok: true, cartLinesMoved: 2, cartLinesDropped: 1, wishlistLinesMoved: 3 });
    const rpc = (supabase as unknown as { rpc: jest.Mock }).rpc;
    expect(rpc).toHaveBeenCalledWith('merge_guest_into_member', {
      _user_id: 'u1',
      _cart_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      _wishlist_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const audit = (logAudit as jest.Mock).mock.calls[0][0];
    expect(audit).toMatchObject({ action: 'cart.merge', outcome: 'success', actor_id: 'u1' });
    expect(JSON.stringify(audit)).not.toContain(CART);
    expect(JSON.stringify(audit)).not.toContain(WISHLIST);
  });

  test('DB の失敗は投げずに ok: false を返し、監査に残す', async () => {
    const supabase = supabaseReturning({ data: null, error: { message: 'boom' } });
    await expect(mergeGuestShoppingIntoMember(supabase, { userId: 'u1', cartToken: CART, wishlistToken: null })).resolves.toEqual({ ok: false });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'cart.merge', outcome: 'error' }));
  });
});
```

`tests/unit/features/cart/services/shopping-context.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { openShoppingContext, findCartIdForBuyer } from '@/features/cart/services/shopping-context';
import { resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import { ensureOwnerRowId, findOwnerRowId } from '@/features/cart/services/shopping-owner.repository';

jest.mock('@/features/checkout/services/checkout-buyer', () => {
  const actual = jest.requireActual('@/features/checkout/services/checkout-buyer');
  return { ...actual, resolveCheckoutBuyer: jest.fn() };
});
jest.mock('@/features/cart/services/guest-shopping-merge', () => ({ mergeGuestShoppingIntoMember: jest.fn() }));
jest.mock('@/features/cart/services/shopping-owner.repository', () => ({
  findOwnerRowId: jest.fn(),
  ensureOwnerRowId: jest.fn(),
}));

const CART = 'c'.repeat(43);
const supabase = {} as never;

function requestWithCookie(cookie?: string) {
  return new NextRequest('http://localhost:3000/api/cart', { headers: cookie ? { cookie } : {} });
}

describe('openShoppingContext', () => {
  beforeEach(() => jest.clearAllMocks());

  test('印の期限切れは 401 auth_expired、障害は 503 を返し、DB に触れない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValueOnce({ kind: 'expired' });
    const expired = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.response.status).toBe(401);
      await expect(expired.response.json()).resolves.toEqual({ error: 'auth_expired' });
    }
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValueOnce({ kind: 'unavailable' });
    const unavailable = await openShoppingContext(requestWithCookie(), 'cart', supabase, { write: false });
    expect(!unavailable.ok && unavailable.response.status).toBe(503);
    expect(findOwnerRowId).not.toHaveBeenCalled();
  });

  test('会員は会員の ID で引き、残っていたゲストの印を合わせて Cookie を消す', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'member', userId: 'u1', email: 'a@example.com' });
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 1, cartLinesDropped: 0, wishlistLinesMoved: 0 });
    (findOwnerRowId as jest.Mock).mockResolvedValue('member-cart');
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toEqual({ kind: 'member', userId: 'u1' });
    expect(opened.context.rateLimitSubject).toBe('member:u1');
    await expect(opened.context.findOwnerId()).resolves.toBe('member-cart');
    expect(findOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'member', userId: 'u1' });
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalledWith(supabase, { userId: 'u1', cartToken: CART, wishlistToken: null });
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')?.value).toBe('');
  });

  test('合わせるのに失敗したら Cookie を残す（次の要求でもう一度合わせる）', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'member', userId: 'u1', email: null });
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: false });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('ゲストで形の違う印は印なし。読むだけなら持ち主は無く、Cookie を付けない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie('cart=broken'), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toBeNull();
    expect(opened.context.rateLimitSubject).toBeNull();
    await expect(opened.context.findOwnerId()).resolves.toBeNull();
    expect(findOwnerRowId).not.toHaveBeenCalled();
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('印の無いゲストが書く時は、新しい印で持ち主を作り Cookie を付ける', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    (ensureOwnerRowId as jest.Mock).mockResolvedValue('new-cart');
    const opened = await openShoppingContext(requestWithCookie(), 'cart', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    await expect(opened.context.ensureOwnerId()).resolves.toBe('new-cart');
    expect(ensureOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'guest', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('印のあるゲストが書く時は、同じ印の Cookie を2週間に延ばす', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.rateLimitSubject).toMatch(/^guest:[0-9a-f]{64}$/);
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toMatchObject({ value: CART, maxAge: 1209600 });
  });

  test('監査の持ち主の情報に印そのものを入れない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.auditOwner).toEqual({ owner: 'guest', guest_token_hash_prefix: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(JSON.stringify(opened.context.auditOwner)).not.toContain(CART);
  });
});

describe('findCartIdForBuyer', () => {
  beforeEach(() => jest.clearAllMocks());

  test('会員は残ったゲストの印を合わせてから会員のカートを引く', async () => {
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0 });
    (findOwnerRowId as jest.Mock).mockResolvedValue('member-cart');
    await expect(findCartIdForBuyer(supabase, requestWithCookie(`cart=${CART}`), { kind: 'member', userId: 'u1', email: null })).resolves.toBe('member-cart');
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalled();
  });

  test('ゲストは cart の印で引き、印が無ければ null', async () => {
    (findOwnerRowId as jest.Mock).mockResolvedValue('guest-cart');
    await expect(findCartIdForBuyer(supabase, requestWithCookie(`cart=${CART}`), { kind: 'guest' })).resolves.toBe('guest-cart');
    await expect(findCartIdForBuyer(supabase, requestWithCookie(), { kind: 'guest' })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/features/cart/services --runInBand`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: Cookie の名前と属性を足す**

`src/lib/cookie.ts` の公開の定数の並び（:4-10）の後と、`clearCookieOptions`（:87）の前に足す。

```ts
export const cartCookieName = 'cart';
export const wishlistCookieName = 'wishlist';
/** ゲストのカート・お気に入りの印の寿命。Shopify の cart Cookie と同じ2週間（設計書 4-1） */
export const guestShoppingCookieMaxAgeSeconds = 14 * 24 * 60 * 60;

export function cookieOptionsForGuestShopping(maxAgeSeconds: number = guestShoppingCookieMaxAgeSeconds) {
  return {
    ...getBaseCookieOptions(),
    maxAge: maxAgeSeconds,
  };
}
```

- [ ] **Step 4: 印の部品を書く**

`src/features/cart/services/guest-shopping-token.ts`:

```ts
import type { NextResponse } from 'next/server';
import { extractCookieValue } from '@/lib/auth/request-token';
import {
  cartCookieName,
  clearCookieOptions,
  cookieOptionsForGuestShopping,
  wishlistCookieName,
} from '@/lib/cookie';
import { tokenHashSha256 } from '@/lib/hash';

export type GuestShoppingKind = 'cart' | 'wishlist';
export type GuestShoppingTokens = { cartToken: string | null; wishlistToken: string | null };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function cookieNameOf(kind: GuestShoppingKind): string {
  return kind === 'cart' ? cartCookieName : wishlistCookieName;
}

/** 256 ビットの乱数を base64url（43文字）にした印。DB には SHA-256 だけを入れる（設計書 4-1） */
export function generateGuestShoppingToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 形の正しい印だけを返す。壊れた値は「印なし」として扱い、DB に問い合わせない */
export function parseGuestShoppingToken(value: string | null | undefined): string | null {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

export function hashGuestShoppingToken(token: string): Promise<string> {
  return tokenHashSha256(token);
}

export function readGuestShoppingTokens(cookieHeader: string | null): GuestShoppingTokens {
  return {
    cartToken: parseGuestShoppingToken(extractCookieValue(cookieHeader, cartCookieName)),
    wishlistToken: parseGuestShoppingToken(extractCookieValue(cookieHeader, wishlistCookieName)),
  };
}

export function setGuestShoppingCookie(res: NextResponse, kind: GuestShoppingKind, token: string): void {
  res.cookies.set({ name: cookieNameOf(kind), value: token, ...cookieOptionsForGuestShopping() });
}

/** ログインで合わせ終えた時とログアウトの時に、この端末のゲストの印を2つとも消す（設計書 4-1・4-3） */
export function clearGuestShoppingCookies(res: NextResponse): void {
  for (const name of [cartCookieName, wishlistCookieName]) {
    res.cookies.set({ name, value: '', ...clearCookieOptions() });
  }
}
```

- [ ] **Step 5: 持ち主の行の部品を書く**

`src/features/cart/services/shopping-owner.repository.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type ShoppingOwnerTable = 'carts' | 'wishlists';
export type ShoppingOwnerRef = { kind: 'member'; userId: string } | { kind: 'guest'; tokenHash: string };

function ownerColumn(owner: ShoppingOwnerRef): { column: 'user_id' | 'guest_token_hash'; value: string } {
  return owner.kind === 'member'
    ? { column: 'user_id', value: owner.userId }
    : { column: 'guest_token_hash', value: owner.tokenHash };
}

export async function findOwnerRowId(
  supabase: SupabaseClient,
  table: ShoppingOwnerTable,
  owner: ShoppingOwnerRef,
): Promise<string | null> {
  const { column, value } = ownerColumn(owner);
  const { data, error } = await supabase.from(table).select('id').eq(column, value).maybeSingle<{ id: string }>();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}

/** 持ち主の行を1つにする（会員1人・印1つにつき1つ。表の一意の決まりで同時に作っても1つになる） */
export async function ensureOwnerRowId(
  supabase: SupabaseClient,
  table: ShoppingOwnerTable,
  owner: ShoppingOwnerRef,
): Promise<string> {
  const { column, value } = ownerColumn(owner);
  const { error } = await supabase.from(table).upsert({ [column]: value }, { onConflict: column, ignoreDuplicates: true });
  if (error) {
    throw error;
  }
  const id = await findOwnerRowId(supabase, table, owner);
  if (!id) {
    throw new Error(`${table} owner row was not created`);
  }
  return id;
}
```

- [ ] **Step 6: 合わせる部品を書く**

`src/features/cart/services/guest-shopping-merge.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/audit';
import { hashGuestShoppingToken, type GuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';

export type GuestMergeResult =
  | { ok: true; cartLinesMoved: number; cartLinesDropped: number; wishlistLinesMoved: number }
  | { ok: false };

type MergeRow = { cart_lines_moved: number; cart_lines_dropped: number; wishlist_lines_moved: number };

/**
 * ゲストのカートとお気に入りを会員の分へ合わせる（設計書第5章）。ログインを止めないため、失敗しても投げない。
 * 印そのものは DB にも監査の記録にも渡さない（ハッシュと件数だけ）。
 */
export async function mergeGuestShoppingIntoMember(
  supabase: SupabaseClient,
  params: { userId: string } & GuestShoppingTokens,
): Promise<GuestMergeResult> {
  if (!params.cartToken && !params.wishlistToken) {
    return { ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0 };
  }
  try {
    const { data, error } = await supabase.rpc('merge_guest_into_member', {
      _user_id: params.userId,
      _cart_token_hash: params.cartToken ? await hashGuestShoppingToken(params.cartToken) : null,
      _wishlist_token_hash: params.wishlistToken ? await hashGuestShoppingToken(params.wishlistToken) : null,
    });
    if (error) {
      throw error;
    }
    const row = ((data ?? []) as MergeRow[])[0] ?? { cart_lines_moved: 0, cart_lines_dropped: 0, wishlist_lines_moved: 0 };
    const result = {
      ok: true as const,
      cartLinesMoved: Number(row.cart_lines_moved),
      cartLinesDropped: Number(row.cart_lines_dropped),
      wishlistLinesMoved: Number(row.wishlist_lines_moved),
    };
    await logAudit({
      action: 'cart.merge',
      outcome: 'success',
      actor_id: params.userId,
      metadata: {
        cart_lines_moved: result.cartLinesMoved,
        cart_lines_dropped: result.cartLinesDropped,
        wishlist_lines_moved: result.wishlistLinesMoved,
      },
    });
    return result;
  } catch (error) {
    console.error('Failed to merge guest shopping into member:', error);
    try {
      await logAudit({
        action: 'cart.merge',
        outcome: 'error',
        actor_id: params.userId,
        detail: error instanceof Error ? error.message : 'merge failed',
      });
    } catch (logError) {
      console.error('Failed to log cart merge audit:', logError);
    }
    return { ok: false };
  }
}
```

- [ ] **Step 7: 持ち主を決める部品を書く**

`src/features/cart/services/shopping-context.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import {
  checkoutBuyerFailureResponse,
  resolveCheckoutBuyer,
  type CheckoutBuyer,
} from '@/features/checkout/services/checkout-buyer';
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import {
  clearGuestShoppingCookies,
  generateGuestShoppingToken,
  hashGuestShoppingToken,
  readGuestShoppingTokens,
  setGuestShoppingCookie,
  type GuestShoppingKind,
} from '@/features/cart/services/guest-shopping-token';
import {
  ensureOwnerRowId,
  findOwnerRowId,
  type ShoppingOwnerRef,
  type ShoppingOwnerTable,
} from '@/features/cart/services/shopping-owner.repository';

export type ShoppingContext = {
  kind: GuestShoppingKind;
  /** 今の持ち主。印のまだ無いゲストは null */
  owner: ShoppingOwnerRef | null;
  /** 回数の制限の subject。印のまだ無いゲストは null（IP だけで数える） */
  rateLimitSubject: string | null;
  /** 監査の記録に入れる持ち主の情報。印そのものは入れない */
  auditOwner: Record<string, string>;
  findOwnerId(): Promise<string | null>;
  ensureOwnerId(): Promise<string>;
  /** 応答に Cookie を付ける・消す（合わせ終えた印を消す、新しい印を付ける、書き換えで寿命を延ばす） */
  finish(response: NextResponse): NextResponse;
};

const tableOf = (kind: GuestShoppingKind): ShoppingOwnerTable => (kind === 'cart' ? 'carts' : 'wishlists');

function auditOwnerOf(owner: ShoppingOwnerRef | null): Record<string, string> {
  if (owner?.kind === 'member') return { owner: 'member', user_id: owner.userId };
  if (owner?.kind === 'guest') return { owner: 'guest', guest_token_hash_prefix: owner.tokenHash.slice(0, 12) };
  return { owner: 'guest' };
}

function subjectOf(owner: ShoppingOwnerRef | null): string | null {
  if (owner?.kind === 'member') return `member:${owner.userId}`;
  if (owner?.kind === 'guest') return `guest:${owner.tokenHash}`;
  return null;
}

/**
 * カート・お気に入りの窓口の持ち主を決める（設計書 4-2）。ログインの確かめはグループ C と同じ規則。
 * 会員の要求にゲストの印が残っていれば、ログインの時に失敗した分としてここで合わせる（設計書 5-1）。
 */
export async function openShoppingContext(
  request: NextRequest,
  kind: GuestShoppingKind,
  supabase: SupabaseClient,
  options: { write: boolean },
): Promise<{ ok: true; context: ShoppingContext } | { ok: false; response: NextResponse }> {
  const buyer = await resolveCheckoutBuyer(request);
  if (buyer.kind === 'expired' || buyer.kind === 'unavailable') {
    return { ok: false, response: checkoutBuyerFailureResponse(buyer.kind) };
  }

  const tokens = readGuestShoppingTokens(request.headers.get('cookie'));
  let owner: ShoppingOwnerRef | null = null;
  let currentToken: string | null = null;
  let issuedToken: string | null = null;
  let clearGuestCookies = false;

  if (buyer.kind === 'member') {
    owner = { kind: 'member', userId: buyer.userId };
    if (tokens.cartToken || tokens.wishlistToken) {
      const merged = await mergeGuestShoppingIntoMember(supabase, { userId: buyer.userId, ...tokens });
      clearGuestCookies = merged.ok;
    }
  } else {
    currentToken = kind === 'cart' ? tokens.cartToken : tokens.wishlistToken;
    if (currentToken) {
      owner = { kind: 'guest', tokenHash: await hashGuestShoppingToken(currentToken) };
    }
  }

  const context: ShoppingContext = {
    kind,
    owner,
    rateLimitSubject: subjectOf(owner),
    auditOwner: auditOwnerOf(owner),
    async findOwnerId() {
      return context.owner ? findOwnerRowId(supabase, tableOf(kind), context.owner) : null;
    },
    async ensureOwnerId() {
      if (!context.owner) {
        issuedToken = generateGuestShoppingToken();
        context.owner = { kind: 'guest', tokenHash: await hashGuestShoppingToken(issuedToken) };
        context.rateLimitSubject = subjectOf(context.owner);
        context.auditOwner = auditOwnerOf(context.owner);
      }
      return ensureOwnerRowId(supabase, tableOf(kind), context.owner);
    },
    finish(response) {
      if (clearGuestCookies) {
        clearGuestShoppingCookies(response);
      } else if (issuedToken) {
        setGuestShoppingCookie(response, kind, issuedToken);
      } else if (options.write && currentToken) {
        setGuestShoppingCookie(response, kind, currentToken);
      }
      return response;
    },
  };
  return { ok: true, context };
}

/** 決済の窓口が、確かめた買い手からカートを引く。Cookie は消さない（次のカートの読み込みが消す。本計画の決め事 P3） */
export async function findCartIdForBuyer(
  supabase: SupabaseClient,
  request: Request,
  buyer: CheckoutBuyer,
): Promise<string | null> {
  const tokens = readGuestShoppingTokens(request.headers.get('cookie'));
  if (buyer.kind === 'member') {
    if (tokens.cartToken || tokens.wishlistToken) {
      await mergeGuestShoppingIntoMember(supabase, { userId: buyer.userId, ...tokens });
    }
    return findOwnerRowId(supabase, 'carts', { kind: 'member', userId: buyer.userId });
  }
  if (!tokens.cartToken) {
    return null;
  }
  return findOwnerRowId(supabase, 'carts', { kind: 'guest', tokenHash: await hashGuestShoppingToken(tokens.cartToken) });
}

/** 会員の書き換えに CSRF の合言葉を求める（更新の印の無いゲストは素通り。決済の窓口と同じ） */
export async function denyIfCsrfInvalid(): Promise<NextResponse | null> {
  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const result = await requireCsrfOrDeny();
  if (result instanceof Response) {
    return result as NextResponse;
  }
  return null;
}
```

- [ ] **Step 8: 通ることを確かめる**

Run: `npx jest tests/unit/features/cart/services --runInBand` と `npx tsc --noEmit -p tsconfig.json`
Expected: PASS・型の誤り 0

- [ ] **Step 9: コミットする**

```bash
git add src/lib/cookie.ts src/features/cart/services/guest-shopping-token.ts src/features/cart/services/shopping-owner.repository.ts src/features/cart/services/guest-shopping-merge.ts src/features/cart/services/shopping-context.ts tests/unit/features/cart/services/guest-shopping-token.test.ts tests/unit/features/cart/services/guest-shopping-merge.test.ts tests/unit/features/cart/services/shopping-context.test.ts
git commit -m "feat(cart): ゲストの印と持ち主の決め方、ログインで合わせる部品を足す"
```

---

### Task 4: カートの窓口（Shopify の Ajax Cart API の形）

**Files:**
- Create: `src/features/cart/types/cart-json.ts`
- Create: `src/features/cart/services/cart-view.ts`
- Create: `src/features/cart/services/cart-errors.ts`
- Modify: `src/features/cart/services/cart-stock.ts:3,15-24`（送る中身の形）
- Modify: `src/app/api/cart/route.ts`（GET だけにする）
- Create: `src/app/api/cart/add/route.ts`、`src/app/api/cart/change/route.ts`
- Delete: `src/app/api/cart/[id]/route.ts`
- Delete: `tests/unit/api/cart/route.test.ts`、`tests/unit/api/cart/get-fulfillment.test.ts`、`tests/unit/api/cart/id-route.test.ts`、`tests/unit/api/cartRoute.test.ts`（消す窓口の試験）
- Test: `tests/unit/features/cart/services/cart-view.test.ts`、`tests/unit/api/cart/cart-get.test.ts`、`tests/unit/api/cart/cart-add.test.ts`、`tests/unit/api/cart/cart-change.test.ts`
- Modify: `tests/unit/middleware/proxy-origin.test.ts:47-85,160-186`（試験用の URL `/api/cart/1` を `/api/cart/change` に替える。Origin の確かめそのものは変えない）

**Interfaces:**
- Consumes: Task 1 の `cart_add_lines`・`cart_change_line`、Task 3 の `openShoppingContext`・`denyIfCsrfInvalid`、`previewFulfillment(client, lines)`（`src/features/checkout/services/checkout-fulfillment.service.ts`）、`signItemImageUrl(supabase, rawUrl)`、`enforceRateLimit`、`logAudit`、`createServiceRoleClient`
- Produces:
  - `src/features/cart/types/cart-json.ts`: `CART_OPTION_NAMES = { color: 'カラー', size: 'サイズ' } as const`、`type CartJsonLine`、`type CartJson`、`EMPTY_CART_JSON: CartJson`（画面とサーバーが共有。サーバー専用の import をしない）
  - `cart-view.ts`: `buildCartJson(supabase, cartId: string | null): Promise<CartJson>`
  - `cart-errors.ts`: `CART_ERROR_DESCRIPTIONS`、`cartErrorResponse(status, description): NextResponse`、`cartRpcErrorResponse(message: string): NextResponse | null`
  - `cart-stock.ts`: `MAX_CART_LINES = 50`、`addCartLinesSchema`、`changeCartLineSchema`（`addCartItemSchema`・`updateCartQuantitySchema` は消す）
  - 窓口: `GET /api/cart` → 200 `CartJson`、`POST /api/cart/add` → 200 `{ items: CartJsonLine[] }`、`POST /api/cart/change` → 200 `CartJson`

`CartJsonLine` の形（設計書 6-1）:

```ts
// src/features/cart/types/cart-json.ts
export const CART_OPTION_NAMES = { color: 'カラー', size: 'サイズ' } as const;

export type CartJsonLine = {
  key: string;
  id: number;
  variant_id: number;
  product_id: number;
  quantity: number;
  title: string;
  product_title: string;
  variant_title: string | null;
  options_with_values: Array<{ name: string; value: string }>;
  price: number;
  line_price: number;
  image: string | null;
  url: string;
  fulfillment: 'stock' | 'backorder' | null;
};

export type CartJson = {
  item_count: number;
  currency: 'JPY';
  items_subtotal_price: number;
  total_price: number;
  items: CartJsonLine[];
};

export const EMPTY_CART_JSON: CartJson = {
  item_count: 0,
  currency: 'JPY',
  items_subtotal_price: 0,
  total_price: 0,
  items: [],
};
```

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/features/cart/services/cart-view.test.ts`:

```ts
import { buildCartJson } from '@/features/cart/services/cart-view';
import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';

jest.mock('@/features/checkout/services/checkout-fulfillment.service', () => ({ previewFulfillment: jest.fn() }));
jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: jest.fn(async (_s: unknown, url: string) => `${url}?signed`) }));

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    quantity: 2,
    added_at: '2026-10-08T00:00:00Z',
    item_variants: {
      id: 1201,
      item_id: 45,
      is_active: true,
      item_colors: { name: 'ブラック' },
      item_sizes: { label: 'M' },
      items: { id: 45, name: 'リネンシャツ', price: 12000, image_url: 'items/45.png', status: 'published' },
    },
    ...overrides,
  };
}

function supabaseWith(rows: unknown[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: rows, error: null }),
  };
  return { from: jest.fn().mockReturnValue(query), rpc: jest.fn() } as never;
}

describe('buildCartJson', () => {
  beforeEach(() => (previewFulfillment as jest.Mock).mockResolvedValue([{ lineNo: 1, fulfillment: 'stock' }]));

  test('持ち主が無ければ空のカート', async () => {
    const supabase = supabaseWith([]);
    await expect(buildCartJson(supabase, null)).resolves.toEqual({ item_count: 0, currency: 'JPY', items_subtotal_price: 0, total_price: 0, items: [] });
  });

  test('Shopify の /cart.js の形で返し、印は返さない', async () => {
    const cart = await buildCartJson(supabaseWith([line()]), 'cart-1');
    expect(cart).toEqual({
      item_count: 2,
      currency: 'JPY',
      items_subtotal_price: 24000,
      total_price: 24000,
      items: [{
        key: 'line-1',
        id: 1201,
        variant_id: 1201,
        product_id: 45,
        quantity: 2,
        title: 'リネンシャツ - ブラック / M',
        product_title: 'リネンシャツ',
        variant_title: 'ブラック / M',
        options_with_values: [{ name: 'カラー', value: 'ブラック' }, { name: 'サイズ', value: 'M' }],
        price: 12000,
        line_price: 24000,
        image: 'items/45.png?signed',
        url: '/item/45',
        fulfillment: 'stock',
      }],
    });
    expect(JSON.stringify(cart)).not.toContain('token');
  });

  test('色・サイズの無いバリアントは題名が商品名だけ', async () => {
    const plain = line({ item_variants: { ...line().item_variants, item_colors: null, item_sizes: null } });
    const cart = await buildCartJson(supabaseWith([plain]), 'cart-1');
    expect(cart.items[0]).toMatchObject({ title: 'リネンシャツ', variant_title: null, options_with_values: [] });
  });

  test('非公開の商品と取り扱い終了のバリアントは出さず、数にも入れない', async () => {
    const hidden = line({ id: 'line-2', item_variants: { ...line().item_variants, items: { ...line().item_variants.items, status: 'private' } } });
    const inactive = line({ id: 'line-3', item_variants: { ...line().item_variants, id: 1300, is_active: false } });
    const cart = await buildCartJson(supabaseWith([line(), hidden, inactive]), 'cart-1');
    expect(cart.items.map((item) => item.key)).toEqual(['line-1']);
    expect(cart.item_count).toBe(2);
  });

  test('お届けの目安が読めなくてもカートは返す', async () => {
    (previewFulfillment as jest.Mock).mockRejectedValueOnce(new Error('rpc down'));
    const cart = await buildCartJson(supabaseWith([line()]), 'cart-1');
    expect(cart.items[0].fulfillment).toBeNull();
  });
});
```

`tests/unit/api/cart/cart-get.test.ts`・`cart-add.test.ts`・`cart-change.test.ts` は、`@/features/cart/services/shopping-context` の `openShoppingContext`・`denyIfCsrfInvalid`、`@/features/cart/services/cart-view` の `buildCartJson`、`@/lib/supabase/server` の `createServiceRoleClient`、`@/features/auth/middleware/rateLimit` の `enforceRateLimit`、`@/lib/audit` の `logAudit` を `jest.mock` で差し替え、次を確かめる。共通の作り方:

```ts
import { NextRequest, NextResponse } from 'next/server';

const context = {
  kind: 'cart',
  owner: { kind: 'guest', tokenHash: 'f'.repeat(64) },
  rateLimitSubject: `guest:${'f'.repeat(64)}`,
  auditOwner: { owner: 'guest', guest_token_hash_prefix: 'ffffffffffff' },
  findOwnerId: jest.fn().mockResolvedValue('cart-1'),
  ensureOwnerId: jest.fn().mockResolvedValue('cart-1'),
  finish: jest.fn((res: NextResponse) => res),
};

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
```

`cart-get.test.ts`:
- `openShoppingContext` が `{ ok: false, response: 401 }` なら、その応答をそのまま返す
- 持ち主の行が無い（`findOwnerId` が `null`）なら `buildCartJson(supabase, null)` を呼び、200 で返す。`finish` を通す
- `buildCartJson` が投げたら 500 `{ status: 500, message: 'Cart Error', description: 'カートを更新できませんでした。時間をおいてもう一度お試しください。' }`

`cart-add.test.ts`:
- IP の回数の制限（`cart:add`・60・60）が 429 を返したら、それを返し、持ち主を決めない
- CSRF の確かめ（`denyIfCsrfInvalid`）が 403 を返したら、それを返す
- 持ち主ごとの制限は `subject: context.rateLimitSubject`（30・60）。印の無いゲスト（`rateLimitSubject: null`）では呼ばない
- 送る中身が `{ items: [] }`・`{ items: [{ id: 1, quantity: 0 }] }`・`{ items: [{ id: '1', quantity: 1 }] }`・11件・壊れた JSON は 400 `送った内容を確認できませんでした。`、DB を呼ばない
- 正しい時は `ensureOwnerId()` の後に `supabase.rpc('cart_add_lines', { _cart_id: 'cart-1', _lines: [{ variant_id: 1201, quantity: 1 }] })` を呼び、200 `{ items: [<buildCartJson の中で variant_id が 1201 の明細>] }` を返し、`finish` を通す
- RPC の断り `CART_LINE_QUANTITY_LIMIT`・`CART_LINE_LIMIT` は 422、`CART_VARIANT_UNAVAILABLE` は 404、知らない失敗は 500。どれも Shopify の形で、文言は Global Constraints のとおり
- 監査 `cart.add` に `context.auditOwner` の中身と `variant_ids` を入れ、印を入れない

`cart-change.test.ts`:
- 送る中身が `{ id: 'not-uuid', quantity: 1 }`・`{ id: <uuid>, quantity: 21 }`・`{ id: <uuid>, quantity: -1 }` は 400
- 持ち主の行が無い時は 404 `カートの商品が見つかりません。ページを読み込み直してください。`（DB の関数を呼ばない）
- 正しい時は `supabase.rpc('cart_change_line', { _cart_id: 'cart-1', _line_id: <uuid>, _quantity: 0 })` を呼び、200 で `buildCartJson(supabase, 'cart-1')` の中身を返す
- RPC の断り `CART_LINE_NOT_FOUND` は 404、`CART_LINE_QUANTITY_LIMIT` は 422
- IP の制限は `cart:change`・120・60、持ち主ごとは 60・60

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/features/cart/services/cart-view.test.ts tests/unit/api/cart --runInBand`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 送る中身の形を替える**

`src/features/cart/services/cart-stock.ts` の `addCartItemSchema`・`updateCartQuantitySchema`（:15-24）を消し、次に替える（`cartVariantSchema`・`CART_VARIANT_PATTERN` は使う所が無くなれば消す）。

```ts
export const MAX_CART_LINES = 50;

/** POST /api/cart/add（Shopify の /cart/add.js と同じく、バリアントの番号と数量で足す） */
export const addCartLinesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            quantity: z.number().int().min(1).max(MAX_CART_ITEM_QUANTITY),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

/** POST /api/cart/change（Shopify の /cart/change.js と同じく、明細の key と数量。0 で削除） */
export const changeCartLineSchema = z
  .object({
    id: z.string().uuid(),
    quantity: z.number().int().min(0).max(MAX_CART_ITEM_QUANTITY),
  })
  .strict();
```

- [ ] **Step 4: 断りの部品を書く**

`src/features/cart/services/cart-errors.ts`:

```ts
import { NextResponse } from 'next/server';

export const CART_ERROR_DESCRIPTIONS = {
  quantityLimit: '1つの商品は20個までです。',
  lineLimit: 'カートに入れられるのは50種類までです。',
  variantUnavailable: '選んだ色・サイズは現在お求めいただけません。',
  lineNotFound: 'カートの商品が見つかりません。ページを読み込み直してください。',
  invalidRequest: '送った内容を確認できませんでした。',
  failed: 'カートを更新できませんでした。時間をおいてもう一度お試しください。',
} as const;

/** Shopify の Ajax Cart API と同じ断りの形（設計書 6-1） */
export function cartErrorResponse(status: 400 | 404 | 422 | 500, description: string): NextResponse {
  return NextResponse.json({ status, message: 'Cart Error', description }, { status });
}

/** DB の関数の断り（RAISE EXCEPTION の文）を窓口の断りに直す。知らない失敗は null（呼び出し側が 500 にする） */
export function cartRpcErrorResponse(message: string): NextResponse | null {
  if (message.startsWith('CART_LINE_QUANTITY_LIMIT')) return cartErrorResponse(422, CART_ERROR_DESCRIPTIONS.quantityLimit);
  if (message.startsWith('CART_LINE_LIMIT')) return cartErrorResponse(422, CART_ERROR_DESCRIPTIONS.lineLimit);
  if (message.startsWith('CART_VARIANT_UNAVAILABLE')) return cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.variantUnavailable);
  if (message.startsWith('CART_LINE_NOT_FOUND')) return cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.lineNotFound);
  if (message.startsWith('CART_INVALID_INPUT')) return cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest);
  return null;
}
```

- [ ] **Step 5: カート全体を組み立てる部品を書く**

`src/features/cart/services/cart-view.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { CART_OPTION_NAMES, EMPTY_CART_JSON, type CartJson, type CartJsonLine } from '@/features/cart/types/cart-json';

type CartLineRow = {
  id: string;
  quantity: number;
  added_at: string;
  item_variants: {
    id: number;
    item_id: number;
    is_active: boolean;
    item_colors: { name: string } | null;
    item_sizes: { label: string } | null;
    items: { id: number; name: string; price: number; image_url: string | null; status: string } | null;
  } | null;
};

/**
 * カート全体を Shopify の /cart.js と同じ形で組み立てる（設計書 6-1）。印 token は返さない。
 * 非公開の商品と取り扱い終了のバリアントの明細は出さない（本計画の決め事 P14）。並びは入れた日時の新しい順。
 */
export async function buildCartJson(supabase: SupabaseClient, cartId: string | null): Promise<CartJson> {
  if (!cartId) {
    return { ...EMPTY_CART_JSON, items: [] };
  }

  const { data, error } = await supabase
    .from('cart_lines')
    .select('id, quantity, added_at, item_variants(id, item_id, is_active, item_colors(name), item_sizes(label), items(id, name, price, image_url, status))')
    .eq('cart_id', cartId)
    .order('added_at', { ascending: false });
  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as unknown as CartLineRow[]).filter(
    (row) => row.item_variants?.is_active === true && row.item_variants.items?.status === 'published',
  );

  let fulfillments: Array<'stock' | 'backorder' | null> = rows.map(() => null);
  try {
    const preview = await previewFulfillment(
      supabase,
      rows.map((row) => ({
        item_id: Number(row.item_variants!.item_id),
        color: row.item_variants!.item_colors?.name ?? null,
        size: row.item_variants!.item_sizes?.label ?? null,
        quantity: row.quantity,
      })),
    );
    fulfillments = rows.map((_, index) => preview.find((line) => line.lineNo === index + 1)?.fulfillment ?? null);
  } catch (previewError) {
    console.error('Failed to preview cart fulfillment:', previewError);
  }

  const items: CartJsonLine[] = await Promise.all(
    rows.map(async (row, index) => {
      const variant = row.item_variants!;
      const item = variant.items!;
      const color = variant.item_colors?.name ?? null;
      const size = variant.item_sizes?.label ?? null;
      const variantTitle = [color, size].filter((value): value is string => Boolean(value)).join(' / ') || null;
      const options = [
        color ? { name: CART_OPTION_NAMES.color, value: color } : null,
        size ? { name: CART_OPTION_NAMES.size, value: size } : null,
      ].filter((option): option is { name: string; value: string } => option !== null);
      return {
        key: row.id,
        id: Number(variant.id),
        variant_id: Number(variant.id),
        product_id: Number(item.id),
        quantity: row.quantity,
        title: variantTitle ? `${item.name} - ${variantTitle}` : item.name,
        product_title: item.name,
        variant_title: variantTitle,
        options_with_values: options,
        price: item.price,
        line_price: item.price * row.quantity,
        image: (await signItemImageUrl(supabase, item.image_url)) ?? item.image_url,
        url: `/item/${item.id}`,
        fulfillment: fulfillments[index],
      };
    }),
  );

  const subtotal = items.reduce((sum, line) => sum + line.line_price, 0);
  return {
    item_count: items.reduce((sum, line) => sum + line.quantity, 0),
    currency: 'JPY',
    items_subtotal_price: subtotal,
    total_price: subtotal,
    items,
  };
}
```

- [ ] **Step 6: 3つの窓口を書く**

`src/app/api/cart/route.ts` の全体を次に替える。

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。持ち主は cart Cookie の印（ゲスト）か
// 確かめた会員の ID で決める（設計書第4章）。

/** GET /api/cart（Shopify の /cart.js と同じ形。設計書 6-1） */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: false });
    if (!opened.ok) {
      return opened.response;
    }
    const cart = await buildCartJson(supabase, await opened.context.findOwnerId());
    return opened.context.finish(NextResponse.json(cart, { headers: { 'Cache-Control': 'no-store' } }));
  } catch (error) {
    console.error('Cart GET error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
```

`src/app/api/cart/add/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { addCartLinesSchema } from '@/features/cart/services/cart-stock';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse, cartRpcErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。会員には CSRF の合言葉を求め、
// 送信元（Origin）の確かめは src/proxy.ts が掛ける。

function clientIpOf(req: NextRequest): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
}

/** POST /api/cart/add（Shopify の /cart/add.js。設計書 6-1） */
export async function POST(req: NextRequest) {
  const clientIp = clientIpOf(req);
  const userAgent = req.headers.get('user-agent');
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const byIp = await enforceRateLimit({ request: req, endpoint: 'cart:add', limit: 60, windowSeconds: 60 });
    if (byIp) return byIp;

    const csrfDenied = await denyIfCsrfInvalid();
    if (csrfDenied) return csrfDenied;

    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: true });
    if (!opened.ok) return opened.response;
    const { context } = opened;

    if (context.rateLimitSubject) {
      const byOwner = await enforceRateLimit({ request: req, endpoint: 'cart:add', limit: 30, windowSeconds: 60, subject: context.rateLimitSubject });
      if (byOwner) return byOwner;
    }

    const parsed = addCartLinesSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return context.finish(cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest));
    }
    const lines = parsed.data.items.map((line) => ({ variant_id: line.id, quantity: line.quantity }));

    const cartId = await context.ensureOwnerId();
    const { error } = await supabase.rpc('cart_add_lines', { _cart_id: cartId, _lines: lines });
    if (error) {
      const mapped = cartRpcErrorResponse(error.message ?? '');
      await logAudit({
        action: 'cart.add',
        outcome: mapped ? 'failure' : 'error',
        detail: error.message ?? 'cart_add_lines failed',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, variant_ids: lines.map((line) => line.variant_id) },
      });
      return context.finish(mapped ?? cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed));
    }

    const cart = await buildCartJson(supabase, cartId);
    const added = new Set(lines.map((line) => line.variant_id));
    await logAudit({
      action: 'cart.add',
      outcome: 'success',
      resource: 'cart_lines',
      ip: clientIp,
      user_agent: userAgent,
      metadata: { ...context.auditOwner, variant_ids: [...added], quantities: lines.map((line) => line.quantity) },
    });
    return context.finish(NextResponse.json({ items: cart.items.filter((line) => added.has(line.variant_id)) }));
  } catch (error) {
    console.error('Cart add error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
```

`src/app/api/cart/change/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { changeCartLineSchema } from '@/features/cart/services/cart-stock';
import { denyIfCsrfInvalid, openShoppingContext } from '@/features/cart/services/shopping-context';
import { buildCartJson } from '@/features/cart/services/cart-view';
import { CART_ERROR_DESCRIPTIONS, cartErrorResponse, cartRpcErrorResponse } from '@/features/cart/services/cart-errors';

// PUBLIC: ゲストのカートを扱うので利用者認証は無い。明細は持ち主のカートの物だけを変えられる（DB の関数が照合する）。

function clientIpOf(req: NextRequest): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip');
}

/** POST /api/cart/change（Shopify の /cart/change.js。数量0で削除。設計書 6-1） */
export async function POST(req: NextRequest) {
  const clientIp = clientIpOf(req);
  const userAgent = req.headers.get('user-agent');
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const byIp = await enforceRateLimit({ request: req, endpoint: 'cart:change', limit: 120, windowSeconds: 60 });
    if (byIp) return byIp;

    const csrfDenied = await denyIfCsrfInvalid();
    if (csrfDenied) return csrfDenied;

    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, 'cart', supabase, { write: true });
    if (!opened.ok) return opened.response;
    const { context } = opened;

    if (context.rateLimitSubject) {
      const byOwner = await enforceRateLimit({ request: req, endpoint: 'cart:change', limit: 60, windowSeconds: 60, subject: context.rateLimitSubject });
      if (byOwner) return byOwner;
    }

    const parsed = changeCartLineSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return context.finish(cartErrorResponse(400, CART_ERROR_DESCRIPTIONS.invalidRequest));
    }

    const cartId = await context.findOwnerId();
    if (!cartId) {
      return context.finish(cartErrorResponse(404, CART_ERROR_DESCRIPTIONS.lineNotFound));
    }

    const { error } = await supabase.rpc('cart_change_line', {
      _cart_id: cartId,
      _line_id: parsed.data.id,
      _quantity: parsed.data.quantity,
    });
    if (error) {
      const mapped = cartRpcErrorResponse(error.message ?? '');
      await logAudit({
        action: 'cart.change',
        outcome: mapped ? 'failure' : 'error',
        detail: error.message ?? 'cart_change_line failed',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, line_id: parsed.data.id, quantity: parsed.data.quantity },
      });
      return context.finish(mapped ?? cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed));
    }

    await logAudit({
      action: 'cart.change',
      outcome: 'success',
      resource: 'cart_lines',
      resource_id: parsed.data.id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: { ...context.auditOwner, quantity: parsed.data.quantity },
    });
    return context.finish(NextResponse.json(await buildCartJson(supabase, cartId)));
  } catch (error) {
    console.error('Cart change error:', error);
    return cartErrorResponse(500, CART_ERROR_DESCRIPTIONS.failed);
  }
}
```

`git rm src/app/api/cart/[id]/route.ts tests/unit/api/cart/route.test.ts tests/unit/api/cart/get-fulfillment.test.ts tests/unit/api/cart/id-route.test.ts tests/unit/api/cartRoute.test.ts` で古い窓口と試験を消す。`tests/unit/middleware/proxy-origin.test.ts` の `/api/cart/1` を `/api/cart/change` に替える。

- [ ] **Step 7: 通ることを確かめる**

Run: `npx jest tests/unit/features/cart tests/unit/api/cart tests/unit/middleware/proxy-origin.test.ts --runInBand` と `npx tsc --noEmit -p tsconfig.json`
Expected: PASS。型の誤りは、Task 7・8 で直す呼び出し元（`addCartItemSchema` を使う画面・決済）以外に無い。残る型の誤りの一覧を報告に書く（このタスクでは画面と決済を直さない）

- [ ] **Step 8: コミットする**

pre-commit の型の確かめが通らない時は、Task 7・8 と同じコミットにまとめる判断を controller がする（台帳に Ruling を書く）。

```bash
git add src/features/cart/types/cart-json.ts src/features/cart/services/cart-view.ts src/features/cart/services/cart-errors.ts src/features/cart/services/cart-stock.ts src/app/api/cart/route.ts src/app/api/cart/add/route.ts src/app/api/cart/change/route.ts tests/unit/features/cart/services/cart-view.test.ts tests/unit/api/cart/cart-get.test.ts tests/unit/api/cart/cart-add.test.ts tests/unit/api/cart/cart-change.test.ts tests/unit/middleware/proxy-origin.test.ts
git commit -m "feat(cart): カートの窓口を Shopify の Ajax Cart API の形（cart・add・change）に作り直す"
```

---

### Task 5: お気に入りの窓口

**Files:**
- Modify: `src/app/api/wishlist/route.ts`（GET・POST）
- Modify: `src/app/api/wishlist/[id]/route.ts`（DELETE）
- Test: `tests/unit/api/wishlist-route.test.ts`（新規）、`tests/unit/api/wishlist-id-route.test.ts`（書き直し）

**Interfaces:**
- Consumes: Task 1 の `wishlists`・`wishlist_lines`、Task 3 の `openShoppingContext(req, 'wishlist', …)`・`denyIfCsrfInvalid`
- Produces:
  - `GET /api/wishlist` → 200 `Array<{ id: string; item_id: number; added_at: string; items: { id; name; price; image_url; category; colors; sizes }; variants: Array<{ id: number; color: string | null; size: string | null }> }>`（公開中の商品だけ。`variants` は販売中のバリアントだけ。本計画の決め事 P11）
  - `POST /api/wishlist` `{ item_id: 正の整数 }` → 201 `{ id, item_id, added_at }`、同じ商品が既にあれば 409 `{ error: 'Already in wishlist' }`（今と同じ）、非公開・無い商品は 404 `{ error: 'Item not found' }`
  - `DELETE /api/wishlist/[id]` → 200 `{ success: true }`、持ち主の明細でなければ 404

今の2つのファイルの形（回数の制限・送る中身の確かめ・監査・画像の署名・返す中身）は残し、次だけを替える。

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/api/wishlist-route.test.ts`（`openShoppingContext`・`denyIfCsrfInvalid`・`createServiceRoleClient`・`enforceRateLimit`・`logAudit` を差し替える。共通の作り方は Task 4 の `context` と同じで、`kind: 'wishlist'`）:
- GET: 持ち主の行が無ければ 200 `[]`。ある時は `wishlist_lines` を `wishlist_id` で読み、公開中の商品だけを今と同じ形で返し、各行に `variants`（`is_active` のバリアントの `{ id, color, size }`）を足す
- GET の回数の制限は `wishlist:get` の IP 120・60、持ち主ごと 60・60（印の無いゲストは IP だけ）
- POST: `denyIfCsrfInvalid` の 403 を返す。`{ item_id: 0 }`・`{ item_id: 'x' }`・壊れた JSON は 400。公開中でない商品は 404。正しい時は `ensureOwnerId()` の後に `wishlist_lines` へ入れ、201。同じ商品（一意の決まりの `23505`）は 409。`finish` を通す
- DELETE（`tests/unit/api/wishlist-id-route.test.ts`）: UUID でない番号は 400。持ち主の行が無い・`wishlist_lines` の `id` と `wishlist_id` が合う行が無い時は 404。合えば消して 200 `{ success: true }`。消す問い合わせが必ず `wishlist_id` の条件を持つ（他人の明細を消せない）

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/api/wishlist-route.test.ts tests/unit/api/wishlist-id-route.test.ts --runInBand`
Expected: FAIL

- [ ] **Step 3: 窓口を直す**

`src/app/api/wishlist/route.ts`:
1. `session_id` の Cookie を読む所（:31-38、:160-167）と、`createClient()`（RLS の文脈を作るリクエストのクライアント）を、`const supabase = await createServiceRoleClient();` と `openShoppingContext(req, 'wishlist', supabase, { write })`（GET は `write: false`、POST は `write: true`）に替える。`opened.ok` が `false` なら `opened.response` を返す
2. 回数の制限の `subject: sessionId` を `subject: context.rateLimitSubject` にし、`rateLimitSubject` が `null` の時は持ち主ごとの制限を呼ばない
3. GET の読み込み（:91-94）を次に替える

```ts
const wishlistId = await context.findOwnerId();
if (!wishlistId) {
  return context.finish(NextResponse.json([]));
}
const { data: wishlistData, error: wishlistError } = await supabase
  .from('wishlist_lines')
  .select('id, item_id, added_at')
  .eq('wishlist_id', wishlistId)
  .order('added_at', { ascending: false });
```

4. GET の商品の読み込みの後で、公開中の商品の販売中のバリアントを読み、各行に `variants` を足す

```ts
const { data: variantRows, error: variantError } = await supabase
  .from('item_variants')
  .select('id, item_id, is_active, item_colors(name), item_sizes(label)')
  .in('item_id', itemIds)
  .eq('is_active', true);
if (variantError) {
  throw variantError;
}
const variantsByItem = new Map<number, Array<{ id: number; color: string | null; size: string | null }>>();
for (const row of (variantRows ?? []) as unknown as Array<{ id: number; item_id: number; item_colors: { name: string } | null; item_sizes: { label: string } | null }>) {
  const list = variantsByItem.get(Number(row.item_id)) ?? [];
  list.push({ id: Number(row.id), color: row.item_colors?.name ?? null, size: row.item_sizes?.label ?? null });
  variantsByItem.set(Number(row.item_id), list);
}
// 返す各行: { ...row, items: <今と同じ>, variants: variantsByItem.get(row.item_id) ?? [] }
```

5. POST の書き込み（:247-251）を次に替える。監査の `metadata.session_id` は `...context.auditOwner` に替える

```ts
const wishlistId = await context.ensureOwnerId();
const { data: inserted, error: insertError } = await supabase
  .from('wishlist_lines')
  .insert({ wishlist_id: wishlistId, item_id })
  .select('id, item_id, added_at')
  .single();
```

6. 応答は全部 `context.finish(...)` を通す（POST はゲストの Cookie の寿命を延ばし、印の無いゲストに新しい印を付ける）

`src/app/api/wishlist/[id]/route.ts`:
1. `session_id` を読む所（:27-36）を `createServiceRoleClient()` と `openShoppingContext(req, 'wishlist', supabase, { write: true })` に替え、`denyIfCsrfInvalid()` を回数の制限の後に足す
2. 消す問い合わせ（:78-112）を次に替える（今は `id` だけで消しており、持ち主の確かめを RLS に頼っている）

```ts
const wishlistId = await context.findOwnerId();
if (!wishlistId) {
  return context.finish(NextResponse.json({ error: 'Wishlist item not found' }, { status: 404 }));
}
const { data: deleted, error: deleteError } = await supabase
  .from('wishlist_lines')
  .delete()
  .eq('id', id)
  .eq('wishlist_id', wishlistId)
  .select('id');
if (deleteError) {
  throw deleteError;
}
if (!deleted || deleted.length === 0) {
  return context.finish(NextResponse.json({ error: 'Wishlist item not found' }, { status: 404 }));
}
return context.finish(NextResponse.json({ success: true }));
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx jest tests/unit/api/wishlist-route.test.ts tests/unit/api/wishlist-id-route.test.ts tests/unit/lib/supabase-client-expired-token.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/app/api/wishlist/route.ts "src/app/api/wishlist/[id]/route.ts" tests/unit/api/wishlist-route.test.ts tests/unit/api/wishlist-id-route.test.ts
git commit -m "feat(wishlist): お気に入りを持ち主の表で読み書きし、カートに入れるためのバリアントを返す"
```

---

### Task 6: ログインで合わせる・ログアウトで消す

**Files:**
- Modify: `src/features/auth/services/register.ts:4-17,137`（`persistSessionAndCookies` の引数と最後）
- Modify: `src/app/api/auth/otp/verify/route.ts:101-102`、`src/app/api/auth/oauth/callback/route.ts:159-160`、`src/app/api/auth/confirm/route.ts:78-79`、`src/app/api/auth/register/route.ts:186-187`
- Modify: `src/app/api/auth/logout/route.ts:134-158`
- Test: `tests/unit/services/register.test.ts`（足す）、`tests/unit/api/auth/logout-guest-shopping.test.ts`（新規）

**Interfaces:**
- Consumes: Task 3 の `readGuestShoppingTokens`・`clearGuestShoppingCookies`・`mergeGuestShoppingIntoMember`、`cartCookieName`・`wishlistCookieName`
- Produces: `persistSessionAndCookies(res, session, user, guestShopping?: GuestShoppingTokens)`。全部の Cookie とセッションの保存が済んだ後で、印があれば合わせ、成功したら `cart`・`wishlist` の Cookie を消す。合わせるのに失敗しても `{ ok: true }` を返す

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/services/register.test.ts` に足す（今の Cookie の部品の差し替えはそのまま使い、`@/features/cart/services/guest-shopping-merge` を `jest.mock` する）:

```ts
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';

jest.mock('@/features/cart/services/guest-shopping-merge', () => ({ mergeGuestShoppingIntoMember: jest.fn() }));

test('ゲストの印があれば、ログインの Cookie を付けた後に合わせ、成功したら cart と wishlist の Cookie を消す', async () => {
  (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 1, cartLinesDropped: 0, wishlistLinesMoved: 0 });
  const res = NextResponse.json({});
  const result = await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });
  expect(result).toEqual({ ok: true });
  expect(mergeGuestShoppingIntoMember).toHaveBeenCalledWith(expect.anything(), { userId: user.id, cartToken: 'c'.repeat(43), wishlistToken: null });
  expect(res.cookies.get('cart')?.value).toBe('');
  expect(res.cookies.get('wishlist')?.value).toBe('');
});

test('合わせるのに失敗してもログインは成功し、Cookie を残す', async () => {
  (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: false });
  const res = NextResponse.json({});
  const result = await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });
  expect(result).toEqual({ ok: true });
  expect(res.cookies.get('cart')).toBeUndefined();
});

test('印が無ければ合わせない', async () => {
  const res = NextResponse.json({});
  await persistSessionAndCookies(res, session, user, { cartToken: null, wishlistToken: null });
  await persistSessionAndCookies(NextResponse.json({}), session, user);
  expect(mergeGuestShoppingIntoMember).not.toHaveBeenCalled();
});
```

（`session`・`user` は今の試験ファイルの成功の試験と同じ値を使う。）

`tests/unit/api/auth/logout-guest-shopping.test.ts`: `src/app/api/auth/logout/route.ts` の `POST` を、今の logout の単体試験（`tests/unit/components/LoginContext.test.tsx` ではなくサーバーの窓口）と同じ差し替え（`next/headers` の `cookies`・`headers`、CSRF、DB）で呼び、応答が `cart` と `wishlist` の Cookie を `value: ''`・`maxAge: 0` で消すことを確かめる。窓口の試験が無ければ、`next/headers` を `jest.mock` して `cookies()` が `{ get: () => undefined, getAll: () => [] }` を返し、CSRF の確かめ（`verifyAndRotateCsrf` など、ファイルが使う物）を素通りにして呼ぶ。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/services/register.test.ts tests/unit/api/auth/logout-guest-shopping.test.ts --runInBand`
Expected: FAIL

- [ ] **Step 3: ログインの共通の関数に合わせる処理を足す**

`src/features/auth/services/register.ts`:
1. 引数に `guestShopping?: GuestShoppingTokens` を足す（型は `import type { GuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';`）
2. 最後の `return { ok: true };`（セッションの保存が済んだ後、:137 付近）の直前に次を足す

```ts
    // ゲストのカートとお気に入りを会員の分へ合わせる（設計書第5章）。ログインの Cookie とセッションを
    // 全部保存した後に呼ぶ。失敗してもログインは止めず、Cookie を残して次の要求で合わせ直す。
    if (guestShopping && (guestShopping.cartToken || guestShopping.wishlistToken)) {
      const { mergeGuestShoppingIntoMember } = await import('@/features/cart/services/guest-shopping-merge');
      const merged = await mergeGuestShoppingIntoMember(service, { userId: user.id, ...guestShopping });
      if (merged.ok) {
        const { clearGuestShoppingCookies } = await import('@/features/cart/services/guest-shopping-token');
        clearGuestShoppingCookies(res);
      }
    }
```

（`service` は関数の中で作っている `createServiceRoleClient()` の戻り値。名前が違えばファイルの名前に合わせる。）

入口4か所の呼び出しを次の形にする（引数名はファイルに合わせる。4か所とも `request: Request` を持つ）。

```ts
const { readGuestShoppingTokens } = await import('@/features/cart/services/guest-shopping-token');
const persistResult = await persistSessionAndCookies(res, data.session, data.user, readGuestShoppingTokens(request.headers.get('cookie')));
```

- [ ] **Step 4: ログアウトで消す**

`src/app/api/auth/logout/route.ts:134-158` の import に `cartCookieName`・`wishlistCookieName` を足し、消す Cookie の並び（:149-156）に2つを足す。

```ts
    // この端末のゲストのカート・お気に入りの印も消す。会員の分はサーバーに残り、次のログインで戻る（設計書 4-3）
    for (const name of [
      sessionCookieName,
      refreshCookieName,
      accessCookieName,
      csrfCookieName,
      loginTwoFactorSessionCookieName,
      passwordResetSessionCookieName,
      cartCookieName,
      wishlistCookieName,
    ]) {
      res.cookies.set({ name, value: '', ...clearCookieOptions() });
    }
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx jest tests/unit/services/register.test.ts tests/unit/api/auth --runInBand` と `npx tsc --noEmit -p tsconfig.json`
Expected: PASS（既存の auth の試験も含む）

- [ ] **Step 6: コミットする**

```bash
git add src/features/auth/services/register.ts src/app/api/auth/otp/verify/route.ts src/app/api/auth/oauth/callback/route.ts src/app/api/auth/confirm/route.ts src/app/api/auth/register/route.ts src/app/api/auth/logout/route.ts tests/unit/services/register.test.ts tests/unit/api/auth/logout-guest-shopping.test.ts
git commit -m "feat(auth): ログインでゲストのカートとお気に入りを合わせ、ログアウトでこの端末の印を消す"
```

---

### Task 7: 決済のつなぎ

**Files:**
- Modify: `src/features/checkout/services/checkout-draft.service.ts:135-161`（型）
- Modify: `src/features/checkout/services/checkout-cart.service.ts`（全体）
- Modify: `src/features/cart/services/cart-stock.ts:26-29,59-92`（取り扱い終了のバリアント）
- Modify: `src/app/api/checkout/create-session/route.ts:182-202,372-409,566-600,803-849`
- Modify: `src/app/api/checkout/promotion-code/route.ts:19-64`
- Modify: `source_cart_id` を使う所の全部（`grep -rn "source_cart_id" src tests` で見つける。`checkout-confirmation.service`・`place-order`・`resume` とその試験を含む）
- Test: `tests/unit/api/checkout/create-session-route.test.ts`、`tests/unit/api/checkout/promotion-code-route.test.ts`、`tests/unit/features/checkout/services/checkout-confirmation.service.test.ts`、`tests/unit/api/checkout/place-order-route.test.ts`、`tests/unit/api/checkout/resume-route.test.ts`、`tests/unit/features/checkout/services/checkout-cart.service.test.ts`（新規）、`collectInventoryIssues` の試験（`grep -rln "collectInventoryIssues" tests` のファイル）

**Interfaces:**
- Consumes: Task 2 の `claim_checkout_draft`（`_cart_id`）、Task 3 の `findCartIdForBuyer`、`resolveCheckoutBuyer`
- Produces:
  - `CheckoutCartSnapshotRow = { id: string; item_id: number; quantity: number; color: string | null; size: string | null; variant_id: number; variant_active: boolean }`（`id` は `cart_lines.id`）
  - `CheckoutDraftItemSnapshot` の `source_cart_id` を `source_cart_line_id: string` に替える
  - `readCheckoutCartRows(supabase, cartId: string): Promise<CheckoutCartSnapshotRow[]>`、`loadCheckoutCart(supabase, cartId: string | null): Promise<CheckoutCartLoad>`
  - `CartQuantityRow` に `variant_active?: boolean` を足す。`collectInventoryIssues` は `variant_active === false` の行の商品を `unavailable` に数える

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/features/checkout/services/checkout-cart.service.test.ts`（新規）:

```ts
import { loadCheckoutCart, readCheckoutCartRows } from '@/features/checkout/services/checkout-cart.service';

function supabaseWith(lines: unknown[], items: unknown[]) {
  const linesQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ data: lines, error: null }) };
  const itemsQuery = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: items, error: null }) };
  return { from: jest.fn((table: string) => (table === 'cart_lines' ? linesQuery : itemsQuery)) } as never;
}

const LINE = {
  id: 'line-1',
  quantity: 2,
  item_variants: { id: 1201, item_id: 45, is_active: true, item_colors: { name: 'ブラック' }, item_sizes: { label: 'M' } },
};
const ITEM = { id: 45, name: 'リネンシャツ', price: 12000, image_url: null, status: 'published' };

describe('checkout-cart.service', () => {
  test('明細をバリアントから下書き用の行にする', async () => {
    await expect(readCheckoutCartRows(supabaseWith([LINE], [ITEM]), 'cart-1')).resolves.toEqual([
      { id: 'line-1', item_id: 45, quantity: 2, color: 'ブラック', size: 'M', variant_id: 1201, variant_active: true },
    ]);
  });

  test('カートが無ければ空', async () => {
    await expect(loadCheckoutCart(supabaseWith([], []), null)).resolves.toEqual({ kind: 'empty' });
  });

  test('取り扱い終了のバリアントがあれば買えない', async () => {
    const inactive = { ...LINE, item_variants: { ...LINE.item_variants, is_active: false } };
    const result = await loadCheckoutCart(supabaseWith([inactive], [ITEM]), 'cart-1');
    expect(result.kind).toBe('unavailable');
  });
});
```

既存の試験の直し（どれも失敗を先に確かめる）:
- `tests/unit/api/checkout/create-session-route.test.ts`: 古い `carts` の問い合わせの差し替え（:150-177 ほか）を `findCartIdForBuyer`（`@/features/cart/services/shopping-context` を `jest.mock`）と `readCheckoutCartRows`（`@/features/checkout/services/checkout-cart.service` を `jest.mock`）の差し替えに替える。下書きを取る関数の引数の確かめ（:653-678）に `_cart_id: 'cart-1'` を足す。写しの `source_cart_id` を `source_cart_line_id` に替える。足す試験: カートが無い（`findCartIdForBuyer` が `null`）なら 400 `Cart is empty`、取り扱い終了のバリアントの行があれば 409 `out_of_stock`
- `tests/unit/api/checkout/promotion-code-route.test.ts:118`: `loadCheckoutCart(client, 'sess-abc')` を `loadCheckoutCart(client, 'cart-1')` に替え、`resolveCheckoutBuyer` と `findCartIdForBuyer` を差し替える。足す試験: `resolveCheckoutBuyer` が `expired` なら 401 `auth_expired`
- `checkout-confirmation.service.test.ts`・`place-order-route.test.ts`・`resume-route.test.ts`: `source_cart_id` を `source_cart_line_id` に替える（中身の確かめは変えない）
- `collectInventoryIssues` の試験: `variant_active: false` の行がある商品は、公開中でも `reason: 'unavailable'` になることを足す

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/api/checkout tests/unit/features/checkout --runInBand`
Expected: FAIL

- [ ] **Step 3: 型と在庫の確かめを直す**

`src/features/checkout/services/checkout-draft.service.ts`:

```ts
export type CheckoutCartSnapshotRow = {
  /** cart_lines.id */
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  variant_id: number;
  variant_active: boolean;
};

export type CheckoutDraftItemSnapshot = {
  /** 下書きを作った時のカートの明細（cart_lines.id）。「注文する」の「カートが変わった」と支払い後の削除に使う */
  source_cart_line_id: string;
  item_id: number;
  item_name: string;
  item_price: number;
  item_image_url: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  line_total: number;
};
```

`src/features/cart/services/cart-stock.ts` の `CartQuantityRow` と `collectInventoryIssues`:

```ts
export type CartQuantityRow = {
  item_id: number;
  quantity: number;
  /** 取り扱いを終えたバリアントの行は false。商品が公開中でも買えない（本計画の決め事 P14） */
  variant_active?: boolean;
};

export function collectInventoryIssues(
  cartRows: CartQuantityRow[],
  inventoryItems: InventoryItem[]
): InventoryIssue[] {
  const requestedQuantities = new Map<number, number>();
  const inactiveItemIds = new Set<number>();
  for (const cartRow of cartRows) {
    requestedQuantities.set(
      cartRow.item_id,
      (requestedQuantities.get(cartRow.item_id) ?? 0) + cartRow.quantity
    );
    if (cartRow.variant_active === false) {
      inactiveItemIds.add(cartRow.item_id);
    }
  }

  const inventoryItemMap = new Map<number, InventoryItem>(
    inventoryItems.map((item) => [item.id, item])
  );

  const issues: InventoryIssue[] = [];
  for (const [itemId, requestedQuantity] of requestedQuantities.entries()) {
    const item = inventoryItemMap.get(itemId);

    if (!item || item.status !== 'published' || inactiveItemIds.has(itemId)) {
      issues.push({
        item_id: itemId,
        name: item?.name ?? `商品 ${itemId}`,
        requestedQuantity,
        availableQuantity: null,
        reason: 'unavailable',
      });
      continue;
    }
  }

  return issues;
}
```

（関数の上のコメント「買えない商品（非公開・存在しない）」に「取り扱いを終えた色・サイズ」を足す。）

- [ ] **Step 4: カートの読み込みを持ち主の明細に替える**

`src/features/checkout/services/checkout-cart.service.ts` の全体:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInventoryConflictBody, collectInventoryIssues } from '@/features/cart/services/cart-stock';
import type {
  CheckoutCartSnapshotRow,
  CheckoutItemSnapshotRow,
} from '@/features/checkout/services/checkout-draft.service';
import {
  calculateCheckoutAmountsFromCartRows,
  type CheckoutDisplayedAmounts,
} from '@/features/checkout/services/checkout-pricing.service';

export type CheckoutCartLoad =
  | { kind: 'empty' }
  | { kind: 'unavailable'; body: ReturnType<typeof buildInventoryConflictBody> }
  | {
      kind: 'ok';
      cartRows: CheckoutCartSnapshotRow[];
      itemMap: Map<number, CheckoutItemSnapshotRow>;
      amounts: CheckoutDisplayedAmounts;
    };

type CartLineRow = {
  id: string;
  quantity: number;
  item_variants: {
    id: number;
    item_id: number;
    is_active: boolean;
    item_colors: { name: string } | null;
    item_sizes: { label: string } | null;
  } | null;
};

/** カートの明細を、下書きを作る行（商品・色・サイズの名前・数量）にする。色・サイズの名前はバリアントから引く */
export async function readCheckoutCartRows(supabase: SupabaseClient, cartId: string): Promise<CheckoutCartSnapshotRow[]> {
  const { data, error } = await supabase
    .from('cart_lines')
    .select('id, quantity, item_variants(id, item_id, is_active, item_colors(name), item_sizes(label))')
    .eq('cart_id', cartId);
  if (error) {
    throw error;
  }
  return ((data ?? []) as unknown as CartLineRow[])
    .filter((row) => row.item_variants !== null)
    .map((row) => ({
      id: row.id,
      item_id: Number(row.item_variants!.item_id),
      quantity: row.quantity,
      color: row.item_variants!.item_colors?.name ?? null,
      size: row.item_variants!.item_sizes?.label ?? null,
      variant_id: Number(row.item_variants!.id),
      variant_active: row.item_variants!.is_active,
    }));
}

/**
 * カートと、サーバーが計算した割引前の金額を読む（create-session と同じ読み方・同じ規則）。
 * 非公開・削除された商品、取り扱いを終えた色・サイズがあれば買えない（FREQ-401）。DB の失敗は投げる。
 */
export async function loadCheckoutCart(supabase: SupabaseClient, cartId: string | null): Promise<CheckoutCartLoad> {
  if (!cartId) {
    return { kind: 'empty' };
  }
  const cartRows = await readCheckoutCartRows(supabase, cartId);
  if (cartRows.length === 0) {
    return { kind: 'empty' };
  }

  const { data: itemsData, error: itemsError } = await supabase
    .from('items')
    .select('id, name, price, image_url, status')
    .in(
      'id',
      cartRows.map((row) => row.item_id),
    );
  if (itemsError) {
    throw itemsError;
  }

  const items = (itemsData ?? []) as CheckoutItemSnapshotRow[];
  const issues = collectInventoryIssues(cartRows, items);
  if (issues.length > 0) {
    return { kind: 'unavailable', body: buildInventoryConflictBody(issues, 'out_of_stock') };
  }

  const itemMap = new Map<number, CheckoutItemSnapshotRow>(items.map((item) => [item.id, item]));
  return { kind: 'ok', cartRows, itemMap, amounts: calculateCheckoutAmountsFromCartRows(cartRows, itemMap) };
}
```

（今の商品の読み込みは `.eq('status', 'published')` で非公開を落としてから `collectInventoryIssues` に渡していた。非公開も名前で案内するため、create-session と同じく状態で絞らずに読む。）

- [ ] **Step 5: create-session と割引コードの窓口を直す**

`src/app/api/checkout/create-session/route.ts`:
1. カートの読み込み（:566-600）を次に替える（`buyerResolution` は :503 で確かめた買い手。`supabase` はこのファイルの service role のクライアント）

```ts
    const { findCartIdForBuyer } = await import("@/features/cart/services/shopping-context");
    const { readCheckoutCartRows } = await import("@/features/checkout/services/checkout-cart.service");
    let cartId: string | null;
    let cartData: CheckoutCartSnapshotRow[];
    try {
      cartId = await findCartIdForBuyer(supabase, req, buyerResolution);
      cartData = cartId ? await readCheckoutCartRows(supabase, cartId) : [];
    } catch (cartError) {
      console.error("Failed to fetch cart for checkout session:", cartError);
      await logAudit({
        action: "checkout.session.create",
        outcome: "error",
        detail: "Failed to fetch cart",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          error_message: cartError instanceof Error ? cartError.message : null,
        },
      });
      return NextResponse.json({ error: "Failed to fetch cart" }, { status: 500 });
    }

    if (!cartId || cartData.length === 0) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "Cart is empty",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }
```

2. 写しを作る所（:803-820）の `source_cart_id: cartItem.id` を `source_cart_line_id: cartItem.id` に、`canonicalizeItemsSnapshot`（:182-202）の `source_cart_id` を `source_cart_line_id` にする
3. `claimCheckoutDraft` の引数（:372-401）に `cartId: string` を足し、`_cart_id: params.cartId` を RPC に渡す。呼び出し（:835-849）に `cartId` を足す

`src/app/api/checkout/promotion-code/route.ts`: `loadCheckoutCart(supabase, guard.sessionId)`（:52）の前で買い手を確かめ、カートを引く。

```ts
    const buyer = await resolveCheckoutBuyer(req);
    if (buyer.kind === 'expired' || buyer.kind === 'unavailable') {
      return guard.finish(checkoutBuyerFailureResponse(buyer.kind));
    }
    const cart = await loadCheckoutCart(supabase, await findCartIdForBuyer(supabase, req, buyer));
```

（import: `resolveCheckoutBuyer`・`checkoutBuyerFailureResponse` は `@/features/checkout/services/checkout-buyer`、`findCartIdForBuyer` は `@/features/cart/services/shopping-context`。）

`source_cart_id` を使う残りの所（`grep -rn "source_cart_id" src tests`）を全部 `source_cart_line_id` にする。`git grep -n "source_cart_id" -- src tests` が何も出さないことを確かめる。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx jest tests/unit/api/checkout tests/unit/features/checkout tests/unit/features/cart --runInBand` と `npx tsc --noEmit -p tsconfig.json`
Expected: PASS。型の誤りは Task 8 の画面だけ

- [ ] **Step 7: コミットする**

```bash
git add src/features/checkout/services/checkout-draft.service.ts src/features/checkout/services/checkout-cart.service.ts src/features/cart/services/cart-stock.ts src/app/api/checkout/create-session/route.ts src/app/api/checkout/promotion-code/route.ts <source_cart_id を直したファイル> tests/unit/features/checkout/services/checkout-cart.service.test.ts tests/unit/api/checkout/create-session-route.test.ts tests/unit/api/checkout/promotion-code-route.test.ts tests/unit/features/checkout/services/checkout-confirmation.service.test.ts tests/unit/api/checkout/place-order-route.test.ts tests/unit/api/checkout/resume-route.test.ts <collectInventoryIssues の試験>
git commit -m "feat(checkout): 確認へ進むと割引コードの確かめを持ち主のカートの明細で読み、下書きにカートを記録する"
```

---

### Task 8: 画面

**Files:**
- Modify: `src/lib/client-fetch.ts:5`（`getCsrfTokenFromCookie` を `export` する。本計画の決め事 P16）
- Create: `src/features/cart/client/cart-api.ts`
- Create: `src/contexts/CartLoginSync.tsx`
- Modify: `src/contexts/CartContext.tsx`、`src/contexts/Providers.tsx:28-42`
- Modify: `src/app/cart/_hooks/useCartItems.ts`
- Modify: `src/app/checkout/page.tsx:195-252,322-353`
- Modify: `src/lib/items/availability.ts`、`src/types/item.ts:33-39`、`src/app/item/[id]/ItemDetailClient.tsx:357-391`
- Modify: `src/app/wishlist/page.tsx:14-142,228-268`
- Modify: `src/app/api/orders/[id]/route.ts:13-46,105-143,168-200`、`src/features/account/hooks/useReorder.ts`、`src/app/account/orders/[id]/page.tsx:32-98`（明細の型に `variantId`）
- Test: `tests/unit/features/cart/client/cart-api.test.ts`（新規）、`tests/unit/contexts/CartContext.test.tsx`、`tests/unit/contexts/CartLoginSync.test.tsx`（新規）、`tests/unit/components/CartPage.test.tsx`、`tests/unit/components/CheckoutPage.test.tsx`、`tests/unit/features/account/hooks/useReorder.test.tsx`（新規）

**Interfaces:**
- Consumes: Task 4 の `CartJson`・`CartJsonLine`・`CART_OPTION_NAMES`（`@/features/cart/types/cart-json`）と窓口、Task 5 のお気に入りの `variants`、`refreshSessionOnce()`、`useLogin()` の `isLoggedIn`
- Produces（`src/features/cart/client/cart-api.ts`）:
  - `type CartEntry = { id: string; item_id: number; variant_id: number; quantity: number; color: string | null; size: string | null; fulfillment?: 'stock' | 'backorder' | null; items: { id: number; name: string; price: number; image_url: string; category?: string } | null }`（`useCartItems.ts` は `export type { CartEntry }` で同じ型を出し直す）
  - `toCartEntries(cart: CartJson): CartEntry[]`
  - `sendShoppingRequest(endpoint: string, init?: RequestInit): Promise<Response>`
  - `fetchCartJson(): Promise<CartJson>`
  - `type CartPostResult = { ok: true; body: unknown } | { ok: false; status: number; description: string }`
  - `postCart(endpoint: '/api/cart/add' | '/api/cart/change', payload: unknown, fallbackDescription: string): Promise<CartPostResult>`
  - `findVariantId(availability, color, size): number | null`
  - `useCart()` に `refreshShopping(): Promise<void>` を足す

- [ ] **Step 1: 失敗する単体テストを書く**

`tests/unit/features/cart/client/cart-api.test.ts`:

```ts
import { fetchCartJson, findVariantId, postCart, sendShoppingRequest, toCartEntries } from '@/features/cart/client/cart-api';
import { refreshSessionOnce } from '@/lib/client-fetch';
import type { CartJson } from '@/features/cart/types/cart-json';

jest.mock('@/lib/client-fetch', () => ({
  ...jest.requireActual('@/lib/client-fetch'),
  refreshSessionOnce: jest.fn(),
}));

const CART: CartJson = {
  item_count: 2,
  currency: 'JPY',
  items_subtotal_price: 24000,
  total_price: 24000,
  items: [{
    key: 'line-1', id: 1201, variant_id: 1201, product_id: 45, quantity: 2,
    title: 'リネンシャツ - ブラック / M', product_title: 'リネンシャツ', variant_title: 'ブラック / M',
    options_with_values: [{ name: 'カラー', value: 'ブラック' }, { name: 'サイズ', value: 'M' }],
    price: 12000, line_price: 24000, image: '/img.png', url: '/item/45', fulfillment: 'backorder',
  }],
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('cart-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.cookie = 'sb-csrf-token=; max-age=0';
    global.fetch = jest.fn();
  });

  test('Shopify の形を今の画面用の形に直す', () => {
    expect(toCartEntries(CART)).toEqual([{
      id: 'line-1', item_id: 45, variant_id: 1201, quantity: 2, color: 'ブラック', size: 'M', fulfillment: 'backorder',
      items: { id: 45, name: 'リネンシャツ', price: 12000, image_url: '/img.png' },
    }]);
  });

  test('ゲスト（読める CSRF の Cookie が無い）は合言葉を付けず、印の更新も呼ばない', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [] }));
    await postCart('/api/cart/add', { items: [{ id: 1201, quantity: 1 }] }, 'x');
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('x-csrf-token')).toBe(false);
    expect(refreshSessionOnce).not.toHaveBeenCalled();
  });

  test('会員は読める CSRF の Cookie の合言葉を付ける', async () => {
    document.cookie = 'sb-csrf-token=abc';
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, CART));
    await postCart('/api/cart/change', { id: 'line-1', quantity: 0 }, 'x');
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('abc');
  });

  test('401 auth_expired は印を1回だけ新しくして送り直す', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(401, { error: 'auth_expired' }))
      .mockResolvedValueOnce(jsonResponse(200, CART));
    (refreshSessionOnce as jest.Mock).mockResolvedValue('refreshed');
    await expect(fetchCartJson()).resolves.toEqual(CART);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('印を新しくできなければ送り直さない', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(401, { error: 'auth_expired' }));
    (refreshSessionOnce as jest.Mock).mockResolvedValue('expired');
    const response = await sendShoppingRequest('/api/cart');
    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('断りの description をそのまま返す', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(422, { status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' }));
    await expect(postCart('/api/cart/add', {}, '失敗')).resolves.toEqual({ ok: false, status: 422, description: '1つの商品は20個までです。' });
  });

  test('選んだ色・サイズのバリアントの番号を探す（DeliveryNote と同じ比べ方）', () => {
    const availability = [
      { colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 11 },
      { colorName: null, sizeLabel: null, inStock: false, variantId: 12 },
    ];
    expect(findVariantId(availability, 'Black', 'M')).toBe(11);
    expect(findVariantId(availability, '', null)).toBe(12);
    expect(findVariantId(availability, 'Ivory', 'M')).toBeNull();
    expect(findVariantId(undefined, 'Black', 'M')).toBeNull();
  });
});
```

`tests/unit/contexts/CartLoginSync.test.tsx`: `useLogin` を `jest.mock` で差し替え、`isLoggedIn` が `false` → `true`（ログイン）と `true` → `false`（ログアウト）に変わった時に `refreshShopping` が1回ずつ呼ばれ、最初の表示では呼ばれないことを確かめる。

既存の画面の試験の直し:
- `tests/unit/contexts/CartContext.test.tsx`: お気に入りの GET・POST・DELETE の差し替えはそのまま。カートの数は `GET /api/cart` が `CartJson`（`item_count`）を返す形にする。足す試験: `updateCartCount()` が `item_count` を数にする、`refreshShopping()` がカートとお気に入りの両方を読み直す
- `tests/unit/components/CartPage.test.tsx`: `GET /api/cart` の差し替え（:39-303 の配列）を `CartJson` に替える（共通の作り方を試験ファイルの先頭に1つ置く）。数量の変更は `POST /api/cart/change` `{ id, quantity }`、削除は同じ窓口に `quantity: 0`（:94-128 の `PATCH`・`DELETE` の確かめを替える）。変更の応答は `CartJson` で、その明細の数量と `fulfillment` が画面に出ること
- `tests/unit/components/CheckoutPage.test.tsx`: カートの差し替え（:117-122、:224-225、:317、:682-700、:855-899）を `CartJson` に替える。:1248-1268 の試験は「引き継がれない」から「引き継がれる」に替える: 読み直したカート（差し替えの `CartJson`）にゲストで入れた商品がある時、`カートに商品がありません` を出さず、その商品の名前が出ること（題名も「ログインでカートの印が新しくなって断られた時も、入力画面に戻して案内を出し、合わせた後のカートと会員の内容を読み直す」に直す）
- `tests/unit/features/account/hooks/useReorder.test.tsx`（新規）: `variantId` のある明細は `POST /api/cart/add` `{ items: [{ id: variantId, quantity }] }` を送って `onSuccess('カートに追加しました')`、`variantId` が `null` なら送らずに `onError('この商品は現在お求めいただけません。')`、422 なら `onError(<description>)`

- [ ] **Step 2: 失敗を確かめる**

Run: `npx jest tests/unit/features/cart/client tests/unit/contexts tests/unit/components/CartPage.test.tsx tests/unit/components/CheckoutPage.test.tsx tests/unit/features/account --runInBand`
Expected: FAIL

- [ ] **Step 3: 画面の通信の部品を書く**

`src/lib/client-fetch.ts:5` の `function getCsrfTokenFromCookie()` を `export function getCsrfTokenFromCookie()` にする（中身は変えない）。

`src/features/cart/client/cart-api.ts`:

```ts
import { getCsrfTokenFromCookie, refreshSessionOnce } from '@/lib/client-fetch';
import { CART_OPTION_NAMES, type CartJson } from '@/features/cart/types/cart-json';
import type { Item } from '@/types/item';

/** カートの画面・決済の画面が使う明細の形（今の画面の部品の形。本計画の決め事 P8） */
export type CartEntry = {
  id: string;
  item_id: number;
  variant_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  fulfillment?: 'stock' | 'backorder' | null;
  items: { id: number; name: string; price: number; image_url: string; category?: string } | null;
};

export function toCartEntries(cart: CartJson): CartEntry[] {
  return cart.items.map((line) => ({
    id: line.key,
    item_id: line.product_id,
    variant_id: line.variant_id,
    quantity: line.quantity,
    color: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.color)?.value ?? null,
    size: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.size)?.value ?? null,
    fulfillment: line.fulfillment,
    items: { id: line.product_id, name: line.product_title, price: line.price, image_url: line.image ?? '' },
  }));
}

/**
 * カート・お気に入りの窓口へ送る（本計画の決め事 P9）。読める CSRF の Cookie がある時（会員）だけ合言葉を付ける。
 * 401 auth_expired と CSRF の 403 は、印を1回だけ新しくして送り直す。ゲストには印の更新を呼ばない。
 */
export async function sendShoppingRequest(endpoint: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const send = () => {
    const headers = new Headers(init.headers);
    if (method !== 'GET' && method !== 'HEAD') {
      const csrfToken = getCsrfTokenFromCookie();
      if (csrfToken) {
        headers.set('x-csrf-token', csrfToken);
      }
    }
    return fetch(endpoint, { ...init, method, headers, credentials: 'same-origin', cache: 'no-store' });
  };

  const first = await send();
  if (first.status !== 401 && first.status !== 403) {
    return first;
  }
  const body = (await first.clone().json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  const authExpired = first.status === 401 && body?.error === 'auth_expired';
  const csrfRejected = first.status === 403 && body?.reason === 'CSRF validation failed';
  if (!authExpired && !csrfRejected) {
    return first;
  }
  return (await refreshSessionOnce()) === 'refreshed' ? send() : first;
}

export async function fetchCartJson(): Promise<CartJson> {
  const response = await sendShoppingRequest('/api/cart');
  if (!response.ok) {
    throw new Error('カートの取得に失敗しました');
  }
  return (await response.json()) as CartJson;
}

export type CartPostResult = { ok: true; body: unknown } | { ok: false; status: number; description: string };

export async function postCart(
  endpoint: '/api/cart/add' | '/api/cart/change',
  payload: unknown,
  fallbackDescription: string,
): Promise<CartPostResult> {
  const response = await sendShoppingRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (response.ok) {
    return { ok: true, body };
  }
  const description = typeof (body as { description?: unknown } | null)?.description === 'string'
    ? (body as { description: string }).description
    : fallbackDescription;
  return { ok: false, status: response.status, description };
}

/** 選んだ色・サイズのバリアントの番号（比べ方は商品詳細の DeliveryNote と同じ） */
export function findVariantId(
  availability: Item['variantAvailability'],
  color: string | null,
  size: string | null,
): number | null {
  const match = availability?.find(
    (entry) => (entry.colorName ?? '') === (color ?? '') && (entry.sizeLabel ?? '') === (size ?? ''),
  );
  return match ? match.variantId : null;
}
```

- [ ] **Step 4: 商品の窓口にバリアントの番号を足す**

`src/lib/items/availability.ts`: `VariantAvailability` に `variantId: number;` を足し、`VariantRow` に `id: number;` を足す。問い合わせ（:59-63）の select の先頭に `id, ` を足し、`entry.combinations.push({...})`（:80-84）に `variantId: Number(row.id),` を足す。`src/types/item.ts:33-39` の `variantAvailability` の要素に `variantId: number;` を足す。

- [ ] **Step 5: ヘッダーの数・カートの画面・決済の画面を直す**

`src/contexts/CartContext.tsx`:
1. `updateCartCount`（:34-45）を次に替える

```ts
  const updateCartCount = useCallback(async () => {
    try {
      const cart = await fetchCartJson();
      setCartCount(cart.item_count);
    } catch (error) {
      console.error('Failed to fetch cart count:', error);
    }
  }, []);
```

2. お気に入りの GET・POST・DELETE（:47-56、:74、:89、:101）の `fetch(` を `sendShoppingRequest(` に替える（中身・楽観更新・巻き戻しは変えない）
3. `refreshShopping` を足して Provider の値に入れる

```ts
  const refreshShopping = useCallback(async () => {
    await Promise.all([updateCartCount(), updateWishlist()]);
  }, [updateCartCount, updateWishlist]);
```

（`updateWishlist` も `useCallback` で包む。Context の型に `refreshShopping: () => Promise<void>` を足す。）

`src/contexts/CartLoginSync.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { useCart } from '@/contexts/CartContext';
import { useLogin } from '@/contexts/LoginContext';

/**
 * ログイン・ログアウトの後にカートとお気に入りを読み直す（本計画の決め事 P13）。ログインではサーバーが
 * ゲストの分を会員の分へ合わせるので、ヘッダーの数を合わせた後の数にする。最初の表示では読み直さない。
 */
export function CartLoginSync() {
  const { isLoggedIn } = useLogin();
  const { refreshShopping } = useCart();
  const previous = useRef<boolean | null>(null);

  useEffect(() => {
    if (previous.current !== null && previous.current !== isLoggedIn) {
      void refreshShopping();
    }
    previous.current = isLoggedIn;
  }, [isLoggedIn, refreshShopping]);

  return null;
}
```

`src/contexts/Providers.tsx`: `<LoginProvider>` の直下（:29 の次の行）に `<CartLoginSync />` を置く（import を足す）。

`src/app/cart/_hooks/useCartItems.ts`:
1. `CartEntry` の定義（:4-22）を消し、`import { fetchCartJson, postCart, toCartEntries, type CartEntry } from '@/features/cart/client/cart-api';` と `export type { CartEntry };` にする
2. `fetchCart` の読み込み（:48-51）を次に替える

```ts
      const items = toCartEntries(await fetchCartJson());
```

3. `sendUpdate` の通信（:99-120）を次に替える

```ts
      const result = await postCart('/api/cart/change', { id: cartId, quantity }, '数量更新に失敗しました');
      if (!result.ok) {
        throw new Error(result.description);
      }
      const updatedLine = toCartEntries(result.body as CartJson).find((item) => item.id === cartId);
      const confirmedQty = updatedLine?.quantity ?? quantity;
      const fulfillment = updatedLine?.fulfillment ?? null;
```

4. `handleRemove` の通信（:178-179）を次に替える

```ts
      const result = await postCart('/api/cart/change', { id: cartId, quantity: 0 }, '削除に失敗しました');
      if (!result.ok) throw new Error(result.description);
```

`src/app/checkout/page.tsx`: `fetchCart`（:338-350）の `fetch("/api/cart")` と配列の読み取りを `toCartEntries(await fetchCartJson())` に替える。画面の型（:196-210）は `CartEntry` を使う（`added_at` を使っていないことを確かめて消す）。

- [ ] **Step 6: 商品詳細・お気に入り・再注文を直す**

`src/app/item/[id]/ItemDetailClient.tsx` の `handleAddToCart`（:357-391）の通信の部分:

```ts
    const variantId = findVariantId(item.variantAvailability, hasColors ? color : null, hasSizes ? size : null);
    if (variantId === null) {
      setValidationError("選んだ色・サイズは現在お求めいただけません。");
      return;
    }

    setAddingToCart(true);
    try {
      const result = await postCart("/api/cart/add", { items: [{ id: variantId, quantity: 1 }] }, "カートへの追加に失敗しました");
      if (!result.ok) throw new Error(result.description);
      await updateCartCount();
```

（以降の `setOptionSheetOpen(false)` などは今のまま。import に `findVariantId`・`postCart` を足す。）

`src/app/wishlist/page.tsx`:
1. お気に入りの行の型と検証（:14-142）に `variants: Array<{ id: number; color: string | null; size: string | null }>` を足す（無ければ空の配列として扱う）
2. カートに入れる処理（:241-267）を次に替える（`resolvedColor`・`resolvedSize` の決め方と「色やサイズの選択が必要な商品です。…」の分かれ道は今のまま）

```ts
    const variant = wishlistItem.variants.find(
      (entry) => (entry.color ?? '') === (resolvedColor ?? '') && (entry.size ?? '') === (resolvedSize ?? ''),
    );
    if (!variant) {
      setCartMessage('選んだ色・サイズは現在お求めいただけません。');
      return;
    }
    const result = await postCart('/api/cart/add', { items: [{ id: variant.id, quantity: 1 }] }, 'カートへの追加に失敗しました');
    if (!result.ok) {
      throw new Error(result.description);
    }
```

（`setCartMessage` は今のファイルの通知の出し方の名前に合わせる。成功の「カートに追加しました。」と件数の更新は今のまま。）

`src/app/api/orders/[id]/route.ts`: 明細の型（:13-22）に `variant_id: number | null;`、select（:107-143 の `order_items(...)`）に `variant_id`、返す明細（:186-198）に `variantId: item.variant_id ?? null,` を足す。`src/app/account/orders/[id]/page.tsx` の明細の型（:32-98）に `variantId: number | null` を足して `useReorder` に渡す。

`src/features/account/hooks/useReorder.ts` の全体:

```ts
import React from "react";
import { postCart } from "@/features/cart/client/cart-api";

// 再購入（注文商品をカートに追加）の共通ロジック。
// 購入履歴タブ・注文詳細ページで同一挙動を共有する。
// 成否メッセージの表示先はページごとに異なるためコールバックで受け取る。

type ReorderableItem = {
  id: string;
  itemId: number | null;
  variantId: number | null;
  quantity: number;
};

export function useReorder(callbacks: {
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [reorderingItemId, setReorderingItemId] = React.useState<string | null>(
    null,
  );

  const reorder = async (item: ReorderableItem) => {
    if (!item.itemId) return;
    // 注文の明細のバリアントで入れる。番号の無い古い明細・取り扱いを終えた色やサイズは入れられない（設計書 8 章）
    if (item.variantId === null) {
      callbacks.onError("この商品は現在お求めいただけません。");
      return;
    }
    setReorderingItemId(item.id);
    try {
      const result = await postCart(
        "/api/cart/add",
        { items: [{ id: item.variantId, quantity: item.quantity }] },
        "カートへの追加に失敗しました",
      );
      if (result.ok) {
        callbacks.onSuccess("カートに追加しました");
      } else {
        callbacks.onError(result.status === 404 ? "この商品は現在お求めいただけません。" : result.description);
      }
    } catch {
      callbacks.onError("カートへの追加に失敗しました");
    } finally {
      setReorderingItemId(null);
    }
  };

  return { reorderingItemId, reorder };
}
```

- [ ] **Step 7: 通ることを確かめる**

Run: `npm run -s typecheck`（無ければ `npx tsc --noEmit -p tsconfig.json`）、`npm run -s lint`、`npx jest --runInBand`（単体の全部）
Expected: 型の誤り 0、lint の誤り 0、単体は全部 PASS

- [ ] **Step 8: コミットする**

```bash
git add src/lib/client-fetch.ts src/features/cart/client/cart-api.ts src/contexts/CartContext.tsx src/contexts/CartLoginSync.tsx src/contexts/Providers.tsx src/app/cart/_hooks/useCartItems.ts src/app/checkout/page.tsx src/lib/items/availability.ts src/types/item.ts "src/app/item/[id]/ItemDetailClient.tsx" src/app/wishlist/page.tsx "src/app/api/orders/[id]/route.ts" src/features/account/hooks/useReorder.ts "src/app/account/orders/[id]/page.tsx" tests/unit/features/cart/client/cart-api.test.ts tests/unit/contexts/CartContext.test.tsx tests/unit/contexts/CartLoginSync.test.tsx tests/unit/components/CartPage.test.tsx tests/unit/components/CheckoutPage.test.tsx tests/unit/features/account/hooks/useReorder.test.tsx
git commit -m "feat(cart): 画面を新しいカートの窓口につなぎ、ログイン・ログアウトの後にカートとお気に入りを読み直す"
```

---

### Task 9: 既存の E2E の直し

**Files:**
- Modify: `e2e/shop-test-utils.ts:41-95,121-251`（真似る窓口を新しい形に）
- Modify: `e2e/checkout-flow-helpers.ts:22-44`（`seedCart` をバリアントで入れる）
- Modify: 直接カートの窓口を使う spec（下の表）
- Modify: `e2e/FR-CART-020-rpc-not-directly-callable.spec.ts`、`e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts:16-17,244-246`

**Interfaces:**
- Consumes: Task 4 の窓口と `CartJson` の形、Task 8 の `variantId`
- Produces: `mockCartApis(page, items)` は今と同じ戻り値（`patchBodies`・`deleteIds`・`postBodies`）。`patchBodies` は `/api/cart/change` の数量1以上、`deleteIds` は数量0、`postBodies` は `/api/cart/add` の送る中身をそのまま記録する。`sampleItemDetail()` は `variantAvailability`（`variantId` 付き）を持つ

- [ ] **Step 1: 共通の部品を新しい形にする**

`e2e/shop-test-utils.ts`:
1. `MockCartItem` に `variant_id?: number` と `fulfillment?: 'stock' | 'backorder' | null` を足し、`sampleCartItem` の既定に `variant_id: 1012` を足す
2. `MockItemDetail` の `variantAvailability` の要素に `variantId: number` を足し、`sampleItemDetail` の既定に次を足す（色 Black・Ivory × サイズ S・M）

```ts
  variantAvailability: [
    { colorName: 'Black', sizeLabel: 'S', inStock: true, variantId: 1011 },
    { colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 1012 },
    { colorName: 'Ivory', sizeLabel: 'S', inStock: true, variantId: 1021 },
    { colorName: 'Ivory', sizeLabel: 'M', inStock: true, variantId: 1022 },
  ],
```

3. `MockWishlistItem` に `variants: Array<{ id: number; color: string | null; size: string | null }>` を足し、`sampleWishlistItem` の既定に `variants: [{ id: 1012, color: 'Black', size: 'M' }]` を足す
4. `mockCartApis`（:121-251）を次の形に替える（戻り値の名前は今のまま）

```ts
function toCartJsonLine(item: MockCartItem) {
  const price = item.items?.price ?? 0;
  const variantTitle = [item.color, item.size].filter((value): value is string => Boolean(value)).join(' / ') || null;
  const name = item.items?.name ?? '';
  return {
    key: item.id,
    id: item.variant_id ?? item.item_id,
    variant_id: item.variant_id ?? item.item_id,
    product_id: item.item_id,
    quantity: item.quantity,
    title: variantTitle ? `${name} - ${variantTitle}` : name,
    product_title: name,
    variant_title: variantTitle,
    options_with_values: [
      ...(item.color ? [{ name: 'カラー', value: item.color }] : []),
      ...(item.size ? [{ name: 'サイズ', value: item.size }] : []),
    ],
    price,
    line_price: price * item.quantity,
    image: item.items?.image_url ?? null,
    url: `/item/${item.item_id}`,
    fulfillment: item.fulfillment ?? null,
  };
}

function toCartJson(items: MockCartItem[]) {
  // 非公開・削除の商品（items: null）は新しい窓口が返さないので、真似る時も出さない
  const lines = items.filter((item) => item.items !== null).map(toCartJsonLine);
  const subtotal = lines.reduce((sum, line) => sum + line.line_price, 0);
  return {
    item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
    currency: 'JPY',
    items_subtotal_price: subtotal,
    total_price: subtotal,
    items: lines,
  };
}

export async function mockCartApis(page: Page, initialItems: MockCartItem[]) {
  let cartItems = [...initialItems];
  const patchBodies: Array<{ id: string; quantity: number }> = [];
  const deleteIds: string[] = [];
  const postBodies: Array<Record<string, unknown>> = [];

  await page.route('**/api/cart', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toCartJson(cartItems)) });
  });

  await page.route('**/api/cart/add', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { items?: Array<{ id: number; quantity: number }> };
    postBodies.push(body as Record<string, unknown>);
    const added = (body.items ?? []).map(({ id, quantity }) => {
      const existing = cartItems.find((item) => (item.variant_id ?? item.item_id) === id);
      if (existing) {
        existing.quantity += quantity;
        return existing;
      }
      const created = sampleCartItem({ id: `cart-added-${cartItems.length + 1}`, variant_id: id, quantity });
      cartItems = [...cartItems, created];
      return created;
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: added.map(toCartJsonLine) }) });
  });

  await page.route('**/api/cart/change', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as { id: string; quantity: number };
    if (body.quantity === 0) {
      deleteIds.push(body.id);
      cartItems = cartItems.filter((item) => item.id !== body.id);
    } else {
      patchBodies.push({ id: body.id, quantity: body.quantity });
      cartItems = cartItems.map((item) => (item.id === body.id ? { ...item, quantity: body.quantity } : item));
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toCartJson(cartItems)) });
  });

  return { patchBodies, deleteIds, postBodies };
}
```

5. `mockWishlistApis` の GET の返す中身に `variants` を入れる（`sampleWishlistItem` の値をそのまま返す）

`e2e/checkout-flow-helpers.ts` の `seedCart`（:22-44）の中の追加を、商品詳細の窓口からバリアントを選んで入れる形にする。

```ts
    const detailResponse = await fetch(`/api/items/${item.id}`);
    if (!detailResponse.ok) {
      throw new Error(`/api/items/${item.id} returned ${detailResponse.status}`);
    }
    const detail = (await detailResponse.json()) as { variantAvailability?: Array<{ variantId: number }> };
    const variantId = detail.variantAvailability?.[0]?.variantId;
    if (!variantId) {
      return { ok: false, reason: 'No variant for the published item' };
    }
    const cartResponse = await fetch('/api/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
    });
    if (!cartResponse.ok) {
      throw new Error(`/api/cart/add returned ${cartResponse.status}`);
    }
```

（`SeedResult` の `ok: false` の `reason` は今の型に合わせる。`FR-CHECKOUT-038` は「色・サイズ無しでバリアントに当たらず受注生産」を前提にしている。新しい形ではバリアントで入れるので、`seedCart` の後に受注生産になることを前提にした確かめがあれば、在庫0のバリアントを選ぶよう試験の側を直す。）

- [ ] **Step 2: 直接カートの窓口を使う spec を直す**

| spec | 直し方 |
|---|---|
| `FR-CART-001-008-cart-ui-and-actions` | `patchBodies`・`deleteIds` の確かめは今のまま通る（`mockCartApis` が記録の形を保つ）。通ることだけ確かめる |
| `FR-CART-021-action-error-toast` | `**/api/cart/*` の `DELETE` の真似を `**/api/cart/change`（数量0）の真似に替え、失敗は 500 `{ status: 500, message: 'Cart Error', description: '削除に失敗しました' }` にする |
| `FR-CHECKOUT-007`・`FR-CHECKOUT-012` | `page.route('**/api/cart')` の古い配列を `CartJson` に替える（`shop-test-utils.ts` から `toCartJson` を `export` して使う） |
| `FR-CHECKOUT-015` | カートの空の応答 `[]` を `{ item_count: 0, currency: 'JPY', items_subtotal_price: 0, total_price: 0, items: [] }` に替える |
| `FR-CHECKOUT-044` | `seedCart` と実の `GET /api/cart` の回数の確かめは今のまま通る。通ることだけ確かめる |
| `FR-CHECKOUT-045` | 実の `POST /api/cart` `{item_id,color,size,quantity}` を、`/api/items/<id>` の `variantAvailability` から選んだバリアントで `POST /api/cart/add` `{ items: [{ id, quantity: 1 }] }` に替える |
| `FR-HEADER-008` | `cart` の応答の `[{quantity}]`・`[]` を `CartJson`（`item_count`）に替える |
| `FR-ITEM-DETAIL-016` | `POST /api/cart` の本文の `quantity` の確かめを、`POST /api/cart/add` の `items[0].quantity === 1` の確かめに替える。応答は `{ items: [] }` |
| `FR-ITEM-DETAIL-004-006-007-008`・`FR-ITEM-DETAIL-060` | `postBodies[0]` の `toMatchObject({ item_id, color, size, ... })` を、選んだ色・サイズの `variantId` の `{ items: [{ id: <variantId>, quantity: 1 }] }` に替える（Black・M は 1012） |
| `FR-ITEM-DETAIL-062` | `POST /api/cart` の 500 の上書きを `**/api/cart/add` の 500 `{ status: 500, message: 'Cart Error', description: 'カートへの追加に失敗しました' }` にする |
| `FR-ITEM-DETAIL-065` | 真似る `variantAvailability` の各要素に `variantId` を足す |
| `FR-WISHLIST-007` | お気に入りの古い配列に `variants` を足す。カートの `POST {item_id,quantity,color,size}` の捕まえ方を `POST /api/cart/add` の `{ items: [{ id, quantity: 1 }] }` に、実の GET の配列の読み方を `CartJson` の `items`（`product_id`・`quantity`・`options_with_values`）に、掃除の古い `DELETE` を `POST /api/cart/change`（数量0）に替える |
| `FR-WISHLIST-011` | `session_id` で数える回数の制限の確かめを、`wishlist` の印（初めて入れた時に付く Cookie）で数える形に替える。他の確かめ（形・非公開・Origin）は今のまま |
| `FR-WISHLIST-012`・`013`・`014`・`015`、`FR-ITEM-DETAIL-056`・`057` | お気に入りの GET の古い配列に `variants: []` を足す（カートに入れる操作が無い spec は足さなくても通る。通らない時だけ足す） |
| `FR-WISHLIST-005` | 今のまま（GET が 200 か 400 かだけを見る。`session_id` が無くても 200 になるので、400 の期待があれば 200 に替える） |
| `FR-CART-002-005-006-007` | `session_id` の Cookie の払い出しの確かめは今のまま（proxy が出す）。カートの空の表示の確かめは今のまま |

- [ ] **Step 3: 古い関数と古い呼び名を直す**

`e2e/FR-CART-020-rpc-not-directly-callable.spec.ts` の `RPCS`（:12-15）を新しい関数に替える（期待は今のまま「400 以上 500 未満」）。

```ts
const RPCS = [
  { name: 'cart_add_lines', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _lines: [{ variant_id: 1, quantity: 1 }] } },
  { name: 'cart_change_line', body: { _cart_id: '00000000-0000-0000-0000-000000000000', _line_id: '00000000-0000-0000-0000-000000000000', _quantity: 1 } },
  { name: 'merge_guest_into_member', body: { _user_id: '00000000-0000-0000-0000-000000000000', _cart_token_hash: null, _wishlist_token_hash: null } },
];
```

`e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`: `CART_COOKIE_NAME = 'session_id'`（:17）を `CHECKOUT_SESSION_COOKIE_NAME = 'session_id'` に改め（使う所も）、:244-246 のコメントの「カートの印（session_id の Cookie）」を「決済の流れの印（session_id の Cookie）」に直す（カートの印は `cart` の Cookie になった）。

- [ ] **Step 4: 通ることを確かめる**

Run: 3000番に何も無いことを確かめ、`npx supabase db reset` の後に `npx playwright test e2e/FR-CART e2e/FR-CHECKOUT e2e/FR-HEADER e2e/FR-ITEM-DETAIL e2e/FR-WISHLIST e2e/FR-ACCOUNT`
Expected: 新しく落ちる試験が無い（既存の赤は `docs` の記録と memory の既存の赤の一覧のとおり。落ちた試験は単体で流し直して切り分け、`page.goto` の時間切れかアサーションの食い違いかを分ける）。`FR-ITEM-DETAIL` で、既定の `variantAvailability` を足したために納期の表示（`delivery-note`）が増えて食い違う spec は、その spec で `variantAvailability` を明示するか、納期の表示を前提にした確かめに直す

- [ ] **Step 5: コミットする**

```bash
git add e2e/shop-test-utils.ts e2e/checkout-flow-helpers.ts <Step 2・3 で直した spec>
git commit -m "test(e2e): カートとお気に入りの真似と種まきを新しい窓口の形に合わせる"
```

---

### Task 10: 新しい E2E・要求・文書

**Files:**
- Create: `e2e/FR-CART-023-guest-cart-carryover-on-login.spec.ts`
- Create: `e2e/FR-CART-024-cart-api-shopify-format.spec.ts`
- Create: `e2e/FR-CHECKOUT-047-login-mid-checkout-merged-cart.spec.ts`
- Create: `e2e/FR-WISHLIST-016-guest-wishlist-carryover-on-login.spec.ts`
- Modify: `docs/02_Requirements/requirements.md`（FREQ-428〜432 を FREQ-427 の行の後に足す）
- Modify: `docs/03_BasicDesign/data/er.md`、`docs/03_BasicDesign/api/api-spec.md:95-101,314`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/04_DetailDesign/sequence/checkout-payment.md`、`docs/04_DetailDesign/states/checkout-draft.md`、`docs/04_DetailDesign/pages/05_item_detail.md`・`11_wishlist.md`・`12_cart.md`、`docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md`

**Interfaces:**
- Consumes: 全タスクの窓口と画面、`e2e/member-session-helpers.ts` の `createTestMember(label)`・`loginAsMember(page, member)`（呼ぶ spec は先頭で `test.use({ trace: 'off' })`）、`e2e/checkout-flow-helpers.ts` の `seedCart`
- Produces: なし

- [ ] **Step 1: E2E を書く**

4本とも、mobile（390×844）・tablet（768×1024）・desktop（1280×800）の3つの画面幅で、各画面幅に別の会員（`createTestMember(\`<名前>-${viewport.name}\`)`）を使う。商品は `seedCart(page)` と同じ選び方（公開中で50円以上の商品と、その最初のバリアント）で入れる。

`e2e/FR-CART-023-guest-cart-carryover-on-login.spec.ts`（FREQ-428-AC-01・FREQ-431-AC-01・FREQ-432-AC-04）:

```ts
import { expect, test } from '@playwright/test';
import { seedCart } from './checkout-flow-helpers';
import { createTestMember, loginAsMember } from './member-session-helpers';

test.use({ trace: 'off' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-CART-023 ゲストのカートをログインで引き継ぐ (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FREQ-428-AC-01・FREQ-431-AC-01・FREQ-432-AC-04: ログインで残り、ログアウトで消え、もう一度のログインで戻る', async ({ page, context }) => {
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, '公開中の商品が無い');

      const cartCookie = (await context.cookies()).find((cookie) => cookie.name === 'cart');
      expect(cartCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
      const lifetimeSeconds = (cartCookie!.expires ?? 0) - Date.now() / 1000;
      expect(lifetimeSeconds).toBeGreaterThan(14 * 24 * 60 * 60 - 120);
      expect(lifetimeSeconds).toBeLessThanOrEqual(14 * 24 * 60 * 60 + 5);

      await page.goto('/cart');
      const guestRows = page.getByTestId('cart-item-row');
      await expect(guestRows).toHaveCount(1);
      const itemName = (await guestRows.first().getByTestId('cart-item-name').textContent())?.trim() ?? '';

      const member = await createTestMember(`cart-carry-${viewport.name}`);
      await loginAsMember(page, member);
      expect((await context.cookies()).find((cookie) => cookie.name === 'cart')).toBeUndefined();

      await page.goto('/cart');
      await expect(page.getByTestId('cart-item-row')).toHaveCount(1);
      await expect(page.getByTestId('cart-item-name').first()).toHaveText(itemName);

      const logout = await page.request.post('/api/auth/logout', { headers: { origin: new URL(page.url()).origin } });
      expect(logout.ok()).toBe(true);
      await page.goto('/cart');
      await expect(page.getByText('YOUR CART IS EMPTY')).toBeVisible();

      await loginAsMember(page, member);
      await page.goto('/cart');
      await expect(page.getByTestId('cart-item-name').first()).toHaveText(itemName);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
```

（`cart-item-row`・`cart-item-name` はカートの画面の今の `data-testid` を使う。無ければ `CartItemRow` の今の見出し・リンクの取り方に合わせる。ログアウトの窓口が CSRF を求めるなら、`sb-csrf-token` の Cookie の値を `x-csrf-token` に付ける。値は画面・ログに出さない。）

`e2e/FR-CART-024-cart-api-shopify-format.spec.ts`（FREQ-430-AC-01〜07）:
- 窓口の確かめ（画面幅に依らないので1回）: `page.request` で、ゲストが `POST /api/cart/add` で同じバリアントを2回入れると `GET /api/cart` の `items` が1行で `quantity` 2、`item_count` 2、`items[0]` に `key`・`id`・`variant_id`・`product_id`・`quantity`・`price`・`line_price` があり、本文に `token` の文字が無い（AC-01・AC-02）。18 を足して 20 にした後の1つで 422・`description` が `1つの商品は20個までです。`（AC-03 の窓口側）。在庫の無いバリアントの番号 `999999999` は 404・`選んだ色・サイズは現在お求めいただけません。`（AC-05）。`POST /api/cart/change` で数量0にすると `items` が空、別のブラウザの文脈（`browser.newContext()`）のゲストの `key` を送ると 404（AC-06）。会員でログインした文脈で `x-csrf-token` を付けずに `POST /api/cart/add` を送ると 403（AC-07）。51種類目の 422（AC-04）は DB 結合テスト（Task 1 の「51種類目は断る」）で確かめ、E2E では窓口が 422 の時に `description` をそのまま返すことを、`page.route` で `/api/cart/add` を 422 `{ status: 422, message: 'Cart Error', description: 'カートに入れられるのは50種類までです。' }` にして商品詳細から入れた時に画面にその文言が出ることで確かめる
- 画面の確かめ（3つの画面幅）: 商品詳細でカートに20個ある商品をもう1つ入れようとすると `1つの商品は20個までです。` が表示され、`GET /api/cart` の数量が20のまま（AC-03）。横方向のページスクロールが発生しないこと

`e2e/FR-CHECKOUT-047-login-mid-checkout-merged-cart.spec.ts`（FREQ-428-AC-05）: FR-CHECKOUT-046 の FREQ-427-AC-01 の流れ（ゲストで「確認へ進む」→ 別のタブでログイン → 「注文する」→ 403 と案内）に続けて、`ログインの状態が変わりました。` を含む案内が表示され、「確認へ進む」を押すと最終確認画面に、ゲストで入れた商品の名前が表示されることを確かめる（決済の画面の作り方・待ち方は FR-CHECKOUT-046 の部品をそのまま使う）。3つの画面幅。

`e2e/FR-WISHLIST-016-guest-wishlist-carryover-on-login.spec.ts`（FREQ-429-AC-01）: ゲストで商品詳細のお気に入りのボタンを押す → `wishlist` の Cookie が付く → ログイン → `/wishlist` にその商品の名前が表示され、`wishlist` の Cookie が無いこと。3つの画面幅。横方向のページスクロールが発生しないこと。

- [ ] **Step 2: E2E が通ることを確かめる**

Run: 3000番に何も無いことを確かめ、`npx supabase db reset` の後に `npx playwright test e2e/FR-CART-023 e2e/FR-CART-024 e2e/FR-CHECKOUT-047 e2e/FR-WISHLIST-016`
Expected: PASS。回数の制限（`auth:refresh` 10分30回・`cart:add`）で落ちた時は、単体で流し直して切り分ける

- [ ] **Step 3: 要求の行を足す**

`docs/02_Requirements/requirements.md` の FREQ-427 の行の後に、次の5行を足す（列は「FREQ | 要求 | REQ の ID | 要件 | AC の ID | 受け付け基準」。今の行と同じく、1つのセルの中の項目は `<br>` で区切り、項目の頭に `・` を付ける）。

| FREQ | 要求 | REQ | 要件 | AC | 受け付け基準 |
|---|---|---|---|---|---|
| FREQ-428 | ログインしてもカートが残ること（Shopify と同じく、カートの印をログインの印と分ける） | REQ-01〜03 | ・カートは session_id と別の `cart` Cookie（ゲスト）と会員の ID（会員）で持つこと<br>・ログインの処理の中でゲストのカートを会員のカートへ合わせること。会員に無ければ付け替え、両方あれば違うバリアントは両方残し、同じバリアントは大きい方の数量、50種類まで（commercetools と同じ）<br>・合わせるのに失敗してもログインを止めず、次にカート・お気に入り・決済を読んだ時にもう一度合わせること | AC-01〜05 | ・mobile（390px）/ tablet（768px）/ desktop（1280px）で、ゲストでカートに入れた商品が、ログインの後もカートの画面に表示されること<br>・会員のカートとゲストのカートに同じバリアントがある時、ログインの後の数量が大きい方になり、違うバリアントは両方残ること（DB 結合）<br>・会員にカートが無い時、ゲストのカートの明細がそのまま会員のカートになること（DB 結合）<br>・合わせて50種類を超える時、会員の明細とゲストの明細を入れた順に50種類までが残ること（DB 結合）<br>・同3画面幅で、ゲストで「確認へ進む」の後にログインして「注文する」を押すと「ログインの状態が変わりました。」を含む案内が表示され、「確認へ進む」を押すと最終確認画面にゲストで入れた商品が表示されること |
| FREQ-429 | ゲストもお気に入りを使え、ログインで会員のお気に入りへ合わさること | REQ-01 | ・ゲストのお気に入りを `wishlist` Cookie で持ち、ログインで会員のお気に入りへ合わせること（同じ商品は1つ） | AC-01〜02 | ・同3画面幅で、ゲストでお気に入りに入れた商品が、ログインの後もお気に入りの画面に表示されること<br>・両方に同じ商品がある時、ログインの後に1件になること（DB 結合） |
| FREQ-430 | カートの窓口を Shopify の Ajax Cart API の形にし、上限と取り扱いの無い色・サイズを断ること | REQ-01〜04 | ・`GET /api/cart` はカート全体（`item_count`・`items`）を返し、印を返さないこと<br>・`POST /api/cart/add` はバリアントの番号と数量で足し、同じバリアントは同じ明細の数量を足すこと<br>・`POST /api/cart/change` は明細の key と数量で変え、数量0で消すこと<br>・断りは `{status, message, description}` の形で、1明細20個・50種類を超える時は 422、バリアントが無い・取り扱い終了の時は 404 とすること | AC-01〜07 | ・`GET /api/cart` が `item_count` と `items`（`key`・`id`・`variant_id`・`product_id`・`quantity`・`price`・`line_price`）を返し、`token` を返さないこと<br>・同じバリアントを2回入れると明細が1行で数量が足されること<br>・同3画面幅で、20個を超えて入れようとすると「1つの商品は20個までです。」が表示され、数量が変わらないこと<br>・51種類目を入れると 422 で `description` が「カートに入れられるのは50種類までです。」であること<br>・無い・取り扱い終了のバリアントを入れると 404 で `description` が「選んだ色・サイズは現在お求めいただけません。」であること<br>・`/api/cart/change` で数量0にすると明細が消え、他人の明細の key は 404 であること<br>・会員がカートを書き換える時、CSRF の合言葉が無いと 403 であること |
| FREQ-431 | ログアウトでこの端末のカートとお気に入りを消し、会員の分は次のログインで戻ること（Adobe Commerce の「ログアウトで消す」と同じ） | REQ-01 | ・ログアウトで `cart`・`wishlist` の Cookie を消し、会員の分はサーバーに残すこと | AC-01〜02 | ・同3画面幅で、会員でログアウトするとカートの画面が空になり、もう一度ログインすると元の商品が表示されること<br>・ログアウトの応答が `cart`・`wishlist` の Cookie を消すこと |
| FREQ-432 | カートとお気に入りのデータを守ること | REQ-01〜04 | ・4つの表をブラウザから読めず書けなくし、読み書きをサーバーの API だけにすること<br>・ゲストの印は DB に SHA-256 だけを保存すること<br>・最後に使ってから30日を過ぎたゲストの分を毎日消すこと<br>・`cart`・`wishlist` の Cookie を HttpOnly・SameSite=Lax・Path=/・2週間とすること | AC-01〜04 | ・`anon`・`authenticated` から4つの表を読めず書けないこと（DB 結合）<br>・DB に印そのものが無く、`guest_token_hash` が印の SHA-256 であること（単体・DB 結合）<br>・最後に使ってから30日を過ぎたゲストのカート・お気に入りが毎日の処理で消え、会員の分と30日以内の分は消えないこと（DB 結合）<br>・`cart`・`wishlist` の Cookie が HttpOnly・SameSite=Lax・Path=/・Max-Age 2週間であること |

（REQ・AC の ID のセルは、今の行と同じく `FREQ-428-REQ-01<br>FREQ-428-REQ-02<br>…`・`FREQ-428-AC-01<br>…` と全部書く。）

- [ ] **Step 4: 文書を直す**

| 文書 | 直し方 |
|---|---|
| `docs/03_BasicDesign/data/er.md` | 古い `carts`・`wishlist` を消し、`carts`・`cart_lines`・`wishlists`・`wishlist_lines` と `checkout_drafts.cart_id` を足す（Mermaid の図・列の表・索引の表・外部キーの表）。移行2本へのリンクを付ける |
| `docs/03_BasicDesign/api/api-spec.md:95-101,314` | カートの4行を `GET /api/cart`・`POST /api/cart/add`・`POST /api/cart/change` の3行（認可は「cart Cookie または会員」、送る中身・返す中身・断りは設計書 6-1 のとおり）に替える。お気に入りの3行の認可を「wishlist Cookie または会員」にし、GET の返す中身に `variants` を足す。:314 の形の行を新しい送る中身に替える |
| `docs/03_BasicDesign/api/route-inventory.md` | `/api/cart/[id]` を消し、`/api/cart/add`・`/api/cart/change` を足す |
| `docs/04_DetailDesign/sequence/checkout-payment.md` | 「確認へ進む」がカートを持ち主で読み、下書きに `cart_id` を記録する流れと、`source_cart_line_id` に直す |
| `docs/04_DetailDesign/states/checkout-draft.md` | `cart_id` と `source_cart_line_id` を足し、移行 B へのリンクを足す |
| `docs/04_DetailDesign/pages/05_item_detail.md`・`11_wishlist.md`・`12_cart.md` | カートに入れる・数量の変更・削除の窓口と、断りの文言、ゲストの印を新しい形に直す |
| `docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md` | 2 章・3 章・4 章の見出しの直後に「カートの所有権とお気に入りは 2026-10-08 のカートとお気に入りの引き継ぎ設計で置き換えた。」と書き、「2026-10-08 のカートとお気に入りの引き継ぎ設計」の部分を同じ specs フォルダの `2026-10-08-cart-wishlist-carryover-design.md` へのリンクにする |

Run: `npm run -s validate-docs`
Expected: 新しい誤りが無い（今ある既知の2件 `docs/superpowers/plans/2026-10-07-checkout-place-order-payment.md` だけ）

- [ ] **Step 5: コミットする**

```bash
git add e2e/FR-CART-023-guest-cart-carryover-on-login.spec.ts e2e/FR-CART-024-cart-api-shopify-format.spec.ts e2e/FR-CHECKOUT-047-login-mid-checkout-merged-cart.spec.ts e2e/FR-WISHLIST-016-guest-wishlist-carryover-on-login.spec.ts docs/02_Requirements/requirements.md docs/03_BasicDesign/data/er.md docs/03_BasicDesign/api/api-spec.md docs/03_BasicDesign/api/route-inventory.md docs/04_DetailDesign/sequence/checkout-payment.md docs/04_DetailDesign/states/checkout-draft.md docs/04_DetailDesign/pages/05_item_detail.md docs/04_DetailDesign/pages/11_wishlist.md docs/04_DetailDesign/pages/12_cart.md docs/superpowers/specs/2026-09-06-variant-inventory-and-cart-ownership-design.md
git commit -m "test(e2e): ログインでカートとお気に入りを引き継ぐ E2E と要求 FREQ-428〜432・文書を足す"
```

---

### Task 11: 全体の確かめ

**Files:** なし（確かめだけ。直しが要れば、その原因のタスクのファイルを直して別のコミットにする）

- [ ] **Step 1: 静的な確かめと単体**

Run: `npm run -s lint`、`npx tsc --noEmit -p tsconfig.json`、`npx jest --runInBand`
Expected: lint の誤り 0、型の誤り 0、単体は全部 PASS

- [ ] **Step 2: DB 結合**

Run: `npx supabase db reset` の後に `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`（PostgREST の3本は Global Constraints の環境変数を付ける）。終わったら `npx supabase db reset`
Expected: 全部 PASS

- [ ] **Step 3: E2E 全件**

Run: 3000番に何も無いことを確かめ、`npx supabase db reset` の直後に `npm run test:e2e`、続けて `npm run e2e:compare`
Expected: 前の基準（2026-10-08 のグループ C の push: 195 failed / 28 skipped / 2451 passed）より新しく落ちた試験が無い。新しく落ちた試験は単体で流し直し、(1) 単体で通るか、(2) 同じ試験の他の画面幅が通っているか、(3) `page.goto` の時間切れかアサーションの食い違いか、で切り分けて報告する

- [ ] **Step 4: グラフを新しくする**

Run: `.venv/Scripts/python.exe -m graphify update .`
Expected: 成功

- [ ] **Step 5: ユーザーに報告して止まる**

報告すること: 全部の確かめの結果（件数）、新しく落ちた試験と切り分け、push の許可の依頼、push の後に本番の DB へ移行2本（`20261008130000_cart_wishlist_ownership.sql` → `20261008130100_cart_checkout_rpcs.sql`）を当てる許可の依頼。当てた後は、2本のファイル名を本番の台帳の版に直し、同じコミットで文書（er.md・checkout-draft.md・checkout-payment.md のリンク、計画と設計書の版の記載）を直して `npm run -s validate-docs` を流す。`checkout_session_claim` の結合テストは移行 B をファイル名の終わり（`_cart_checkout_rpcs.sql`）で探すので、改名に耐えることを確かめる
