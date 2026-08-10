# ゲスト購入後の導線設計

作成日: 2026-08-10

## 概要

ゲスト（会員登録なし）で購入した客が、注文後に注文内容と配送状況を把握できるようにする。

方針は「**ゲスト向けの照会画面は作らず、メールで完結させる**」。ゲストは注文確認メールと発送通知メールで注文内容・お届け先・追跡番号を確認する。会員登録した客は、過去のゲスト注文がマイページの購入履歴に現れる。

### 調査で判明した前提の崩れ

設計中に、この方針が現状のままでは成立しないことが分かった。

1. **注文確認メールが一度も送られていない。** `src/lib/orders/order-confirmation-email.ts` の `sendOrderConfirmationEmail` は定義だけで、import している箇所が0件。テストも無い。メール基盤自体は動いている（問い合わせ・パスワードリセットが `sendMail` を使用）ので、配線だけが抜けている
2. **そのメール本文にお届け先が入っていない。** 「住所を間違えていないか」という最も多い用途を満たせない
3. **「発送済み」という状態が存在しない。** `order_status` enum は `pending, paid, failed, cancelled` のみ。管理APIは `z.enum(['cancelled'])` でキャンセルしかできない。発送しても DB 上は `paid` のまま
4. **追跡番号の実装が無い。** ただし完了画面（`src/app/checkout/page.tsx` L1549）が「発送完了後、追跡番号をメールでお知らせいたします」と既に客に約束している

このため、当初の「紐付けと登録誘導の2本」からスコープを広げ、メールの配線と受注管理（発送）まで含める。

## 1. 全体像

| 要求 | 内容 | 依存 |
|---|---|---|
| FREQ-264 | 注文確認メールを実際に送る＋お届け先を含める | なし |
| FREQ-265 | 会員紐付け | なし |
| FREQ-266 | 完了画面の登録誘導 | FREQ-265（住所引き継ぎのため） |
| FREQ-267 | 発送ステータスの導入 | なし |
| FREQ-268 | 発送通知メール | FREQ-267 |

実装順は 264 → 265 → 266 → 267 → 268。

264〜266（メールの配線と会員導線）と 267〜268（受注管理）は互いに独立している。実装計画は 266 の完了時点でいったん区切れる形にし、そこで止めても価値が出るようにする。

| | 画面 | サーバー | E2E |
|---|---|---|---|
| FREQ-264 | なし | `complete/route.ts` に配線、メール本文 | 単体のみ |
| FREQ-265 | なし | 既存2箇所にフック | `FR-ACCOUNT-030` |
| FREQ-266 | 完了画面＋`/register` | なし | `FR-CHECKOUT-015` |
| FREQ-267 | ADMIN の ORDER タブ、注文詳細 | status API、migration 083・084 | `FR-ADMIN-050` / `FR-ACCOUNT-031` |
| FREQ-268 | なし | 発送通知メール | 単体のみ |

### 実装方式

サーバー側の処理は Route Handler ＋ service-role client で実装する。`src/app/api/contact/route.ts` が公開 POST の完成形（同一オリジン検証 → レート制限 → zod → service-role → 監査ログ）で、既存コードはこの形に寄っている。

Postgres RPC には寄せない。このプロジェクトの RPC は PostgREST 経由で `anon` から直接呼べる状態で、セキュリティアドバイザーが `finalize_order_from_checkout_draft` を含む複数を警告している。関数を増やすと攻撃面が広がる。

`auth.users` へのトリガーも採らない。Supabase のアップグレードで壊れやすく、「ログイン毎に走らせる」を満たせない（ログインは `auth.users` を更新しないことがある）。

紐付けは1つの共通関数に閉じ、呼び出し側を2箇所に限定して、両経路を E2E で押さえる。

### 採用しなかった案: ゲスト注文照会

注文番号とメールで注文内容を表示する公開ページ（`/orders/lookup`）を検討したが、採らない。ゲストには注文確認メールと発送通知メールが届くので、そこで用が足りる。照会画面を持つと、注文番号とメールを知る第三者が住所・電話を閲覧できる経路が増える。

この判断により、注文番号での前方一致検索が不要になった。`orders.id` は `uuid` 型で PostgREST から前方一致検索できないため生成列 `order_number` の追加を検討していたが、これも作らない。

## 2. 注文確認メールの配線（FREQ-264）

