# ログイン 2 要素目の専用画面化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ログインのメール OTP 入力を、ログイン / 会員登録タブ内の一状態から専用ルート `/login/verify` へ切り出し、あわせて OTP 検証側の 2 つの穴（アカウント単位のレート制限の欠如、`verifyOtp` の type 総当たり）を塞ぐ。

**Architecture:** 既存の署名 Cookie `sb-login-2fa-session` を唯一の状態担体とする。`/login/verify` は Server Component で Cookie を検証し、無効なら `/login` へリダイレクトする。パスワードを必要としていた OTP 再送は、Cookie 由来の宛先へ送る新エンドポイントへ移す。

**Tech Stack:** Next.js 16 App Router / React 19 / TypeScript / Supabase Auth / Playwright / Jest

**Spec:** [../specs/2026-09-04-login-otp-dedicated-screen-design.md](../specs/2026-09-04-login-otp-dedicated-screen-design.md)

## Global Constraints

- E2E は本番ビルドに対して実行する。実行前に `:3000` で dev サーバーが動いていないことを確認する（`Get-NetTCPConnection -LocalPort 3000 -State Listen`）。動いていたら止める。
- E2E のビューポートは mobile 390px / tablet 768px / desktop 1280px の 3 種を基本とする。
- UI 変更は `docs/02_Requirements/requirements.md` のトレーサビリティ行と `e2e/FR-*.spec.ts` をセットで作る。
- OTP の桁数は 8（`OTP_LENGTH = 8`）。
- 2FA Cookie 名は `sb-login-2fa-session`、`httpOnly` / `SameSite=Strict`。
- 2FA Cookie の TTL は 300 秒（5 分）。Supabase の Email OTP Expiration と一致させる。
- 宛先メールアドレスは常にマスクして表示する。生の値を画面に出さない。
- `/login/verify` に `?next=` を導入しない。
- レート制限の `subject` は必ず Cookie 由来の `pending.email` を使う。クライアント入力の email を使わない。
- **コミットはこのリポジトリでは利用者の指示があるときだけ行う。** 実行時に指示が無ければ各タスクの Commit ステップは飛ばし、変更を作業ツリーに残したまま次へ進む。
- 全タスク完了後に `graphify update .` を実行する。

## File Structure

| ファイル                                                  | 責務                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/mask-email.ts`（新規）                           | メールアドレスのマスク。純粋関数 1 つ                         |
| `src/features/auth/services/login-2fa-session.ts`（変更） | 2FA Cookie の TTL 定数                                        |
| `src/app/api/auth/otp/verify/route.ts`（変更）            | OTP 検証。type 固定とアカウント単位の制限                     |
| `src/app/api/auth/login/cancel/route.ts`（新規）          | 2FA Cookie の破棄                                             |
| `src/app/api/auth/login/resend/route.ts`（新規）          | Cookie 由来の宛先へ OTP 再送                                  |
| `src/app/login/verify/page.tsx`（新規）                   | Server Component。Cookie 検証とゲートのみ                     |
| `src/app/login/verify/VerifyOtpClient.tsx`（新規）        | コード入力 UI                                                 |
| `src/app/login/page.tsx`（変更）                          | 有効な 2FA Cookie があれば `/login/verify` へ送る逆方向ガード |
| `src/components/LoginModal.tsx`（変更）                   | OTP を持たなくなり、資格情報ステップだけになる                |
| `e2e/auth-2fa-test-utils.ts`（新規）                      | e2e から本物の署名 Cookie を置くヘルパ                        |

---

### Task 1: 仕様の追記

**Files:**

- Modify: `docs/02_Requirements/requirements.md`（末尾に 2 行追加）

**Interfaces:**

- Consumes: なし
- Produces: FREQ-334 / FREQ-335 の AC 番号。以降のタスクのテストがこれを参照する

- [ ] **Step 1: 現在の最大 FREQ 番号を確認する**

Run: `grep -o "FREQ-[0-9]*" docs/02_Requirements/requirements.md | sort -t- -k2 -n | tail -1`
Expected: `FREQ-333`

- [ ] **Step 2: FREQ-334 の行を追記する**

`docs/02_Requirements/requirements.md` の末尾に、以下を 1 行（改行なし）で追加する。

```text
| FREQ-334 | ログインの第 2 要素（メール OTP）の入力を、ログイン / 会員登録タブ内の一状態ではなく専用画面で行うこと | FREQ-334-REQ-01 | メール OTP の入力を専用ルート /login/verify に置き、2FA Cookie（sb-login-2fa-session）が有効なときだけ表示すること。Cookie の不在・改竄・期限切れはすべて同じく /login へリダイレクトし、アカウントの存在を示唆しないこと。判定は Server Component で行い、判定前に入力画面の HTML を送らないこと | FREQ-334-AC-01 | 2FA Cookie を持たない状態で /login/verify を開いたとき /login へ遷移し、認証コード入力欄が一度も表示されないこと（mobile 390px / tablet 768px / desktop 1280px） | FREQ-334-REQ-02 | パスワード検証に成功したら /login/verify へ router.replace で遷移すること。push を使わないこと（戻るボタンで /login に戻れると、生きた 2FA Cookie を持ったまま再ログインでき、2 通目の OTP が飛んでアカウント制限を消費する） | FREQ-334-AC-02 | パスワード検証成功後に /login/verify へ着地し、ブラウザバックで資格情報フォームへ戻らないこと（mobile / tablet / desktop） | FREQ-334-REQ-03 | /login に有効な 2FA Cookie を持って到達した場合は /login/verify へリダイレクトすること | FREQ-334-AC-03 | 有効な 2FA Cookie を持った状態で /login を開いたとき /login/verify へ遷移すること（mobile / tablet / desktop） | FREQ-334-REQ-04 | 検証画面で宛先メールアドレスをマスクして表示すること。ローカル部が 5 文字以上なら先頭 2 文字 + マスク + 末尾 2 文字、4 文字以下なら先頭 1 文字 + マスク。マスク部は常に 3 文字固定とし、ローカル部の長さを漏らさないこと。@ を含まない値は空文字を返し、宛先の行自体を表示しないこと | FREQ-334-AC-04 | 検証画面に生のメールアドレスが表示されず、マスク済みの文字列（例: 14***56@gmail.com）が表示されること（mobile / tablet / desktop） | FREQ-334-REQ-05 | OTP の再送をパスワード不要にすること。再送は 2FA Cookie 由来の宛先へ送る POST /api/auth/login/resend で行い、リクエスト本文に宛先を取らないこと。成功時は 2FA Cookie を再発行して有効期限を延ばすこと | FREQ-334-AC-05 | 検証画面の再送で POST /api/auth/login/resend が呼ばれ、リクエスト本文にメールアドレスとパスワードのいずれも含まれないこと | FREQ-334-REQ-06 | 検証画面から「別のアドレスでやり直す」を選んだとき、POST /api/auth/login/cancel で 2FA Cookie を破棄してから /login へ戻すこと（クライアント状態を戻すだけでは Cookie が残る） | FREQ-334-AC-06 | 「別のアドレスでやり直す」を押したあと /login に戻り、再度 /login/verify を直接開いても入力画面が表示されないこと（mobile / tablet / desktop） |
```

- [ ] **Step 3: FREQ-335 の行を追記する**

続けて、以下を 1 行で追加する。

```text
| FREQ-335 | メール OTP 検証の総当たり耐性を上げ、検証するトークンの用途を限定すること | FREQ-335-REQ-01 | /api/auth/otp/verify にアカウント単位のレート制限（5 回 / 600 秒）を加えること。subject は 2FA Cookie 由来の pending.email とし、クライアント入力の email を使わないこと（クライアント入力を使うと、他人のアカウントの枠を故意に潰す DoS になる）。制限は Cookie 検証の後に置くこと | FREQ-335-AC-01 | 同一アカウントで認証コードの誤りを 5 回送ったあと 6 回目が 429 になること。異なるアカウントの枠は消費されないこと | FREQ-335-REQ-02 | アカウント単位の上限に達したら 2FA Cookie を破棄し、試行の窓を 1 回のログイン試行に閉じること | FREQ-335-AC-02 | 上限到達後に /login/verify を開くと /login へ遷移すること | FREQ-335-REQ-03 | verifyOtp の type を email に固定すること。email / magiclink / signup の総当たりをやめること（1 回の入力で Supabase 側の検証を最大 3 回消費し、別目的で発行されたトークンまで受理しうる。Supabase の公式サンプルもログイン OTP は type: email のみ） | FREQ-335-AC-03 | 認証コードを 1 回送ったとき supabase.auth.verifyOtp が type: 'email' で 1 回だけ呼ばれること | FREQ-335-REQ-04 | 2FA Cookie の TTL を Supabase の Email OTP Expiration 以下にすること。現行の設定に合わせて 300 秒とする（Cookie だけが長いと、コードが切れているのに入力画面が生きている窓ができる） | FREQ-335-AC-04 | POST /api/auth/login が発行する sb-login-2fa-session の Max-Age が 300 であること |
```

- [ ] **Step 4: 追記できたことを確認する**

Run: `grep -c "FREQ-334\|FREQ-335" docs/02_Requirements/requirements.md`
Expected: `2`（1 行に 1 つずつ、計 2 行）

- [ ] **Step 5: Commit**

```bash
git add docs/02_Requirements/requirements.md
git commit -m "docs(spec): add FREQ-334 / FREQ-335 for the dedicated OTP screen"
```

---

### Task 2: メールアドレスのマスク

**Files:**

- Create: `src/lib/mask-email.ts`
- Test: `tests/unit/lib/mask-email.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `maskEmail(email: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/lib/mask-email.test.ts`:

