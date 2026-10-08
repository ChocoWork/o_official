# ログイン客の注文の持ち主を確かめて保存する（グループ C）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ログインして買った注文を、完了画面に戻らなくても本人の注文履歴に必ず出す。「確認へ進む」と「注文する」の両方でサーバーがログインを確かめ、同じ人の時だけ、注文を作るのと同じ処理の中で持ち主を書く。別の人の注文が履歴に出ることを、サーバーと DB の両方で防ぐ。

**Architecture:** DB に「下書きの買い手」の列（後から変えられない）と「注文の持ち主の付け替え禁止」のトリガーを足し、下書きを取る関数と受付の関数に買い手の引数を足す。サーバーには買い手を確かめる関数を1つ足し、決済の3つの入口（create-session・place-order・resume）が最初に呼ぶ。完了（complete）の紐付けは消す。画面は、ログインの印が古い時に1回だけ新しくして送り直し、ログインの状態が変わった時は入力画面に戻して案内する。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Supabase（Postgres 17、SECURITY DEFINER RPC、トリガー）、`authenticateRequest`（getClaims＋セッションの生存確認）、Jest（ts-jest・Testing Library）＋`pg`、Playwright

**Spec:** [docs/superpowers/specs/2026-10-08-order-owner-binding-design.md](../specs/2026-10-08-order-owner-binding-design.md)（ユーザー承認 2026-10-08）

## Global Constraints

- 画面の文言（設計書のとおり。一字も変えない）:
  - ログインの状態が変わった: `ログインの状態が変わりました。もう一度「確認へ進む」を押してください。`
  - ログインの有効期限が切れ、新しくできなかった（確認へ進む）: `ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。`
- 記号（設計書のとおり）: 401 の `{ error: 'auth_expired' }`、409 の `{ error: 'login_changed', message }`、受付の関数の断り `login_changed`、DB の例外 `CHECKOUT_DRAFT_BUYER_IMMUTABLE`・`CHECKOUT_DRAFT_BUYER_MISMATCH`・`ORDER_OWNER_IMMUTABLE`
- 列と引数の名前: `checkout_drafts.buyer_user_id`（uuid、空はゲスト、外部キーなし）、`claim_checkout_draft(..., _buyer_user_id uuid)`（既定値なし）、`place_order_from_checkout_draft(..., _shown_in_stock_variant_ids bigint[] DEFAULT NULL, _buyer_user_id uuid DEFAULT NULL)`
- 会員の ID は `authenticateRequest` の検証済みの `claims.sub` からだけ取る。画面から送られた値は使わない
- 買い手の確かめは、各入口の守り（Cookie・回数の制限・CSRF）の直後、DB への書き込みと Stripe の呼び出しより前に行う。401・503 は何も変える前に返す
- `CHECKOUT_REQUEST_VERSION` を 2 から 3 に上げ、下書きの見分けの値（fingerprint）に買い手（`buyerUserId`。ゲストは `null`）を含める
- 移行は1本（`supabase/migrations/20261008120000_checkout_order_owner_binding.sql`。本番に当てた後に版へ直す）。`BEGIN;`〜`COMMIT;` で囲み、何度当てても同じ結果になるように書く（`IF NOT EXISTS`・`DROP ... IF EXISTS`・`CREATE OR REPLACE`）。関数は `SECURITY DEFINER`＋`SET search_path = ''`＋完全修飾名。作り直す関数は `PUBLIC`・`anon`・`authenticated` から EXECUTE を外し、`service_role` だけに与える。最後に `NOTIFY pgrst, 'reload schema';`
- `supabase/pending/` は触らない。本番 DB へは、全タスクの後、ユーザーの push の後で許可を得て Supabase MCP の `apply_migration` で当てる。当てた後、ファイル名を本番の台帳の version に直す（`docs/06_Operations/db-migrations.md`）
- 画面と機能の変更は、実装と同じタスクで `docs/02_Requirements/requirements.md` に FREQ 行を足す（FREQ-426・FREQ-427。番号は `grep -oE "FREQ-[0-9]+" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1` の次であることを確かめる）。E2E は `e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`（`ls e2e | grep FR-CHECKOUT- | sort -V | tail -1` の次であることを確かめる）
- E2E は本番ビルド（`next build && next start`）・手元の Supabase（`npx supabase db reset` の直後）で、mobile（390px）・tablet（768px）・desktop（1280px）の3つの画面幅で流す。流す前に3000番に何も無いことを `Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue` で確かめる。DB 結合テストの直後に E2E を流さない（`checkout_session_claim` のテストが関数を消すため。Task 2 で後片付けを直すまで）
- DB 結合テストは、`npx supabase db reset` の後に、フォルダ全体を `--runInBand` で流す（`npx jest tests/integration/db --runInBand`。`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`）
- 実装は Codex（`--model gpt-6.1-sol`、コミットしない。E2E と DB 結合テストは controller が流す）。controller がタスクのファイルだけを名指しでコミットし、レビューは Opus。master に直接コミットし、push しない。`--no-verify` を使わない。コミットメッセージは日本語の Conventional Commits、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 秘密の値（`.env.local` の鍵・JWT_SECRET・パスワード）を画面・ログ・文書・報告に出さない
- 返答・文書・コメントは日本語。コードのコメントは周りに合わせる（理由を書く。何をしているかの繰り返しは書かない）

## Review Focus

本計画のタスクのテストで直接は確かめていないが、使う人が最も踏みやすい入力と状態。各行のテストは括弧内のタスクに足してある。

1. **会員が「確認へ進む」の後、アクセストークンの期限が切れてから「注文する」を押す**: 画面が印を新しくして1回だけ送り直し、受け付けられる。`login_changed` にならない（Task 5 の「401 で印を新しくして1回だけ送り直す」、Task 4 の「401 は Stripe と DB に触れる前に返る」）
2. **ゲストのまま最後まで買う**: 何も断られず、注文の持ち主は空（Task 2 の「ゲストなら持ち主は空」、Task 4 の「ゲストは買い手に null を渡す」、Task 6 で既存のゲスト購入の E2E が通ること）
3. **同じ会員が「注文する」を2回押す（通信のやり直しを含む）**: 2回目は同じ注文を返し、`login_changed` にならない（Task 2 の「同じ買い手なら既にある注文を返す」）
4. **会員を消す（アカウントの削除）**: 注文の持ち主は空になり、トリガーが削除を止めない。その会員の下書きで「注文する」を押しても断られる（Task 2 の「会員を消すと持ち主が空になる」「下書きの買い手は残り、ゲストと一致しない」）
5. **別のタブで支払いが済んだ後に、ログインを切り替えて古いタブで「注文する」を押す**: 支払い済みの知らせ（`payment_done`）を返さず、`login_changed` で断る（Task 4 の「別のタブの支払い済みの画面も、買い手が違えば返さない」）

---

## 本計画の決め事（設計書の書いていないところ）

| ID | 決め事 | 理由 |
|---|---|---|
| P1 | 買い手を確かめる関数は `resolveCheckoutBuyer(request)` で、`{ kind: 'member', userId } \| { kind: 'guest' } \| { kind: 'expired' } \| { kind: 'unavailable' }` を返す。失敗の応答は `checkoutBuyerFailureResponse(kind)`（401 `{ error: 'auth_expired' }`／503 は `authFailureResponse('unavailable')`）。`verified.ok` なのに `sub` が無い時は `expired` | 3つの入口で応答の包み方（`guard.finish` の有無）が違うので、判定と応答を分ける。`sub` の無い印は会員として扱えない |
| P2 | 更新の印の有無は、要求の Cookie の `sb-refresh-token`（`refreshCookieName`）で見る | 設計書 4-1。更新の入口が見る Cookie と同じ |
| P3 | create-session の監査ログの action は今の `checkout.session.create` を使う（設計書第7章の `checkout.create_session` は今の名前に合わせる） | 既存の監査の検索を壊さない |
| P4 | 下書きを取る関数の `_buyer_user_id` には既定値を付けない | `checkout_session_claim` の結合テストが古い13個の版を作り直す。既定値があると、13個での呼び出しが2つの版のどちらか決まらなくなる |
| P5 | `tests/integration/db/checkout_session_claim.integration.test.ts` の後片付け（afterAll）を「消す → 元の移行（20260925000132）→ 本計画の移行」に変え、DB を移行の後の状態に戻す | 新しい結合テストが下書きを取る関数を使う。テストの順番に依らず通り、DB 結合の後の E2E も壊さない |
| P6 | E2E の会員のログインは、手元の Supabase に会員を作り（auth admin API）、既存の `setLoginTwoFactorCookie` でパスワード確認の後の状態にし、`/api/auth/login/resend` で確認コードを送り、手元のメール受けから読み、`/api/auth/otp/verify` に送る。POST には `origin` の見出しを付ける | ボット対策（Turnstile）の付いた `/api/auth/login` を通らずに、アプリが出す本物の Cookie を得る。送信元の確かめ（`src/proxy.ts`）は Origin の無い POST を断る |
| P7 | DB 結合テストの下書きの試験データ（`createDraft`）に、任意の `buyerUserId` を足す | 下書きの買い手は作った後に変えられない（トリガー）ので、作る時に入れる |
| P8 | place-order・resume で、Stripe の決済の画面の下書きを読む時に `buyer_user_id` も読む。支払い済みの別の画面の下書きは `checkout_session_id` で引く | 設計書 4-3・4-4 |

