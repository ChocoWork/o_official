# ゲスト購入後の導線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ゲストで購入した客が、注文確認メールと発送通知メールで注文内容・お届け先・追跡番号を把握でき、会員登録すれば過去のゲスト注文がマイページの購入履歴に現れるようにする。

**Architecture:** サーバー処理はすべて Route Handler ＋ service-role client で実装する。Postgres RPC は増やさない（このプロジェクトの RPC は PostgREST 経由で `anon` から直接呼べる状態で、セキュリティアドバイザーが複数を警告しているため）。紐付けは1つの共通関数に閉じ、メール確認直後と OTP 検証成功時の2箇所から呼ぶ。発送は条件付き UPDATE 1本で確定させ、更新できたときだけ通知メールを送る。

**Tech Stack:** Next.js 16 App Router / React 19 / TypeScript / Supabase (Postgres + Auth) / Zod / Jest + ts-jest / Playwright

**設計書:** `docs/superpowers/specs/2026-08-10-guest-order-flow-design.md`

## Global Constraints

- 実装と同時に `docs/2_Specs/spec.md` のトレーサビリティテーブルへ1行追加する（プロジェクトの要求管理ルール）
- E2E は `mobile 390px` / `tablet 768px` / `desktop 1280px` の3ビューポートで書く
- E2E は本番ビルドに対して実行する。`npx playwright test` が `scripts/e2e-server.mjs` 経由でサーバーを用意する
- 単体テストは `npx jest <path>` で実行する。テストは `tests/` 配下、`*.test.ts`
- メール送信・紐付け・住所コピーの失敗は、呼び出し元のフロー（チェックアウト・ログイン・メール確認）を壊さない。ログと監査ログだけ残して握りつぶす
- 監査ログは `logAudit` を使う。`action` は設計書 7章の表のとおり
- `orders` の不変列（migration 081）は触らない。`status` / `shipped_at` / `shipping_carrier` / `tracking_number` / `user_id` は更新可
- メールの正規化は `lower(trim())` のみ。`+tag` やドット違いは別アドレスとして扱う
- 既存ファイルのスタイルに合わせる。`src/app/api/**` はタブインデント、`src/lib/**` `src/components/**` はスペース2

## File Structure

**新規作成**

| ファイル | 責務 |
|---|---|
| `src/lib/orders/link-guest-orders.ts` | メール一致でゲスト注文を会員へ紐付ける。住所・氏名の profiles へのコピーも持つ |
| `src/lib/orders/shipping-carriers.ts` | 配送業者のラベルと追跡URLの組み立て |
| `src/lib/orders/order-shipped-email.ts` | 発送通知メールの本文組み立てと送信 |
| `src/features/checkout/components/GuestRegisterPrompt.tsx` | 注文完了画面の会員登録カード |
| `migrations/083_order_status_shipped.sql` | `order_status` enum に `shipped` を追加 |
| `migrations/084_order_shipping_info.sql` | 発送情報の列と制約 |

**変更**

| ファイル | 変更内容 |
|---|---|
| `src/lib/orders/order-confirmation-email.ts` | お届け先を本文へ追加 |
| `src/app/api/checkout/complete/route.ts` | 注文確定の2経路から確認メールを送る |
| `src/app/api/auth/confirm/route.ts` | メール確認成功後に紐付けを呼ぶ |
| `src/app/api/auth/otp/verify/route.ts` | OTP 検証成功後に紐付けを呼ぶ |
| `src/app/checkout/page.tsx` | 完了画面に `GuestRegisterPrompt` を差し込む |
| `src/app/register/page.tsx` | `searchParams.email` をメール欄の初期値にする |
| `src/app/api/admin/orders/[id]/status/route.ts` | `shipped` 遷移を受け付ける |
| `src/app/api/admin/orders/route.ts` | 型・ラベル変換・フィルタに `shipped` を追加 |
| `src/components/OrderSection.tsx` | `'発送済み'` ステータスと発送操作 |
| `src/app/admin/page.tsx` | 発送ハンドラと発送ダイアログの配線 |
| `src/app/account/orders/[id]/page.tsx` | 発送情報セクション |

**触らない**

`src/lib/orders/order-status.ts` は既に `shipped: '発送済み'` と `resolveOrderProgressIndex` の `shipped → 2` を持っている。変更不要。

---

## Task 1: 注文確認メールにお届け先を追加し、実際に送る（FREQ-264）

現状 `sendOrderConfirmationEmail` は定義だけで、import している箇所が0件。注文確認メールは一度も送られていない。本文にお届け先も無い。

**Files:**
- Modify: `src/lib/orders/order-confirmation-email.ts`
- Modify: `src/app/api/checkout/complete/route.ts`
- Test: `tests/unit/lib/orders/order-confirmation-email.test.ts`（新規）
- Test: `tests/unit/api/checkout/complete-route.test.ts`（既存に追加）
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Produces: `sendOrderConfirmationEmail(params: OrderConfirmationParams): Promise<void>`。`OrderConfirmationParams` に `shipping: OrderConfirmationShipping` を追加する

```ts
export type OrderConfirmationShipping = {
  fullName: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  building: string | null;
  phone: string | null;
};
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/orders/order-confirmation-email.test.ts` を新規作成。

```ts
const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

import { sendOrderConfirmationEmail } from '@/lib/orders/order-confirmation-email';

const BASE_PARAMS = {
  orderId: 'a1b2c3d4-1111-2222-3333-444455556666',
  email: 'hanako@example.com',
  fullName: '山田 花子',
  items: [
    { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000 },
  ],
  subtotalAmount: 28000,
  shippingAmount: 800,
  totalAmount: 28800,
  currency: 'jpy',
  shipping: {
    fullName: '山田 花子',
    postalCode: '150-0001',
    prefecture: '東京都',
    city: '渋谷区',
    address: '神宮前1-2-3',
    building: 'レジデンス101',
    phone: '090-1234-5678',
  },
};

describe('sendOrderConfirmationEmail', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_FROM = env.MAIL_FROM_ADDRESS;

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  afterAll(() => {
    env.MAIL_FROM_ADDRESS = ORIGINAL_FROM;
  });

  test('本文にお届け先が含まれる', async () => {
    await sendOrderConfirmationEmail(BASE_PARAMS);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('お届け先');
    expect(body).toContain('〒150-0001');
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
    expect(body).toContain('レジデンス101');
    expect(body).toContain('090-1234-5678');
  });

  test('建物名が無いときは建物の行を出さない', async () => {
    await sendOrderConfirmationEmail({
      ...BASE_PARAMS,
      shipping: { ...BASE_PARAMS.shipping, building: null },
    });

    const body = mockSendMail.mock.calls[0][0].text as string;
    expect(body).toContain('東京都渋谷区神宮前1-2-3');
    expect(body).not.toContain('レジデンス101');
  });

  test('メールアドレスが無いときは送らない', async () => {
    await sendOrderConfirmationEmail({ ...BASE_PARAMS, email: null });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('MAIL_FROM_ADDRESS が無いときは送らない', async () => {
    env.MAIL_FROM_ADDRESS = '';
    await sendOrderConfirmationEmail(BASE_PARAMS);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/lib/orders/order-confirmation-email.test.ts`
Expected: FAIL。`shipping` を渡していない型エラー、または「お届け先」が本文に無い

- [ ] **Step 3: メール本文にお届け先を足す**

`src/lib/orders/order-confirmation-email.ts` を編集する。

型を追加する（`ConfirmationItem` の下）。

```ts
export type OrderConfirmationShipping = {
  fullName: string | null;
  postalCode: string | null;
  prefecture: string | null;
  city: string | null;
  address: string | null;
  building: string | null;
  phone: string | null;
};
```

`OrderConfirmationParams` に1行足す。

```ts
  currency: string;
  shipping: OrderConfirmationShipping;
};
```

分割代入に `shipping` を追加する。

```ts
  const { orderId, email, fullName, items, subtotalAmount, shippingAmount, totalAmount, currency, shipping } = params;
```

`itemLines` の下に住所の行を組み立てる関数を置く。

```ts
  // 空の項目で空行が出ないよう、値のある行だけを積む。
  const shippingLines = [
    shipping.fullName ? `${shipping.fullName} 様` : null,
    shipping.postalCode ? `〒${shipping.postalCode}` : null,
    [shipping.prefecture, shipping.city, shipping.address].filter(Boolean).join('') || null,
    shipping.building || null,
    shipping.phone || null,
  ].filter((line): line is string => Boolean(line));
```

本文の合計行と問い合わせ案内のあいだに差し込む。