```ts
import { maskEmail } from "@/lib/mask-email";

describe("maskEmail", () => {
  test("ローカル部が 5 文字以上なら先頭 2 + マスク + 末尾 2", () => {
    expect(maskEmail("14masa56@gmail.com")).toBe("14***56@gmail.com");
    expect(maskEmail("abcde@example.com")).toBe("ab***de@example.com");
  });

  test("ローカル部が 4 文字以下なら先頭 1 + マスク", () => {
    expect(maskEmail("abcd@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  test("マスク部は常に 3 文字で、ローカル部の長さを漏らさない", () => {
    const short = maskEmail("abcde@example.com");
    const long = maskEmail("abcdefghijklmno@example.com");
    expect(short.split("@")[0]).toHaveLength(7);
    expect(long.split("@")[0]).toHaveLength(7);
  });

  test("サブドメインを含むドメインはそのまま残す", () => {
    expect(maskEmail("user@sub.example.co.jp")).toBe("u***@sub.example.co.jp");
  });

  test("@ を含まない値や空文字は空文字を返す", () => {
    expect(maskEmail("nope")).toBe("");
    expect(maskEmail("")).toBe("");
    expect(maskEmail("a@")).toBe("");
    expect(maskEmail("@example.com")).toBe("");
  });
});
```

- [ ] **Step 2: 失敗することを確認する**

Run: `npx jest tests/unit/lib/mask-email.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mask-email'`

- [ ] **Step 3: 実装する**

`src/lib/mask-email.ts`:

```ts
/**
 * 画面に出す宛先をマスクする。
 *
 * 肩越しに見られてもアドレス全体を復元できないようにしつつ、「どのアカウントに
 * 送ったか」の手がかりは残す。マスク部を 3 文字固定にするのは、ローカル部の
 * 長さという情報まで漏らさないため。
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    // マスクし損ねた生の値を返すくらいなら、宛先を出さない。
    return "";
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length >= 5
      ? `${local.slice(0, 2)}***${local.slice(-2)}`
      : `${local.slice(0, 1)}***`;

  return `${masked}@${domain}`;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npx jest tests/unit/lib/mask-email.test.ts`
Expected: PASS（5 テスト）

- [ ] **Step 5: 型と lint を確認する**

Run: `npx tsc --noEmit && npx eslint src/lib/mask-email.ts tests/unit/lib/mask-email.test.ts`
Expected: 出力なし

- [ ] **Step 6: Commit**

```bash
git add src/lib/mask-email.ts tests/unit/lib/mask-email.test.ts
git commit -m "feat(auth): add maskEmail for displaying OTP destinations"
```

---

### Task 3: 2FA Cookie の TTL を 300 秒にする

**Files:**

- Modify: `src/features/auth/services/login-2fa-session.ts:5`
- Test: `tests/integration/api/auth/login.test.ts`

**Interfaces:**

