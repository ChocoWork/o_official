# お客さんのログイン（メールのコードの窓口と画面）

> 状態: 推定 | 確認日: 2026-11-18 | 対象: `src/app/api/auth/email-code/{start,verify,resend,cancel}/route.ts`、`src/features/auth/services/email-code-session.ts`、`src/features/auth/schemas/email-code.ts`、`src/lib/cookie.ts`（範囲の外。メールのコードの保留の Cookie の名前と属性だけを足した）

## 概要

段2で、お客さんがメールに届いたコードだけでログイン・新規登録できるようにする。この文書の最初の節（DD-AUTH-059）は、その土台になる4つの窓口と保留の Cookie の処理を書く。画面（`/login`・`/login/code` など）の処理は、以降のタスクがこの文書に足す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応する ID | SR-AUTH-021、FR-AUTH-023、SEC-AUTH-048、SEC-AUTH-049、THR-AUTH-049、API-AUTH-029、API-AUTH-030、API-AUTH-031、API-AUTH-032、DD-AUTH-059、ADR-0469、SEC-AUTH-050、DD-AUTH-060、SR-AUTH-022、FR-AUTH-025、DD-AUTH-061、FR-AUTH-026、DD-AUTH-062、FR-AUTH-027、DD-AUTH-063、SR-AUTH-023、FR-AUTH-028、DD-AUTH-064、SR-AUTH-024、FR-AUTH-029、DD-AUTH-065 |
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

パスワード付きで作って確認していないアドレス: 始めは同じ 202 を返す（応答を変えない）。GoTrue は「メールアドレスの確認」のメールを送る。本文はリンクを持たず、8桁のコード（`{{ .Token }}`）を入れさせる（段4で確認のリンクの窓口を消した。FR-AUTH-054-AC-04）。`/login/code` の画面は、アカウントの状態にかかわらず、いつも「「メールアドレスの確認」のメールが届いた時は、そのメールにある8桁の数字を入れてください。」と案内する。サーバーで確認済みにはしない（コードを入れられるのは、メールを読める本人だけにするため）。コードを入れると確認済みになる。

GoTrue の宛先ごとの送信の間隔の 429 を 202 に隠す理由: 直前に認証のメールを受けた既存のアドレスだけで起きるので、429 のまま返すと未登録と見分けがつく。代わりにプロジェクト全体の送信の上限でも「送った」と見えるが、監査とログに残り、画面の再送（60秒後）で戻れる。

テスト観点: 始めと再送の GoTrue の 429 が成功と同じ応答になる（成功の監査は書かない）、始めと再送が本物の鍵の作りで合計5通を共有する、始めの応答が未登録・登録済み（`email_exists`）・登録済みで未確認・店員で同じ（本文・状態・Cookie の名前と属性）、`email_address_invalid` が 400、Turnstile の失敗で作成・送信・宛先の枠が0回、始めと再送が同じ枠で合計5通まで、別の保留の Cookie の失敗が本人の枠を使わない、枠を使い切ると Cookie を消して 429、店員は 403 で Cookie を残さない、成功で印が外れる（外す失敗でもログインできる）、`offerPasskey` の4通り、旧い保留の Cookie が新しい窓口で 401。