```ts
    `合計: ${formatCurrency(totalAmount, currency)}`,
    '',
    'お届け先:',
    ...shippingLines,
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/lib/orders/order-confirmation-email.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: 二重送信しないことのテストを書く**

`tests/unit/api/checkout/complete-route.test.ts` の冒頭、他の `jest.mock` と並べてメールモックを足す。`import { POST }` より前に置くこと。

```ts
const mockSendOrderConfirmationEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-confirmation-email', () => ({
  sendOrderConfirmationEmail: (...args: unknown[]) => mockSendOrderConfirmationEmail(...args),
}));
```

既存テスト `'Stripe checkout session 完了時は draft ベース RPC で paid 注文を作成する'`（L112）と `'既存注文がある場合は RPC を呼ばず既存注文を返す'`（L138）を開き、その2件が `mockRetrieveCheckoutSession` / `mockFrom` / `mockRpc` に何を積んでいるかを読む。**同じ積み方をそのままコピーして**、末尾に2件足す。

```ts
  test('注文が新規に確定したとき確認メールを1通送る', async () => {
    // ここに L112 のテストと同一のモック設定をコピーする
    // （mockRetrieveCheckoutSession / mockFrom / mockRpc の3つ）。

    await POST(makeRequest(/* L112 と同じリクエストボディ */));

    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    const params = mockSendOrderConfirmationEmail.mock.calls[0][0];
    // orderId は RPC が返した order_id と一致する
    expect(typeof params.orderId).toBe('string');
    // お届け先が draft の shipping_snapshot から埋まっている
    expect(params.shipping).toEqual(
      expect.objectContaining({ postalCode: expect.any(String) }),
    );
  });

  test('既存注文が見つかったときは確認メールを送らない', async () => {
    // ここに L138 のテストと同一のモック設定をコピーする。

    await POST(makeRequest(/* L138 と同じリクエストボディ */));

    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });
```

既存の2件が重複したリテラルを持っているなら、この Task で定数へ切り出してから4件で共有してよい。切り出しは任意で、既存テストが通り続けることだけを守る。

- [ ] **Step 6: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/api/checkout/complete-route.test.ts`
Expected: FAIL。`mockSendOrderConfirmationEmail` が呼ばれていない

- [ ] **Step 7: complete から確認メールを送る**

`src/app/api/checkout/complete/route.ts` を編集する。

import を追加する。

```ts
import { sendOrderConfirmationEmail } from '@/lib/orders/order-confirmation-email';
```

`linkOrderToUser` の下にヘルパーを追加する。draft のスナップショットから送信パラメータを組み立てる。

```ts
/** draft のスナップショットから確認メールの送信パラメータを組み立てる。 */
function buildConfirmationParams(orderId: string, draft: CheckoutDraftDetails) {
	const shipping = draft.shipping_snapshot;
	return {
		orderId,
		email: shipping?.email ?? null,
		fullName: shipping?.fullName ?? null,
		items: (draft.items_snapshot ?? []).map((item) => ({
			item_name: item.item_name,
			color: item.color,
			size: item.size,
			quantity: item.quantity,
			line_total: item.line_total,
		})),
		subtotalAmount: draft.subtotal_amount,
		shippingAmount: draft.shipping_amount,
		totalAmount: draft.total_amount,
		currency: draft.currency,
		shipping: {
			fullName: shipping?.fullName ?? null,
			postalCode: shipping?.postalCode ?? null,
			prefecture: shipping?.prefecture ?? null,
			city: shipping?.city ?? null,
			address: shipping?.address ?? null,
			building: shipping?.building ?? null,
			phone: shipping?.phone ?? null,
		},
	};
}
```

フォールバック成功の分岐（`if (fallbackResult.data) {` の中、`logAudit` の前）に1行入れる。

```ts
				await sendOrderConfirmationEmail(
					buildConfirmationParams(fallbackResult.data.id, draftData as CheckoutDraftDetails),
				);
```

RPC 成功後、`finalizedOrder` を解釈した後の成功 `logAudit` の前にも入れる。

```ts
		await sendOrderConfirmationEmail(
			buildConfirmationParams(finalizedOrder.orderId, draftData as CheckoutDraftDetails),
		);
```

既存注文の早期リターン経路には**入れない**。ここが二重送信を防ぐ唯一の仕組み。

- [ ] **Step 8: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/api/checkout/complete-route.test.ts tests/unit/lib/orders/order-confirmation-email.test.ts`
Expected: PASS（既存テストも含めて全件）

- [ ] **Step 9: spec.md に追記する**

`docs/2_Specs/spec.md` の末尾に1行足す。

```
| FREQ-264 | 注文確定時に注文確認メールを送信し、本文にお届け先を含めること | FREQ-264-REQ-01 | 注文が新規に確定した経路で、注文時のメールアドレス宛に件名「【Le Fil des Heures】ご注文ありがとうございます（ORD-XXXXXXXX）」のメールを送信すること | FREQ-264-AC-01 | 注文確定時に sendOrderConfirmationEmail が1回呼ばれること | FREQ-264-REQ-02 | メール本文に氏名・郵便番号・都道府県・市区町村・住所・建物名・電話番号を含めること | FREQ-264-AC-02 | メール本文に「お届け先」「〒150-0001」「東京都渋谷区神宮前1-2-3」「レジデンス101」「090-1234-5678」が含まれること | FREQ-264-REQ-03 | 同じ payment_intent_id で注文完了APIを再度呼んでもメールを再送しないこと | FREQ-264-AC-03 | 既存注文が見つかる経路では sendOrderConfirmationEmail が呼ばれないこと |
```

- [ ] **Step 10: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/lib/orders/order-confirmation-email.ts src/app/api/checkout/complete/route.ts tests/unit/lib/orders/order-confirmation-email.test.ts tests/unit/api/checkout/complete-route.test.ts docs/2_Specs/spec.md
git commit -m "feat(orders): 注文確認メールを配線しお届け先を追加"
```

---

## Task 2: ゲスト注文を会員へ紐付ける共通関数（FREQ-265 前半）

**Files:**
- Create: `src/lib/orders/link-guest-orders.ts`
- Test: `tests/unit/lib/orders/link-guest-orders.test.ts`

**Interfaces:**
- Produces:

```ts
export async function linkGuestOrdersByEmail(params: {
  userId: string;
  email: string;
  emailConfirmedAt: string | null;
}): Promise<number>;
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/orders/link-guest-orders.test.ts` を新規作成。

```ts
const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockIlike = jest.fn(() => ({ is: mockIs }));
const mockUpdate = jest.fn(() => ({ ilike: mockIlike }));
const mockFrom = jest.fn(() => ({ update: mockUpdate }));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';

describe('linkGuestOrdersByEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockResolvedValue({ data: [{ id: 'order-1' }], error: null });
  });

  test('メール未確認では UPDATE を呼ばず 0 を返す', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: null,
    });

    expect(linked).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('メール確認済みなら user_id が NULL の注文だけを更新する', async () => {
    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: '  Hanako@Example.com ',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(1);
    expect(mockFrom).toHaveBeenCalledWith('orders');
    expect(mockUpdate).toHaveBeenCalledWith({ user_id: 'user-1' });
    // メールは lower(trim()) に正規化し、大文字小文字を無視して比較する。
    // ilike はワイルドカードを含まなければ大文字小文字を無視した等値比較になる。
    expect(mockIlike).toHaveBeenCalledWith('shipping_email', 'hanako@example.com');
    // 他人が所有済みの注文は奪わない
    expect(mockIs).toHaveBeenCalledWith('user_id', null);
  });

  test('0件でも成功として 0 を返し、監査ログを残さない', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('Supabase がエラーを返しても例外を投げず 0 を返す', async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const linked = await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(linked).toBe(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'orders.link_guest_orders', outcome: 'error' }),
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/lib/orders/link-guest-orders.test.ts`
Expected: FAIL with "Cannot find module '@/lib/orders/link-guest-orders'"

- [ ] **Step 3: 最小の実装を書く**

`src/lib/orders/link-guest-orders.ts` を新規作成。

```ts
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

/**
 * 注文時のメールが一致するゲスト注文を、この会員へ紐付ける。
 *
 * メール確認済みの会員だけを対象にする。未確認のまま紐付けると、
 * 他人のメールアドレスで登録するだけでその注文を奪えてしまう。
 *
 * 呼び出し元はログイン・メール確認のフローなので、失敗しても例外は投げない。
 * user_id IS NULL 条件により冪等なので、失敗しても次回ログインで復旧する。
 *
 * @returns 紐付いた件数。0 は正常（対象が無かった）。
 */
export async function linkGuestOrdersByEmail(params: {
  userId: string;
  email: string;
  emailConfirmedAt: string | null;
}): Promise<number> {
  if (!params.emailConfirmedAt) return 0;

  const normalizedEmail = params.email.trim().toLowerCase();
  if (!normalizedEmail) return 0;

  try {
    const supabase = await createServiceRoleClient();
    // user_id IS NULL が所有権の一方向性を担保する。
    // 既に誰かのものになった注文は決して移さない。
    // ilike はワイルドカードを含まなければ大文字小文字を無視した等値比較になる。
    // 注文時のメールは大文字が混ざりうるので eq では取りこぼす。
    const { data, error } = await supabase
      .from('orders')
      .update({ user_id: params.userId })
      .ilike('shipping_email', normalizedEmail)
      .is('user_id', null)
      .select('id');

    if (error) throw error;

    const linked = data?.length ?? 0;
    if (linked > 0) {
      await logAudit({
        action: 'orders.link_guest_orders',
        outcome: 'success',
        resource: 'orders',
        resource_id: params.userId,
        metadata: { linked_count: linked },
      });
    }
    return linked;
  } catch (error) {
    console.error('Failed to link guest orders to user:', error);
    await logAudit({
      action: 'orders.link_guest_orders',
      outcome: 'error',
      resource: 'orders',
      resource_id: params.userId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/lib/orders/link-guest-orders.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: コミット**

```bash
git add src/lib/orders/link-guest-orders.ts tests/unit/lib/orders/link-guest-orders.test.ts
git commit -m "feat(orders): メール一致でゲスト注文を会員へ紐付ける関数を追加"
```

---

## Task 3: 紐付けをメール確認とOTP検証から呼ぶ（FREQ-265 後半）

ログインは2段階で、`/api/auth/login` はパスワード検証と OTP 送信だけを行う。セッションが立つのは `/api/auth/otp/verify` なので、フックはそちらに置く。

**Files:**
- Modify: `src/app/api/auth/confirm/route.ts`
- Modify: `src/app/api/auth/otp/verify/route.ts`
- Test: `tests/integration/api/auth/confirm.test.ts`（既存に追加）
- Modify: `docs/2_Specs/spec.md`
- Test: `e2e/FR-ACCOUNT-030-guest-order-linking.spec.ts`（新規）

**Interfaces:**
- Consumes: Task 2 の `linkGuestOrdersByEmail({ userId, email, emailConfirmedAt })`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/api/auth/confirm.test.ts` の他の `jest.mock` と並べて追加する。