- Consumes: なし
- Produces: `loginTwoFactorSessionMaxAgeSeconds === 300`

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/api/auth/login.test.ts` の既存の describe に追加する。既存テストが `POST /api/auth/login` の成功系でどうモックしているかを読んでから、同じ組み立てで書く。

```ts
test("[SECURITY] 2FA Cookie の Max-Age は 300（Supabase の OTP 有効期限と一致させる）", async () => {
  // 既存の成功系テストと同じモック構成でリクエストを組み立てる
  const res: any = await loginHandler(buildValidLoginRequest());

  const cookie = res._cookies.find(
    (c: any) => c.name === "sb-login-2fa-session",
  );
  expect(cookie).toBeDefined();
  expect(cookie.maxAge).toBe(300);
});
```

`buildValidLoginRequest()` は既存テストのリクエスト組み立てをそのまま使う。既存に相当するヘルパが無ければ、成功系テストのリクエスト生成部分をコピーしてローカル関数に切り出す。

- [ ] **Step 2: 失敗することを確認する**

Run: `npx jest tests/integration/api/auth/login.test.ts -t "Max-Age は 300"`
Expected: FAIL — `Expected: 300 / Received: 600`

- [ ] **Step 3: 定数を変える**

`src/features/auth/services/login-2fa-session.ts:5` を置き換える。

```ts
// Supabase の Email OTP Expiration（現行 300 秒）と一致させる。
// Cookie だけが長いと、コードが切れているのに入力画面が生きている窓ができ、
// 利用者からは「入れても無効」にしか見えない。
const LOGIN_2FA_SESSION_MAX_AGE_SECONDS = 5 * 60;
```

- [ ] **Step 4: 通ることを確認する**

Run: `npx jest tests/integration/api/auth/login.test.ts`
Expected: PASS（既存テストも含めて全件）

- [ ] **Step 5: Commit**

```bash
git add src/features/auth/services/login-2fa-session.ts tests/integration/api/auth/login.test.ts
git commit -m "fix(auth): align the 2FA cookie TTL with the Supabase OTP expiry"
```

---

### Task 4: OTP 検証の堅牢化

**Files:**

- Modify: `src/app/api/auth/otp/verify/route.ts`
- Test: `tests/integration/api/auth/otp-verify.test.ts`（新規）

**Interfaces:**

- Consumes: `readLoginTwoFactorSessionFromCookieHeader`, `createLoginTwoFactorSessionToken`（既存）
- Produces: なし（既存エンドポイントの挙動変更）

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/api/auth/otp-verify.test.ts` を新規作成する。モックの組み立て方は `tests/integration/api/auth/password-reset.test.ts` の冒頭（`makeChain` / `mockFromImplementation` / `logAudit` のモック）と同じ形にそろえる。Supabase クライアントのモックに `auth.verifyOtp` を持たせ、呼び出しを記録する。

```ts
test("[SECURITY] verifyOtp は type: email で 1 回だけ呼ばれる", async () => {
  const calls: any[] = [];
  mockVerifyOtpImplementation = jest.fn(async (args: any) => {
    calls.push(args);
    return { data: { session: fakeSession, user: fakeUser }, error: null };
  });

  const res: any = await otpVerifyHandler(buildOtpRequest("12345678"));

  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].type).toBe("email");
});

test("[SECURITY] アカウント単位のレート制限は Cookie 由来の email を subject にする", async () => {
  const rlCalls: any[] = [];
  mockEnforceRateLimitImplementation = jest.fn(async (args: any) => {
    rlCalls.push(args);
    return undefined;
  });

  await otpVerifyHandler(buildOtpRequest("12345678"));

  const accountCall = rlCalls.find((c) => c.subject);
  expect(accountCall).toBeDefined();
  expect(accountCall.subject).toBe("test@example.com"); // Cookie に入れた値
  expect(accountCall.limit).toBe(5);
  expect(accountCall.windowSeconds).toBe(600);
});

test("[SECURITY] 上限到達で 429 を返し、2FA Cookie を破棄する", async () => {
  mockEnforceRateLimitImplementation = jest.fn(async (args: any) =>
    args.subject
      ? new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "Retry-After": "600" },
        })
      : undefined,
  );

  const res: any = await otpVerifyHandler(buildOtpRequest("12345678"));

  expect(res.status).toBe(429);
  const cleared = res._cookies.find(
    (c: any) => c.name === "sb-login-2fa-session",
  );
  expect(cleared).toBeDefined();
  expect(cleared.maxAge).toBe(0);
});
```

`buildOtpRequest(code)` は、有効な 2FA Cookie（`createLoginTwoFactorSessionToken({ userId: 'user-123', email: 'test@example.com' })`）を `cookie` ヘッダに載せた `Request` を返すローカル関数として書く。

- [ ] **Step 2: 失敗することを確認する**

Run: `npx jest tests/integration/api/auth/otp-verify.test.ts`
Expected: FAIL — 1 本目は `calls` が 3 件（type 総当たり）、2 本目は `accountCall` が `undefined`

- [ ] **Step 3: `tryVerifyOtpWithTypes` を削除して type を固定する**

`src/app/api/auth/otp/verify/route.ts` の先頭にある `tryVerifyOtpWithTypes` 関数を丸ごと削除し、`import type { SupabaseClient }` も未使用になるので消す。

呼び出し側（`const result = await tryVerifyOtpWithTypes(supabase, email, code);` の行）を置き換える。

```ts
// Supabase の公式サンプル（Passwordless email sign-in）はログイン OTP を
// type: 'email' で検証する。複数 type を総当たりすると、1 回の入力で
// Supabase 側の検証を最大 3 回消費し、別目的で発行されたトークン
// （signup / magiclink）まで第 2 要素として受理しうる。
const { data, error: verifyError } = await supabase.auth.verifyOtp({
  email,
  token: code,
  type: "email",
});
```

以降の `result.data` を `data`、`result.type` を `'email'` に置き換える。具体的には次の 5 箇所。

```ts
// 1) 失敗判定
if (verifyError || !data?.session || !data?.user) {

// 2) 成功応答
{ user: data.user, message: '認証に成功しました。' }

// 3) セッション永続化
const persistResult = await persistSessionAndCookies(res, data.session, data.user);

// 4) ゲスト注文の紐付け
await linkGuestOrdersByEmail({
  userId: data.user.id,
  email: data.user.email ?? email,
  emailConfirmedAt: data.user.email_confirmed_at ?? null,
});

// 5) 監査ログ
detail: 'verified_type:email',
```

- [ ] **Step 4: アカウント単位のレート制限を足す**

2FA Cookie の検証ブロック（`if (!pending || pending.email !== email) { ... }`）の**直後**に挿入する。

```ts
// アカウント単位の総当たり対策。subject は必ず Cookie 由来にする。
// クライアント入力の email を使うと、他人のアカウントの枠を故意に
// 潰す DoS になる。
try {
  const { enforceRateLimit } =
    await import("@/features/auth/middleware/rateLimit");
  const rlAccount = await enforceRateLimit({
    request,
    endpoint: "auth:otp:verify",
    limit: 5,
    windowSeconds: 600,
    subject: pending.email,
  });

  if (rlAccount) {
    // 上限に達したら試行の窓ごと閉じる。Cookie を残すと、窓が明けてから
    // 同じログイン試行の続きとして再開できてしまう。
    // enforceRateLimit はテスト環境で素の Response を返しうるので、
    // 返り値を書き換えず新しい NextResponse を組み立てる。
    const { loginTwoFactorSessionCookieName, clearCookieOptions } =
      await import("@/lib/cookie");
    const limited = NextResponse.json(
      { error: "Too many requests" },
      { status: 429 },
    );
    const retryAfter = rlAccount.headers.get("Retry-After");
    if (retryAfter) {
      limited.headers.set("Retry-After", retryAfter);
    }
    limited.cookies.set({
      name: loginTwoFactorSessionCookieName,
      value: "",
      ...clearCookieOptions(),
    });
    await logAudit({
      action: "auth.otp.verify",
      actor_email: pending.email,
      outcome: "failure",
      detail: "account_rate_limited",
    });
    return limited;
  }
} catch (e) {
  console.error("Rate limit middleware error (otp verify account):", e);
}
```

