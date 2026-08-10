# ゲスト購入後の導線設計

作成日: 2026-08-10

## 概要

ゲスト（会員登録なし）で購入した客が、注文後に取れる手段を3つ用意する。

1. **ゲスト注文照会** — 注文番号とメールで注文内容を確認する。会員登録しない客を救う
2. **会員紐付け** — 同じメールで会員登録すると、過去のゲスト注文が購入履歴に出る
3. **完了画面の登録誘導** — 注文完了直後に、入力済みの情報を引き継いで登録へ導く

現状はゲスト注文の `orders.user_id` が NULL のままで、後から会員登録しても購入履歴に出ない。`orders.shipping_email` は保存済みなので、紐付ける材料は揃っている。

## 1. 全体像

3つは独立して価値がある。依存は一方向のみ。

| 要求 | 内容 | 依存 |
|---|---|---|
| FREQ-264 | ゲスト注文照会 | なし |
| FREQ-265 | 会員紐付け | なし |
| FREQ-266 | 完了画面の登録誘導 | FREQ-265（住所引き継ぎのため） |

実装順は 264 → 265 → 266。

| | 画面 | API | E2E |
|---|---|---|---|
| FREQ-264 | `/orders/lookup`（新規） | `POST /api/orders/lookup`（新規） | `FR-ORDER-001`（新カテゴリ） |
| FREQ-265 | なし | 既存2箇所にフック | `FR-ACCOUNT-030` |
| FREQ-266 | 完了画面＋`/register` | なし | `FR-CHECKOUT-015` |

DB 変更は migration 083 の1本。RLS 変更なし。

### 実装方式

照会も紐付けも Route Handler ＋ service-role client で実装する。`src/app/api/contact/route.ts` が公開 POST の完成形（同一オリジン検証 → IP レート制限 → zod → ハニーポット → メール単位レート制限 → service-role → 監査ログ）なので、照会はこれを踏襲する。

Postgres RPC には寄せない。このプロジェクトの RPC は PostgREST 経由で `anon` から直接呼べる状態で、セキュリティアドバイザーが `finalize_order_from_checkout_draft` を含む複数を警告している。照会関数を足すとレート制限を迂回できる攻撃面が増える。

`auth.users` へのトリガーも採らない。Supabase のアップグレードで壊れやすく、「ログイン毎に走らせる」を満たせない（ログインは `auth.users` を更新しないことがある）。

紐付けは1つの共通関数に閉じ、呼び出し側を2箇所に限定して、両経路を E2E で押さえる。

## 2. ゲスト注文照会（FREQ-264）

### 前提: 注文番号で検索できない

注文番号は `src/lib/orders/order-number.ts` の `toOrderNumber()` が `ORD-` ＋ UUID 先頭8桁で組み立てている。`orders.id` は `uuid` 型なので、PostgREST から前方一致検索ができない（uuid に `like` 演算子が無い）。

生成列を追加して解決する。

### migration 083

```sql
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_number text
  GENERATED ALWAYS AS ('ORD-' || upper(substr(id::text, 1, 8))) STORED;

-- 8桁hex は衝突しうるので一意制約は付けない。
CREATE INDEX IF NOT EXISTS idx_orders_order_number
  ON public.orders(order_number);

-- 紐付け（FREQ-265）の検索用。
CREATE INDEX IF NOT EXISTS idx_orders_unlinked_email
  ON public.orders (lower(shipping_email)) WHERE user_id IS NULL;
```

migration 081 のトリガーには抵触しない。`protect_legal_order_immutable_fields` は不変列を明示列挙しており、`record_order_revision` の `to_jsonb` 差分にも現れない（`id` が不変なら生成列の値も不変）。

`orders` は 16 行、`order_items` は 18 行（2026-08-10 時点）。STORED 生成列の追加はテーブル書き換えを伴うが、この規模なら一瞬で終わる。

表示側の `toOrderNumber()` はそのまま残し、DB 列は検索専用とする。両者の書式は一致させること。

### API `POST /api/orders/lookup`

検証はすべてデータを返す前に完了する。画面は受け取った結果を描くだけで、描画時の判定は無い。

| # | 検証 | 落ちたとき |
|---|---|---|
| 1 | `isSameOriginRequest` | 403 |
| 2 | IP レート制限 `enforceRateLimit({ endpoint: 'orders:lookup', limit: 20, windowSeconds: 3600 })` | 429（`Retry-After` 付き） |
| 3 | zod: `orderNumber` は `/^ORD-[0-9A-Fa-f]{8}$/`、`email` はメール形式 | 400 |
| 4 | ハニーポット `website` が空 | 403 ＋ 監査ログ |
| 5 | メール単位レート制限 `enforceRateLimit({ endpoint: 'orders:lookup', limit: 5, windowSeconds: 3600, subject: email })` | 429 |
| 6 | `order_number = ? AND lower(shipping_email) = lower(?)` | 404 |
| 7 | 一意に1件へ絞れたか | 404 |

6 が本体。注文番号とメールの片方だけでは絶対に返らない。2 と 5 を分けているのは、1つの IP から多数のメールを試す攻撃と、1つのメールに対し注文番号を総当たりする攻撃の両方を塞ぐため。

8桁 hex は約43億通り。メール一致も要求するため総当たりは非現実的で、レート制限で塞ぐ。

0件・2件以上のいずれも**同一の 404 と同一メッセージ**を返す。区別すると注文番号の存在有無が漏れる。

応答には `Cache-Control: no-store` を付ける。

### 返す内容

会員の注文詳細と同等。

