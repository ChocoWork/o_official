# お客さんのログイン（メールのコードの窓口と画面）

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/app/api/auth/email-code/{start,verify,resend,cancel}/route.ts`、`src/features/auth/services/email-code-session.ts`、`src/features/auth/schemas/email-code.ts`、`src/lib/cookie.ts`（範囲の外。メールのコードの保留の Cookie の名前と属性だけを足した）

## 概要

段2で、お客さんがメールに届いたコードだけでログイン・新規登録できるようにする。この文書の最初の節（DD-AUTH-059）は、その土台になる4つの窓口と保留の Cookie の処理を書く。画面（`/login`・`/login/code` など）の処理は、以降のタスクがこの文書に足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応する ID | SR-AUTH-021、FR-AUTH-023、SEC-AUTH-048、SEC-AUTH-049、THR-AUTH-049、API-AUTH-029、API-AUTH-030、API-AUTH-031、API-AUTH-032、DD-AUTH-059、ADR-0469、SEC-AUTH-050、DD-AUTH-060 |
| 対象のコード | `src/app/api/auth/email-code/start/route.ts`、`verify/route.ts`、`resend/route.ts`、`cancel/route.ts`、`src/features/auth/services/email-code-session.ts`、`src/features/auth/schemas/email-code.ts`、`src/lib/cookie.ts`（`emailCodeSessionCookieName`・`cookieOptionsForEmailCode`）、`src/features/auth/passkey/{webauthn-browser,passkey-client,device-name,post-login}.ts`、`src/features/auth/schemas/passkey.ts`（`dropNullFields`）、`src/lib/auth/passkey-gotrue.ts`（`server-only`） |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（6-1）、[段2の計画](../../superpowers/plans/2026-11-17-passkey-stage2-customers.md)、[パスキーの窓口](auth-passkey-server-endpoints.md) |
| 調べた時点 | 2026-11-17（手元の GoTrue で、作成→コードの送信→確定の組み合わせを実測した。手元の DB・Mailpit で E2E を流した） |

## 処理の詳細

### DD-AUTH-059 メールのコードの窓口4つと保留の Cookie の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-029、API-AUTH-030、API-AUTH-031、API-AUTH-032、SEC-AUTH-048、SEC-AUTH-049 |
| 根拠 | 手元の GoTrue は、未登録のアドレスに `signInWithOtp({ shouldCreateUser: true })` を呼ぶと確認メールの型（リンク型）で送る。この型は旧の会員登録も使うので、コードを足すと旧画面の確認メールが変わる。そこで窓口が先に、確認済み・パスワード無しでアカウントを作り（`admin.createUser`）、全員に同じく `signInWithOtp({ shouldCreateUser: false })` を呼ぶ。ログインのコードのメールの型だけが使われ、コードだけが届く。登録済みなら `createUser` が `email_exists` で断られるので握り、応答を同じにする |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/email-code-session.test.ts`、`tests/unit/api/auth/email-code-*-route.test.ts`）、結合テスト（`tests/integration/api/auth/email-code-*.test.ts`）、E2E（`e2e/FR-LOGIN-055-email-code-api.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-1-brief.md`、`docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（6-1）、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 1。作り手の判断 3・4、調整役の判断 3） |

```mermaid
sequenceDiagram
    participant B as ブラウザ
    participant S as /api/auth/email-code/start
    participant V as /api/auth/email-code/verify
    participant G as GoTrue
    participant M as メール
    B->>S: POST email・turnstileToken・next
    S->>S: IP の枠 → 本文の形 → Turnstile → 宛先の枠
    S->>G: admin.createUser（確認済み・印 email_code_signup_pending）
    G-->>S: 成功、または email_exists（握る）
    S->>G: signInWithOtp（shouldCreateUser: false）
    G->>M: 8桁のコードだけのメール
    S-->>B: 202（常に同じ本文）・保留の Cookie（メールと jti）
    B->>V: POST code（保留の Cookie つき）
    V->>V: IP の枠 → 本文 → Cookie → Cookie ごとの枠 → 宛先ごとの枠
    V->>G: verifyOtp（宛先は Cookie 由来）
    G-->>V: セッション、または店員の拒否（403 の印）
    V-->>B: 200 user・offerPasskey、または 403 staff_passkey_required