```ts
const mockLinkGuestOrdersByEmail = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: (...args: unknown[]) => mockLinkGuestOrdersByEmail(...args),
}));
```

`describe` 内に1件足す。既存の成功パターンのテストと同じモック設定（`verifyOtp` が session と user を返す形）を使う。

```ts
  test('メール確認に成功したらゲスト注文の紐付けを呼ぶ', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      auth: {
        verifyOtp: jest.fn().mockResolvedValue({
          data: {
            session: { access_token: 'a', refresh_token: 'r' },
            user: {
              id: 'user-1',
              email: 'hanako@example.com',
              email_confirmed_at: '2026-08-10T00:00:00Z',
            },
          },
          error: null,
        }),
      },
    });

    const { GET } = require('@/app/api/auth/confirm/route');
    await GET(new Request('http://example.com/api/auth/confirm?token_hash=t&type=email'));

    expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/integration/api/auth/confirm.test.ts`
Expected: FAIL。`mockLinkGuestOrdersByEmail` が呼ばれていない

- [ ] **Step 3: confirm に紐付けを足す**

`src/app/api/auth/confirm/route.ts` に import を追加する。

```ts
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
```

`persistSessionAndCookies` の後、成功の `logAudit` の前に入れる。

```ts
    // ゲストのまま買った注文をこの会員へ引き継ぐ。
    // 失敗しても紐付けは冪等なので、次回ログインで再試行される。
    await linkGuestOrdersByEmail({
      userId: data.user.id,
      email: data.user.email ?? '',
      emailConfirmedAt: data.user.email_confirmed_at ?? null,
    });
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npx jest tests/integration/api/auth/confirm.test.ts`
Expected: PASS

- [ ] **Step 5: OTP 検証にも同じ呼び出しを足す**

`src/app/api/auth/otp/verify/route.ts` に import を追加する。

```ts
import { linkGuestOrdersByEmail } from '@/lib/orders/link-guest-orders';
```

`persistSessionAndCookies` の後、`outcome: 'success'` の `logAudit` の前に入れる。

```ts
    // ログインのたびに走らせる。登録後に増えたゲスト注文も拾える。
    await linkGuestOrdersByEmail({
      userId: result.data.user.id,
      email: result.data.user.email ?? email,
      emailConfirmedAt: result.data.user.email_confirmed_at ?? null,
    });
```

- [ ] **Step 6: E2E を書く**

`e2e/FR-ACCOUNT-030-guest-order-linking.spec.ts` を新規作成。既存の慣習どおり API をモックする。

購入履歴は独立ページではなく `/account?tab=orders`（`src/app/account/page.tsx` のタブ）で、`GET /api/orders` から `{ data: OrderSummary[] }` を受ける。`OrderSummary` は `src/app/account/page.tsx` L59 に定義がある。

```ts
import { test, expect, Page } from '@playwright/test';

// FREQ-265: メール確認済みの会員でログインすると、同じメールで行った
// ゲスト注文が購入履歴に現れる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

// src/app/account/page.tsx L59 の OrderSummary に合わせる。
const LINKED_ORDER = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  orderNumber: 'ORD-A1B2C3D4',
  orderDate: '2026-08-01',
  status: 'paid',
  totalAmount: '¥28,800',
  itemCount: 1,
  shippingFullName: '山田 花子',
  shippingEmail: 'hanako@example.com',
  shippingPhone: '090-1234-5678',
  shippingAddress: '東京都渋谷区神宮前1-2-3',
  items: [{ itemName: 'シルクブラウス', quantity: 1 }],
  detailHref: '/account/orders/a1b2c3d4-1111-2222-3333-444455556666',
};

async function mockAccountApis(page: Page, orders: unknown[]): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'user-1', email: 'hanako@example.com', role: 'user', mfaVerified: true },
      }),
    }),
  );

  // GET /api/orders は { data: OrderSummary[] } を返す（配列を直接包む）。
  await page.route('**/api/orders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: orders }),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-030 guest order linking (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('紐付いたゲスト注文が購入履歴に表示される', async ({ page }) => {
      // FREQ-265-AC-01
      await mockAccountApis(page, [LINKED_ORDER]);
      await page.goto('/account?tab=orders');

      await expect(page.getByText('ORD-A1B2C3D4')).toBeVisible();
      await expect(page.getByText('シルクブラウス')).toBeVisible();
    });

    test('紐付いていない注文は購入履歴に表示されない', async ({ page }) => {
      // FREQ-265-AC-02
      await mockAccountApis(page, []);
      await page.goto('/account?tab=orders');

      await expect(page.getByText('ORD-A1B2C3D4')).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAccountApis(page, [LINKED_ORDER]);
      await page.goto('/account?tab=orders');

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

`/account?tab=orders` はログイン済みでないとタブが描画されない。`useLogin()` が `/api/auth/me` を見るので、上のモックで足りる。足りなければ既存の `e2e/account-test-utils.ts` にログイン状態を作るヘルパーがあるか確認して使う。

- [ ] **Step 7: E2E を実行する**

Run: `npx playwright test e2e/FR-ACCOUNT-030-guest-order-linking.spec.ts --reporter=list`
Expected: PASS（9件）

- [ ] **Step 8: spec.md に追記する**

```
| FREQ-265 | 同じメールアドレスで会員登録したとき、過去のゲスト注文を購入履歴に表示すること | FREQ-265-REQ-01 | メール確認済みの会員に対し、注文時のメールが一致し user_id が未設定のゲスト注文を紐付けること。メール確認前は紐付けないこと | FREQ-265-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、紐付いたゲスト注文が購入履歴に表示されること | FREQ-265-REQ-02 | 既に他の会員に紐付いた注文は移さないこと | FREQ-265-AC-02 | 同3ビューポートで、紐付いていない注文が購入履歴に表示されないこと | FREQ-265-AC-03 | 同3ビューポートで横方向のページスクロールが発生しないこと |
```

- [ ] **Step 9: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/api/auth/confirm/route.ts src/app/api/auth/otp/verify/route.ts tests/integration/api/auth/confirm.test.ts e2e/FR-ACCOUNT-030-guest-order-linking.spec.ts docs/2_Specs/spec.md
git commit -m "feat(auth): メール確認とOTP検証でゲスト注文を会員へ紐付ける"
```

---

## Task 4: 紐付け時に住所と氏名を profiles へ引き継ぐ

**Files:**
- Modify: `src/lib/orders/link-guest-orders.ts`
- Test: `tests/unit/lib/orders/link-guest-orders.test.ts`（既存に追加）