### DD-AUTH-060 ブラウザの WebAuthn の部品と、1b の窓口を呼ぶ部品

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-050、SEC-AUTH-061、ARC-AUTH-015 |
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
| `listPasskeys`・`renamePasskey`・`deletePasskey` | `clientFetch`（CSRF は `clientFetch` が付ける）で `GET`・`PATCH`・`DELETE` | 401 → `unauthorized`、404 → `not_found`、429 → `rate_limited`、503 → `unavailable`、店員の窓口の 409 で本文が `staff_min_keys` の時だけ `min_keys`（段3b Task 18。お客さんの窓口は返さず、お客さんの画面は今までどおりどの失敗も1つの文）、それ以外 → `failed`。応答の本文は、失敗のどの道でも読み切ってから使う（読まない道では捨てる）（no-store の読み残しで E2E の `networkidle` が来なくなるため）。`listPasskeys` はお客さん専用で、店員の項目（`isStaff`・`approvedCount`・`approved`）は返さない（店員の一覧は `loadStaffPasskeys`）。`renamePasskey`・`deletePasskey` は店員のパスキーの画面（`StaffPasskeyManager`）も使い、店員の削除の 409 は上の `min_keys` として返る |
| `deviceNameFromUserAgent` | `iPhone`・`iPad`・`Android`・`Mac`・`Windows`・`Linux` を含む順に見る | 無ければ `この端末`。返す名前は固定で、どれも64字より短い |
| `resolvePostLoginPath` | `POST /api/auth/post-login`（`needsMfa` の時だけ `GET /api/auth/passkey`） | 401・失敗・読めない本文は `/login`。`needsMfa` は、認めた鍵がちょうど1本の店員なら `/admin/passkeys?more=1`、それ以外は `/login?error=staff_passkey_required`。それ以外は `sanitizeReturnPath`（段4の Task 30。ARC-AUTH-015、ADR-0475） |
| `dropNullFields`（窓口側） | 応答の最上位の `null` の項目を落とす | GoTrue へ渡す前に、ログイン・登録の終わりの2本が使う |

テスト観点: `parse*FromJSON` が在る環境と無い環境の両方で、既知の base64url が正しい `ArrayBuffer` になる、`toJSON()` が `authenticatorAttachment: null` を返しても戻りに `null` が残らない、4つの `DOMException` の名前の対応、`PublicKeyCredential` が無い環境で `unsupported`、ログに `challenge` が出ない、始め・終わりの状態ごとの `reason`、登録の 403・401・502・400・503 の対応、名前の変更の失敗で `ok: true`・`nameApplied: false`、`null` の応答が窓口で 400 にならず GoTrue へ `null` なしで渡る、`src/features/auth/passkey/**` が `passkey-gotrue`・`passkey-start-config` を読まない。