- [ ] **Step 5: 通ることを確認する**

Run: `npx jest tests/integration/api/auth/otp-verify.test.ts && npx tsc --noEmit && npx eslint src/app/api/auth/otp/verify/route.ts`
Expected: 3 テスト PASS、型・lint とも出力なし

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth/otp/verify/route.ts tests/integration/api/auth/otp-verify.test.ts
git commit -m "fix(auth): pin the OTP verify type and add per-account rate limiting"
```

---

### Task 5: 2FA Cookie を破棄するエンドポイント

**Files:**

- Create: `src/app/api/auth/login/cancel/route.ts`
- Test: `tests/integration/api/auth/login-cancel.test.ts`

**Interfaces:**

- Consumes: `loginTwoFactorSessionCookieName`, `clearCookieOptions`（`@/lib/cookie`）
- Produces: `POST /api/auth/login/cancel` → `200 { ok: true }`、`sb-login-2fa-session` を `maxAge=0` で破棄

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/api/auth/login-cancel.test.ts`:

```ts
import { logAudit } from "@/lib/audit";

jest.mock("@/lib/audit", () => ({ logAudit: jest.fn() }));

let cancelHandler: any;

beforeAll(async () => {
  const route = await import("@/app/api/auth/login/cancel/route");
  cancelHandler = route.POST;
});

test("[SUCCESS] 2FA Cookie を破棄して 200 を返す", async () => {
  const req = new Request("http://localhost/api/auth/login/cancel", {
    method: "POST",
  });

  const res: any = await cancelHandler(req);

  expect(res.status).toBe(200);
  const cleared = res._cookies.find(
    (c: any) => c.name === "sb-login-2fa-session",
  );
  expect(cleared).toBeDefined();
  expect(cleared.maxAge).toBe(0);
});

test("[AUDIT] 中断を監査ログに残す", async () => {
  const req = new Request("http://localhost/api/auth/login/cancel", {
    method: "POST",
  });

  await cancelHandler(req);

  expect(logAudit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "login", outcome: "cancelled" }),
  );
});
```

`res._cookies` を読むためのテスト用セットアップ（`NextResponse` のモック）は `tests/integration/api/auth/password-reset.test.ts` と同じものを流用する。

- [ ] **Step 2: 失敗することを確認する**

Run: `npx jest tests/integration/api/auth/login-cancel.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/login/cancel/route'`

- [ ] **Step 3: 実装する**

`src/app/api/auth/login/cancel/route.ts`:

```ts
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import {
  clearCookieOptions,
  loginTwoFactorSessionCookieName,
} from "@/lib/cookie";
import { readLoginTwoFactorSessionFromCookieHeader } from "@/features/auth/services/login-2fa-session";

// PUBLIC: 認証コード入力からの離脱。副作用は 2FA Cookie の破棄のみ。
//
// CSRF は proxy の Origin 検査（FREQ-327）が /api 配下の POST を既定で
// 覆うため、ここでは扱わない。踏まれても被害は「ログインの中断」だけなので
// レート制限も置かない。
export async function POST(request: Request) {
  const pending = readLoginTwoFactorSessionFromCookieHeader(
    request.headers.get("cookie"),
  );

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set({
    name: loginTwoFactorSessionCookieName,
    value: "",
    ...clearCookieOptions(),
  });

  // 中断が多発するなら OTP の配送に問題がある、という信号になる。
  await logAudit({
    action: "login",
    actor_email: pending?.email ?? null,
    outcome: "cancelled",
    detail: "otp_step_abandoned",
  });

  return res;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npx jest tests/integration/api/auth/login-cancel.test.ts && npx tsc --noEmit && npx eslint src/app/api/auth/login/cancel/route.ts`
Expected: 2 テスト PASS、型・lint とも出力なし

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/login/cancel/route.ts tests/integration/api/auth/login-cancel.test.ts
git commit -m "feat(auth): add an endpoint that drops the pending 2FA cookie"
```

---

### Task 6: OTP を再送するエンドポイント

**Files:**

- Create: `src/app/api/auth/login/resend/route.ts`
- Test: `tests/integration/api/auth/login-resend.test.ts`

**Interfaces:**

- Consumes: `readLoginTwoFactorSessionFromCookieHeader`, `createLoginTwoFactorSessionToken`, `loginTwoFactorSessionMaxAgeSeconds`
- Produces: `POST /api/auth/login/resend` → `200 { ok: true }`、`sb-login-2fa-session` を再発行

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/api/auth/login-resend.test.ts`:

```ts
test("[SECURITY] 宛先は Cookie 由来で、本文の email を無視する", async () => {
  const otpCalls: any[] = [];
  mockSignInWithOtpImplementation = jest.fn(async (args: any) => {
    otpCalls.push(args);
    return { data: {}, error: null };
  });

  const req = new Request("http://localhost/api/auth/login/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `sb-login-2fa-session=${encodeURIComponent(validCookieValue)}`,
    },
    body: JSON.stringify({ email: "attacker@example.com" }),
  });

  const res: any = await resendHandler(req);

  expect(res.status).toBe(200);
  expect(otpCalls).toHaveLength(1);
  expect(otpCalls[0].email).toBe("test@example.com"); // Cookie に入れた値
});

test("[SECURITY] 2FA Cookie が無ければ 401", async () => {
  const req = new Request("http://localhost/api/auth/login/resend", {
    method: "POST",
  });

  const res: any = await resendHandler(req);

  expect(res.status).toBe(401);
});

test("[SECURITY] レート制限の枠を /api/auth/login と共有する", async () => {
  const rlCalls: any[] = [];
  mockEnforceRateLimitImplementation = jest.fn(async (args: any) => {
    rlCalls.push(args);
    return undefined;
  });

  await resendHandler(buildValidResendRequest());

  const accountCall = rlCalls.find((c) => c.subject);
  expect(accountCall.endpoint).toBe("auth:login");
  expect(accountCall.subject).toBe("test@example.com");
  expect(accountCall.limit).toBe(5);
});

test("[SUCCESS] 成功時に 2FA Cookie を再発行して期限を延ばす", async () => {
  const res: any = await resendHandler(buildValidResendRequest());

  const cookie = res._cookies.find(
    (c: any) => c.name === "sb-login-2fa-session",
  );
  expect(cookie).toBeDefined();
  expect(cookie.maxAge).toBe(300);
});
```