---

## File Structure

| ファイル | 責務 |
|---|---|
| `supabase/migrations/20261008120000_checkout_order_owner_binding.sql`（新規） | 下書きの買い手の列とトリガー、注文の持ち主のトリガー、2つの関数の作り直し（Task 2） |
| `tests/integration/db/checkout_order_owner_binding.integration.test.ts`（新規） | 上の DB の決まりの結合テスト（Task 2） |
| `tests/integration/db/helpers/order-fixtures.ts` | `createDraft` に `buyerUserId` を足す（Task 2） |
| `tests/integration/db/checkout_session_claim.integration.test.ts` | 後片付けで DB を移行の後に戻す（Task 2） |
| `src/lib/orders/order-payment-types.ts` | 受付の関数の断りに `login_changed` を足す（Task 4。place-order の `REJECTION_BY_RPC` と同じコミットにしないと型の確かめが落ちる） |
| `src/features/checkout/services/checkout-buyer.ts`（新規） | 買い手の確かめと失敗の応答（Task 3） |
| `tests/unit/features/checkout/services/checkout-buyer.test.ts`（新規） | 上の単体テスト（Task 3） |
| `src/app/api/checkout/create-session/route.ts` | 買い手の確かめ、見分けの値と下書きを取る関数への買い手（Task 3） |
| `src/app/api/checkout/place-order/route.ts` | 買い手の確かめと比べ、`login_changed`、受付の関数への買い手（Task 4） |
| `src/app/api/checkout/resume/route.ts` | 買い手の確かめと比べ（Task 4） |
| `src/app/api/checkout/complete/route.ts` | 持ち主を書く処理を消す（Task 4） |
| `src/lib/client-fetch.ts` | 印を1回だけ新しくする関数を外へ出す（Task 5） |
| `src/app/checkout/_lib/checkout-api.ts` | 401 で新しくして送り直す、`login_changed`・有効期限切れの扱い（Task 5） |
| `src/app/checkout/page.tsx` | `login_changed` と有効期限切れの案内、ログインの状態の読み直し（Task 5） |
| `e2e/member-session-helpers.ts`（新規） | E2E の会員の作成とログイン（Task 1） |
| `e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`（新規） | FREQ-426-AC-01・FREQ-427-AC-01 の E2E（Task 6） |
| 文書（Task 6） | `requirements.md`・レビュー台帳・`api-spec.md`・`checkout-payment.md`・`13_checkout.md`・`checkout-draft.md`・`er.md` |

---

### Task 1: E2E の会員のログイン（手元だけ）

設計書第12章の「計画の最初の作業で、手元の環境でログインを通せるか確かめる」。後の Task 6 が使う。

**Files:**
- Create: `e2e/member-session-helpers.ts`
- 確かめ用（コミットしない）: `e2e/zz-member-session-smoke.spec.ts`

**Interfaces:**
- Consumes: `setLoginTwoFactorCookie(page, email, userId)`（`e2e/auth-2fa-test-utils.ts`）、`isLocalUrl`（`scripts/e2e/environment.ts`）、環境変数 `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`MAIL_LOCAL_URL`（`playwright.config.ts` が手元の値を入れる）
- Produces: `createTestMember(label: string): Promise<TestMember>`、`loginAsMember(page: Page, member: TestMember): Promise<void>`、`type TestMember = { userId: string; email: string }`

- [ ] **Step 1: 助けを書く**

`e2e/member-session-helpers.ts`:

```ts
/**
 * E2E の会員（手元の Supabase だけ）。グループ C の FR-CHECKOUT-046 が使う。
 * パスワードの確かめ（Turnstile つきの /api/auth/login）は既存の setLoginTwoFactorCookie で済んだ状態にし、
 * 確認コードを /api/auth/login/resend で送って手元のメール受けから読み、/api/auth/otp/verify で
 * アプリが出す本物のログインの Cookie を得る（計画の決め事 P6）。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { APIRequestContext, Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

export type TestMember = { userId: string; email: string };

type MailpitSearch = { messages?: Array<{ ID: string; Created?: string }> };
type MailpitMessage = { Text?: string; HTML?: string };

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('会員を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 試験ごとの会員を作る（メール確認済み。会員の行は auth.users への追加で自動で作られる） */
export async function createTestMember(label: string): Promise<TestMember> {
  const email = `e2e-member-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const { data, error } = await localAdmin().auth.admin.createUser({
    email,
    email_confirm: true,
    password: `E2e-${randomBytes(12).toString('hex')}!`,
  });
  if (error || !data.user) {
    throw error ?? new Error('会員を作れない');
  }
  return { userId: data.user.id, email };
}

async function readLatestCode(request: APIRequestContext, email: string, sentAfter: number): Promise<string> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) {
    throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const search = await request.get(new URL('/api/v1/search', mailUrl).toString(), {
      params: { query: `to:${email}` },
      timeout: 5_000,
    });
    if (search.ok()) {
      const body = (await search.json()) as MailpitSearch;
      const latest = (body.messages ?? []).find((message) => !message.Created || Date.parse(message.Created) >= sentAfter - 1_000);
      if (latest) {
        const message = await request.get(new URL(`/api/v1/message/${encodeURIComponent(latest.ID)}`, mailUrl).toString(), { timeout: 5_000 });
        const content = (await message.json()) as MailpitMessage;
        const code = `${content.Text ?? ''}\n${content.HTML ?? ''}`.match(/\b(\d{6})\b/)?.[1];
        if (code) {
          return code;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('確認コードのメールが届かない');
}

/** page の文脈（同じブラウザ）に、会員としてのログインの Cookie を置く */
export async function loginAsMember(page: Page, member: TestMember): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.goto('/');
  }
  const origin = new URL(page.url()).origin;
  await setLoginTwoFactorCookie(page, member.email, member.userId);
  const sentAfter = Date.now();
  const resend = await page.request.post('/api/auth/login/resend', { headers: { origin } });
  if (!resend.ok()) {
    throw new Error(`確認コードを送れない: ${resend.status()}`);
  }
  const code = await readLatestCode(page.request, member.email, sentAfter);
  const verify = await page.request.post('/api/auth/otp/verify', { headers: { origin }, data: { code } });
  if (!verify.ok()) {
    throw new Error(`確認コードが通らない: ${verify.status()}`);
  }
  const me = await page.request.get('/api/auth/me');
  const body = (await me.json()) as { authenticated?: boolean; user?: { id?: string } };
  if (!body.authenticated || body.user?.id !== member.userId) {
    throw new Error('会員としてログインできていない');
  }
}
```

（Mailpit の応答の形・確認コードのメールの本文・`/api/auth/me` の形が違えば、手元で確かめて合わせる。`/api/auth/login/resend` の入力に本文が要る時は、そのルートの zod の形に合わせる。）

- [ ] **Step 2: 確かめ用の spec を書く（コミットしない）**

`e2e/zz-member-session-smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { createTestMember, loginAsMember } from './member-session-helpers';

test('手元の会員としてログインでき、注文履歴の入口が本人として答える', async ({ page }) => {
  const member = await createTestMember('smoke');
  await loginAsMember(page, member);
  const orders = await page.request.get('/api/orders');
  expect(orders.status()).toBe(200);
});
```

- [ ] **Step 3: controller が流す**

Run（controller。3000番を止め、`npx supabase db reset` の後）: `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/zz-member-session-smoke.spec.ts --reporter=line`
Expected: 1 passed

- [ ] **Step 4: 確かめ用の spec を消して、助けだけをコミット**

`e2e/zz-member-session-smoke.spec.ts` を消す（この作業で作った一時のファイル）。

```bash
git add e2e/member-session-helpers.ts
git commit -m "test(e2e): 手元の会員としてログインする助けを足す"
```

通せなかった時（確認コードのメールが届かない・Cookie が出ない）は、BLOCKED として理由を報告する。controller がユーザーに相談する。

---

### Task 2: DB の決まり（移行と結合テスト）

**Files:**
- Create: `supabase/migrations/20261008120000_checkout_order_owner_binding.sql`
- Create: `tests/integration/db/checkout_order_owner_binding.integration.test.ts`
- Modify: `tests/integration/db/helpers/order-fixtures.ts`（`createDraft` に `buyerUserId`）
- Modify: `tests/integration/db/checkout_session_claim.integration.test.ts`（afterAll）

**Interfaces:**
- Produces: 列 `checkout_drafts.buyer_user_id uuid`、関数 `claim_checkout_draft(text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb, uuid)`、`place_order_from_checkout_draft(uuid, text, text, integer, integer, text, timestamptz, text, bigint[], uuid)`、受付の関数の断り `'login_changed'`（TS の型 `PlaceOrderRejection` に足すのは Task 4）

- [ ] **Step 1: 試験データに買い手を足す**

`tests/integration/db/helpers/order-fixtures.ts` の `createDraft` の options に `buyerUserId?: string | null` を足し、INSERT の列に `buyer_user_id` を足す（値は `options.buyerUserId ?? null`）。ほかの呼び出し元は変えない。

- [ ] **Step 2: 落ちる結合テストを書く**

`tests/integration/db/checkout_order_owner_binding.integration.test.ts`（`describeLocalDb` を使う。会員は `auth.users` に入れて作る。`tests/integration/db/order_internal_columns.integration.test.ts` の 88〜125 行と同じ形）:

```ts
/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, uniqueSuffix } from './helpers/order-fixtures';

async function createMember(db: PgClient, label: string): Promise<string> {
  const result = await db.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
    [`owner-binding-${label}-${uniqueSuffix()}@example.com`],
  );
  return result.rows[0].id as string;
}

async function placeFromFinalScreen(
  db: PgClient,
  draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number },
  buyerUserId: string | null,
) {
  const result = await db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null,
       _shown_in_stock_variant_ids => array[]::bigint[], _buyer_user_id => $5)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, buyerUserId],
  );
  return result.rows[0] as { order_id: string | null; order_status: string | null; created: boolean; rejection: string | null };
}

async function placeFromReconciler(
  db: PgClient,
  draft: { draftId: string; cartSessionId: string; checkoutSessionId: string; totalAmount: number },
) {
  const result = await db.query(
    `select * from public.place_order_from_checkout_draft(
       _draft_id => $1, _checkout_session_id => $2, _cart_session_id => $3,
       _stripe_amount_total => $4, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => now(), _payment_intent_id => null)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
  );
  return result.rows[0] as { order_id: string | null; rejection: string | null };
}