### 送信箇所

`src/app/api/checkout/complete/route.ts` の**注文が新規に確定した2経路**で、レスポンスを返す直前に `await` する。

- `finalize_order_from_checkout_draft` RPC の成功後
- レガシースキーマ用フォールバック `finalizeOrderDirectlyFromDraft` の成功後

既存注文の早期リターン経路（同じ `payment_intent_id` で再度呼ばれたとき）では送らない。これで二重送信は起きない。

`sendOrderConfirmationEmail` は既に失敗を握りつぶして監査ログだけ残す設計なので、メール障害で注文完了が壊れることはない。

Stripe Webhook 側には置かない。注文行を作るのは `complete` だけで、Webhook は `pending → paid` を切り替えるだけだから。

### 本文にお届け先を追加

`OrderConfirmationParams` に配送先を追加し、本文へ次を出す。

- 氏名
- 郵便番号
- 都道府県・市区町村・住所
- 建物名（あれば）
- 電話番号

既存の項目（注文番号・商品明細・小計・送料・合計・問い合わせ案内）はそのまま残す。

## 3. 会員紐付け（FREQ-265）

### 共通関数

`src/lib/orders/link-guest-orders.ts`

```ts
/**
 * 注文時のメールが一致するゲスト注文を、この会員へ紐付ける。
 * 呼び出し元の認証フローを壊さないため、失敗しても例外は投げない。
 */
export async function linkGuestOrdersByEmail(params: {
  userId: string;
  email: string;
  emailConfirmedAt: string | null;
}): Promise<number>; // 紐付いた件数
```

1. `emailConfirmedAt` が null → 何もせず 0 を返す。メール未確認の会員に紐付けると、他人のメールで登録するだけで注文を奪える
2. service-role で UPDATE

   ```sql
   UPDATE orders SET user_id = :userId
   WHERE lower(shipping_email) = lower(:email)
     AND user_id IS NULL
   ```

   `user_id IS NULL` が所有権の一方向性を担保する。既に誰かのものになった注文は決して移さない
3. `.select('id')` で件数を取り、1件以上なら監査ログ `orders.link_guest_orders` / `outcome: 'success'`（件数を metadata へ）
4. 0件は正常（ログ不要）。エラーは `console.error` ＋監査ログ `outcome: 'error'`、例外は投げない

メール正規化は `lower(trim())` のみ。Gmail の `+tag` やドット違いは別アドレスとして扱う。同一視すると他人の注文を掴む事故が起きる。

この関数は冪等（`user_id IS NULL` 条件のため何度実行しても同じ結果）。失敗しても次のログインで自然に復旧する。これが「ログイン毎にも走らせる」を選んだ実質的な理由。

### 呼び出し2箇所

ログインは2段階で、`/api/auth/login` はパスワード検証と OTP 送信だけを行う（`outcome: 'password_verified'`）。セッションが立つのは `/api/auth/otp/verify` なので、フックはそちらに置く。

| 場所 | タイミング | 取れる値 |
|---|---|---|
| `src/app/api/auth/confirm/route.ts` | `verifyOtp` 成功、`persistSessionAndCookies` の後 | `data.user.id` / `.email` / `.email_confirmed_at` |
| `src/app/api/auth/otp/verify/route.ts` | `outcome: 'success'` の監査ログ直前 | `result.data.user` 同上 |

どちらも `await` するが、戻り値でレスポンスは変えない。紐付けが失敗してもログイン・メール確認は成功させる。

### RLS

変更不要。`authenticated orders read` ポリシーは既に `auth.uid() = user_id` を含むので、`user_id` が入った瞬間にマイページの購入履歴へ現れる。`order_items` の `authenticated order items read` も同じ条件で連動する。

### 通知

紐付いた件数を画面に出す仕組みは作らない。履歴に増えているのが答えで、通知 UI は要求に無い。

## 4. 完了画面の登録誘導（FREQ-266）

### URL に個人情報を載せない

配送先をクエリで渡すと、住所・電話が URL・ブラウザ履歴・Referrer に残る。2段構えにする。

```
完了画面
  └ [会員登録へ進む] → /register?email=hanako%40example.com
                          （メールのみ。氏名も住所も載せない）
       ↓ 登録 → 確認メール → /api/auth/confirm
            ├ linkGuestOrdersByEmail()          … FREQ-265
            └ 紐付いた注文から配送先を profiles へコピー
```