`validCookieValue` は `createLoginTwoFactorSessionToken({ userId: 'user-123', email: 'test@example.com' })` で作る。`buildValidResendRequest()` は 1 本目と同じ組み立てのローカル関数にする。

- [ ] **Step 2: 失敗することを確認する**

Run: `npx jest tests/integration/api/auth/login-resend.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/auth/login/resend/route'`

- [ ] **Step 3: 実装する**

`src/app/api/auth/login/resend/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createPublicClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  cookieOptionsForLoginTwoFactor,
  loginTwoFactorSessionCookieName,
} from "@/lib/cookie";
import {
  createLoginTwoFactorSessionToken,
  loginTwoFactorSessionMaxAgeSeconds,
  readLoginTwoFactorSessionFromCookieHeader,
} from "@/features/auth/services/login-2fa-session";

// PUBLIC: 認証コードの再送。パスワードは要求しない。
//
// パスワード検証を通ったことは 2FA Cookie が既に証明しているため、宛先は
// Cookie から取り、リクエスト本文は一切見ない。本文の email を信じると、
// 他人の宛先へ当社ドメインからメールを送らせる導線になる。
export async function POST(request: Request) {
  const pending = readLoginTwoFactorSessionFromCookieHeader(
    request.headers.get("cookie"),
  );

  if (!pending) {
    return NextResponse.json(
      {
        error:
          "セッションの有効期限が切れました。もう一度ログインしてください。",
      },
      { status: 401 },
    );
  }

  // 枠は POST /api/auth/login と共有する。抑えたいのは 1 アカウントへ送る
  // メールの総量なので、分けるとログイン 5 通 + 再送 5 通で 10 通送れてしまう。
  try {
    const { enforceRateLimit } =
      await import("@/features/auth/middleware/rateLimit");
    const rl = await enforceRateLimit({
      request,
      endpoint: "auth:login",
      limit: 5,
      windowSeconds: 600,
      subject: pending.email,
    });
    if (rl) return rl;
  } catch (e) {
    console.error("Rate limit middleware error (login resend):", e);
  }

  const supabase = await createPublicClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: pending.email,
    options: { shouldCreateUser: false },
  });

  if (error) {
    await logAudit({
      action: "login",
      actor_email: pending.email,
      outcome: "error",
      detail: `otp_resend_failed: ${error.message}`,
      resource_id: pending.userId,
    });
    return NextResponse.json(
      {
        error:
          "認証コードの送信に失敗しました。時間をおいて再度お試しください。",
      },
      { status: 500 },
    );
  }

  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.headers.set("Cache-Control", "no-store");

  // 再送した直後に Cookie が切れると、届いたコードを入力できない。
  res.cookies.set({
    name: loginTwoFactorSessionCookieName,
    value: createLoginTwoFactorSessionToken({
      userId: pending.userId,
      email: pending.email,
    }),
    ...cookieOptionsForLoginTwoFactor(loginTwoFactorSessionMaxAgeSeconds),
  });

  await logAudit({
    action: "login",
    actor_email: pending.email,
    outcome: "otp_resent",
    resource_id: pending.userId,
  });

  return res;
}
```

- [ ] **Step 4: 通ることを確認する**

Run: `npx jest tests/integration/api/auth/login-resend.test.ts && npx tsc --noEmit && npx eslint src/app/api/auth/login/resend/route.ts`
Expected: 4 テスト PASS、型・lint とも出力なし

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/login/resend/route.ts tests/integration/api/auth/login-resend.test.ts
git commit -m "feat(auth): resend the login OTP from the pending 2FA cookie"
```

---

### Task 7: e2e から本物の 2FA Cookie を置くヘルパ

**Files:**

- Create: `e2e/auth-2fa-test-utils.ts`

**Interfaces:**

- Consumes: `createLoginTwoFactorSessionToken`（`@/features/auth/services/login-2fa-session`）
- Produces: `setLoginTwoFactorCookie(page: Page, email?: string, userId?: string): Promise<void>`

既存の e2e は `/api/auth/login` をネットワーク層でモックしており 2FA Cookie が実在しない。Task 8 で `/login/verify` にサーバーゲートを入れると、その状態では弾かれる。

- [ ] **Step 1: ヘルパを書く**

`e2e/auth-2fa-test-utils.ts`:

```ts
import type { Page } from "@playwright/test";
import { createLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";

/**
 * パスワード検証を通過した直後の状態を作る。
 *
 * e2e は /api/auth/login をネットワーク層でモックするため、本物の 2FA Cookie が
 * 発行されない。/login/verify はサーバーで Cookie を検証するので、テスト側で
 * 本物の署名 Cookie を置く必要がある。
 *
 * 署名鍵は playwright.config.ts の loadEnvConfig が読む .env.local の
 * JWT_SECRET（または LOGIN_2FA_SESSION_SECRET）。
 * この仕組みは「認証前段の有効な状態」を偽造できるため、CI では本番の
 * JWT_SECRET を使わないこと。
 */
export async function setLoginTwoFactorCookie(
  page: Page,
  email = "user@example.com",
  userId = "e2e-user-id",
) {
  const value = createLoginTwoFactorSessionToken({ userId, email });

  await page.context().addCookies([
    {
      name: "sb-login-2fa-session",
      value,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
```

- [ ] **Step 2: 解決できることを確認する**

Run: `npx tsc --noEmit && npx eslint e2e/auth-2fa-test-utils.ts`
Expected: 出力なし（`@/` エイリアスが e2e からも解決されること）

- [ ] **Step 3: 実際に Cookie が置けることを確認する使い捨てスペックで検証する**

`e2e/__tmp-cookie.spec.ts` を作る。

```ts
import { test, expect } from "@playwright/test";
import { setLoginTwoFactorCookie } from "./auth-2fa-test-utils";

test("署名 Cookie を置ける", async ({ page }) => {
  await page.goto("/login");
  await setLoginTwoFactorCookie(page, "user@example.com");
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "sb-login-2fa-session")).toBeDefined();
});
```

Run: `npx playwright test e2e/__tmp-cookie --reporter=line`
Expected: 1 passed

- [ ] **Step 4: 使い捨てスペックを消す**

Run: `rm -f e2e/__tmp-cookie.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add e2e/auth-2fa-test-utils.ts
git commit -m "test(e2e): add a helper that mints a real pending 2FA cookie"
```

---

### Task 8: `/login/verify` の新設

**Files:**

- Create: `src/app/login/verify/page.tsx`
- Create: `src/app/login/verify/VerifyOtpClient.tsx`
- Create: `e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts`

**Interfaces:**

- Consumes: `maskEmail`（Task 2）、`POST /api/auth/login/cancel`（Task 5）、`POST /api/auth/login/resend`（Task 6）、`setLoginTwoFactorCookie`（Task 7）
- Produces: ルート `/login/verify`。`VerifyOtpClient` は `{ email: string }` を受け取る default export

- [ ] **Step 1: 失敗する e2e を書く**

`e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";
import { setLoginTwoFactorCookie } from "./auth-2fa-test-utils";

// FREQ-334: メール OTP の入力を専用画面で行う。
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

const EMAIL = "14masa56@gmail.com";

const openVerify = async (page: Page) => {
  await page.goto("/login");
  await setLoginTwoFactorCookie(page, EMAIL);
  await page.goto("/login/verify");
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-027 otp dedicated screen (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
    });

    test("AC-01: 2FA Cookie が無ければ /login へ送り返す", async ({ page }) => {
      await page.goto("/login/verify");

      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel("認証コード 1 桁目")).toHaveCount(0);
    });

    test("AC-04: 宛先はマスクして表示する", async ({ page }) => {
      await openVerify(page);

      await expect(page.getByText("14***56@gmail.com")).toBeVisible();
      await expect(page.locator("body")).not.toContainText(EMAIL);
    });

    test("タブ（ログイン / 会員登録）を出さない", async ({ page }) => {
      await openVerify(page);

      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.getByLabel("認証コード 1 桁目")).toBeVisible();
    });

    test("リロードしてもコード入力が残る", async ({ page }) => {
      await openVerify(page);
      await page.reload();

      await expect(page.getByLabel("認証コード 1 桁目")).toBeVisible();
    });

    test("AC-05: 再送はパスワードも宛先も送らない", async ({ page }) => {
      await page.clock.install();
      await openVerify(page);

      let body: unknown = null;
      await page.route("**/api/auth/login/resend", async (route) => {
        body = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"ok":true}',
        });
      });

      await page.clock.fastForward(61_000);
      await page.getByRole("button", { name: "再送信" }).click();

      await expect(page.getByText(/後に再送可能|再送信しました/)).toBeVisible();
      expect(body).toBeNull(); // 本文を持たない
    });

    test("AC-06: 別のアドレスでやり直すと Cookie が消える", async ({
      page,
    }) => {
      await openVerify(page);

      await page
        .getByRole("button", { name: "別のアドレスでやり直す" })
        .click();
      await expect(page).toHaveURL(/\/login$/);

      await page.goto("/login/verify");
      await expect(page).toHaveURL(/\/login$/);
    });
  });
}
```

- [ ] **Step 2: 失敗することを確認する**

Run: `npx playwright test e2e/FR-LOGIN-027 --reporter=line`
Expected: FAIL — `/login/verify` が 404

- [ ] **Step 3: Server Component のゲートを書く**

`src/app/login/verify/page.tsx`:

```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";
import VerifyOtpClient from "./VerifyOtpClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * 認証コードの入力画面。
 *
 * 判定をサーバーに置くのは、判定前に入力画面の HTML を送らないため。
 * クライアント判定にすると、リダイレクトされるまでの一瞬フォームが見える。
 * 不在・改竄・期限切れをすべて同じ扱いにして、アカウントの存在を示唆しない。
 */