async function ownerOf(db: PgClient, orderId: string): Promise<string | null> {
  const result = await db.query('select user_id from public.orders where id = $1', [orderId]);
  return (result.rows[0]?.user_id as string | null) ?? null;
}

describeLocalDb('integration: 注文の持ち主の確かめ（グループ C）', (db) => {
  const members: string[] = [];
  afterAll(async () => {
    for (const id of members) await db().query('delete from auth.users where id = $1', [id]);
  });
  async function member(label: string) {
    const id = await createMember(db(), label);
    members.push(id);
    return id;
  }

  test('「注文する」の買い手が下書きと同じなら、注文を作るのと同時に持ち主を書く', async () => {
    const buyer = await member('same');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
    const row = await placeFromFinalScreen(db(), draft, buyer);
    expect(row.rejection).toBeNull();
    expect(row.created).toBe(true);
    expect(await ownerOf(db(), row.order_id as string)).toBe(buyer);
  });

  test('ゲストなら持ち主は空', async () => {
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId });
    const row = await placeFromFinalScreen(db(), draft, null);
    expect(row.rejection).toBeNull();
    expect(await ownerOf(db(), row.order_id as string)).toBeNull();
  });

  test('買い手が違えば login_changed で断り、注文も在庫の確保も作らない', async () => {
    const recorded = await member('recorded');
    const other = await member('other');
    const { itemId, variantId } = await createCatalogFixture(db(), { stock: 3 });
    const draft = await createDraft(db(), { itemId, buyerUserId: recorded });
    for (const buyer of [other, null]) {
      const row = await placeFromFinalScreen(db(), draft, buyer);
      expect(row).toMatchObject({ order_id: null, created: false, rejection: 'login_changed' });
    }
    const guestDraft = await createDraft(db(), { itemId });
    expect((await placeFromFinalScreen(db(), guestDraft, recorded)).rejection).toBe('login_changed');
    const orders = await db().query('select count(*)::int as n from public.orders where checkout_session_id = any($1)', [[draft.checkoutSessionId, guestDraft.checkoutSessionId]]);
    expect(orders.rows[0].n).toBe(0);
    const stock = await db().query('select stock_quantity from public.item_variants where id = $1', [variantId]);
    expect(stock.rows[0].stock_quantity).toBe(3);
  });

  test('同じ買い手の2回目は同じ注文を返し、違う買い手には注文の ID を返さない', async () => {
    const buyer = await member('retry');
    const other = await member('retry-other');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
    const first = await placeFromFinalScreen(db(), draft, buyer);
    const second = await placeFromFinalScreen(db(), draft, buyer);
    expect(second).toMatchObject({ order_id: first.order_id, created: false, rejection: null });
    expect(await placeFromFinalScreen(db(), draft, other)).toMatchObject({ order_id: null, rejection: 'login_changed' });
  });

  test('下書きの行が無い時は、既にある注文の持ち主と比べる', async () => {
    const buyer = await member('no-draft');
    const other = await member('no-draft-other');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
    const first = await placeFromFinalScreen(db(), draft, buyer);
    await db().query('delete from public.checkout_drafts where id = $1', [draft.draftId]);
    expect(await placeFromFinalScreen(db(), draft, other)).toMatchObject({ order_id: null, rejection: 'login_changed' });
    expect((await placeFromFinalScreen(db(), draft, buyer)).order_id).toBe(first.order_id);
  });

  test('照合の経路（「注文する」を通らない支払い）では、下書きに買い手があっても持ち主を付けない', async () => {
    const buyer = await member('reconciler');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const draft = await createDraft(db(), { itemId, buyerUserId: buyer });
    const row = await placeFromReconciler(db(), draft);
    expect(row.rejection).toBeNull();
    expect(await ownerOf(db(), row.order_id as string)).toBeNull();
  });

  test('下書きの買い手は後から変えられない（空から会員へも）', async () => {
    const buyer = await member('immutable');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const guestDraft = await createDraft(db(), { itemId });
    await expect(
      db().query('update public.checkout_drafts set buyer_user_id = $1 where id = $2', [buyer, guestDraft.draftId]),
    ).rejects.toThrow('CHECKOUT_DRAFT_BUYER_IMMUTABLE');
    const memberDraft = await createDraft(db(), { itemId, buyerUserId: buyer });
    await expect(
      db().query('update public.checkout_drafts set buyer_user_id = null where id = $1', [memberDraft.draftId]),
    ).rejects.toThrow('CHECKOUT_DRAFT_BUYER_IMMUTABLE');
  });

  test('注文の持ち主: 空から会員へは書け、別の会員へも空へも付け替えられない', async () => {
    const owner = await member('owner');
    const other = await member('owner-other');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const row = await placeFromFinalScreen(db(), await createDraft(db(), { itemId }), null);
    const orderId = row.order_id as string;
    await db().query('update public.orders set user_id = $1 where id = $2', [owner, orderId]);
    expect(await ownerOf(db(), orderId)).toBe(owner);
    await expect(db().query('update public.orders set user_id = $1 where id = $2', [other, orderId])).rejects.toThrow('ORDER_OWNER_IMMUTABLE');
    await expect(db().query('update public.orders set user_id = null where id = $1', [orderId])).rejects.toThrow('ORDER_OWNER_IMMUTABLE');
  });

  test('会員を消すと注文の持ち主は空になり、その会員の下書きでは誰も注文できない', async () => {
    const leaving = await createMember(db(), 'leaving');
    const { itemId } = await createCatalogFixture(db(), { stock: 0 });
    const ordered = await placeFromFinalScreen(db(), await createDraft(db(), { itemId, buyerUserId: leaving }), leaving);
    const pendingDraft = await createDraft(db(), { itemId, buyerUserId: leaving });
    await db().query('delete from auth.users where id = $1', [leaving]);
    expect(await ownerOf(db(), ordered.order_id as string)).toBeNull();
    expect((await placeFromFinalScreen(db(), pendingDraft, null)).rejection).toBe('login_changed');
  });

  test('下書きを取る関数は買い手を書き、同じ見分けの値で買い手が違えば例外', async () => {
    const buyer = await member('claim');
    const other = await member('claim-other');
    const sessionId = `fx-claim-${uniqueSuffix()}`;
    const fingerprint = `v3:${'a'.repeat(64)}`;
    const claim = (buyerUserId: string | null) => db().query(
      `select * from public.claim_checkout_draft(
         $1, 3::smallint, $2, 'custom', 'http://localhost:3000', 'stripe_card', 'jpy',
         5000, 0, 0, 5000, '{}'::jsonb,
         '[{"item_id":1,"item_name":"x","item_price":5000,"quantity":1,"line_total":5000}]'::jsonb, $3)`,
      [sessionId, fingerprint, buyerUserId],
    );
    const created = await claim(buyer);
    const draftId = created.rows[0].id as string;
    const stored = await db().query('select buyer_user_id from public.checkout_drafts where id = $1', [draftId]);
    expect(stored.rows[0].buyer_user_id).toBe(buyer);
    expect((await claim(buyer)).rows[0].id).toBe(draftId);
    await expect(claim(other)).rejects.toThrow('CHECKOUT_DRAFT_BUYER_MISMATCH');
    await expect(claim(null)).rejects.toThrow('CHECKOUT_DRAFT_BUYER_MISMATCH');
  });
});
```

（`createCatalogFixture` の商品は `item_id` が試験ごとに違うので、下書きを取る関数の明細の `item_id` は検証に使われない形のままでよい。下書きを取る関数の入力の検証で落ちる時は、検証の条件に合わせて値を直す。）

- [ ] **Step 3: 落ちることを確かめる**

Run（controller）: `npx supabase db reset` の後、`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db/checkout_order_owner_binding.integration.test.ts --runInBand`
Expected: FAIL（`buyer_user_id` の列が無い・関数の引数が合わない）

- [ ] **Step 4: 移行を書く**

`supabase/migrations/20261008120000_checkout_order_owner_binding.sql`。冒頭の注記と、次の4つの部分を書く。

(a) 下書きの買い手の列とトリガー:

```sql
-- グループ C: ログイン客の注文の持ち主を確かめて保存する
-- （docs/superpowers/specs/2026-10-08-order-owner-binding-design.md 第5章）
BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS buyer_user_id uuid;