```

処理の順番と決め:

| 窓口 | 順番 | 失敗 |
| --- | --- | --- |
| 始め | IP の枠（50回/10分、`auth:email-code:send`）→ 本文の形（400）→ Turnstile（403 `Bot detection failed`）→ 宛先の枠（5回/10分、同じ名前）→ `createUser`（`email_exists` は握る、`email_address_invalid` は 400、それ以外は 500・監査 `supabase_create_user_failed`）→ `signInWithOtp`（captcha の拒否は 500、GoTrue の 429 は成功と同じ 202 に隠して監査 `email_code_send_throttled`・ログ、5xx は 503）→ 保留の Cookie と戻り先の控え | 上の表のとおり。成功は常に 202 |
| 確定 | IP の枠（30回/10分、`auth:email-code:verify`）→ 本文（400）→ 保留の Cookie（401）→ Cookie ごとの枠（`email:jti`、5回/10分）→ 宛先ごとの枠（20回/10分）→ `verifyOtp`（宛先は Cookie 由来）。使い切ったら Cookie を消して 429（消すのはブラウザの Cookie だけ。署名した値は期限まで使えるが、宛先ごとの枠が上を押さえる） | 店員の印つきの拒否は 403 `staff_passkey_required`（Cookie は消し、セッションを作らない）。コード違いは 401 |
| 再送 | 保留の Cookie（401）→ IP の枠（50回/10分）→ 宛先の枠（5回/10分、始めと同じ名前）→ `signInWithOtp` → Cookie を元の発行時刻と `jti` で付け直す（200） | GoTrue の 429 は成功と同じ 200 に隠して監査 `email_code_send_throttled`・ログ（保留の Cookie は誰でも任意のアドレス宛てに持てるため）、5xx・通信の失敗は 503、ほかの送信の失敗は 500。隠した時は `otp_resent` を書かない |
| 取りやめ | 保留の Cookie と戻り先の控えを消して 204。Cookie があった時だけ監査に残す | 無し |

成功した確定: セッションを保存（ゲストのカート・お気に入りの引き継ぎつき）→ 印 `email_code_signup_pending` を外す（失敗は監査の符号だけで続行）→ 注文の引き継ぎ（`linkGuestOrdersByEmail`）→ 200 `{ user: { id, email, role }, offerPasskey, message }`。`offerPasskey` は、`role` が `user` で、鍵の一覧が成功して0本の時だけ真（一覧の失敗・店員は偽。閉じる側）。

保留の Cookie（`sb-email-code-session`）: メールと乱数 `jti` と発行時刻を HMAC で署名する。`userId` を持たない（登録済みかどうかを Cookie から読ませない）。属性は旧の保留の Cookie と同じ（HttpOnly・SameSite=Strict・5分）。再送では発行時刻と `jti` を引き継ぎ、絶対の上限（30分）で打ち切る。署名の目的（`purpose`）が旧と違うので、旧い Cookie の値を新しい窓口に渡しても、その逆も読めない。

旧の会員登録（`signUp`）で作って確認していないアドレス: 始めは同じ 202 を返す（応答を変えない）。GoTrue は確認のメール（リンク型）を送るのでコードは届かない。`/login/code` の画面は、アカウントの状態にかかわらず、いつも「コードの無い確認のメールが届いた時は、そのメールのリンクを押してから、もう一度お試しください。」と案内する。サーバーで確認済みにはしない（パスワードを先に付けた他人が、そのアドレスでログインできてしまうため）。旧の登録は段4まで残る。本人がリンクを押した後は、先にパスワードを付けた他人の旧の登録が確認済みになる危険が、段2の前と同じく残る。

GoTrue の宛先ごとの送信の間隔の 429 を 202 に隠す理由: 直前に認証のメールを受けた既存のアドレスだけで起きるので、429 のまま返すと未登録と見分けがつく。代わりにプロジェクト全体の送信の上限でも「送った」と見えるが、監査とログに残り、画面の再送（60秒後）で戻れる。

テスト観点: 始めと再送の GoTrue の 429 が成功と同じ応答になる（成功の監査は書かない）、始めと再送が本物の鍵の作りで合計5通を共有する、始めの応答が未登録・登録済み（`email_exists`）・登録済みで未確認・店員で同じ（本文・状態・Cookie の名前と属性）、`email_address_invalid` が 400、Turnstile の失敗で作成・送信・宛先の枠が0回、始めと再送が同じ枠で合計5通まで、別の保留の Cookie の失敗が本人の枠を使わない、枠を使い切ると Cookie を消して 429、店員は 403 で Cookie を残さない、成功で印が外れる（外す失敗でもログインできる）、`offerPasskey` の4通り、旧い保留の Cookie が新しい窓口で 401。

### DD-AUTH-060 ブラウザの WebAuthn の部品と、1b の窓口を呼ぶ部品

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-050 |
| 根拠 | 画面（Task 4〜7）が薄くなるよう、ブラウザの WebAuthn の呼び出しと、1b の窓口を呼ぶ処理を、React を知らない関数に切り出す。実ブラウザの `toJSON()` は `authenticatorAttachment: null` を返しうるので、部品が落とし、窓口の形も `null` を受けて GoTrue へ渡す前に落とす（1b の持ち越し T2 M12）。`passkey-gotrue` に `server-only` を付け（T2 M3）、画面の部品が読まないことを試験で守る。登録の終わりの GoTrue の失敗（502）と形の失敗（400。`uv_required` を含む）は、画面では区別せず `retry` にそろえる（T7 M3。窓口の状態は変えない） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/passkey/*.test.ts`、`tests/unit/features/auth/schemas/passkey.test.ts`、`tests/unit/api/auth/passkey-{login,register}-finish-route.test.ts`）。1b の E2E（`e2e/FR-LOGIN-050`・`051`）が窓口の直の呼び出しで緑のまま |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-2-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 2）、`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/final-review.md`（持ち越し） |