- 注文番号、注文日、ステータス
- 商品明細（画像・商品名・色・サイズ・数量・金額）
- 小計、送料、合計
- お届け先（氏名・郵便番号・住所・建物・電話・メール）

返さないもの: 注文の UUID、`payment_intent_id`、`checkout_session_id`、`session_id`。表示に不要な内部 ID は出さない。カード情報はそもそも保持していない（Stripe 側）。

### 画面 `/orders/lookup`

- Client Component がフォームを持ち、`POST /api/orders/lookup` を fetch して結果を state に保持し、同一ページのフォーム位置に描画する。ルーティングもクエリ更新も行わない
- セッションもトークンも発行しない。リロードすると state が消えてフォームに戻る
- 結果は POST の応答なので URL に載らない。コピペ拡散・ブラウザ履歴・Referrer からの漏洩が起きない
- ページに `noindex` を付ける
- エラー文言は「注文番号またはメールアドレスが一致しません。ご注文確認メールをご確認のうえ、もう一度お試しください。」の1種類のみ

会員の注文詳細（`src/app/account/orders/[id]/page.tsx`）と表示部品を共有する。ページが太らないよう、表示専用コンポーネントを `src/features/orders/components/` へ切り出して両者から使う。

### 設計上の割り切り

注文番号とメールの両方を知っている人は誰でも閲覧できる。注文確認メールを見られる人＝本人相当、という前提を置く。家族に転送されたメールから見られるのは仕様の範囲。

メール内のワンタイムリンク方式ならこれを防げるが、「メールを紛失した客を救う」という照会機能の目的そのものが失われるので採らない。

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

## 5. エラー処理

認証フローを壊さないことを原則とする。紐付けは付随処理なので、失敗してもログイン・メール確認・チェックアウトは成功させる。

| 箇所 | 失敗時 | 理由 |
|---|---|---|
| 照会 API | ステータスを返して終わり | 単体の機能。失敗を隠す理由がない |
| 紐付け（confirm / otp verify） | ログ＋監査ログのみ、例外を投げない | 紐付け失敗で login を 500 にするとログインできなくなる。次回ログインで再試行される |
| 住所・氏名コピー | ログのみ。紐付けは成功扱い | 後から自分で入力できる |
| 完了画面のカード | 表示に失敗しても注文完了は表示 | 決済済みの客に失敗を見せない |

### 監査ログ

| action | outcome | いつ |
|---|---|---|
| `orders.lookup` | `success` / `failure` | 照会の成功・不一致 |
| `orders.lookup` | `failure` | ハニーポット命中 |
| `orders.link_guest_orders` | `success` | 1件以上紐付いたとき（件数を metadata へ） |
| `orders.link_guest_orders` | `error` | UPDATE 失敗 |
| `orders.copy_guest_profile` | `error` | 住所・氏名コピー失敗のみ |

## 6. テスト

### 単体（Jest）

`link-guest-orders.test.ts`

- `emailConfirmedAt` が null → UPDATE を呼ばず 0 を返す
- `user_id IS NULL` 条件が付いている（他人所有を奪わない）
- メールは `lower(trim())` で比較し、`+tag` 違いは紐付かない
- Supabase がエラーを返しても例外を投げず 0 を返す

`order-lookup.test.ts`

- 注文番号の正規化（小文字入力を大文字化、`ORD-` 欠落は 400）
- 0件と複数件がどちらも同一の 404 になる

### E2E（Playwright / mobile 390・tablet 768・desktop 1280）

既存の慣習どおり API はモックする。

| ファイル | 検証 |
|---|---|
| `FR-ORDER-001-guest-order-lookup.spec.ts` | 照会成功で明細・金額・お届け先が出る／不一致で同一文言のエラー／レート制限で 429／横スクロールなし |
| `FR-ACCOUNT-030-guest-order-linking.spec.ts` | メール確認後に過去のゲスト注文が購入履歴に出る／メール未確認では出ない |
| `FR-CHECKOUT-015-guest-register-prompt.spec.ts` | 未ログインの完了画面にカードが出る／ログイン済みでは出ない／遷移先が `/register?email=...` |

## 7. 受け入れ基準

`docs/2_Specs/spec.md` のトレーサビリティテーブルへ入れる形。

- **FREQ-264-AC-01** 3ビューポートで、`/orders/lookup` に注文番号・メールの入力欄と送信ボタンが表示されること
- **FREQ-264-AC-02** 正しい組で送信すると、注文番号・ステータス・商品明細・小計・送料・合計・お届け先が表示されること
- **FREQ-264-AC-03** メールだけ誤った組と、存在しない注文番号のいずれも「注文番号またはメールアドレスが一致しません。」と表示され、区別できないこと
- **FREQ-264-AC-04** 結果画面で横方向のページスクロールが発生しないこと
- **FREQ-265-AC-01** メール確認済みの会員でログインすると、同じメールで行ったゲスト注文が購入履歴に表示されること
- **FREQ-265-AC-02** 既に他の会員に紐付いた注文は購入履歴に表示されないこと
- **FREQ-266-AC-01** 3ビューポートで、未ログインの注文完了画面に「会員登録へ進む」ボタンを含むカードが表示されること
- **FREQ-266-AC-02** ログイン済みの完了画面には同カードが表示されないこと
- **FREQ-266-AC-03** ボタンから遷移した `/register` のメール入力欄に、注文時のメールが入っていること

## 8. スコープ外

- 照会結果からのキャンセル・返品申請（表示のみ）
- ゲストへの注文状況更新メール
- `+tag` やドット違いの同一視
- 紐付いた件数の通知 UI
- 照会結果を保持する短期セッション（ゲストは都度入力、会員はマイページから）