COMMENT ON COLUMN public.checkout_drafts.buyer_user_id IS
  '「確認へ進む」でサーバーが確かめた会員の ID。空はゲスト。後から変えられない。外部キーは付けない（会員を消した後も誰とも一致せず、「注文する」が断られる側に倒すため。設計書 5-4）。';

CREATE OR REPLACE FUNCTION public.guard_checkout_draft_buyer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.buyer_user_id IS DISTINCT FROM OLD.buyer_user_id THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_BUYER_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS checkout_drafts_buyer_immutable ON public.checkout_drafts;
CREATE TRIGGER checkout_drafts_buyer_immutable
  BEFORE UPDATE OF buyer_user_id ON public.checkout_drafts
  FOR EACH ROW EXECUTE FUNCTION public.guard_checkout_draft_buyer();
```

(b) 注文の持ち主のトリガー:

```sql
-- 注文の持ち主は空から値へだけ書ける。別の会員への付け替えは断る。
-- 空へ戻すのは、会員を消して外部キー（ON DELETE SET NULL）が空にする時だけ通す（設計書 5-5）。
-- RLS に左右されずに profiles を見るため SECURITY DEFINER にする。
CREATE OR REPLACE FUNCTION public.guard_order_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.user_id IS NULL OR NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles AS p WHERE p.user_id = OLD.user_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ORDER_OWNER_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_order_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_owner_immutable ON public.orders;
CREATE TRIGGER orders_owner_immutable
  BEFORE UPDATE OF user_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_owner();
```

(c) 下書きを取る関数: `supabase/migrations/20260925000132_add_checkout_session_claim_rpcs.sql` の `CREATE OR REPLACE FUNCTION public.claim_checkout_draft(...)` 〜 `$$;` をそのまま写し、次の4点だけを変える。

1. 前に `DROP FUNCTION IF EXISTS public.claim_checkout_draft(text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb);` を置く
2. 引数の最後に `_buyer_user_id uuid` を足す（既定値なし。決め事 P4）
3. `INSERT INTO public.checkout_drafts AS d (...)` の列に `buyer_user_id`、値に `_buyer_user_id` を足す
4. `CHECKOUT_FINGERPRINT_MISMATCH` の確かめの直後に、次を足す:

```sql
  -- 見分けの値に買い手を含めるので起きない想定。起きたら同じ下書きを別の人に渡さない（設計書 5-2）
  IF claimed.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RAISE EXCEPTION 'CHECKOUT_DRAFT_BUYER_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
```

関数の後に、14個の引数の形で `REVOKE ALL ... FROM PUBLIC, anon, authenticated;` と `GRANT EXECUTE ... TO service_role;` を置く。

(d) 受付の関数: `supabase/migrations/20261007133711_checkout_final_screen_place_order.sql` の `CREATE OR REPLACE FUNCTION public.place_order_from_checkout_draft(...)` 〜 `$$;` をそのまま写し、次を変える。

1. 前に `DROP FUNCTION IF EXISTS public.place_order_from_checkout_draft(uuid, text, text, integer, integer, text, timestamptz, text, bigint[]);` を置く
2. 引数の最後に `_buyer_user_id uuid DEFAULT NULL` を足す
3. DECLARE に `existing_owner uuid;` を足す
4. 下書きをロックする `SELECT d.* INTO draft_row ... FOR UPDATE;` の直後（既にある注文を読み直すより前）に、次を足す:

```sql
  -- 「注文する」の経路では、「確認へ進む」の時の買い手と今の買い手が同じ時だけ進む（グループ C 設計書 5-3）。
  -- 既にある注文を返すより前に比べ、違う人に注文の ID を返さない。
  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    IF draft_row.id IS NOT NULL THEN
      IF draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
        RETURN;
      END IF;
    ELSE
      SELECT o.user_id
      INTO existing_owner
      FROM public.orders AS o
      WHERE o.checkout_session_id = _checkout_session_id;
      IF FOUND AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
        RETURN;
      END IF;
    END IF;
  END IF;
```

5. `INSERT INTO public.orders (...)` の列に `user_id` を足し、値に次を足す:

```sql
      -- 照合の経路（「注文する」を通らない支払い）では、払った時のログインを確かめていないので持ち主を付けない
      CASE WHEN _shown_in_stock_variant_ids IS NOT NULL THEN draft_row.buyer_user_id ELSE NULL END,
```

関数の後に、10個の引数の形で `REVOKE ALL ... FROM PUBLIC, anon, authenticated;` と `GRANT EXECUTE ... TO service_role;` を置く。

最後に:

```sql
NOTIFY pgrst, 'reload schema';

COMMIT;
```

- [ ] **Step 5: claim のテストの後片付けを直す**

`tests/integration/db/checkout_session_claim.integration.test.ts`:

```ts
const OWNER_BINDING_SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations",
    fs.readdirSync(path.join(process.cwd(), "supabase/migrations"))
      .find((name: string) => name.endsWith("_checkout_order_owner_binding.sql")),
  ),
  "utf8",
);
```

を足し、afterAll を次にする（DB を移行の後の状態に戻す。決め事 P5）:

```ts
  afterAll(async () => {
    if (clientA) {
      // 試験用に消した列と関数を、移行の後の状態（元の移行＋グループ C の移行）に戻す。
      // 戻さないと、後に走る DB 結合テストと E2E の「確認へ進む」が関数の無い DB に当たる。
      await clientA.query(CLEANUP_SQL);
      await clientA.query(COMPAT_SQL);
      await clientA.query(OWNER_BINDING_SQL);
      await clientA.end();
    }
    if (clientB) await clientB.end();
  });