住所は URL を経由せず、紐付け成功時にサーバー側で引き継ぐ。

### 配送先コピー

`linkGuestOrdersByEmail` が1件以上紐付けたとき、続けて実行する。

- 対象は紐付いた注文のうち `created_at` が最も新しい1件の配送先
- `profiles.addresses` が空のときだけ書き込む。既に住所を持つ会員には触れない
- 形は既存の `AddressItem`（`postalCode` / `prefecture` / `city` / `address` / `building` / `isDefault`）に合わせ、`isDefault: true` で1件だけ入れる
- `src/app/api/profile/addresses/route.ts` の既存の書き込みヘルパーを使い、legacy `address` 列のミラーも既存挙動に従う
- 失敗しても紐付け自体は成功扱い（ログのみ）

氏名も同じ扱いにする。`profiles` の表示名が空のときだけ、注文時の氏名をコピーする。URL には載せない。

### 完了画面の UI

`src/app/checkout/page.tsx` の注文番号表示ブロック（L1517 付近）の下にカードを1枚追加する。

```
┌────────────────────────────────┐
│  次回から入力不要になります      │
│                                │
│  会員登録すると、このご注文が    │
│  マイページに表示され、お届け先   │
│  も引き継がれます。              │
│                                │
│      [ 会員登録へ進む ]         │
└────────────────────────────────┘
```

- 未ログインのときだけ出す。ログイン済みなら既に紐付いているので不要
- 既に2018行ある `checkout/page.tsx` を太らせないよう、カードは `src/features/checkout/components/GuestRegisterPrompt.tsx` として切り出す

### `/register` 側

`searchParams.email` があればメール入力欄の初期値にする。それだけ。

値は一切信用しない。実際の登録は従来どおり Turnstile・パスワード規則・メール確認を通る。不正な値なら入力欄が変な文字列で埋まるだけで、確認メールは入力されたアドレスにしか届かない。

## 5. 発送ステータスの導入（FREQ-267）

### migration は2本に分ける

`ALTER TYPE ... ADD VALUE` で追加した値は同一トランザクション内で使えない。列追加や制約と混ぜず、enum の追加だけを独立させる。

```sql
-- 083: enum の追加のみ
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'shipped';
```

```sql
-- 084: 発送情報の列と、紐付け用インデックス
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS shipping_carrier text NULL
    CHECK (shipping_carrier IS NULL OR shipping_carrier IN ('yamato','sagawa','japanpost')),
  ADD COLUMN IF NOT EXISTS tracking_number text NULL
    CHECK (tracking_number IS NULL OR tracking_number ~ '^[0-9A-Za-z-]{1,64}$');

-- ADD CONSTRAINT に IF NOT EXISTS は無いので、migration 074 と同じく
-- DROP してから足して再実行可能にする。
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_shipping_info_requires_shipped_at;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_shipping_info_requires_shipped_at
  CHECK (shipped_at IS NOT NULL OR (shipping_carrier IS NULL AND tracking_number IS NULL));

CREATE INDEX IF NOT EXISTS idx_orders_unlinked_email
  ON public.orders (lower(shipping_email)) WHERE user_id IS NULL;
```

追加する列はいずれも migration 081 の不変列リストに無いので更新できる。`record_order_revision` が変更を履歴に残す（`status` も変わるので `status_update` として記録される）。

`orders` は 16 行、`order_items` は 18 行（2026-08-10 時点）。

### 追跡URLはDBに持たない

`src/lib/orders/shipping-carriers.ts` に業者ごとのラベルと URL 組み立て関数を置く。

```ts
export const SHIPPING_CARRIERS = {
  yamato: {
    label: 'ヤマト運輸',
    trackingUrl: (n: string) =>
      `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=${encodeURIComponent(n)}`,
  },
  sagawa: {
    label: '佐川急便',
    trackingUrl: (n: string) =>
      `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(n)}`,
  },
  japanpost: {
    label: '日本郵便',
    trackingUrl: (n: string) =>
      `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(n)}&searchKind=S002&locale=ja`,
  },
} as const;
```

URL 形式は業者都合で変わるのでコードで管理し、デプロイで直す。マスタ管理 UI は作らない。上記の形式は実装時にブラウザで疎通を確認すること。

### 遷移規則