処理の順番と決め:

| 部品 | 順番 | 結果 |
| --- | --- | --- |
| `requestAssertion`・`requestAttestation` | 対応の確かめ（`PublicKeyCredential` と `navigator.credentials`）→ 選択肢の `challenge`・`allowCredentials[].id`・`excludeCredentials[].id`・`user.id` を `ArrayBuffer` に直す（`parse*FromJSON` が在れば使い、無ければ自前の base64url）→ `credentials.get`・`create` → 応答を JSON にする（`toJSON()` が在れば使い、無ければ自前）→ `null` の項目を落とす | `NotAllowedError` は `cancelled`、`InvalidStateError` は `already_registered`、`NotSupportedError`・`SecurityError` は `unsupported`、それ以外は `failed`。対応が無ければ `unsupported`。何もログに出さない |
| `loginWithPasskey` | 始め（1b の `browser-start`）→ `assert` → `POST /api/auth/passkey/login/finish { challenge_id, credential, next }` | 始めの失敗はそのまま。終わりは 401 `passkey_login_failed` → `not_found`、400 `uv_required` → `uv_required`、403 `staff_passkey_required`・`passkey_not_approved` → `staff_blocked`、429 → `rate_limited`（`Retry-After` を秒で）、503・502・409 → `unavailable`、それ以外 → `failed` |
| `registerPasskey` | `POST register/start` → `create` → `POST register/finish` → `PATCH /api/auth/passkey/{id}`（失敗は握る） | 403 `registration_not_allowed` の `reauth_required` → `reauth_required`、401 → `unauthorized`、429 → `rate_limited`、502・400 → `retry`、503 → `unavailable`。名前の変更の失敗は `ok: true` で `nameApplied: false` |
| `listPasskeys`・`renamePasskey`・`deletePasskey` | `clientFetch`（CSRF は `clientFetch` が付ける）で `GET`・`PATCH`・`DELETE` | 401 → `unauthorized`、404 → `not_found`、429 → `rate_limited`、503 → `unavailable`、それ以外 → `failed`。応答の本文は、読まない道でも捨てる（no-store の読み残しで E2E の `networkidle` が来なくなるため）。お客さん専用で、店員の項目（`isStaff`・`approvedCount`・`approved`）は返さない（段3で足す） |
| `deviceNameFromUserAgent` | `iPhone`・`iPad`・`Android`・`Mac`・`Windows`・`Linux` を含む順に見る | 無ければ `この端末`。返す名前は固定で、どれも64字より短い |
| `resolvePostLoginPath` | `POST /api/auth/post-login` | 旧 `VerifyOtpClient` の同名の関数と同じ規則（401 は `/login`、失敗・読めない本文・`needsMfa` は `/auth/verified`、それ以外は `sanitizeReturnPath`） |
| `dropNullFields`（窓口側） | 応答の最上位の `null` の項目を落とす | GoTrue へ渡す前に、ログイン・登録の終わりの2本が使う |

テスト観点: `parse*FromJSON` が在る環境と無い環境の両方で、既知の base64url が正しい `ArrayBuffer` になる、`toJSON()` が `authenticatorAttachment: null` を返しても戻りに `null` が残らない、4つの `DOMException` の名前の対応、`PublicKeyCredential` が無い環境で `unsupported`、ログに `challenge` が出ない、始め・終わりの状態ごとの `reason`、登録の 403・401・502・400・503 の対応、名前の変更の失敗で `ok: true`・`nameApplied: false`、`null` の応答が窓口で 400 にならず GoTrue へ `null` なしで渡る、`src/features/auth/passkey/**` が `passkey-gotrue`・`passkey-start-config` を読まない。