export default async function LoginVerifyPage() {
  const store = await cookies();
  const session = verifyLoginTwoFactorSessionToken(
    store.get(loginTwoFactorSessionCookieName)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  return <VerifyOtpClient email={session.email} />;
}
```

`verifyLoginTwoFactorSessionToken` が `login-2fa-session.ts` から export されていなければ export を足す（`verifyPasswordResetSessionToken` と同じ形）。

- [ ] **Step 4: 入力画面を書く**

`src/app/login/verify/VerifyOtpClient.tsx` を作る。

OTP の 1 桁入力ハンドラ群（`focusOtpInput` / `handleOtpChange` / `handleOtpKeyDown` / `handleOtpPaste`）は `src/components/LoginModal.tsx:78-178` から**逐語的に移動**する。手で打ち直すと転記ミスが入るので、切り取って貼る。

その外側は次のとおり書く。

```tsx
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { formatResendCountdown } from "@/lib/format-countdown";
import { maskEmail } from "@/lib/mask-email";
import "@/components/AuthForm.css";

const OTP_LENGTH = 8;
const EMPTY_OTP_DIGITS = Array.from({ length: OTP_LENGTH }, () => "");
const RESEND_COOLDOWN_SECONDS = 60;

type AuthMeResponse = {
  authenticated?: boolean;
  user?: { role?: unknown };
};

const isPrivilegedRole = (role: unknown): boolean =>
  role === "admin" || role === "supporter";

export default function VerifyOtpClient({ email }: { email: string }) {
  const router = useRouter();
  const { verifyOtp } = useLogin();
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [otpDigits, setOtpDigits] = useState<string[]>(EMPTY_OTP_DIGITS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<Date | null>(new Date());
  const [timeRemaining, setTimeRemaining] = useState(RESEND_COOLDOWN_SECONDS);

  const otpCode = otpDigits.join("");
  const maskedEmail = maskEmail(email);

  // ここに LoginModal:78-178 から移した
  // focusOtpInput / handleOtpChange / handleOtpKeyDown / handleOtpPaste を置く

  // 残り時間は経過時刻から引き直す。setInterval の回数を数えると、タブが
  // 背面に回って間引かれたぶんだけ再送可能になる時刻が後ろへずれる。
  useEffect(() => {
    if (!sentAt) return;
    const interval = setInterval(() => {
      const elapsed = (Date.now() - sentAt.getTime()) / 1000;
      const remaining = Math.max(
        0,
        RESEND_COOLDOWN_SECONDS - Math.floor(elapsed),
      );
      setTimeRemaining(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [sentAt]);

  const resolvePostLoginPath = useCallback(async (): Promise<string> => {
    try {
      const response = await fetch("/api/auth/me", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await response
        .json()
        .catch(() => null)) as AuthMeResponse | null;
      if (!response.ok || body?.authenticated !== true) return "/login";
      return isPrivilegedRole(body?.user?.role) ? "/auth/verified" : "/account";
    } catch {
      return "/account";
    }
  }, []);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otpCode.length !== OTP_LENGTH) {
      setError("認証コードは8桁で入力してください");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await verifyOtp(email, otpCode);
      if (!res.success) {
        setError(res.error || "認証コードの確認に失敗しました");
        return;
      }
      router.replace(await resolvePostLoginPath());
    } catch (err) {
      console.error("Unexpected OTP verify error", err);
      setError("認証コードの確認に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  // 再送はパスワードを要らない。パスワード検証を通ったことは 2FA Cookie が
  // 証明しているので、宛先も本文では送らない。
  const handleResend = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/auth/login/resend", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          router.replace("/login");
          return;
        }
        setError("認証コードの送信に失敗しました");
        return;
      }
      setOtpDigits([...EMPTY_OTP_DIGITS]);
      setSentAt(new Date());
      setTimeRemaining(RESEND_COOLDOWN_SECONDS);
      setSuccess("認証コードを再送信しました。");
      setTimeout(() => focusOtpInput(0), 0);
    } finally {
      setLoading(false);
    }
  };

  // クライアント状態を戻すだけでは Cookie が残る。サーバーに捨てさせる。
  const handleUseAnotherAddress = async () => {
    await fetch("/api/auth/login/cancel", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    router.replace("/login");
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="px-6 text-center">
        <h1 className="font-brand lk-text-4xl tracking-widest">
          認証コードを入力
        </h1>
        {maskedEmail ? (
          <p className="mt-[5px] lk-text-sm leading-relaxed">
            {maskedEmail} 宛に送信しました
          </p>
        ) : null}
        <p className="mt-[5px] lk-text-sm leading-relaxed">
          コードは5分間有効です
        </p>

        <form className="mt-5" onSubmit={handleVerify}>
          <div
            className="flex items-center justify-between gap-1.5 sm:gap-2"
            id="otp"
          >
            {Array.from({ length: OTP_LENGTH }).map((_, index) => (
              <input
                key={index}
                ref={(el) => {
                  otpInputRefs.current[index] = el;
                }}
                value={otpDigits[index]}
                onChange={(event) => handleOtpChange(index, event.target.value)}
                onKeyDown={(event) => handleOtpKeyDown(index, event)}
                onPaste={(event) => handleOtpPaste(index, event)}
                className="flex-1 min-w-0 h-11 border border-black/20 rounded-lg text-center lk-text-lg outline-none transition-colors duration-200 focus:border-black"
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                maxLength={1}
                aria-label={`認証コード ${index + 1} 桁目`}
              />
            ))}
          </div>

          <Button
            type="submit"
            size="md"
            className="auth-action w-full mt-[30px]"
            disabled={loading || otpCode.length !== OTP_LENGTH}
          >
            {loading ? "処理中..." : "サインイン"}
          </Button>
        </form>

        <div className="mt-[30px]">
          {timeRemaining > 0 ? (
            <p className="lk-text-xs text-[#474747]">
              {formatResendCountdown(timeRemaining)}
            </p>
          ) : (
            <Button
              type="button"
              className="auth-action w-full"
              size="md"
              disabled={loading}
              onClick={handleResend}
            >
              再送信
            </Button>
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-4 lk-text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {success ? (
          <p role="status" className="mt-4 lk-text-sm">
            {success}
          </p>
        ) : null}

        <div className="mt-[30px] flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={handleUseAnotherAddress}
            className="lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
          >
            別のアドレスでやり直す
          </button>
        </div>
      </div>
    </div>
  );
}
```

隙間の値（`mt-[5px]` / `mt-5` / `mt-[30px]`）は FREQ-331 で決めた 4 段階スケールに合わせている。

- [ ] **Step 5: `/login/verify` を認証ページ扱いにする**

`src/contexts/Providers.tsx` の `isAuthPage` の条件に `/login/verify` を足す。足さないとフッターが出て、他の認証画面と作法がずれる。

```tsx
const isAuthPage =
  pathname === "/login" ||
  pathname === "/login/verify" ||
  pathname === "/auth/password-reset";
```

- [ ] **Step 6: e2e が通ることを確認する**

Run: `Get-NetTCPConnection -LocalPort 3000 -State Listen`（動いていれば停止）→ `npx playwright test e2e/FR-LOGIN-027 --reporter=line`
Expected: 18 passed（6 テスト × 3 ビューポート）

- [ ] **Step 7: 型と lint を確認する**

Run: `npx tsc --noEmit && npx eslint src/app/login/verify src/contexts/Providers.tsx e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts`
Expected: 出力なし

- [ ] **Step 8: Commit**

```bash
git add src/app/login/verify src/contexts/Providers.tsx e2e/FR-LOGIN-027-otp-dedicated-screen.spec.ts
git commit -m "feat(auth): move the login OTP step to a dedicated screen"
```

---

### Task 9: LoginModal の縮小と逆方向ガード

**Files:**

- Modify: `src/components/LoginModal.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `e2e/account-test-utils.ts`
- Modify: `e2e/FR-LOGIN-001-otp-turnstile.spec.ts`
- Modify: `e2e/FR-LOGIN-006-otp-resend-countdown.spec.ts`
- Modify: `e2e/FR-LOGIN-008-password-otp-2fa.spec.ts`
- Modify: `e2e/FR-LOGIN-026-turnstile-token-single-use.spec.ts`

**Interfaces:**

- Consumes: `/login/verify`（Task 8）、`setLoginTwoFactorCookie`（Task 7）
- Produces: なし

- [ ] **Step 1: 共通ヘルパを直す**

`e2e/account-test-utils.ts` の `loginAndOpenAccount` を、`/login` で資格情報を送ったあと `/login/verify` でコードを入れる形に書き換える。`/api/auth/login` のモックが 2FA Cookie を発行しないので、`setLoginTwoFactorCookie` で本物の Cookie を置いてから `/login/verify` へ進む。

```ts
import { setLoginTwoFactorCookie } from "./auth-2fa-test-utils";

export async function loginAndOpenAccount(
  page: Page,
  email = "user@example.com",
) {
  await page.goto("/login");
  // 以降、資格情報の入力と送信は従来どおり

  // モックした /api/auth/login は Cookie を発行しないので、テスト側で置く。
  await setLoginTwoFactorCookie(page, email);
  await page.goto("/login/verify");

  for (let index = 0; index < 8; index += 1) {
    await page
      .getByLabel(`認証コード ${index + 1} 桁目`)
      .fill(String((index + 1) % 10));
  }
  await page.getByRole("button", { name: "サインイン" }).click();
}
```

- [ ] **Step 2: 共通ヘルパ経由の 2 本が通ることを確認する**

Run: `npx playwright test e2e/FR-ACCOUNT-007 e2e/FR-CHECKOUT-012 --reporter=line`
Expected: all passed

- [ ] **Step 3: LoginModal から OTP を取り除く**

`src/components/LoginModal.tsx` から次を削除する。

- `otpSent` / `otpDigits` / `otpSentTime` / `timeRemaining` / `otpInputRefs` の各宣言
- `OTP_LENGTH` / `EMPTY_OTP_DIGITS` / `otpCode` / `focusOtpInput` / `handleOtpChange` / `handleOtpKeyDown` / `handleOtpPaste` / `handleVerifyOtp`
- カウントダウンの `useEffect`
- OTP のマークアップ（`{otpSent ? (...) : null}` の 2 ブロック）と「メールアドレスを変更」ボタン
- `resolvePostLoginPath` / `AuthMeResponse` / `isPrivilegedRole`（Task 8 で移設済み）
- 未使用になる import（`formatResendCountdown`、`useLogin` から取っていた `verifyOtp`）

`handleLogin` の成功分岐を差し替える。

```ts
      } else {
        // 検証は専用画面で行う。push だと戻るボタンで資格情報フォームに戻れて
        // しまい、生きた 2FA Cookie を持ったまま再ログインして 2 通目の OTP を
        // 発射できる。replace で戻り先を残さない。
        onClose?.();
        router.replace('/login/verify');
      }
```

送信ボタンの `disabled` と文言から OTP 分岐を落とす。

```tsx
            disabled={loading || !email || !password}
          >
            {loading ? '処理中...' : 'ログイン'}
```

- [ ] **Step 4: `/login` に逆方向ガードを足す**

`src/app/login/page.tsx` の `LoginPage` の先頭に加える。

```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";

// ...

// 検証待ちのまま戻ってきた場合は続きへ送る。ここで資格情報フォームを
// 見せると、もう一度ログインを押して 2 通目の OTP を発射でき、
// アカウント単位のレート制限（5 回 / 600 秒）を無駄に消費する。
const store = await cookies();
if (
  verifyLoginTwoFactorSessionToken(
    store.get(loginTwoFactorSessionCookieName)?.value,
  )
) {
  redirect("/login/verify");
}
```

- [ ] **Step 5: 残りの 4 本を直す**

`e2e/FR-LOGIN-001` / `006` / `008` / `026` を、`/login` でパスワードを送ったあと `/login/verify` に着地する前提へ書き換える。各ファイルの OTP 部分は `setLoginTwoFactorCookie` + `page.goto('/login/verify')` に置き換える。FR-LOGIN-006（再送カウントダウン）は再送先が `/api/auth/login/resend` に変わるので、モック対象も差し替える。

- [ ] **Step 6: ログイン周り全体が通ることを確認する**

Run: `npx playwright test e2e/FR-LOGIN e2e/FR-ACCOUNT-007 e2e/FR-CHECKOUT-012 --reporter=line`
Expected: all passed

- [ ] **Step 7: 型と lint を確認する**

Run: `npx tsc --noEmit && npx eslint src/components/LoginModal.tsx src/app/login/page.tsx e2e`
Expected: 出力なし

- [ ] **Step 8: Commit**

```bash
git add src/components/LoginModal.tsx src/app/login/page.tsx e2e
git commit -m "refactor(auth): drop the inline OTP step from LoginModal"
```

---

### Task 10: 堅牢化の e2e と全体回帰

**Files:**

- Create: `e2e/FR-LOGIN-028-otp-verify-hardening.spec.ts`

**Interfaces:**

- Consumes: Task 4 / 7 / 8 の成果
- Produces: なし

- [ ] **Step 1: 失敗する e2e を書く**

`e2e/FR-LOGIN-028-otp-verify-hardening.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { setLoginTwoFactorCookie } from "./auth-2fa-test-utils";

// FREQ-335-AC-02: 上限に達したら試行の窓ごと閉じる。
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test(`FR-LOGIN-028 上限到達で 2FA Cookie が破棄される (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    // 429 と Cookie 破棄をサーバーの実挙動に依存させず、応答だけを再現する。
    await page.route("**/api/auth/otp/verify", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: {
          "Retry-After": "600",
          "Set-Cookie":
            "sb-login-2fa-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
        },
        body: JSON.stringify({ error: "Too many requests" }),
      });
    });

    await page.goto("/login");
    await setLoginTwoFactorCookie(page, "user@example.com");
    await page.goto("/login/verify");

    for (let index = 0; index < 8; index += 1) {
      await page.getByLabel(`認証コード ${index + 1} 桁目`).fill("1");
    }
    await page.getByRole("button", { name: "サインイン" }).click();

    await expect(page.locator('p[role="alert"]')).toBeVisible();

    // Cookie が消えているので、開き直すと入力画面に入れない
    await page.goto("/login/verify");
    await expect(page).toHaveURL(/\/login$/);
  });
}
```

- [ ] **Step 2: 通ることを確認する**

Run: `npx playwright test e2e/FR-LOGIN-028 --reporter=line`
Expected: 3 passed

- [ ] **Step 3: ユニットと統合の全件を流す**

Run: `npx jest`
Expected: all passed

- [ ] **Step 4: 認証まわりの e2e を本番ビルドで流す**

Run: `Get-NetTCPConnection -LocalPort 3000 -State Listen`（動いていれば停止）→ `npx playwright test e2e/FR-LOGIN e2e/FR-PWRESET e2e/FR-ACCOUNT-007 e2e/FR-CHECKOUT-012 --reporter=line`
Expected: all passed

- [ ] **Step 5: 知識グラフを更新する**

Run: `graphify update .`
Expected: `Code graph updated.`

- [ ] **Step 6: Commit**

```bash
git add e2e/FR-LOGIN-028-otp-verify-hardening.spec.ts graphify-out
git commit -m "test(e2e): cover the OTP verify lockout on the dedicated screen"
```

---

## セルフレビュー結果

**仕様カバレッジ**

| 仕様の節                | 実装するタスク                                              |
| ----------------------- | ----------------------------------------------------------- |
| 3.1 ルートとゲート      | Task 8 Step 3                                               |
| 3.2 入力画面            | Task 8 Step 4                                               |
| 3.3 逆方向ガード        | Task 9 Step 4                                               |
| 4 LoginModal の縮小     | Task 9 Step 3                                               |
| 5.1 cancel              | Task 5                                                      |
| 5.2 resend              | Task 6                                                      |
| 5.3 otp/verify の堅牢化 | Task 4                                                      |
| 5.4 Cookie の TTL       | Task 3                                                      |
| 6 マスク表示            | Task 2、Task 8 Step 4                                       |
| 7.1 テストヘルパ        | Task 7                                                      |
| 7.2 既存 spec の修正    | Task 9 Step 1 / Step 5                                      |
| 7.3 新規 spec           | Task 8 Step 1、Task 10 Step 1、Task 2 Step 1、Task 4 Step 1 |
| 8 要求管理              | Task 1                                                      |

**型の整合**

- `maskEmail(email: string): string` — Task 2 で定義、Task 8 で使用。名前・引数一致
- `setLoginTwoFactorCookie(page, email?, userId?)` — Task 7 で定義、Task 8 / 9 / 10 で使用。名前一致
- `VerifyOtpClient({ email }: { email: string })` — Task 8 Step 4 で定義、Step 3 で使用。プロパティ名一致
- `verifyLoginTwoFactorSessionToken(token)` — Task 8 Step 3 と Task 9 Step 4 で使用。存在しなければ Task 8 Step 3 で export を足す旨を明記済み

**スコープ**

Google サインイン、会員登録、`?next=` は仕様どおり範囲外。計画にも含めていない。