| 遷移 | 可否 |
|---|---|
| `paid` → `shipped` | 許可 |
| `pending` / `failed` / `cancelled` → `shipped` | 409 |
| `shipped` → `shipped` | 409（二重発送防止） |
| `shipped` → `cancelled` | 409（発送後の取消は返品フロー。今回は扱わない） |

### API

`src/app/api/admin/orders/[id]/status/route.ts` の zod を判別ユニオンに拡張する。

```ts
z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(['yamato', 'sagawa', 'japanpost']),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  }),
])
```

更新は条件付き UPDATE 1本で行う。

```sql
UPDATE orders
   SET status = 'shipped', shipped_at = now(),
       shipping_carrier = :carrier, tracking_number = :tracking
 WHERE id = :id AND status = 'paid' AND shipped_at IS NULL
```

0件なら 409、1件なら通知メールを送る。読んでから書く形にしないので、同時に2回押しても発送は1回しか成立せず、通知メールも1通しか出ない。重複送信防止の仕組みを別に作る必要がない。

### 画面

- `src/lib/orders/order-status.ts` に `shipped: '発送済み'` を追加
- `src/components/OrderSection.tsx` の `OrderStatus` 型に `'発送済み'` を追加。`決済完了` の行にだけ「発送済みにする」ボタンを出し、既存の Dialog で配送業者（選択）と追跡番号（入力）を受ける。色は既存の `statusClassMap` に1行足す
- `src/app/account/orders/[id]/page.tsx` に発送情報セクション（配送業者・追跡番号・追跡リンク）
- 管理の一覧 API（`src/app/api/admin/orders/route.ts`）の型・`mapOrderStatusToLabel`・フィルタの `z.enum` にも `shipped` を追加

## 6. 発送通知メール（FREQ-268）

`src/lib/orders/order-shipped-email.ts` を新設する。`order-confirmation-email.ts` と同じ形（失敗は握りつぶして監査ログ）にする。

本文に出すもの:

- 氏名、注文番号
- 商品明細
- 配送業者、追跡番号、追跡URL
- お届け先

送信失敗しても発送処理は成功のまま（DB は既に `shipped`）。監査ログ `order.shipped.mail` / `outcome: 'error'` に残す。自動再送はしない。

## 7. エラー処理

認証フローとチェックアウトを壊さないことを原則とする。メール送信と紐付けは付随処理なので、失敗しても本体は成功させる。

| 箇所 | 失敗時 | 理由 |
|---|---|---|
| 注文確認メール | ログ＋監査ログのみ | 決済済みの客に注文失敗を見せない |
| 紐付け（confirm / otp verify） | ログ＋監査ログのみ、例外を投げない | 紐付け失敗で login を 500 にするとログインできなくなる。次回ログインで再試行される |
| 住所・氏名コピー | ログのみ。紐付けは成功扱い | 後から自分で入力できる |
| 完了画面のカード | 表示に失敗しても注文完了は表示 | 決済済みの客に失敗を見せない |
| 発送通知メール | ログ＋監査ログのみ。発送は成功扱い | DB は既に `shipped`。巻き戻すと二重発送の判定が壊れる |
| 発送の UPDATE | 409 を返す | 管理者の操作なので、失敗は明示する |

### 監査ログ

| action | outcome | いつ |
|---|---|---|
| `order.confirmation.mail` | `error` | 注文確認メールの送信失敗（既存） |
| `orders.link_guest_orders` | `success` | 1件以上紐付いたとき（件数を metadata へ） |
| `orders.link_guest_orders` | `error` | UPDATE 失敗 |
| `orders.copy_guest_profile` | `error` | 住所・氏名コピー失敗のみ |
| `admin.orders.status.update` | `success` / `failure` | 発送・キャンセル（既存の action を流用） |
| `order.shipped.mail` | `error` | 発送通知メールの送信失敗 |

## 8. テスト

### 単体（Jest）

`link-guest-orders.test.ts`

- `emailConfirmedAt` が null → UPDATE を呼ばず 0 を返す
- `user_id IS NULL` 条件が付いている（他人所有を奪わない）
- メールは `lower(trim())` で比較し、`+tag` 違いは紐付かない
- Supabase がエラーを返しても例外を投げず 0 を返す

`order-confirmation-email.test.ts`

- 本文にお届け先（郵便番号・住所・電話）が含まれる
- `email` または `MAIL_FROM_ADDRESS` が無いときは送らない