```

- [ ] **Step 6: 通ることを確かめる**

Run（controller）: `npx supabase db reset` の後、`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx jest tests/integration/db --runInBand`
Expected: 新しいテストを含めて全件 PASS（`security_definer_search_path`・`checkout_session_claim`・`place_order_*` も）

続けて（controller）: DB 結合の直後に `npx supabase status` が healthy のまま、`select count(*) from pg_proc where proname = 'claim_checkout_draft'` が 1 であること（後片付けで移行の後に戻っている）

- [ ] **Step 7: コミット**

```bash
git add supabase/migrations/20261008120000_checkout_order_owner_binding.sql tests/integration/db/checkout_order_owner_binding.integration.test.ts tests/integration/db/helpers/order-fixtures.ts tests/integration/db/checkout_session_claim.integration.test.ts
git commit -m "feat(db): 下書きの買い手と注文の持ち主の決まりを足し、受付で買い手を比べる"
```

---

### Task 3: 買い手の確かめと「確認へ進む」

**Files:**
- Create: `src/features/checkout/services/checkout-buyer.ts`
- Create: `tests/unit/features/checkout/services/checkout-buyer.test.ts`
- Modify: `src/app/api/checkout/create-session/route.ts`
- Test: `tests/unit/api/checkout/create-session-route.test.ts`

**Interfaces:**
- Consumes: `authenticateRequest`・`authFailureResponse`（`src/lib/auth/authenticate.ts`）、`refreshCookieName`（`src/lib/cookie.ts`）、Task 2 の `claim_checkout_draft(..., _buyer_user_id)`
- Produces: `resolveCheckoutBuyer(request: NextRequest): Promise<CheckoutBuyerResolution>`、`checkoutBuyerFailureResponse(kind: 'expired' | 'unavailable'): NextResponse`、`buyerUserIdOf(buyer: CheckoutBuyer): string | null`、型 `CheckoutBuyer = { kind: 'member'; userId: string } | { kind: 'guest' }`、`CheckoutBuyerResolution = CheckoutBuyer | { kind: 'expired' } | { kind: 'unavailable' }`

- [ ] **Step 1: 落ちる単体テストを書く**

`tests/unit/features/checkout/services/checkout-buyer.test.ts`:

```ts
/** @jest-environment node */
import { NextRequest } from 'next/server';

const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  ...jest.requireActual('@/lib/auth/authenticate'),
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));

import { buyerUserIdOf, checkoutBuyerFailureResponse, resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';

function request(cookie = ''): NextRequest {
  return new NextRequest('http://localhost/api/checkout/place-order', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

describe('resolveCheckoutBuyer', () => {
  beforeEach(() => mockAuthenticate.mockReset());

  test('検証済みの印なら会員（ID は claims.sub）', async () => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: { sub: 'user-1' } });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({ kind: 'member', userId: 'user-1' });
  });

  test('印が無ければゲスト', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'missing' });
    await expect(resolveCheckoutBuyer(request())).resolves.toEqual({ kind: 'guest' });
  });

  test.each(['invalid', 'revoked'] as const)('%s で更新の印があれば expired', async (reason) => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'expired' });
  });

  test.each(['invalid', 'revoked'] as const)('%s で更新の印が無ければゲスト（古い印は使わない）', async (reason) => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason });
    await expect(resolveCheckoutBuyer(request('sb-access-token=old'))).resolves.toEqual({ kind: 'guest' });
  });

  test('確かめられなければ unavailable', async () => {
    mockAuthenticate.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'unavailable' });
  });

  test('sub の無い印は会員として扱わない', async () => {
    mockAuthenticate.mockResolvedValue({ ok: true, claims: {} });
    await expect(resolveCheckoutBuyer(request('sb-refresh-token=r1'))).resolves.toEqual({ kind: 'expired' });
  });
});

describe('checkoutBuyerFailureResponse', () => {
  test('expired は 401 auth_expired', async () => {
    const response = checkoutBuyerFailureResponse('expired');
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'auth_expired' });
  });

  test('unavailable は 503 と Retry-After', () => {
    const response = checkoutBuyerFailureResponse('unavailable');
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
  });
});

test('buyerUserIdOf はゲストを null にする', () => {
  expect(buyerUserIdOf({ kind: 'member', userId: 'u' })).toBe('u');
  expect(buyerUserIdOf({ kind: 'guest' })).toBeNull();
});
```

Run: `npx jest tests/unit/features/checkout/services/checkout-buyer.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 2: 関数を書く**

`src/features/checkout/services/checkout-buyer.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { refreshCookieName } from '@/lib/cookie';

/** 決済の入口が扱う買い手（グループ C 設計書 4-1）。会員の ID は検証済みのログインからだけ取る */
export type CheckoutBuyer = { kind: 'member'; userId: string } | { kind: 'guest' };

export type CheckoutBuyerResolution = CheckoutBuyer | { kind: 'expired' } | { kind: 'unavailable' };

/**
 * ログインを確かめて、この要求の買い手を決める。決済の入口は、守り（Cookie・回数の制限・CSRF）の直後、
 * 何かを変える前に呼ぶ。だから 401 の後に画面が送り直しても二重にならない。
 */
export async function resolveCheckoutBuyer(request: NextRequest): Promise<CheckoutBuyerResolution> {
  const verified = await authenticateRequest(request);
  if (verified.ok) {
    const userId = verified.claims.sub;
    return typeof userId === 'string' && userId.length > 0 ? { kind: 'member', userId } : { kind: 'expired' };
  }
  if (verified.reason === 'missing') {
    return { kind: 'guest' };
  }
  if (verified.reason === 'unavailable') {
    // 確かめられないままゲストとして受け付けると、「確認へ進む」と「注文する」の比べが意味を失う（設計書 C3）
    return { kind: 'unavailable' };
  }
  // 新しくできる印が無ければ、残った古い印は使わずゲストとして扱う。同じ断りを繰り返さない（設計書 4-1）
  return request.cookies.get(refreshCookieName)?.value ? { kind: 'expired' } : { kind: 'guest' };
}

export function checkoutBuyerFailureResponse(kind: 'expired' | 'unavailable'): NextResponse {
  if (kind === 'unavailable') {
    return authFailureResponse('unavailable');
  }
  return NextResponse.json({ error: 'auth_expired' }, { status: 401 });
}

export function buyerUserIdOf(buyer: CheckoutBuyer): string | null {
  return buyer.kind === 'member' ? buyer.userId : null;
}
```

Run: `npx jest tests/unit/features/checkout/services/checkout-buyer.test.ts`
Expected: PASS

- [ ] **Step 3: create-session の落ちるテストを足す**

`tests/unit/api/checkout/create-session-route.test.ts` に、`@/features/checkout/services/checkout-buyer` の `resolveCheckoutBuyer` を差し替える mock を足し（既定は `{ kind: 'guest' }`）、次のケースを足す:

- 会員なら `claim_checkout_draft` の引数 `_buyer_user_id` が会員の ID、ゲストなら `null`
- 会員とゲストで、同じ入力でも `_request_fingerprint` が違う（`v3:` で始まる）
- `_request_version` が 3
- `{ kind: 'expired' }` なら 401 `{ error: 'auth_expired' }` を返し、カートの読み出し・`claim_checkout_draft`・Stripe の呼び出しが無い
- `{ kind: 'unavailable' }` なら 503 を返し、同じく何も呼ばない
- CSRF で断られる時は、買い手の確かめを呼ばない（守りの後に確かめる）

既存のケースで `_request_version ?? 2` などを前提にしている箇所は 3 に直す。

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts`
Expected: FAIL（新しいケース）

- [ ] **Step 4: create-session を直す**

`src/app/api/checkout/create-session/route.ts`:

1. `CHECKOUT_REQUEST_VERSION` を `3` にする
2. CSRF の確かめ（`requireCsrfOrDeny`）の直後、本文の読み取りの前に:

```ts
    // 買い手（会員かゲスト）は検証済みのログインからだけ決め、下書きに記録する（グループ C 設計書 4-2）
    const buyerResolution = await resolveCheckoutBuyer(req);
    if (buyerResolution.kind === "expired" || buyerResolution.kind === "unavailable") {
      return checkoutBuyerFailureResponse(buyerResolution.kind);
    }
    const buyerUserId = buyerUserIdOf(buyerResolution);
```

3. `buildCheckoutRequestFingerprint` の引数と正準 JSON に `buyerUserId: string | null` を足す（買い手が違えば別の下書きになる）。呼び出しに `buyerUserId` を渡す
4. 下書きを取る関数の呼び出し（`claim_checkout_draft` の rpc）に `_buyer_user_id: params.buyerUserId` を足し、その関数の引数の型と呼び出し元（`claimParams`）に `buyerUserId` を通す

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts tests/unit/features/checkout/services/checkout-buyer.test.ts`
Expected: PASS

- [ ] **Step 5: 型と lint**