**Interfaces:**
- Produces: `linkGuestOrdersByEmail` の内部で `copyGuestProfileFromOrder` を呼ぶ。外向きのシグネチャは変えない

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/orders/link-guest-orders.test.ts` に追加する。profiles の読み書き用にモックを拡張する。

```ts
  test('紐付いたとき profiles が空なら住所と氏名をコピーする', async () => {
    const profileSelect = jest.fn().mockResolvedValue({
      data: { addresses: null, address: null, display_name: null },
      error: null,
    });
    const profileUpsert = jest.fn().mockResolvedValue({ error: null });
    const orderSelect = jest.fn().mockResolvedValue({
      data: [
        {
          id: 'order-1',
          shipping_full_name: '山田 花子',
          shipping_postal_code: '150-0001',
          shipping_prefecture: '東京都',
          shipping_city: '渋谷区',
          shipping_address: '神宮前1-2-3',
          shipping_building: 'レジデンス101',
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
      error: null,
    });

    mockSelect.mockImplementation(() => orderSelect());
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: profileSelect }) }),
          upsert: profileUpsert,
        };
      }
      return { update: mockUpdate };
    });

    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(profileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        addresses: [
          expect.objectContaining({
            postalCode: '150-0001',
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
            building: 'レジデンス101',
            isDefault: true,
          }),
        ],
      }),
      expect.anything(),
    );
  });

  test('profiles に既に住所があればコピーしない', async () => {
    const profileSelect = jest.fn().mockResolvedValue({
      data: { addresses: [{ postalCode: '100-0001' }], address: null, display_name: '既存' },
      error: null,
    });
    const profileUpsert = jest.fn().mockResolvedValue({ error: null });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: profileSelect }) }),
          upsert: profileUpsert,
        };
      }
      return { update: mockUpdate };
    });

    await linkGuestOrdersByEmail({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });

    expect(profileUpsert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/lib/orders/link-guest-orders.test.ts`
Expected: FAIL。`profileUpsert` が呼ばれていない

- [ ] **Step 3: 実装する**

`src/lib/orders/link-guest-orders.ts` の UPDATE の `.select()` で返す列を増やす。

```ts
      .select('id, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, created_at');
```

同ファイルに関数を追加する。

```ts
type LinkedOrderRow = {
  id: string;
  shipping_full_name: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_building: string | null;
  created_at: string;
};

/**
 * 紐付いた注文の配送先を profiles へ引き継ぐ。
 *
 * 既に住所や表示名を持つ会員には触れない。上書きすると、会員が自分で
 * 設定した内容を過去の注文で潰すことになる。
 * 失敗しても紐付け自体は成功として扱う（住所は後から入力できる）。
 */
async function copyGuestProfileFromOrder(
  supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
  userId: string,
  orders: LinkedOrderRow[],
): Promise<void> {
  // 最も新しい注文の配送先を使う。
  const latest = [...orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!latest) return;

  try {
    const { data: profile, error: selectError } = await supabase
      .from('profiles')
      .select('addresses, address, display_name')
      .eq('user_id', userId)
      .maybeSingle<{
        addresses: unknown[] | null;
        address: unknown | null;
        display_name: string | null;
      }>();

    if (selectError) throw selectError;

    const hasAddress =
      (Array.isArray(profile?.addresses) && profile.addresses.length > 0) || Boolean(profile?.address);
    const hasDisplayName = Boolean(profile?.display_name);
    if (hasAddress && hasDisplayName) return;

    const payload: Record<string, unknown> = { user_id: userId };

    if (!hasAddress) {
      const addressItem = {
        id: latest.id,
        postalCode: latest.shipping_postal_code ?? '',
        prefecture: latest.shipping_prefecture ?? '',
        city: latest.shipping_city ?? '',
        address: latest.shipping_address ?? '',
        building: latest.shipping_building ?? '',
        isDefault: true,
      };
      payload.addresses = [addressItem];
      // legacy な単一 address 列もミラーする（既存の書き込み挙動に合わせる）。
      payload.address = addressItem;
    }

    if (!hasDisplayName && latest.shipping_full_name) {
      payload.display_name = latest.shipping_full_name;
    }

    if (Object.keys(payload).length === 1) return;

    const { error: upsertError } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'user_id' });

    if (upsertError) throw upsertError;
  } catch (error) {
    console.error('Failed to copy guest profile from order:', error);
    await logAudit({
      action: 'orders.copy_guest_profile',
      outcome: 'error',
      resource: 'profiles',
      resource_id: userId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
```

`linkGuestOrdersByEmail` の成功分岐で呼ぶ。

```ts
    const linked = data?.length ?? 0;
    if (linked > 0) {
      await copyGuestProfileFromOrder(supabase, params.userId, data as LinkedOrderRow[]);
      await logAudit({ ... });
    }
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/lib/orders/link-guest-orders.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/lib/orders/link-guest-orders.ts tests/unit/lib/orders/link-guest-orders.test.ts
git commit -m "feat(orders): 紐付け時に配送先と氏名を profiles へ引き継ぐ"
```

---

## Task 5: 完了画面の会員登録カードと /register の初期値（FREQ-266）

**Files:**
- Create: `src/features/checkout/components/GuestRegisterPrompt.tsx`
- Modify: `src/app/checkout/page.tsx`
- Modify: `src/app/register/page.tsx`
- Test: `e2e/FR-CHECKOUT-015-guest-register-prompt.spec.ts`（新規）
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Produces:

```ts
export function GuestRegisterPrompt(props: { email: string }): React.JSX.Element;
```

- [ ] **Step 1: カードコンポーネントを作る**

`src/features/checkout/components/GuestRegisterPrompt.tsx` を新規作成。

`src/app/checkout/page.tsx` は既に2018行あるので、カードは切り出して肥大化を避ける。

```tsx
'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button/Button';

/**
 * 注文完了画面の会員登録カード。未ログインのときだけ描画する。
 *
 * メールだけをクエリで渡す。住所や電話を URL に載せると、
 * ブラウザ履歴・Referrer に個人情報が残る。配送先は会員登録の
 * メール確認が済んだあとにサーバー側で profiles へ引き継ぐ。
 */
export function GuestRegisterPrompt({ email }: { email: string }) {
  const href = `/register?email=${encodeURIComponent(email)}`;

  return (
    <section
      aria-label="会員登録のご案内"
      className="mt-6 border border-[#d4d4d4] bg-white px-5 py-4"
    >
      <h3 className="font-acumin text-sm tracking-widest text-black">
        次回から入力不要になります
      </h3>
      <p className="mt-2 font-acumin text-xs leading-relaxed text-[#474747]">
        会員登録すると、このご注文がマイページに表示され、お届け先も引き継がれます。
      </p>
      <Button variant="primary" size="sm" className="mt-4 font-acumin" asChild>
        <Link href={href}>会員登録へ進む</Link>
      </Button>
    </section>
  );
}
```

`Button` に `asChild` が無い場合は、`Link` で `Button` を包む形にするか、`onClick` で `router.push(href)` する形にする。実装時に `src/components/ui/Button/Button_types.ts` を確認して合わせること。

- [ ] **Step 2: 完了画面に差し込む**

`src/app/checkout/page.tsx` の注文番号を表示しているブロック（`<p className="checkout-label">注文番号</p>` の周辺、L1517 付近）を探し、そのブロックの直後にカードを置く。

import を追加する。

```tsx
import { GuestRegisterPrompt } from '@/features/checkout/components/GuestRegisterPrompt';
```

差し込む。使う変数は既に同ファイルに揃っている。

- `isLoggedIn` … L272 の `const { isLoggedIn } = useLogin();`
- `form.email` … 注文フォームのメール入力値
- `completedOrderId` … L266。完了画面はこれが非 null のときに出る

```tsx
{!isLoggedIn && form.email.trim() ? (
  <GuestRegisterPrompt email={form.email.trim()} />
) : null}
```

- [ ] **Step 3: /register でメールの初期値を受ける**

`src/app/register/page.tsx` を編集し、`searchParams` の `email` をメール入力欄の初期値にする。

App Router の Client Component なら `useSearchParams()` を使う。

```tsx
const searchParams = useSearchParams();
const initialEmail = searchParams.get('email') ?? '';
```

`useState` の初期値に渡す。

```tsx
const [email, setEmail] = useState(initialEmail);
```

値は一切信用しない。登録は従来どおり Turnstile・パスワード規則・メール確認を通るので、不正な値は単に入力欄が埋まるだけで終わる。

- [ ] **Step 4: E2E を書く**

`e2e/FR-CHECKOUT-015-guest-register-prompt.spec.ts` を新規作成。

```ts
import { test, expect, Page } from '@playwright/test';

// FREQ-266: 未ログインの注文完了画面から、メールを引き継いで会員登録へ導く。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function mockAuth(page: Page, authenticated: boolean): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        authenticated
          ? { authenticated: true, user: { id: 'user-1', email: 'hanako@example.com', role: 'user' } }
          : { authenticated: false },
      ),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-015 guest register prompt (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('未ログインの完了画面に会員登録カードが表示される', async ({ page }) => {
      // FREQ-266-AC-01
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      const card = page.getByRole('region', { name: '会員登録のご案内' });
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: '会員登録へ進む' })).toBeVisible();
    });

    test('ログイン済みの完了画面にはカードが表示されない', async ({ page }) => {
      // FREQ-266-AC-02
      await mockAuth(page, true);
      await gotoCompletedCheckout(page);

      await expect(page.getByRole('region', { name: '会員登録のご案内' })).toHaveCount(0);
    });

    test('カードから /register へメールを引き継いで遷移する', async ({ page }) => {
      // FREQ-266-AC-03
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      await page.getByRole('link', { name: '会員登録へ進む' }).click();
      await expect(page).toHaveURL(/\/register\?email=hanako%40example\.com/);
      await expect(page.getByLabel('メールアドレス')).toHaveValue('hanako@example.com');
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAuth(page, false);
      await gotoCompletedCheckout(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

`gotoCompletedCheckout` は、完了画面の状態を作るヘルパー。`src/app/checkout/page.tsx` は `completedOrderId` の state で完了画面へ遷移するので、`/api/checkout/complete` をモックして完了させるか、既存の `e2e/FR-CHECKOUT-013-complete-ui.spec.ts` が完了画面をどう作っているかを読んで同じ手順を使う。実装時に必ず既存ファイルを確認すること。

- [ ] **Step 5: E2E を実行する**

Run: `npx playwright test e2e/FR-CHECKOUT-015-guest-register-prompt.spec.ts --reporter=list`
Expected: PASS（12件）

- [ ] **Step 6: spec.md に追記する**

```
| FREQ-266 | 注文完了画面から、注文時のメールを引き継いで会員登録へ誘導すること | FREQ-266-REQ-01 | 未ログインの注文完了画面に「会員登録へ進む」ボタンを含む案内カードを表示すること。ログイン済みでは表示しないこと | FREQ-266-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、未ログインの注文完了画面に「会員登録のご案内」領域と「会員登録へ進む」リンクが表示されること | FREQ-266-AC-02 | 同3ビューポートで、ログイン済みの完了画面に同領域が表示されないこと | FREQ-266-REQ-02 | ボタンから /register へ遷移し、注文時のメールをメール入力欄の初期値にすること。住所や電話は URL に含めないこと | FREQ-266-AC-03 | 同3ビューポートで、遷移先が /register?email=... となり、メール入力欄に注文時のメールが入っていること | FREQ-266-AC-04 | 同3ビューポートで横方向のページスクロールが発生しないこと |
```

- [ ] **Step 7: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/features/checkout/components/GuestRegisterPrompt.tsx src/app/checkout/page.tsx src/app/register/page.tsx e2e/FR-CHECKOUT-015-guest-register-prompt.spec.ts docs/2_Specs/spec.md
git commit -m "feat(checkout): 注文完了画面から会員登録へ誘導する"
```

**ここまでで FREQ-264〜266 が完結する。** 受注管理（Task 6 以降）は独立しているので、ここで止めても価値が出る。

---

## Task 6: 発送ステータスのDB基盤と配送業者マスタ（FREQ-267 前半）

設計書 5章はここに `idx_orders_unlinked_email` を作ると書いているが、作らない。紐付けを `ilike` で引く形にしたため、`lower(shipping_email)` の式インデックスは使われない（ILIKE は btree を使えない）。設計書側もこの Task の完了時に合わせて直す。

`order_status` enum は `pending, paid, failed, cancelled` のみで `shipped` が無い。

**Files:**
- Create: `migrations/083_order_status_shipped.sql`
- Create: `migrations/084_order_shipping_info.sql`
- Create: `src/lib/orders/shipping-carriers.ts`
- Test: `tests/unit/lib/orders/shipping-carriers.test.ts`（新規）

**Interfaces:**
- Produces:

```ts
export type ShippingCarrierId = 'yamato' | 'sagawa' | 'japanpost';
// z.enum に渡すため、要素型が推論されるタプル（as const）である必要がある。
// readonly ShippingCarrierId[] にすると z.enum が受け付けない。
export const SHIPPING_CARRIER_IDS: readonly ['yamato', 'sagawa', 'japanpost'];
export const SHIPPING_CARRIERS: Record<ShippingCarrierId, { label: string; trackingUrl: (n: string) => string }>;
export function isShippingCarrierId(value: unknown): value is ShippingCarrierId;
```

- [ ] **Step 1: migration 083 を書く**

`migrations/083_order_status_shipped.sql` を新規作成。

`ALTER TYPE ... ADD VALUE` で追加した値は同一トランザクション内で使えないため、enum の追加だけを独立した1本にする。

```sql
-- 083: 注文ステータスに「発送済み」を追加する
--
-- ALTER TYPE ... ADD VALUE で追加した値は、同じトランザクション内では使えない。
-- 列追加や制約と混ぜず、この1本だけを独立させる。
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'shipped';
```

- [ ] **Step 2: migration 084 を書く**

`migrations/084_order_shipping_info.sql` を新規作成。

```sql
-- ============================================================
-- 084: 発送情報と、ゲスト注文の紐付け用インデックス
--
-- ここで追加する列は migration 081 の不変列リストに入っていないので更新できる。
-- 変更は record_order_revision トリガーが order_revisions へ記録する。
-- ============================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS shipping_carrier text NULL
    CHECK (shipping_carrier IS NULL OR shipping_carrier IN ('yamato', 'sagawa', 'japanpost')),
  ADD COLUMN IF NOT EXISTS tracking_number text NULL
    CHECK (tracking_number IS NULL OR tracking_number ~ '^[0-9A-Za-z-]{1,64}$');

-- ADD CONSTRAINT に IF NOT EXISTS は無いので、DROP してから足して再実行可能にする。
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_shipping_info_requires_shipped_at;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_shipping_info_requires_shipped_at
  CHECK (shipped_at IS NOT NULL OR (shipping_carrier IS NULL AND tracking_number IS NULL));

COMMENT ON COLUMN public.orders.shipped_at IS
  '発送日時。NULL は未発送。発送の二重実行を防ぐ条件にも使う。';
COMMENT ON COLUMN public.orders.shipping_carrier IS
  '配送業者。追跡URLの形式は src/lib/orders/shipping-carriers.ts が持つ。';

-- 紐付け用のインデックスは作らない。
-- 紐付けは PostgREST の ilike（大文字小文字を無視した等値比較）で引くが、
-- ILIKE は btree インデックスを使えないため lower(shipping_email) の
-- 式インデックスを作っても効かない。orders は現在16行で、全表走査でも問題ない。
-- 件数が数万に育ったら pg_trgm の GIN か、メールを保存時に正規化する方針へ切り替える。

COMMIT;
```

- [ ] **Step 3: マイグレーションを適用する**

Supabase MCP の `apply_migration` を使い、083 → 084 の順に別々に適用する。プロジェクト ID は `.env.local` の `NEXT_PUBLIC_SUPABASE_URL` から読む。

適用後に確認する。

```sql
select unnest(enum_range(NULL::public.order_status)) as status;
select column_name from information_schema.columns
 where table_schema='public' and table_name='orders'
   and column_name in ('shipped_at','shipping_carrier','tracking_number');
```

Expected: `shipped` が enum に含まれ、3列が存在する

- [ ] **Step 4: 配送業者マスタの失敗するテストを書く**

`tests/unit/lib/orders/shipping-carriers.test.ts` を新規作成。

```ts
import {
  SHIPPING_CARRIERS,
  SHIPPING_CARRIER_IDS,
  isShippingCarrierId,
} from '@/lib/orders/shipping-carriers';

describe('shipping carriers', () => {
  test('3社のラベルを持つ', () => {
    expect(SHIPPING_CARRIER_IDS).toEqual(['yamato', 'sagawa', 'japanpost']);
    expect(SHIPPING_CARRIERS.yamato.label).toBe('ヤマト運輸');
    expect(SHIPPING_CARRIERS.sagawa.label).toBe('佐川急便');
    expect(SHIPPING_CARRIERS.japanpost.label).toBe('日本郵便');
  });

  test('追跡番号を含む追跡URLを組み立てる', () => {
    expect(SHIPPING_CARRIERS.yamato.trackingUrl('1234-5678-9012')).toContain('1234-5678-9012');
    expect(SHIPPING_CARRIERS.sagawa.trackingUrl('123456789012')).toContain('123456789012');
    expect(SHIPPING_CARRIERS.japanpost.trackingUrl('123456789012')).toContain('123456789012');
  });

  test('追跡番号をURLエンコードする', () => {
    expect(SHIPPING_CARRIERS.yamato.trackingUrl('a b')).toContain('a%20b');
  });

  test('未知の業者IDを弾く', () => {
    expect(isShippingCarrierId('yamato')).toBe(true);
    expect(isShippingCarrierId('dhl')).toBe(false);
    expect(isShippingCarrierId(null)).toBe(false);
  });
});
```

- [ ] **Step 5: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/lib/orders/shipping-carriers.test.ts`
Expected: FAIL with "Cannot find module '@/lib/orders/shipping-carriers'"

- [ ] **Step 6: 配送業者マスタを実装する**

`src/lib/orders/shipping-carriers.ts` を新規作成。

```ts
/**
 * 配送業者のラベルと追跡URL。
 *
 * URL の形式は業者都合で変わるのでコードで管理し、デプロイで直す。
 * DB にマスタを持つと管理UIが要るが、業者は年に何度も増えない。
 */
export type ShippingCarrierId = 'yamato' | 'sagawa' | 'japanpost';

export const SHIPPING_CARRIER_IDS = ['yamato', 'sagawa', 'japanpost'] as const;

export const SHIPPING_CARRIERS: Record<
  ShippingCarrierId,
  { label: string; trackingUrl: (trackingNumber: string) => string }
> = {
  yamato: {
    label: 'ヤマト運輸',
    trackingUrl: (n) =>
      `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=${encodeURIComponent(n)}`,
  },
  sagawa: {
    label: '佐川急便',
    trackingUrl: (n) =>
      `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(n)}`,
  },
  japanpost: {
    label: '日本郵便',
    trackingUrl: (n) =>
      `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(n)}&searchKind=S002&locale=ja`,
  },
};

export function isShippingCarrierId(value: unknown): value is ShippingCarrierId {
  return typeof value === 'string' && (SHIPPING_CARRIER_IDS as readonly string[]).includes(value);
}
```

- [ ] **Step 7: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/lib/orders/shipping-carriers.test.ts`
Expected: PASS（4件）

- [ ] **Step 8: 追跡URLの疎通を目視で確認する**

3社の `trackingUrl` が返す URL をブラウザで開き、追跡番号の入力画面または結果画面が出ることを確認する。形式が変わっていたら実際の形式に直し、テストも合わせる。

- [ ] **Step 9: コミット**

```bash
git add migrations/083_order_status_shipped.sql migrations/084_order_shipping_info.sql src/lib/orders/shipping-carriers.ts tests/unit/lib/orders/shipping-carriers.test.ts
git commit -m "feat(orders): 発送ステータスのDB基盤と配送業者マスタを追加"
```

---

## Task 7: 発送API（FREQ-267 中盤）

**Files:**
- Modify: `src/app/api/admin/orders/[id]/status/route.ts`
- Modify: `src/app/api/admin/orders/route.ts`
- Test: `tests/unit/api/admin/order-status-shipped.test.ts`（新規）

**Interfaces:**
- Consumes: Task 6 の `ShippingCarrierId` / `SHIPPING_CARRIER_IDS`
- Produces: `POST /api/admin/orders/[id]/status` が `{ status: 'shipped', carrier, trackingNumber }` を受け付ける

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/api/admin/order-status-shipped.test.ts` を新規作成。既存の `tests/unit/api/checkout/complete-route.test.ts` のモック構造に倣う。

```ts
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockSelect = jest.fn();
const mockIs = jest.fn(() => ({ select: mockSelect }));
const mockEqStatus = jest.fn(() => ({ is: mockIs }));
const mockEqId = jest.fn(() => ({ eq: mockEqStatus }));
const mockUpdate = jest.fn(() => ({ eq: mockEqId }));
const mockFrom = jest.fn(() => ({ update: mockUpdate }));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn().mockResolvedValue({ from: mockFrom }),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1' }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockSendOrderShippedEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-shipped-email', () => ({
  sendOrderShippedEmail: (...args: unknown[]) => mockSendOrderShippedEmail(...args),
}));

import { POST } from '@/app/api/admin/orders/[id]/status/route';

const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

function makeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };

describe('POST /api/admin/orders/[id]/status - shipped', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('paid の注文を発送済みにできる', async () => {
    mockSelect.mockResolvedValue({
      data: [{ id: ORDER_ID, shipping_email: 'hanako@example.com' }],
      error: null,
    });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(200);
    // status='paid' かつ shipped_at IS NULL の行だけを更新する
    expect(mockEqStatus).toHaveBeenCalledWith('status', 'paid');
    expect(mockIs).toHaveBeenCalledWith('shipped_at', null);
    expect(mockSendOrderShippedEmail).toHaveBeenCalledTimes(1);
  });

  test('更新対象が無ければ 409 を返し、メールを送らない', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null });

    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678-9012' }),
      CONTEXT,
    );

    expect(res.status).toBe(409);
    expect(mockSendOrderShippedEmail).not.toHaveBeenCalled();
  });

  test('未知の配送業者は 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'dhl', trackingNumber: '1234' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test('追跡番号に記号が混ざると 400 を返す', async () => {
    const res: any = await POST(
      makeRequest({ status: 'shipped', carrier: 'yamato', trackingNumber: '12 34/56' }),
      CONTEXT,
    );

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/api/admin/order-status-shipped.test.ts`
Expected: FAIL。`shipped` が zod に無いので 400 になる

- [ ] **Step 3: status API を拡張する**

`src/app/api/admin/orders/[id]/status/route.ts` を編集する。

import を追加する。

```ts
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';
```

`updateStatusSchema` を判別ユニオンに差し替える。

```ts
const updateStatusSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('cancelled') }),
	z.object({
		status: z.literal('shipped'),
		carrier: z.enum(SHIPPING_CARRIER_IDS),
		trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
	}),
]);
```

キャンセル処理の分岐の前に、発送の分岐を追加する。

```ts
	if (parsedBody.data.status === 'shipped') {
		// 読んでから書く形にしない。status と shipped_at を条件に含めた
		// UPDATE 1本で確定させることで、同時に2回押しても発送は1回しか成立せず、
		// 通知メールも1通しか出ない。
		const { data, error } = await supabase
			.from('orders')
			.update({
				status: 'shipped',
				shipped_at: new Date().toISOString(),
				shipping_carrier: parsedBody.data.carrier,
				tracking_number: parsedBody.data.trackingNumber,
			})
			.eq('id', id)
			.eq('status', 'paid')
			.is('shipped_at', null)
			.select('id, shipping_email, shipping_full_name');

		if (error) {
			console.error('[admin.orders.status] Failed to ship order:', error);
			return NextResponse.json({ error: '発送状態の更新に失敗しました。' }, { status: 500 });
		}

		if (!data?.length) {
			await logAudit({
				action: 'admin.orders.status.update',
				actor_id: authz.userId,
				outcome: 'failure',
				resource: 'orders',
				resource_id: id,
				detail: 'not_shippable',
			});
			return NextResponse.json(
				{ error: '発送できる状態ではありません。決済完了の未発送注文のみ発送できます。' },
				{ status: 409 },
			);
		}

		await logAudit({
			action: 'admin.orders.status.update',
			actor_id: authz.userId,
			outcome: 'success',
			resource: 'orders',
			resource_id: id,
			metadata: { status: 'shipped', carrier: parsedBody.data.carrier },
		});

		await sendOrderShippedEmail({
			orderId: id,
			email: data[0].shipping_email,
			fullName: data[0].shipping_full_name,
			carrier: parsedBody.data.carrier,
			trackingNumber: parsedBody.data.trackingNumber,
		});

		return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
	}
```

- [ ] **Step 4: 一覧APIに shipped を通す**

`src/app/api/admin/orders/route.ts` を編集する。

- `OrderRow['status']` の union に `'shipped'` を足す
- クエリの `z.enum(['pending', 'paid', 'failed', 'cancelled'])` に `'shipped'` を足す
- `mapOrderStatusToLabel` に分岐を足す

```ts
	if (status === 'shipped') {
		return '発送済み';
	}
```

- `.select(...)` の列に `shipped_at, shipping_carrier, tracking_number` を足し、レスポンスに含める

- [ ] **Step 5: テストを実行して通ることを確認する**

この時点で `sendOrderShippedEmail` はまだ存在しないので、Task 8 のモジュールを先に空実装で作る。

`src/lib/orders/order-shipped-email.ts` に仮の実装を置く（Task 8 で中身を書く）。

```ts
export async function sendOrderShippedEmail(_params: {
  orderId: string;
  email: string | null;
  fullName: string | null;
  carrier: string;
  trackingNumber: string;
}): Promise<void> {
  return;
}
```

Run: `npx jest tests/unit/api/admin/order-status-shipped.test.ts`
Expected: PASS（4件）

- [ ] **Step 6: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/api/admin/orders/[id]/status/route.ts src/app/api/admin/orders/route.ts src/lib/orders/order-shipped-email.ts tests/unit/api/admin/order-status-shipped.test.ts
git commit -m "feat(admin): 注文を発送済みにするAPIを追加"
```

---

## Task 8: 発送通知メール（FREQ-268）

**Files:**
- Modify: `src/lib/orders/order-shipped-email.ts`（Task 7 の仮実装を置き換える）
- Test: `tests/unit/lib/orders/order-shipped-email.test.ts`（新規）
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Consumes: Task 6 の `SHIPPING_CARRIERS` / `ShippingCarrierId`
- Produces:

```ts
export async function sendOrderShippedEmail(params: {
  orderId: string;
  email: string | null;
  fullName: string | null;
  carrier: ShippingCarrierId;
  trackingNumber: string;
}): Promise<void>;
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/orders/order-shipped-email.test.ts` を新規作成。

```ts
const mockSendMail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';

const BASE = {
  orderId: 'a1b2c3d4-1111-2222-3333-444455556666',
  email: 'hanako@example.com',
  fullName: '山田 花子',
  carrier: 'yamato' as const,
  trackingNumber: '1234-5678-9012',
};

describe('sendOrderShippedEmail', () => {
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    env.MAIL_FROM_ADDRESS = 'noreply@example.com';
  });

  test('配送業者・追跡番号・追跡URLを本文に含める', async () => {
    await sendOrderShippedEmail(BASE);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('hanako@example.com');
    expect(call.subject).toContain('ORD-A1B2C3D4');
    expect(call.text).toContain('ヤマト運輸');
    expect(call.text).toContain('1234-5678-9012');
    expect(call.text).toContain('toi.kuronekoyamato.co.jp');
  });

  test('メールアドレスが無いときは送らない', async () => {
    await sendOrderShippedEmail({ ...BASE, email: null });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('送信に失敗しても例外を投げず監査ログに残す', async () => {
    mockSendMail.mockRejectedValueOnce(new Error('smtp down'));

    await expect(sendOrderShippedEmail(BASE)).resolves.toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.shipped.mail', outcome: 'error' }),
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx jest tests/unit/lib/orders/order-shipped-email.test.ts`
Expected: FAIL。仮実装は何もしないので `mockSendMail` が呼ばれない

- [ ] **Step 3: 実装する**

`src/lib/orders/order-shipped-email.ts` を書き換える。

```ts
import sendMail from '@/lib/mail';
import { toOrderNumber } from '@/lib/orders/order-number';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIERS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

type OrderShippedParams = {
  orderId: string;
  email: string | null;
  fullName: string | null;
  carrier: ShippingCarrierId;
  trackingNumber: string;
};

/**
 * 発送通知メールを送る。
 *
 * 送信に失敗しても発送処理は成功のまま（DB は既に shipped）。巻き戻すと
 * 二重発送の判定が壊れるので、監査ログに残すだけで例外は投げない。
 * 自動再送はしない。
 */
export async function sendOrderShippedEmail(params: OrderShippedParams): Promise<void> {
  const { orderId, email, fullName, carrier, trackingNumber } = params;

  if (!email || !process.env.MAIL_FROM_ADDRESS) {
    return;
  }

  const orderNumber = toOrderNumber(orderId);
  const carrierInfo = SHIPPING_CARRIERS[carrier];

  const text = [
    fullName ? `${fullName} 様` : 'お客様',
    '',
    'ご注文の商品を発送いたしました。',
    '',
    `注文番号: ${orderNumber}`,
    '',
    `配送業者: ${carrierInfo.label}`,
    `追跡番号: ${trackingNumber}`,
    `追跡はこちら: ${carrierInfo.trackingUrl(trackingNumber)}`,
    '',
    '※ 追跡情報は反映までに数時間かかる場合があります。',
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');

  try {
    await sendMail({
      to: email,
      subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
      text,
    });
  } catch (error) {
    console.warn('Order shipped mail send failed. Shipment is recorded:', error);
    await logAudit({
      action: 'order.shipped.mail',
      outcome: 'error',
      resource: 'order',
      resource_id: orderId,
      detail: 'mail_send_failed',
    });
  }
}
```

- [ ] **Step 4: テストを実行して通ることを確認する**

Run: `npx jest tests/unit/lib/orders/order-shipped-email.test.ts tests/unit/api/admin/order-status-shipped.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: spec.md に追記する**

```
| FREQ-268 | 注文を発送済みにしたとき、配送業者と追跡番号を含む発送通知メールを送信すること | FREQ-268-REQ-01 | 発送が成立したとき、注文時のメールアドレス宛に配送業者名・追跡番号・追跡URLを含むメールを送信すること | FREQ-268-AC-01 | 発送時に送信されるメール本文に「ヤマト運輸」「1234-5678-9012」と追跡URLが含まれること | FREQ-268-REQ-02 | 既に発送済みの注文を再度発送しようとした場合、メールを再送しないこと | FREQ-268-AC-02 | 更新対象が0件のとき sendOrderShippedEmail が呼ばれないこと | FREQ-268-REQ-03 | メール送信に失敗しても発送処理は成功として扱い、監査ログに記録すること | FREQ-268-AC-03 | 送信失敗時に例外を投げず、action=order.shipped.mail / outcome=error の監査ログが記録されること |
```

- [ ] **Step 6: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/lib/orders/order-shipped-email.ts tests/unit/lib/orders/order-shipped-email.test.ts docs/2_Specs/spec.md
git commit -m "feat(orders): 発送通知メールを追加"
```

---

## Task 9: 管理画面の発送操作（FREQ-267 後半）

**Files:**
- Modify: `src/components/OrderSection.tsx`
- Modify: `src/app/admin/page.tsx`
- Test: `e2e/FR-ADMIN-050-order-shipping.spec.ts`（新規）
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Consumes: Task 6 の `SHIPPING_CARRIERS` / `SHIPPING_CARRIER_IDS` / `ShippingCarrierId`
- Produces: `OrderSectionProps` に `onShipOrder?: (id: string) => void` を追加。`OrderStatus` に `'発送済み'` を追加

- [ ] **Step 1: OrderSection に発送済みステータスと操作を足す**

`src/components/OrderSection.tsx` を編集する。

型を広げる。

```ts
export type OrderStatus = '未決済' | '決済完了' | '決済失敗' | 'キャンセル' | '発送済み';
```

`statusClassMap` に1行足す。

```ts
		発送済み: 'bg-green-100 text-green-800',
```

props に発送ハンドラを足す。

```ts
	onShipOrder?: (id: string) => void;
```

`export default function OrderSection({ ... })` の分割代入にも `onShipOrder,` を足す。

操作列に発送ボタンを足す。既存のキャンセルボタンの前に置く。

```tsx
								{order.status === '決済完了' && onShipOrder ? (
									<Button
										variant="primary"
										size="sm"
										className="font-acumin"
										onClick={() => onShipOrder(order.id)}
										disabled={isProcessing}
									>
										{isProcessing ? '処理中...' : '発送済みにする'}
									</Button>
								) : null}
```

`actionLabelMap` は触らない。発送済みの行はキャンセルもできない（`actionLabelMap['発送済み']` が undefined なのでボタンが出ない）。

- [ ] **Step 2: admin/page.tsx に発送ダイアログを足す**

`src/app/admin/page.tsx` を編集する。

import を追加する。

```tsx
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SHIPPING_CARRIERS, SHIPPING_CARRIER_IDS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
```

state を追加する。

```tsx
  const [shipOrderId, setShipOrderId] = useState<string | null>(null);
  const [shipCarrier, setShipCarrier] = useState<ShippingCarrierId>('yamato');
  const [shipTrackingNumber, setShipTrackingNumber] = useState('');
```

`handleCancelOrder` の下にハンドラを追加する。

```tsx
  const openShipDialog = (id: string) => {
    setShipCarrier('yamato');
    setShipTrackingNumber('');
    setShipOrderId(id);
  };

  const handleShipOrder = async () => {
    const id = shipOrderId;
    if (!id) return;

    if (!/^[0-9A-Za-z-]{1,64}$/.test(shipTrackingNumber.trim())) {
      setOrdersErrorMessage('追跡番号は英数字とハイフンで入力してください。');
      return;
    }

    try {
      setOrdersErrorMessage(null);
      updateProcessingOrder(id, true);
      setShipOrderId(null);

      const response = await clientFetch(`/api/admin/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'shipped',
          carrier: shipCarrier,
          trackingNumber: shipTrackingNumber.trim(),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('発送できる状態ではありません。一覧を更新して状態を確認してください。');
        }
        if (response.status === 403) {
          throw new Error('注文ステータス更新の権限がありません。');
        }
        throw new Error('発送状態の更新に失敗しました。');
      }

      setOrders((prevOrders) =>
        prevOrders.map((order) => (order.id === id ? { ...order, status: '発送済み' } : order)),
      );
    } catch (error) {
      console.error('Failed to ship order:', error);
      setOrdersErrorMessage(error instanceof Error ? error.message : '発送状態の更新に失敗しました。');
    } finally {
      updateProcessingOrder(id, false);
    }
  };
```

`<OrderSection ... />` に props を渡す。

```tsx
            onShipOrder={openShipDialog}
```

同じ JSX ツリー内、`OrderSection` の後ろにダイアログを置く。

```tsx
          <Dialog
            open={shipOrderId !== null}
            onClose={() => setShipOrderId(null)}
            title="発送済みにする"
            confirmText="発送する"
            cancelText="キャンセル"
            onConfirm={() => void handleShipOrder()}
          >
            <div className="space-y-3">
              <div>
                <label htmlFor="ship-carrier" className="block font-acumin text-xs text-[#474747]">
                  配送業者
                </label>
                <select
                  id="ship-carrier"
                  value={shipCarrier}
                  onChange={(event) => setShipCarrier(event.target.value as ShippingCarrierId)}
                  className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin text-xs text-black"
                >
                  {SHIPPING_CARRIER_IDS.map((id) => (
                    <option key={id} value={id}>
                      {SHIPPING_CARRIERS[id].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ship-tracking" className="block font-acumin text-xs text-[#474747]">
                  追跡番号
                </label>
                <input
                  id="ship-tracking"
                  type="text"
                  inputMode="numeric"
                  maxLength={64}
                  value={shipTrackingNumber}
                  onChange={(event) => setShipTrackingNumber(event.target.value)}
                  placeholder="1234-5678-9012"
                  className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin text-xs text-black"
                />
              </div>
            </div>
          </Dialog>
```

- [ ] **Step 3: E2E を書く**

`e2e/FR-ADMIN-050-order-shipping.spec.ts` を新規作成。`e2e/FR-ADMIN-049-entry-review-acknowledgement.spec.ts` の `mockAdminApis` の構造をそのまま流用し、`/api/admin/orders` を差し替える。

```ts
import { test, expect, Page } from '@playwright/test';

// FREQ-267: 決済完了の注文を、配送業者と追跡番号を添えて発送済みにできる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDERS = [
  {
    id: 'order-paid',
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-08-01',
    itemCount: '1点',
    items: [{ name: 'シルクブラウス', quantity: 1 }],
    totalAmount: '¥28,800',
    status: '決済完了',
  },
  {
    id: 'order-pending',
    customerName: '佐藤 太郎',
    customerEmail: 'taro@example.com',
    orderDate: '2026-08-02',
    itemCount: '1点',
    items: [{ name: 'タックスカート', quantity: 1 }],
    totalAmount: '¥32,000',
    status: '未決済',
  },
  {
    id: 'order-shipped',
    customerName: '鈴木 次郎',
    customerEmail: 'jiro@example.com',
    orderDate: '2026-08-03',
    itemCount: '1点',
    items: [{ name: 'コート', quantity: 1 }],
    totalAmount: '¥58,000',
    status: '発送済み',
  },
];

async function mockAdminApis(page: Page): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'a', email: 'a@e.com', role: 'admin', mfaVerified: true },
      }),
    }),
  );

  await page.route('**/api/admin/orders?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { orders: ORDERS, totalCount: ORDERS.length, totalPages: 1 },
      }),
    }),
  );

  await page.route('**/api/admin/orders/*/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'shipped' }),
    }),
  );
}

async function openOrders(page: Page) {
  await page.goto('/admin');
  await page.getByRole('button', { name: 'ORDER' }).click();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-050 order shipping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminApis(page);
    });

    test('決済完了の注文にだけ発送ボタンが出る', async ({ page }) => {
      // FREQ-267-AC-01 / AC-02
      await openOrders(page);

      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(1);
    });

    test('配送業者と追跡番号を入力して発送できる', async ({ page }) => {
      // FREQ-267-AC-03
      await openOrders(page);

      await page.getByRole('button', { name: '発送済みにする' }).click();
      await expect(page.getByLabel('配送業者')).toBeVisible();
      await page.getByLabel('配送業者').selectOption('yamato');
      await page.getByLabel('追跡番号').fill('1234-5678-9012');
      await page.getByRole('button', { name: '発送する' }).click();

      // exact を付けないとボタン文言「発送済みにする」も部分一致で拾ってしまう。
      await expect(page.getByText('発送済み', { exact: true })).toHaveCount(2);
      await expect(page.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await openOrders(page);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 4: E2E を実行する**

Run: `npx playwright test e2e/FR-ADMIN-050-order-shipping.spec.ts --reporter=list`
Expected: PASS（9件）

落ちた場合は、`/api/admin/orders` のレスポンス形と ADMIN タブのボタン名を実物に合わせて修正する。

- [ ] **Step 5: spec.md に追記する**

```
| FREQ-267 | 注文を発送済みにでき、配送業者と追跡番号を記録・表示すること | FREQ-267-REQ-01 | ADMIN の ORDER タブで、決済完了かつ未発送の注文にのみ「発送済みにする」操作を出すこと | FREQ-267-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、決済完了の注文にのみ「発送済みにする」ボタンが表示されること | FREQ-267-REQ-02 | 発送時に配送業者と追跡番号を入力させ、発送後は一覧のステータスを「発送済み」にすること | FREQ-267-AC-02 | 同3ビューポートで、配送業者と追跡番号を入力して発送すると一覧のステータスが「発送済み」になり、発送ボタンが消えること | FREQ-267-REQ-03 | 決済完了以外のステータスや発送済みの注文は発送できないこと | FREQ-267-AC-03 | 更新対象が0件のとき409を返すこと | FREQ-267-AC-04 | 同3ビューポートで横方向のページスクロールが発生しないこと |
```

- [ ] **Step 6: 型チェックとコミット**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/components/OrderSection.tsx src/app/admin/page.tsx e2e/FR-ADMIN-050-order-shipping.spec.ts docs/2_Specs/spec.md
git commit -m "feat(admin): 注文を発送済みにする操作を追加"
```

---

## Task 10: 注文詳細に発送情報を表示する（FREQ-267 表示側）

**Files:**
- Modify: `src/app/account/orders/[id]/page.tsx`
- Test: `e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts`（新規）
- Modify: `docs/2_Specs/spec.md`

**Interfaces:**
- Consumes: Task 6 の `SHIPPING_CARRIERS` / `isShippingCarrierId`

`src/lib/orders/order-status.ts` は既に `shipped: '発送済み'` と `resolveOrderProgressIndex` の `shipped → 2` を持っているので、ステータス表示と進捗バーは変更不要。

- [ ] **Step 1: 注文詳細に発送情報を足す**

`src/app/account/orders/[id]/page.tsx` を編集する。

import を追加する。

```tsx
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
```

注文の型（L29 付近の `orderNumber: string;` があるオブジェクト型）に3つ足す。

```tsx
  shippedAt: string | null;
  shippingCarrier: string | null;
  trackingNumber: string | null;
```

注文番号を表示しているブロック（L162 付近の `注文番号` ラベルがある箇所）の後ろにセクションを足す。

```tsx
{order.shippingCarrier && order.trackingNumber && isShippingCarrierId(order.shippingCarrier) ? (
  <section aria-label="配送情報" className="mt-6">
    <h2 className="mb-2 text-[#474747] tracking-wider">配送情報</h2>
    <dl className="space-y-1 text-sm">
      <div className="flex gap-2">
        <dt className="text-[#707070]">配送業者</dt>
        <dd>{SHIPPING_CARRIERS[order.shippingCarrier].label}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-[#707070]">追跡番号</dt>
        <dd className="tabular-nums">{order.trackingNumber}</dd>
      </div>
    </dl>
    <a
      href={SHIPPING_CARRIERS[order.shippingCarrier].trackingUrl(order.trackingNumber)}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 inline-block text-sm underline"
    >
      配送状況を確認する
    </a>
  </section>
) : null}
```

`target="_blank"` には必ず `rel="noopener noreferrer"` を付ける。付けないと遷移先から `window.opener` 経由で元のページを操作できる。

取得元は `src/app/api/orders/[id]/route.ts`（詳細ページ L72 の `clientFetch(\`/api/orders/${params.id}\`)`）。この route の `select` に `shipped_at, shipping_carrier, tracking_number` を足し、レスポンスのマッピングで `shippedAt` / `shippingCarrier` / `trackingNumber` として返す。

一覧側（`src/app/api/orders/route.ts`）は今回触らない。購入履歴の一覧に追跡番号は出さない。

- [ ] **Step 2: E2E を書く**

`e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts` を新規作成。

```ts
import { test, expect, Page } from '@playwright/test';

// FREQ-267: 発送済みの注文詳細に配送業者・追跡番号・追跡リンクを出す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const ORDER_ID = 'a1b2c3d4-1111-2222-3333-444455556666';

const SHIPPED_ORDER = {
  id: ORDER_ID,
  orderNumber: 'ORD-A1B2C3D4',
  status: 'shipped',
  createdAt: '2026-08-01T00:00:00.000Z',
  totalAmount: 28800,
  items: [{ itemName: 'シルクブラウス', quantity: 1, lineTotal: 28000 }],
  shippedAt: '2026-08-05T00:00:00.000Z',
  shippingCarrier: 'yamato',
  trackingNumber: '1234-5678-9012',
};

const PAID_ORDER = {
  ...SHIPPED_ORDER,
  status: 'paid',
  shippedAt: null,
  shippingCarrier: null,
  trackingNumber: null,
};

async function mockOrderDetail(page: Page, order: unknown): Promise<void> {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: { id: 'user-1', email: 'hanako@example.com', role: 'user', mfaVerified: true },
      }),
    }),
  );

  await page.route(`**/api/orders/${ORDER_ID}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: order }),
    }),
  );
}

for (const viewport of viewports) {
  test.describe(`FR-ACCOUNT-031 order shipping info (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送済みの注文に配送情報が出る', async ({ page }) => {
      // FREQ-267-AC-05
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const section = page.getByRole('region', { name: '配送情報' });
      await expect(section).toBeVisible();
      await expect(section.getByText('ヤマト運輸')).toBeVisible();
      await expect(section.getByText('1234-5678-9012')).toBeVisible();

      const link = section.getByRole('link', { name: '配送状況を確認する' });
      await expect(link).toHaveAttribute('href', /toi\.kuronekoyamato\.co\.jp/);
      await expect(link).toHaveAttribute('rel', /noopener/);
    });

    test('未発送の注文には配送情報が出ない', async ({ page }) => {
      // FREQ-267-AC-06
      await mockOrderDetail(page, PAID_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      await expect(page.getByRole('region', { name: '配送情報' })).toHaveCount(0);
    });

    test('横方向のページスクロールが発生しない', async ({ page }) => {
      await mockOrderDetail(page, SHIPPED_ORDER);
      await page.goto(`/account/orders/${ORDER_ID}`);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
```

- [ ] **Step 3: E2E を実行する**

Run: `npx playwright test e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts --reporter=list`
Expected: PASS（9件）

- [ ] **Step 4: spec.md の FREQ-267 に受け入れ基準を追記する**

Task 9 で追加した FREQ-267 の行の末尾に、追跡表示の REQ と AC を足す。

```
 | FREQ-267-REQ-04 | 発送済みの注文詳細に配送業者・追跡番号・追跡リンクを表示し、未発送では表示しないこと | FREQ-267-AC-05 | 同3ビューポートで、発送済みの注文詳細に「配送情報」領域と「ヤマト運輸」「1234-5678-9012」「配送状況を確認する」リンクが表示されること | FREQ-267-AC-06 | 同3ビューポートで、未発送の注文詳細に「配送情報」領域が表示されないこと |
```

- [ ] **Step 5: 全テストを実行してコミット**

```bash
npx tsc --noEmit -p tsconfig.json
npx jest
npx playwright test e2e/FR-ACCOUNT-030-guest-order-linking.spec.ts e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts e2e/FR-CHECKOUT-015-guest-register-prompt.spec.ts e2e/FR-ADMIN-050-order-shipping.spec.ts --reporter=list
git add src/app/account/orders/[id]/page.tsx e2e/FR-ACCOUNT-031-order-shipping-info.spec.ts docs/2_Specs/spec.md
git commit -m "feat(account): 注文詳細に配送業者と追跡番号を表示する"
```

Expected: 型チェック・Jest 全件・E2E 39件すべて PASS

---

## Task 11: グラフの更新と最終確認

**Files:**
- Modify: `graphify-out/`（自動生成）

- [ ] **Step 1: 知識グラフを更新する**

```bash
graphify update .
```

- [ ] **Step 2: 全テストを流す**

```bash
npx tsc --noEmit -p tsconfig.json
npx jest
npx playwright test --reporter=list
```

Expected: すべて PASS。落ちたテストがあれば、まず単体で再実行して環境由来か実装由来かを切り分ける

- [ ] **Step 3: コミット**

```bash
git add graphify-out
git commit -m "chore(graphify): ゲスト購入導線の実装を反映"
```