`order-shipped.test.ts`

- `paid` 以外のステータスからは 409
- 既に `shipped_at` が入っていれば 409（二重発送防止）
- 追跡URLが業者ごとに正しく組み立てられる

### 結合（Jest）

`tests/integration/api/checkout/complete.test.ts`

- 注文が新規に確定した経路で `sendOrderConfirmationEmail` が1回呼ばれる
- 同じ `payment_intent_id` で2回目を呼ぶと、既存注文の早期リターン経路に入り呼ばれない（FREQ-264-AC-03）

### E2E（Playwright / mobile 390・tablet 768・desktop 1280）

既存の慣習どおり API はモックする。

FREQ-264 と FREQ-268 は画面を持たないサーバー処理なので、E2E ファイルは作らず単体・結合テストで検証する。プロジェクトの要求管理ルール（FREQ ごとに E2E を作る）から意図的に外れる点をここに記録しておく。

| ファイル | 検証 |
|---|---|
| `FR-CHECKOUT-015-guest-register-prompt.spec.ts` | 未ログインの完了画面にカードが出る／ログイン済みでは出ない／遷移先が `/register?email=...` |
| `FR-ACCOUNT-030-guest-order-linking.spec.ts` | メール確認後に過去のゲスト注文が購入履歴に出る／メール未確認では出ない |
| `FR-ACCOUNT-031-order-shipping-info.spec.ts` | 注文詳細に配送業者・追跡番号・追跡リンクが出る／未発送では出ない |
| `FR-ADMIN-050-order-shipping.spec.ts` | 決済完了の行に「発送済みにする」が出る／発送後は出ない／未決済の行には出ない／ダイアログで業者と追跡番号を入力できる |

## 9. 受け入れ基準

`docs/2_Specs/spec.md` のトレーサビリティテーブルへ入れる形。

- **FREQ-264-AC-01** 注文が確定したとき、注文時のメールアドレス宛に件名「【Le Fil des Heures】ご注文ありがとうございます（ORD-XXXXXXXX）」のメールが送信されること
- **FREQ-264-AC-02** そのメール本文に、氏名・郵便番号・都道府県・市区町村・住所・建物名・電話番号が含まれること
- **FREQ-264-AC-03** 同じ `payment_intent_id` で注文完了APIを2回呼んでも、メールが2通送られないこと
- **FREQ-265-AC-01** メール確認済みの会員でログインすると、同じメールで行ったゲスト注文が購入履歴に表示されること
- **FREQ-265-AC-02** 既に他の会員に紐付いた注文は購入履歴に表示されないこと
- **FREQ-266-AC-01** mobile（390px）/ tablet（768px）/ desktop（1280px）で、未ログインの注文完了画面に「会員登録へ進む」ボタンを含むカードが表示されること
- **FREQ-266-AC-02** ログイン済みの完了画面には同カードが表示されないこと
- **FREQ-266-AC-03** ボタンから遷移した `/register` のメール入力欄に、注文時のメールが入っていること
- **FREQ-267-AC-01** 同3ビューポートで、ADMIN の ORDER タブの「決済完了」の注文に「発送済みにする」ボタンが表示されること
- **FREQ-267-AC-02** 「未決済」「決済失敗」「キャンセル」「発送済み」の注文には同ボタンが表示されないこと
- **FREQ-267-AC-03** 同ボタンから配送業者と追跡番号を入力して発送すると、一覧のステータスが「発送済み」になること
- **FREQ-267-AC-04** 同3ビューポートで、発送済み注文の注文詳細に配送業者・追跡番号・追跡リンクが表示されること
- **FREQ-267-AC-05** 未発送の注文詳細には発送情報のセクションが表示されないこと
- **FREQ-268-AC-01** 発送済みにしたとき、注文時のメールアドレス宛に配送業者・追跡番号・追跡URLを含むメールが送信されること
- **FREQ-268-AC-02** 既に発送済みの注文をもう一度発送しようとしても、メールが2通送られないこと

## 10. スコープ外

- ゲスト向けの注文照会画面（方針として採らない）
- 発送通知メールの再送UI（失敗は監査ログに残し、問い合わせ対応）
- 発送後のキャンセル・返品フロー
- 配送業者APIとの連携（追跡番号は手入力）
- `+tag` やドット違いの同一視
- 紐付いた件数の通知UI