Run: `npx tsc --noEmit -p tsconfig.json` と `npx eslint src/features/checkout/services/checkout-buyer.ts src/app/api/checkout/create-session/route.ts tests/unit/features/checkout/services/checkout-buyer.test.ts tests/unit/api/checkout/create-session-route.test.ts`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/features/checkout/services/checkout-buyer.ts tests/unit/features/checkout/services/checkout-buyer.test.ts src/app/api/checkout/create-session/route.ts tests/unit/api/checkout/create-session-route.test.ts
git commit -m "feat(checkout): 確認へ進むでログインを確かめ、下書きに買い手を記録する"
```

---

### Task 4: 「注文する」・入り直し・完了

**Files:**
- Modify: `src/lib/orders/order-payment-types.ts`（`PLACE_ORDER_REJECTIONS` に `'login_changed'`）
- Modify: `src/app/api/checkout/place-order/route.ts`
- Modify: `src/app/api/checkout/resume/route.ts`
- Modify: `src/app/api/checkout/complete/route.ts`
- Test: `tests/unit/api/checkout/place-order-route.test.ts`、`tests/unit/api/checkout/resume-route.test.ts`、`tests/unit/api/checkout/complete-route.test.ts`

**Interfaces:**
- Consumes: Task 3 の `resolveCheckoutBuyer`・`checkoutBuyerFailureResponse`・`buyerUserIdOf`、Task 2 の `place_order_from_checkout_draft(..., _buyer_user_id)` と断り `login_changed`
- Produces: place-order の 409 `{ error: 'login_changed', message: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。' }`、3つの入口の 401 `{ error: 'auth_expired' }`・503

- [ ] **Step 1: place-order の落ちるテストを足す**

`tests/unit/api/checkout/place-order-route.test.ts` に `resolveCheckoutBuyer` の mock を足し（既定は `{ kind: 'guest' }`）、`DRAFT` に `buyer_user_id: null` を足して、次のケースを足す:

- 下書きの買い手が会員 A で、今の買い手がゲスト（または会員 B）なら、409 `login_changed`（文言は Global Constraints のとおり）。受付の関数を呼ばない。決済の画面を閉じ（`expireOpenCheckoutSession` を呼ぶ）、監査ログに `reason: 'login_changed'`・`draft_buyer_user_id`・`buyer_user_id` を残す
- 決済の画面が `complete`（支払い済み）でも、買い手が違えば `payment_done` ではなく `login_changed`（比べが支払い済みの判断より前）
- 残り10分未満でも、買い手が違えば `session_expired` ではなく `login_changed`
- 別のタブの支払い済みの画面（`findPaidCheckoutSession` が別の ID を返す）があり、その下書きの買い手が今の買い手と違えば、`payment_done` を返さず `login_changed`。同じなら今のまま `payment_done`
- 買い手が同じなら、受付の関数の引数 `_buyer_user_id` が会員の ID（ゲストは `null`）
- 受付の関数が `rejection: 'login_changed'` を返したら 409 `login_changed`、決済の画面を閉じる
- `{ kind: 'expired' }` なら 401 `auth_expired`、`{ kind: 'unavailable' }` なら 503。どちらも Stripe・DB を呼ばない
- 下書きが無い時は比べず、今のまま `superseded`

下書きの読み出しの chain（`mockDraftsChain`）は、`checkout_session_id` で引く問い合わせ（支払い済みの別の画面の下書き）にも答えられるようにする。

Run: `npx jest tests/unit/api/checkout/place-order-route.test.ts`
Expected: FAIL（新しいケース）

- [ ] **Step 2: place-order を直す**

`src/lib/orders/order-payment-types.ts` の `PLACE_ORDER_REJECTIONS` の最後に `'login_changed',` を足し、注記に「login_changed は受け付けの窓口から呼んだときだけ返る（グループ C 設計書 5-3）」を足す。下の 1 と同じコミットにする（`REJECTION_BY_RPC` は `Record<PlaceOrderRejection, ...>` なので、片方だけだと型の確かめが落ちる）。

`src/app/api/checkout/place-order/route.ts`:

1. `RejectionCode` に `'login_changed'`、`REJECTION_MESSAGES` に `login_changed: 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。'`、`REJECTION_BY_RPC` に `login_changed: 'login_changed'` を足す
2. `DraftRow` と `loadDraft` の select に `buyer_user_id`（`string | null`）を足す。支払い済みの別の画面の下書きの買い手を `checkout_session_id` で引く関数を足す:

```ts
/** 支払い済みの別の画面の下書きの買い手。下書きが無ければ undefined（比べられないので返さない側に倒す） */
async function buyerOfCheckoutSession(checkoutSessionId: string): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from('checkout_drafts')
    .select('buyer_user_id')
    .eq('checkout_session_id', checkoutSessionId)
    .maybeSingle<{ buyer_user_id: string | null }>();
  if (error) {
    throw error;
  }
  return data ? data.buyer_user_id : undefined;
}
```

3. `guardCheckoutPost` の直後（本文の読み取りの前）:

```ts
  // 買い手は検証済みのログインからだけ決める。何かを変える前に確かめる（グループ C 設計書 4-3）
  const buyerResolution = await resolveCheckoutBuyer(req);
  if (buyerResolution.kind === 'expired' || buyerResolution.kind === 'unavailable') {
    return guard.finish(checkoutBuyerFailureResponse(buyerResolution.kind));
  }
  const buyerUserId = buyerUserIdOf(buyerResolution);
```

4. モードの確かめ（`livemode`）の直後、`session.status === 'complete'` の判断より前に、下書きを読んで比べる。今の「下書きを読む」処理はここへ動かし、後の `superseded` の判断は動かした下書きを使う:

```ts
    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    const draft = draftId ? await loadDraft(draftId) : null;
    // 「確認へ進む」の時の買い手と違えば、支払い済み・時間切れの判断より前に断る（設計書 4-3、C5）
    if (draft && (draft.buyer_user_id ?? null) !== buyerUserId) {
      return loginChanged({ ...ref, draft_id: draft.id, draft_buyer_user_id: draft.buyer_user_id ?? null });
    }
```

`loginChanged` は `reject` と同じ形で、決済の画面を閉じてから断る:

```ts
  const loginChanged = async (metadata: Record<string, unknown>) => {
    await expireRejectedCheckoutSession(stripe, checkoutSessionId);
    return reject('login_changed', { ...metadata, buyer_user_id: buyerUserId });
  };
```

（`stripe` と `checkoutSessionId` が使える位置に置く。）

5. 別のタブの支払い済みの画面（`paidCheckoutSessionId`）を返す前に、その下書きの買い手を比べる:

```ts
    if (paidCheckoutSessionId && paidCheckoutSessionId !== checkoutSessionId) {
      const paidBuyer = await buyerOfCheckoutSession(paidCheckoutSessionId);
      if (paidBuyer === undefined || paidBuyer !== buyerUserId) {
        return loginChanged({ ...ref, draft_id: draft.id, paid_checkout_session_id: paidCheckoutSessionId, draft_buyer_user_id: paidBuyer ?? null });
      }
      ...（今の payment_done の処理）
    }
```

6. 受付の関数の呼び出しに `_buyer_user_id: buyerUserId` を足す。断りの処理の `if (code === 'cart_changed' || code === 'superseded')` に `|| code === 'login_changed'` を足す（決済の画面を閉じる）

Run: `npx jest tests/unit/api/checkout/place-order-route.test.ts`
Expected: PASS

- [ ] **Step 3: resume の落ちるテストを足す**

`tests/unit/api/checkout/resume-route.test.ts` に `resolveCheckoutBuyer` の mock（既定はゲスト）を足し、次のケースを足す:

- 開いている決済の画面の下書きの買い手が違えば `{ state: 'none' }`（確認画面の中身を返さない）
- 決済の画面が `complete` で、その下書きの買い手が違えば `{ state: 'none' }`（`payment_done` を返さない）
- 決済の画面の ID が無く、`findPaidCheckoutSession` が支払い済みの画面を返した時、その下書きの買い手が違えば `{ state: 'none' }`、同じなら今のまま `payment_done`
- `{ kind: 'expired' }` なら 401 `auth_expired`、`{ kind: 'unavailable' }` なら 503。Stripe を呼ばない

Run: `npx jest tests/unit/api/checkout/resume-route.test.ts`
Expected: FAIL（新しいケース）

- [ ] **Step 4: resume を直す**

`src/app/api/checkout/resume/route.ts`:

1. `guardCheckoutPost` の直後に、place-order と同じ形で買い手を確かめる（失敗は `guard.finish(checkoutBuyerFailureResponse(...))`）
2. 下書きの select に `buyer_user_id` を足す。下書きの読み出しを `session.status === 'complete'` の判断の前へ動かし、下書きがあって買い手が違えば `none()` を返す。下書きが無い時の扱いは今のまま（`complete` なら `payment_done`、`open` なら `none`）
3. 決済の画面の ID が無い時の `findPaidCheckoutSession` の結果も、その画面の下書きの買い手（`checkout_session_id` で引く）が今の買い手と同じ時だけ `payment_done` を返す。違う・下書きが無い時は `none()`

Run: `npx jest tests/unit/api/checkout/resume-route.test.ts`
Expected: PASS

- [ ] **Step 5: complete の紐付けを消す**

`tests/unit/api/checkout/complete-route.test.ts` の紐付け（`linkOrderToUser`・`auth.getUser`・`checkout.link_order_to_user`）のケースを、「ログインしていても注文の持ち主を書かない（`orders` の update を呼ばない）・ログインの確かめを呼ばない」1本に置き換える。

`src/app/api/checkout/complete/route.ts` から `resolveAuthenticatedUserId`・`linkOrderToUser`・`linkOrderToUserIfUnowned`・`activeUserId` とその呼び出しを消し、使われなくなった import（`extractAuthToken` など）を消す。ほかの処理（照合・メール・カート）は変えない。

Run: `npx jest tests/unit/api/checkout/complete-route.test.ts`
Expected: PASS

- [ ] **Step 6: 決済まわりの単体テスト・型・lint**

Run: `npx jest tests/unit/api/checkout tests/unit/features/checkout tests/unit/lib/stripe` と `npx tsc --noEmit -p tsconfig.json` と、変えたファイルの `npx eslint`
Expected: PASS・エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/lib/orders/order-payment-types.ts src/app/api/checkout/place-order/route.ts src/app/api/checkout/resume/route.ts src/app/api/checkout/complete/route.ts tests/unit/api/checkout/place-order-route.test.ts tests/unit/api/checkout/resume-route.test.ts tests/unit/api/checkout/complete-route.test.ts
git commit -m "feat(checkout): 注文すると入り直しで買い手を比べ、完了での紐付けをやめる"
```

---

### Task 5: 画面（送り直しと案内）

**Files:**
- Modify: `src/lib/client-fetch.ts`
- Modify: `src/app/checkout/_lib/checkout-api.ts`
- Modify: `src/app/checkout/page.tsx`
- Test: `tests/unit/lib/client-fetch.test.ts`、`tests/unit/app/checkout/checkout-api.test.ts`、`tests/unit/components/CheckoutPage.test.tsx`

**Interfaces:**
- Consumes: Task 3・4 の 401 `auth_expired`・409 `login_changed`、`useLogin().refreshAuthState`（`src/contexts/LoginContext.tsx`）
- Produces: `refreshSessionOnce(): Promise<boolean>`（client-fetch）、`CheckoutRejectionCode` に `"login_changed"`、`requestCheckoutConfirmation` の `{ kind: "error", code: "auth_expired", message: LOGIN_EXPIRED_MESSAGE, retryable: true }`

- [ ] **Step 1: client-fetch の落ちるテストを足す**

`tests/unit/lib/client-fetch.test.ts` に、`refreshSessionOnce` が `/api/auth/refresh` を1回呼び、200 なら `true`、401 なら `false` を返し、同時の2回の呼び出しが1回の更新にまとまるケースを足す。

- [ ] **Step 2: client-fetch を直す**

`src/lib/client-fetch.ts` に足す:

```ts
/**
 * ログインの印を1回だけ新しくする（同時に走る更新は1つにまとめる）。
 * clientFetch は書き込み（POST）を自動で送り直さない。送り直しても二重にならない入口
 * （ログインの確かめを何かを変える前に行う決済の入口）だけが、これを呼んで自分で送り直す。
 */
export function refreshSessionOnce(): Promise<boolean> {
  return refreshSession();
}
```

Run: `npx jest tests/unit/lib/client-fetch.test.ts`
Expected: PASS

- [ ] **Step 3: checkout-api の落ちるテストを足す**

`tests/unit/app/checkout/checkout-api.test.ts` に、`refreshSessionOnce` の mock を足し、次のケースを足す:

- create-session・place-order・resume が 401 `{ error: 'auth_expired' }` を返したら、`refreshSessionOnce` を1回呼び、`true` なら同じ本文で1回だけ送り直し、2回目の応答で結果を返す
- 401 でも `error` が `auth_expired` でなければ、送り直さない
- 新しくできなかった（`false`）、または送り直しも 401 `auth_expired` の時:
  - `requestCheckoutConfirmation` は `{ kind: "error", code: "auth_expired", message: "ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。", retryable: true, correlationId: null }`
  - `placeOrder` は `{ kind: "rejected", rejection: { code: "login_changed", message: "ログインの状態が変わりました。もう一度「確認へ進む」を押してください。", changedLines: [] } }`
  - `resumeCheckout` は `{ state: "none" }`
- `placeOrder` が 409 `{ error: 'login_changed', message }` を `rejected`（code `login_changed`）として返す

- [ ] **Step 4: checkout-api を直す**

`src/app/checkout/_lib/checkout-api.ts`:

1. `CheckoutRejectionCode` と `REJECTION_CODES` に `"login_changed"` を足す
2. 文言の定数を足す（Global Constraints のとおり）:

```ts
const LOGIN_CHANGED_MESSAGE = "ログインの状態が変わりました。もう一度「確認へ進む」を押してください。";
const LOGIN_EXPIRED_MESSAGE = "ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。";
```

3. 送り直しの関数を足し、create-session・place-order・resume の `postJson` をこれに置き換える:

```ts
type CheckoutPostResult = { response: Response; data: JsonBody; loginExpired: boolean };

function isAuthExpired(response: Response, data: JsonBody): boolean {
  return response.status === 401 && data?.error === "auth_expired";
}

/**
 * ログインの印が古いと断られたら、印を新しくして1回だけ送り直す（グループ C 設計書第6章）。
 * 入口はログインの確かめを何かを変える前に行うので、送り直しても二重にならない。
 */
async function postCheckoutJson(url: string, body: unknown): Promise<CheckoutPostResult> {
  const first = await postJson(url, body);
  const firstData = await readJson(first);
  if (!isAuthExpired(first, firstData)) {
    return { response: first, data: firstData, loginExpired: false };
  }
  if (!(await refreshSessionOnce())) {
    return { response: first, data: firstData, loginExpired: true };
  }
  const second = await postJson(url, body);
  const secondData = await readJson(second);
  return { response: second, data: secondData, loginExpired: isAuthExpired(second, secondData) };
}
```

（各関数は、今 `readJson(response)` で読んでいる所を `data` に置き換える。`loginExpired` の時は Step 3 の結果を返す。通信の失敗で投げられた時の今の扱いは変えない。）

Run: `npx jest tests/unit/app/checkout/checkout-api.test.ts`
Expected: PASS

- [ ] **Step 5: 画面の落ちるテストを足す**

`tests/unit/components/CheckoutPage.test.tsx` に、次のケースを足す（`useLogin` の mock に `refreshAuthState: jest.fn()` を足す）:

- 最終確認画面で「注文する」が `login_changed` で断られたら、入力画面に戻り、ボタンの上（`checkout-session-error`）に `ログインの状態が変わりました。もう一度「確認へ進む」を押してください。` が出て、「確認へ進む」が押せる。`refreshAuthState` が呼ばれる
- 「確認へ進む」が `code: "auth_expired"` の error で返ったら、入力画面のまま有効期限切れの文が出て、押し直せる。`refreshAuthState` が呼ばれる

- [ ] **Step 6: 画面を直す**

`src/app/checkout/page.tsx`:

1. `const { isLoggedIn } = useLogin();` を `const { isLoggedIn, refreshAuthState } = useLogin();` にする
2. `handleRejected` の最初に:

```ts
    if (rejection.code === "login_changed") {
      // 「確認へ進む」の時とログインの状態が違う。入力画面を今のログインに合わせ、やり直してもらう（設計書第6章）
      backToInput();
      setSessionErrorRetryable(true);
      setSessionErrorCorrelationId(null);
      setCheckoutError(rejection.message);
      void refreshAuthState();
      return;
    }
```

3. `proceedToConfirmation` の最後の一般のエラーの扱い（`setSessionErrorRetryable(result.retryable)` の前）に:

```ts
    if (result.code === "auth_expired") {
      // ログインの印を新しくできなかった。入力画面をゲストの形に合わせる（自動でゲストとして進めない。設計書 C2）
      void refreshAuthState();
    }
```

Run: `npx jest tests/unit/components/CheckoutPage.test.tsx tests/unit/app/checkout`
Expected: PASS

- [ ] **Step 7: 型・lint・単体全件**

Run: `npx tsc --noEmit -p tsconfig.json`、変えたファイルの `npx eslint`、`npx jest --testPathIgnorePatterns tests/integration/db`
Expected: エラーなし・全件 PASS

- [ ] **Step 8: コミット**

```bash
git add src/lib/client-fetch.ts src/app/checkout/_lib/checkout-api.ts src/app/checkout/page.tsx tests/unit/lib/client-fetch.test.ts tests/unit/app/checkout/checkout-api.test.ts tests/unit/components/CheckoutPage.test.tsx
git commit -m "feat(checkout): ログインの印が古い時は送り直し、ログインの状態が変わった時は案内する"
```

---

### Task 6: E2E・要求・文書

**Files:**
- Create: `e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`
- Modify: `docs/02_Requirements/requirements.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/sequence/checkout-payment.md`、`docs/04_DetailDesign/pages/13_checkout.md`、`docs/04_DetailDesign/states/checkout-draft.md`、`docs/03_BasicDesign/data/er.md`

**Interfaces:**
- Consumes: Task 1 の `createTestMember`・`loginAsMember`、`e2e/checkout-flow-helpers.ts` の `CHECKOUT_VIEWPORTS`・`seedCart`・`stubPostalCode`・`fillShippingForm`・`proceedToFinal`・`placeOrderWithTestCard`

- [ ] **Step 1: E2E を書く**

`e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts`:

```ts
/**
 * FR-CHECKOUT-046 ログイン客の注文の持ち主（グループ C）
 * 対応 FREQ: FREQ-426（AC-01）・FREQ-427（AC-01）。FREQ-426-AC-02 は DB 結合テスト（checkout_order_owner_binding）で確かめる。
 * 会員は手元の Supabase に試験ごとに作る（e2e/member-session-helpers.ts）。手元以外では動かない。
 */
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';

const LOGIN_CHANGED = 'ログインの状態が変わりました。もう一度「確認へ進む」を押してください。';

/** 会員の入力画面。メールアドレスはアカウントのもので読み取り専用なので、ほかの欄だけを埋める */
async function fillMemberShippingForm(page: Page, member: TestMember): Promise<void> {
  await expect(page.getByLabel('メールアドレス')).toHaveValue(member.email, { timeout: 30_000 });
  await page.getByLabel('氏名').fill('山田花子');
  await page.getByLabel('フリガナ').fill('ヤマダハナコ');
  await page.getByLabel('電話番号').fill('0312345678');
  await page.getByLabel('郵便番号').fill('1500001');
  await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
  await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
  await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
}

function localDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('注文を読めるのは手元の Supabase だけ');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

test.describe('FR-CHECKOUT-046 ログイン客の注文の持ち主', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）会員の注文は、完了の処理がログインなしでも注文履歴に出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const member = await createTestMember(`owner-${viewport.name}`);
      await loginAsMember(page, member);
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      // 別のブラウザに戻った形: 完了の処理の要求からログインの Cookie を外す（カートの Cookie は残す）
      await page.route('**/api/checkout/complete', async (route) => {
        const cookie = (route.request().headers().cookie ?? '')
          .split(';')
          .map((part) => part.trim())
          .filter((part) => !/^(sb-access-token|sb-refresh-token|sb-csrf-token)=/.test(part))
          .join('; ');
        await route.continue({ headers: { ...route.request().headers(), cookie } });
      });
      await page.goto('/checkout');
      await fillMemberShippingForm(page, member);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByText(/ORD-[0-9A-Z]{8}/)).toBeVisible({ timeout: 90_000 });

      const orders = await page.request.get('/api/orders');
      expect(orders.status()).toBe(200);
      const body = (await orders.json()) as { data?: Array<{ id: string }> };
      expect((body.data ?? []).length).toBeGreaterThan(0);
      const { data: owned } = await localDb().from('orders').select('id, user_id').eq('user_id', member.userId);
      expect((owned ?? []).length).toBe(1);
    });

    test(`${viewport.name}（${viewport.width}px）ゲストで確認へ進んだ後にログインすると、注文するが断られ注文が作られない`, async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-login-changed-${viewport.name}@example.com`);
      await proceedToFinal(page);

      // 同じブラウザの別のタブでログインする
      const member = await createTestMember(`changed-${viewport.name}`);
      const other = await context.newPage();
      await other.goto('/');
      await loginAsMember(other, member);
      await other.close();

      await placeOrderWithTestCard(page);
      await expect(page.getByTestId('checkout-session-error')).toHaveText(LOGIN_CHANGED, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeVisible();
      const { data: placed } = await localDb().from('orders').select('id').eq('user_id', member.userId);
      expect(placed ?? []).toHaveLength(0);
    });
  }
});
```

（会員の入力画面の欄の名前・完了画面の注文番号の出し方・`/api/orders` の応答の形は、手元で確かめて合わせる。会員の入力画面に「保存済みの配送先」や「情報を保存する」が出る時は、新しい会員（保存済みの住所が0件）で入力の欄が出ることを確かめる。AC-02 では、注文が作られないことを、このテストのカートの session の注文が0件であることでも確かめてよい。）

- [ ] **Step 2: controller が流す**

Run（controller。3000番を止め、`npx supabase db reset` の後）: `PLAYWRIGHT_HTML_OPEN=never npx playwright test e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts --reporter=line`
Expected: 6 passed

- [ ] **Step 3: 要求を足す**

`docs/02_Requirements/requirements.md` のトレーサビリティの表（FREQ-425 の行の後）に、設計書 9-1 の2行を、今の表の形（要求ID｜要求｜要件ID｜要件｜受け付け基準ID｜受け付け基準。複数は `<br>` でつなぐ）で足す。

- [ ] **Step 4: 文書を直す**

設計書 9-2 のとおり:

- レビュー台帳: R-24 の節に「解消（グループ C）」と、直し方（「注文する」で確かめた会員を、注文を作るのと同じ処理の中で持ち主として書く。「注文する」を通らない支払いは持ち主を付けず、メール確認済みのログインでまとめる。完了での紐付けはやめた）を足す。一覧の表（32行目）と対処計画の表のグループ C の行を「実装済み」（設計書・計画書へのリンクつき）にする
- `api-spec.md`: create-session・place-order・resume の 401 `auth_expired`・503、place-order の 409 `login_changed`、resume の買い手の比べ、complete の紐付けの廃止
- `checkout-payment.md`: 買い手の確かめと比べの段（設計書第3章の図と同じ流れ）
- `13_checkout.md`: `login_changed` と有効期限切れの案内（文言は Global Constraints のとおり）
- `checkout-draft.md`: `buyer_user_id`（「確認へ進む」で記録し、変えられない）
- `er.md`: `checkout_drafts.buyer_user_id` と注文の持ち主の決まり（トリガー）

Run: `npm run -s validate-docs`
Expected: 既知の2件（`docs/superpowers/plans/2026-10-07-checkout-place-order-payment.md` のリンク）だけ

- [ ] **Step 5: 決済まわりの E2E を全部流す（controller）**

Run（controller。3000番を止め、`npx supabase db reset` の後）: `ls e2e/FR-CHECKOUT-*.spec.ts e2e/FR-UI-006*.spec.ts e2e/FR-UI-007*.spec.ts e2e/FR-UI-008*.spec.ts e2e/FR-UI-009*.spec.ts e2e/FR-CART-*.spec.ts e2e/FR-CONTACT-012*.spec.ts e2e/FR-ACCOUNT-*.spec.ts` の全部を流す
Expected: 新しい赤が無い（既知の赤は FR-CART-002 の2件、まとめて流した時の FR-CART-015。アカウントの既知の赤は `e2e-login-pwreset-preexisting-failures` の記録と比べる）

- [ ] **Step 6: コミット**

```bash
git add e2e/FR-CHECKOUT-046-order-owner-binding.spec.ts docs/02_Requirements/requirements.md docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md docs/03_BasicDesign/api/api-spec.md docs/04_DetailDesign/sequence/checkout-payment.md docs/04_DetailDesign/pages/13_checkout.md docs/04_DetailDesign/states/checkout-draft.md docs/03_BasicDesign/data/er.md
git commit -m "test(e2e): FR-CHECKOUT-046 と FREQ-426・427、グループ C の文書を足す"
```

---

## 全タスクの後（controller）

1. 単体全件・型・lint・`validate-docs`
2. `npx supabase db reset` → DB 結合を全件（`--runInBand`）→ もう一度 `npx supabase db reset` → 決済まわりとアカウントの E2E
3. 全体のレビュー（Opus）。指摘の直しは1回、範囲の再レビューは1回
4. ユーザーに push の許可をもらう。push の後、本番 DB への移行の適用の許可をもらい、Supabase MCP の `apply_migration` で当てる。当てた版にファイル名を直し、`checkout_session_claim` のテストが探すファイル名の終わり（`_checkout_order_owner_binding.sql`）が変わらないことを確かめる