### DD-AUTH-061 旧のログイン・会員登録の画面の `/login/password` への退避と、旧の流れの戻り先

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-001、FLOW-AUTH-001 |
| 根拠 | `/login` を新しい画面に作り替える前に、パスワードの旧の画面を `/login/password` へ動かし、中身を変えずに旧の画面を操作する試験の URL だけを付け替える。旧の流れが新しい画面に飛ばされて旧のフォームを探して落ちるのを防ぎ、段4で旧を丸ごと消せるようにする（調整役の判断 2・I-2） |
| 状態 | 廃止 |
| 確かめ方 | 単体テスト（`tests/unit/app/login/login-page.test.tsx`、`tests/unit/contexts/providers-auth-page.test.tsx`、`tests/unit/components/auth-tabs.test.tsx`、`tests/unit/components/VerifyOtpClient.test.tsx`、`tests/unit/components/register-modal.test.tsx`、`tests/unit/app/login/login-verify-page.test.tsx`）、E2E（`e2e/FR-LOGIN-056-legacy-login-relocated.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-3-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 3。調整役の判断 2・I-2） |

処理の順番と決め:

| 単位 | 動き |
| --- | --- |
| `src/app/login/password/page.tsx` | 旧の `/login` のページをそのまま移した。保留の旧い Cookie が有効なら `/login/verify` へ転送（問い合わせは読まない）→ `tab`・`email`・`next`（戻り先の確かめを通った道筋だけ）・`registered` を `AuthTabs` に渡す。metadata は題・説明・OG を旧と同じにし、`robots: { index: false, follow: false }` を足す |
| `src/components/AuthTabs.tsx` | タブの `path` を `/login/password` にする。タブを替えても `history.replaceState` で `/login/password` に置き換える |
| `src/contexts/Providers.tsx`（範囲の外） | `isAuthPage` に `/login/password`・`/login/code`・`/login/passkey` を足す。足さないと真ん中寄せの枠にならず `FR-LOGIN-016`・`017`・`023` が落ちる |
| `src/app/login/verify/page.tsx` | 保留の Cookie が無い・偽り・期限切れの時の転送先を `/login/password` にする |
| `src/app/login/verify/VerifyOtpClient.tsx` | 再送の401、取りやめ、`post-login` の401 で移る先を `/login/password` にする |
| `src/components/RegisterModal.tsx` | 戻る手段が無い時の「ログインページへ」のリンクを `/login/password` にする |
| `src/app/login/page.tsx` | Task 3 では変えず、Task 5 で新しい画面に作り替えた（DD-AUTH-063）。Task 3 の終わりは `/login` と `/login/password` が同じ中身だった |
| 変えない行き先 | `src/app/api/auth/confirm/route.ts` の `/login`・`/login?registered=1`、「登録済み」のメールのリンク、`/auth/verified` の「ログインページへ」、`GuestRegisterPrompt` の `/login?tab=register&email=…`。お客さんに見せる行き先は新しい `/login` が受ける（`tab` は読まず、`email` はメール欄の初めの値。Task 5） |
| Task 5 で付け替えた行き先 | パスワードの再設定の完了（`src/app/auth/password-reset/page.tsx` の「ログインへ」2か所）・リンクの確かめの完了（`verify/VerifyClient.tsx`）・パスワードの変更の完了（`src/app/account/password/PasswordChangeForm.tsx` の `router.replace`）は `/login/password`。段4までパスワードの旧い流れで入るため（新しい `/login` からは旧の画面へリンクしないので、これらが段4までの入り方になる） |

テスト観点: `/login/password` が旧のページの分岐（保留の転送・タブ・メール・戻り先・案内）を持つ、`robots` が noindex・nofollow、`isAuthPage` が `/login/password`・`/login/code`・`/login/passkey` で真になり、近い別の住所（`/login/other`・`/login/password/extra`）では偽、`AuthTabs` の `replaceState` が `/login/password`、旧の流れの3つの戻り先が `/login/password`。E2E は旧の画面を操作する試験の `goto('/login')` を `/login/password` に付け替え、期待は変えない（`/login?next=…` へ送られることを確かめる試験は新しい `/login` に着くので替えない）。

### DD-AUTH-062 メールのコードの入力画面 `/login/code` の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | API-AUTH-030、API-AUTH-031、API-AUTH-032、SCR-AUTH-001 |
| 根拠 | 旧の `/login/verify`（DD-AUTH-002）の動きを写し、窓口だけを `email-code/*` にする。旧の部品を共有に直さないのは、段4で旧を丸ごと消すため（作り手の判断 5）。成功の行き先は、確定の窓口の応答の `offerPasskey` だけで決める。一覧や検索の別の呼び出しをしないので、窓口が失敗側に倒れた時（`offerPasskey` が偽）は、静かに「勧めない」へ退く |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/passkey/email-code-entry.test.tsx`、`tests/unit/app/login/code-page.test.tsx`）、E2E（`e2e/FR-LOGIN-058-email-code-screen.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-4-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 4。作り手の判断 5） |

処理の順番と決め:

| 単位 | 動き |
| --- | --- |
| `src/app/login/code/page.tsx` | 保留の Cookie（`sb-email-code-session`）を `verifyEmailCodeSessionToken` で確かめる → 無い・偽り・期限切れは同じく `/login` へ転送（確かめない人に HTML を見せない）→ 有効なら保留のメールを部品へ渡す。`robots` は noindex・nofollow |
| `EmailCodeEntry`（開いた時） | 最初の欄にフォーカス。再送の待ちを今から60秒で始め、1秒ごとに経過の時刻から残りを引き直す。説明は `maskEmail` で伏せたメールと「8桁・5分以内」。いつも「「メールアドレスの確認」のメールが届いた時は、そのメールにある8桁の数字を入れてください。」を出す（アカウントの状態で変えない。FR-AUTH-023・DD-AUTH-059 と同じ案内） |
| 欄 | 数字だけ。打つと次の欄へ。貼り付けは、その欄から8桁まで割り振る。Backspace は空の欄なら前の欄を空にして戻る。矢印で移る |
| 「ログイン」 | 8桁そろうまで `disabled`。送ると `POST /api/auth/email-code/verify { code }`（応答の本文は必ず読む） |
| 確定の 200 | 移動が終わるまで入力・送信を止めたままにする（二度目の確定は保留が無く 401 になる）。`refreshAuthState()` → `offerPasskey` が真 かつ `isPasskeySupported()` が真なら `router.replace('/login/passkey')`。それ以外は `resolvePostLoginPath()`（DD-AUTH-060）の行き先へ `router.replace`（戻るで入力画面へ戻れない） |
| 確定の 401 | 本文の文が「セッションの有効期限」で始まれば保留の Cookie 切れ → 「時間がたちました。もう一度メールアドレスを入れてください。」を出し、入力を閉じ、「ログイン画面へ戻る」へフォーカスを移す（自動では戻さない。押すと `/login`）。それ以外はコードの誤り → 「確認コードが無効、または期限切れです。」（最初の欄へフォーカスを戻し、入力を続けられる） |
| 確定の 429 | 宛先・保留ごとの枠では窓口が保留の Cookie を閉じる。IP の枠の 429 では Cookie は残るが、画面は同じく閉じる → 「試行が集中しています。しばらくしてからやり直してください。」を出し、入力を閉じる（自動では戻さない。「ログイン画面へ戻る」で `/login`） |
| 確定の 403 `staff_passkey_required` | 「店員の方は、パスキーでログインしてください。」を出し、入力と再送を止め、「ログイン画面へ戻る」だけを置く（自動では戻さない） |
| 確定のそれ以外・通信の失敗 | 「確認できませんでした。時間をおいて、もう一度お試しください。」 |
| 「コードを再送する」 | 待ちが0になるまで `disabled`（残りは `formatResendCountdown`）。押すと `POST /api/auth/email-code/resend`（本文は捨てる）。200 は欄を空にし、待ちを60秒に戻し、「確認コードを再送しました。」を `status` で知らせ、最初の欄へ。401 は保留切れと同じ。429 は `Retry-After`（秒または日付。読めなければ60秒）を待ちにし、「しばらく再送できません。時間をおいて、もう一度お試しください。」。503 は「ただいま処理できません。時間をおいて、もう一度お試しください。」。それ以外は「確認コードを送れませんでした。時間をおいて、もう一度お試しください。」 |
| 「メールアドレスを入れ直す」 | `POST /api/auth/email-code/cancel`（本文は捨て、失敗は握る）→ `/login` へ置き換える。文字ボタンは高さ44px以上。`/login` は新しい画面（DD-AUTH-063） |
| 共通 | エラーは `LiveMessage`（`alert`）、成功の知らせは `status`。送信中は `aria-busy` と `disabled`、二重に送らない |

テスト観点: 8桁そろうまで「ログイン」が `disabled`、貼り付けの割り振りと数字以外の除去、Backspace、確定の応答ごとの文言と行き先（401 の2種・429・403・200 で `offerPasskey` が真・偽・未対応のブラウザ・本文が読めない）、閉じた後に自動では戻らず、フォーカスが「ログイン画面へ戻る」へ移ること、成功の後に二重に送れないこと、`refreshAuthState` が移動より先に走ること、再送の待ち（`jest.useFakeTimers`）・成功・401・`Retry-After`・503・その他、取りやめが失敗でも `/login` へ戻り本文を捨てること、送信中の二重送信の防止。ページは Cookie 無し・偽りで `/login` へ転送、有効ならメールを渡す。E2E は `start` を `request` で呼んで Mailpit のコードを入れ、鍵を持つ会員が戻り先へ着くこと、間違ったコード、再送の待ち、取りやめ、Cookie 無し、390px の幅を確かめる（`offerPasskey` が真の着地は `/login/passkey` が出来る Task 6 の E2E）。

### DD-AUTH-063 新しいログイン画面 `/login` の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-001、API-AUTH-029、API-AUTH-030、SEC-AUTH-048 |
| 根拠 | 旧のタブの画面（メール・パスワード）を `/login/password` に退避した（DD-AUTH-061）うえで、`/login` をパスキー・Google・メールのコードの3つの入口に作り替える。パスキーを持つ人は鍵1つで入り、持たない人と初めての人はメールのコードで入る。見出しは今の画面に無いので足さず、スクリーンリーダーのためにだけ視覚的に隠した「ログイン」を置く（作り手の判断 6）。ボット検証の枠は1つで、パスキー（始めの方式が `browser` の時）とメールで共有する。始めの方式 `server` は窓口がボット検証をしないので渡さない（判断 13）。応答の読み残しで通信が閉じない問題を避けるため、どの道でも本文を読むか捨てる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/passkey/login-choices.test.tsx`、`tests/unit/features/auth/passkey/email-code-start-form.test.tsx`、`tests/unit/app/login/page.test.tsx`）、E2E（`e2e/FR-LOGIN-057-login-screen.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-5-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 5。作り手の判断 5・6、判断 12・13） |

2026-11-18（最終レビュー M-4）: `LoginChoices` は `@/lib/supabase/client` を静的に読む。計画の作り手の判断13（`mode === 'browser'` の時だけ動的に読む）と違うが、`src/contexts/LoginContext.tsx` が全ページで同じ物を既に読んで初期化しているので、束も初期化も変わらず、動きは同じ。

処理の順番と決め:

| 単位 | 動き |
| --- | --- |
| `src/app/login/page.tsx`（ページの動きの詳細は `14_login.md` の DD-AUTH-001。この表は流れだけ） | 新しい保留の Cookie（`sb-email-code-session`）を `verifyEmailCodeSessionToken` で確かめ、有効なら `/login/code` へ転送 → 旧い保留の Cookie（`sb-login-2fa-session`）が有効なら `/login/verify` へ転送（問い合わせは読まない）→ `next`（`validateReturnPath` を通った道筋だけ）・`email`（文字列ならメール欄の初めの値。`tab` は読まない）・`registered=1`（固定の案内の文）を `LoginChoices` へ渡す。題と説明は新しい文（FR-AUTH-027） |
| `LoginChoices`（開いた時） | サーバーの描画と同じく「対応」の前提で描き、描画の後（`useEffect`）に `isPasskeySupported()` を見て、未対応ならボタンを外して一文を出す。ボット検証のスクリプトとウィジェットを、サイトキーがある時だけ置く |
| 「パスキーでログイン」 | 押すと `disabled`・`aria-busy`・「確認しています…」。`resolveBrowserStartMode()` が `browser` なら `createPasskeyAuthenticationStarter({ mode: 'browser', supabase })` とボット検証のトークンを使い（トークンが無ければ GoTrue を呼ばずに「使えない」の文）、`server` なら窓口 (a) を呼ぶ。続けて `loginWithPasskey`（DD-AUTH-060。鍵の選択 → 終わりの窓口。`next` は終わりの窓口の本文に渡す）。`browser` の時は送った後でボット検証を引き直す |
| パスキーの結果 | 成功は `refreshAuthState()` → `resolvePostLoginPath()`（DD-AUTH-060）の行き先へ `router.replace`（移動が終わるまでボタンは止めたまま。勧めの画面は出さない）。`cancelled`: 状態の知らせ「パスキーでのログインを中止しました。」（`role="status"`・赤にしない）。`not_found`・`uv_required`・`staff_blocked`・`rate_limited`（`Retry-After` があれば「約 N 分後」を足す）・そのほか（`unavailable`・`captcha_required`・`failed`）は理由ごとの文を `role="alert"` で出す |
| 「Googleでサインイン」 | 今のボタンのまま（`loginWithGoogle({ next })`） |
| `EmailCodeStartForm`（送る） | `EmailCodeStartRequestSchema` で形を確かめる（誤りは送らず文を出す）→ サイトキーがあってトークンが無ければ「ボット検証を完了してください」→ `POST /api/auth/email-code/start { email, turnstileToken, next }`（本文は必ず読む）。202 は `/login/code` へ `router.replace`（移動が終わるまで止めたまま）、400 は本文の文、403 `Bot detection failed` は「ボット検証を完了してください」、429 は「試行が集中しています。しばらくしてからやり直してください。」、それ以外と通信の失敗は「確認コードを送れませんでした。時間をおいてやり直してください。」。どの道でもボット検証を引き直す |
| 共通 | 状態の変化は `LiveMessage`。送信中は `aria-busy` と `disabled`。応答の本文は読むか捨てる |

テスト観点: 3つの入口と OR の並び、未対応のブラウザでボタンが出ず一文が出る、パスキー押下から各 `reason` の文言と `Retry-After`、成功で post-login の行き先へ移り勧めの画面へ行かない、`mode: 'browser'` でトークンが無ければ GoTrue を呼ばない・あれば呼んで引き直す・`server` では呼ばない、メール欄の各応答の文言と二重送信の防止、`?next`・`?email`・`?registered=1`、保留の Cookie（新・旧）の転送と両方有効な時の順番。E2E は、3つの入口と Tab の順、パスキー押下で始めの窓口が1回、中止の文、`next` が終わりの窓口の本文に渡ること、未対応の一文、メールを送って `/login/code` へ移り Mailpit にコードが届くこと、Google のボタン、390px で横にはみ出さず、旧の画面が今のまま。

### DD-AUTH-064 パスキーを作る勧めの画面 `/login/passkey` の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-001、API-AUTH-024、API-AUTH-025 |
| 根拠 | メールのコードで入った直後が、パスキーを案内する一番自然な機会になる。勧めは post-login の前に出し（戻り先を使い切らない）、作れない端末・店員・鍵を持つ人には出さない（鍵を持つ人は確定の窓口が `offerPasskey` を偽にする）。成功の後は自動で進まず、「続ける」へフォーカスを移して読む時間を奪わない（WCAG 2.2.1。`/login/code` の自動の戻しを外したのと同じ）。1b の持ち越し T2 M12 は、仮想の認証器の往復の E2E で、本物のブラウザの応答の形が作る・ログインの両方の窓口を通ることまで確かめる（仮想の認証器は `platform` を返し `null` は出ない。`null` を落とす分岐は Task 2 の単体。`null` を送る実機は開店前に確かめる）。ボタンの大きさは、リポジトリの `Button`（md）に従う |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/passkey/passkey-offer.test.tsx`、`tests/unit/app/login/passkey-page.test.tsx`）、E2E（`e2e/FR-LOGIN-059-passkey-offer-real-browser.spec.ts`、`e2e/FR-LOGIN-058-email-code-screen.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-6-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 6。判断 12、調整役の判断: 成功の後に自動で進まない） |

処理の順番と決め:

| 単位 | 動き |
| --- | --- |
| `src/app/login/passkey/page.tsx` | 部品を描くだけ。`robots` は noindex・nofollow。ログインの判定は、ブラウザの状態を使うので描いた後に部品が行う |
| `PasskeyOffer`（開いた時） | `useLogin()` が決まるまで何も描かない。ログインしていなければ `router.replace('/login')`。`role` が `user` でなければ `resolvePostLoginPath()` の行き先へ `router.replace`。`isUserVerifyingPlatformAuthenticatorAvailable()` が偽・例外・`PublicKeyCredential` が無いなら同じく行き先へ。真なら勧めを描き、見出し（`tabIndex=-1`）へフォーカスする。判定は1回だけ |
| 「パスキーを作る」 | `registerPasskey`（DD-AUTH-060。始め → ブラウザで鍵を作る → 終わり → 端末の名前）。作る間は `disabled`・`aria-busy`・「作成しています…」で、「あとで」も止める。作る間はボタンを無効にするので、二重に押せない |
| 成功 | 「パスキーを作りました。」を `status` で知らせる（名前が付かなければ「名前は、アカウントのログイン方法から変えられます。」を続ける）。ボタンは「続ける」だけにし、フォーカスを移す。自動では進まない |
| 失敗 | `cancelled`: 「パスキーの作成を中止しました。」（作る・あとで が残る）。`already_registered`・`unsupported`: 文と「続ける」だけ。`retry`・`failed`: 「うまく作れませんでした。もう一度お試しください。」と「もう一度」（始めから）。`reauth_required`・`unauthorized`: 「もう一度ログインしてください。」と「ログインへ」（`/login`）。`rate_limited`: 「試行が集中しています。しばらくしてからやり直してください。」。`unavailable`: 「ただいまパスキーを作れません。時間をおいてお試しください。」。失敗の後、無効になったボタンからフォーカスが落ちた時だけ主のボタンへ戻す |
| 「あとで」・「続ける」 | `resolvePostLoginPath()`（DD-AUTH-060）を1回だけ呼んで `router.replace`（二重に押しても1回）。戻り先は、この呼び出しで初めて使い切る |
| 共通 | 状態の変化は `LiveMessage`。`challenge_id`・応答・トークンは画面にもログにも出さない（`registerPasskey` の中だけ） |

テスト観点: 文言と2つのボタンと見出しへの初期フォーカス、判定が終わるまで空、未ログインで `/login`、店員・使えない端末（偽・例外・未対応）で行き先へ、「あとで」の二重押しが1回、作る間の無効・`aria-busy`・二重押し、成功で自動で進まず「続ける」にフォーカス（`jest.useFakeTimers` で10秒進めても動かない）、名前が付かない時の足し文、各 `reason` の文言と先へ進む手段、失敗後のフォーカスを奪わないこと。E2E は仮想の認証器（CDP）で、新規の作成と鍵1つ、ログアウトからのパスキーのログイン（本物の `toJSON()` の `null`）、鍵を持つ人に勧めを出さないこと、本人確認ができない認証器で `register/finish` が0回、「あとで」で戻り先、未対応のブラウザで飛ばす、未ログインで `/login`・横にはみ出さないことを確かめる。

### DD-AUTH-065 アカウントの「ログイン方法」タブ（パスキーの一覧・追加・名前・削除）の処理の順番

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-012、API-AUTH-024、API-AUTH-025、API-AUTH-026、API-AUTH-027、API-AUTH-028 |
| 根拠 | パスキーを作ったお客さんが、鍵を見て、足し、名前を変え、消せるようにする。窓口は1b で作った物（一覧・登録の始めと終わり・名前の変更・削除）をそのまま使い、新しい窓口は足さない。最後の1本も消せる（設計 2-2・6-1）ので、確認の本文に「最後のパスキーです。…」を足す。知らせは自動で消さない（WCAG 2.2.1。`/login/passkey` と同じ）。アカウントの画面の変更は、タブの追加とリンクの削除の2点だけにとどめる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/passkey/account-passkeys.test.tsx`、`tests/integration/ui/auth-account-security-tab.test.tsx`）、E2E（`e2e/FR-LOGIN-060-account-passkeys.spec.ts`、`e2e/FR-ACCOUNT-046-password-change.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-17-passkey-stage2-customers/task-7-brief.md`、`docs/superpowers/plans/2026-11-17-passkey-stage2-customers.md`（Task 7。判断 1・8、オーナーの決め: 新しいタブ「ログイン方法」） |

処理の順番と決め:

| 単位 | 動き |
| --- | --- |
| `src/app/account/page.tsx`（タブ） | `AccountTab` に `security` を足す。`useLogin().userRole === 'user'` の時だけ、PC 用の縦のタブと mobile・tablet 用の上のタブの両方（同じ項目の並び）の最後に「ログイン方法」を出す。`tab=security` を `normalizeAccountTab` が受ける。店員が `tab=security` で開いたら `profile` に直して URL も替える。お客様情報の「パスワードを変更」のリンクは外す（画面 `/account/password` と窓口は変えない） |
| `AccountPasskeys`（開いた時） | `listPasskeys()` を1回呼ぶ。待つ間はスケルトン（`animate-pulse`）。成功なら一覧か空の文。失敗なら「パスキーの一覧を読み込めませんでした。」と「再読み込み」。401 もこの文（未ログインの門はアカウントの画面が先に受ける）。`isPasskeySupported()` は描いた後に1回確かめる |
| 一覧の行 | 名前（なければ「名前なし」）、「{YYYY年M月D日} に作成」、使った日があれば「最後に使った日: …」。日付は `Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' })` の部品から「年・月・日」を組む。ボタンのアクセシブルな名前は、同じ画面に複数あっても区別できるよう「{名前}の名前を変更」「{名前}を削除」（見える文字を含める） |
| 名前の変更 | その行を入力欄（ラベル「名前」）に切り替える。前後の空白を除き、空・65字以上（コードポイント）・UTF-8 で120バイト超は送らず「名前は1〜64字（日本語は40字まで）で入力してください。」（窓口の `PasskeyRenameSchema` と同じ `isPasskeyNameLengthOk` で確かめる）。送る間は「保存」を `disabled`・`aria-busy`。成功は一覧のその行だけを書き換える。失敗は「名前を変更できませんでした。もう一度お試しください。」で、入力欄は残す |
| 削除 | 既存の `ConfirmDialog`。本文は「削除すると、このパスキーではログインできなくなります。」。一覧が1本だけの時は「最後のパスキーです。削除しても、メールのコードか Google でログインできます。」を続ける。成功はその行を一覧から外す（最後なら空の文）。失敗は「削除できませんでした。もう一度お試しください。」 |
| 追加 | `registerPasskey`（DD-AUTH-060。始め → ブラウザで鍵を作る → 終わり → 端末の名前）。追加の間は「パスキーを追加」が `disabled`・`aria-busy` になるので二重に押せない。成功は `listPasskeys()` を引き直し（一覧の間はボタンが消えるので、フォーカスが落ちたら戻す）、「パスキーを追加しました。」を `status` で知らせる（自動では消さない）。失敗の文は DD-AUTH-064 と同じ。`reauth_required` は専用の文と、`buildLoginHref('/account?tab=security')`（`/login?next=%2Faccount%3Ftab%3Dsecurity`）への「メールのコードでログイン」のリンクを出す。画面にいる間の `window.location` は使わず、戻り先は固定で組む（タブを押して入った時に前の URL の検索条件を載せない） |
| 空・未対応 | 空は「パスキーはまだありません。作ると、メールのコードを待たずにログインできます。」と「パスキーを追加」。未対応のブラウザでは、一覧と名前・削除は出し、追加を無効にして「この端末ではパスキーを追加できません。」 |
| フォーカス | 追加の失敗の後、無効になったボタンからフォーカスが落ちて `document.body` にある時だけ「パスキーを追加」へ戻す（ほかへ移していたら奪わない）。確認の画面は `ConfirmDialog` が閉じた時に元の要素へ戻す |
| 共通 | 状態の変化は `LiveMessage`。`challenge_id`・応答・トークンは画面にもログにも出さない（`registerPasskey` の中だけ）。窓口の応答の本文は `passkey-client.ts` が読み切るか捨てる |

テスト観点: 見出し・説明・スケルトン、一覧の名前・作成日（日本時間で日付をまたぐ）・最後に使った日・「名前なし」、空・読み込みの失敗と再読み込み・未対応のブラウザ、名前の変更の成功・キャンセル・空と65字は送らず64字は送る・失敗、削除の確認の文（2本以上と最後の1本で違う）・キャンセル・失敗・成功で行が減る、追加の成功（一覧を引き直す・知らせが30秒進めても消えない）・各 `reason` の文・`reauth_required` のリンクの `href`・追加中の無効と二重押し・フォーカスを戻す／奪わない、アカウントの画面のタブの並びと店員の非表示と「パスワードを変更」が無いこと。E2E は仮想の認証器（CDP）で、空 → 追加 → 名前の変更 → 認証器を替えて2本目 → 削除 → 最後の削除 → 空、窓口の応答を差し替えた再ログインの文とリンク、長い名前の折り返し・幅の外へ出ないこと・ボタンが `size=md`、タブの並びと `/account/password` を直に開けること、タブを押して `tab=security` になること。

覚え書き（実測 2026-11-18）: GoTrue は名前を UTF-8 で120バイトまでしか受けない（日本語40字=120バイトは通り、42字=126バイト・「é」64字=128バイトは 400）。121〜125バイトは測っていない（安全な側に120で止める）。そこで窓口（`PasskeyRenameSchema`）と画面（`AccountPasskeys`）の両方で「1〜64字かつ120バイト以内」を確かめ、窓口は GoTrue を呼ぶ前に 400 `invalid_request` を返す。追加の時の名前は端末の名前の初期値（`iPhone`・`Windows` など最長でも数バイト）なので、この上限に当たらない。

追記（Task 7 の直し、2026-11-18）: (1) 名前の保存・キャンセルの後はその行の「名前を変更」へ、削除の成功の後は見出し「パスキー」へ、フォーカスが `body` に落ちている時だけ移す。削除の成功は「パスキーを削除しました。」を `status` で知らせる。削除に失敗したらその行の「削除」へ戻す。(2) 削除の間はその行の「削除」を `disabled`・`aria-busy` にして、同じ鍵を2回送らない。(3) 追加の `unauthorized` は「もう一度ログインしてください。」と「ログインへ」（`/login`。`/login/passkey` の勧めと同じ）を出す。
