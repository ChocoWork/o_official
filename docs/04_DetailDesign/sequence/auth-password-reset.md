# パスワード再設定シーケンス

> 状態: 現行ソース照合済み | 確認日: 2026-10-04 | 対象: メール要求、リンク確認、再設定、画面再開

## 概要

再設定要求はランダムtokenのhashを10分の期限で保存し、メール送信をafter callbackへ予約する。リンク確認はtokenを消費せず、10分の署名Cookieを作る。confirmは未使用tokenをclaimしてからパスワードを更新する。4つの開始契機を分けて描く。[記載方針](README.md)を参照する。

## 範囲と根拠

既存要件は[LOGINのページ別要求表](../pages/14_login.md)と[要求定義](../../02_Requirements/requirements.md)を参照する。

| 対象 | 実コード参照 |
| --- | --- |
| 再設定メール | [request API](../../../src/app/api/auth/password-reset/request/route.ts) L15–137 |
| リンク・画面再開 | [link API](../../../src/app/api/auth/password-reset/link/route.ts)、[session API](../../../src/app/api/auth/password-reset/session/route.ts) |
| パスワード更新 | [confirm API](../../../src/app/api/auth/password-reset/confirm/route.ts) L30–189 |
| 署名Cookie・Schema | [reset session](../../../src/features/auth/services/password-reset-session.ts)、[Schema](../../../src/features/auth/schemas/password-reset.ts)、[Cookie](../../../src/lib/cookie.ts) |
| UI | [リンク確認](../../../src/app/auth/password-reset/verify/VerifyClient.tsx)、[再設定画面](../../../src/app/auth/password-reset/page.tsx) |
| DB定義・RPC | [migration](../../../supabase/migrations/20260901102912_remote_schema.sql) L759–771、L1705–1721、L2122–2137 |

POSTは[proxy](../../../src/proxy.ts)のOrigin検査が先行する。レート制限は[共通helper](../../../src/features/auth/middleware/rateLimit.ts)の429／503とRetry-Afterを返す。

## SQ-AUTH-RESET-REQUEST: 再設定メールの要求

開始契機はメールアドレスの送信または同じ画面の再送。事前条件はemailと、設定時のTurnstile token。終了結果はアカウント有無を区別しない200、または検証・保存エラーである。

```mermaid
sequenceDiagram
  actor User as 利用者
  participant UI as 再設定画面
  participant API as request API
  participant Bot as Turnstile検証
  participant DB as Postgres / RPC
  participant Mail as sendMail
  User->>UI: 再設定メールを要求
  UI->>API: POST /api/auth/password-reset/request
  API->>DB: IP10回 / 3600秒
  API->>API: Schema検証
  API->>Bot: verifyTurnstile
  API->>DB: email5回 / 3600秒、find_auth_user_id_by_email
  DB-->>API: userId / 該当なし / error
  alt 検索エラー
    API-->>UI: 500
  else 該当なし
    API->>DB: no_account監査
    API-->>UI: 200 ok=true
  else userIdあり
    API->>DB: 同じemailの未使用tokenをused=true
    API->>API: 32byte乱数token生成・SHA256
    API->>DB: password_reset_tokens INSERT（10分）
    alt 保存失敗
      API-->>UI: 500（メールを予約しない）
    else 保存成功
      API->>API: after callbackへメール送信を予約
      API->>DB: mail_queued監査
      API-->>UI: 200 ok=true
      API->>Mail: afterでverifyページのリンクを送信
    end
  end
```

入力Schema不正400、Turnstile失敗403、JSON解析を含む外側例外500。旧tokenの失効更新エラーはログに残して新規発行へ進むため、最新の1本だけが有効という保証はその更新の成功が条件になる。送信先は`/auth/password-reset/verify?token=...`。afterのメール送信失敗は返した200を変えない。UI再送は同じrequest APIを呼び、成功後60秒待機、再送429ではRetry-After（読めなければ3600秒）で待機する。

## SQ-AUTH-RESET-LINK: リンク確認と署名Cookieの発行

開始契機はメール内verifyページを開くこと。事前条件はraw token。終了結果は署名reset Cookieと再設定フォームへの移動、またはリンクエラーである。

```mermaid
sequenceDiagram
  actor User as 利用者
  participant UI as verifyページ
  participant API as link API
  participant DB as password_reset_tokens / RPC
  User->>UI: /auth/password-reset/verify?token=...を開く
  UI->>API: POST /api/auth/password-reset/link（token）
  API->>DB: IP20回 / 600秒
  API->>API: token有無・SHA256
  API->>DB: hash一致、used=false、expires_atが現在以降をSELECT
  DB-->>API: token行 または欠落/error
  alt token不正・期限切れ・検索DBエラー
    API-->>UI: 400 link_invalid / link_expired
    UI->>UI: /auth/password-reset?error=link_expired
  else token行あり
    opt user_idなし
      API->>DB: find_auth_user_id_by_email
      DB-->>API: userId / 該当なし / error
    end
    alt user検索RPCエラー
      API-->>UI: 500 internal_error
    else userIdなし
      API-->>UI: 400 link_expired
    else userId確定
      API->>API: tokenId付き署名 sb-password-reset-session を準備
      Note over API,DB: token行を消費・更新しない
      API-->>UI: 200 ok=true + reset Cookie（10分）
      UI->>UI: /auth/password-resetへreplace
    end
  end
```

legacyの`GET /api/auth/password-reset/link`はtokenを検証せず、tokenありならverifyページへ303、無しなら`/auth/password-reset?error=link_invalid`へ303を返す。GETでもPOSTでもtokenを消費しない。user検索RPC障害は500、user無しは400、外側例外は400。UIはPOSTのHTTPエラーを一律link_expiredへ送るが、通信例外なら画面内の再試行を表示する。

reset Cookieはpurpose・userId・email・tokenId・expをHMAC SHA256で署名し、HttpOnly／SameSite=Strict、10分。POSTのリンク検証はDBのexpires_atを見る。

## SQ-AUTH-RESET-CONFIRM: パスワード更新と全セッション失効

開始契機は新passwordフォームの送信。事前条件は有効なreset Cookieと`new_password`。終了結果は更新200、または検証・claim・更新エラーである。

```mermaid
sequenceDiagram
  actor User as 利用者
  participant UI as 再設定画面
  participant API as confirm API
  participant Check as 漏洩password照合
  participant DB as Postgres / RPC
  participant Auth as Supabase Auth Admin
  participant Mail as sendMail
  User->>UI: 新passwordと確認passwordを送信
  UI->>API: POST /api/auth/password-reset/confirm（new_password）
  API->>DB: IP10回 / 3600秒
  API->>API: 署名Cookie・本文検証
  API->>DB: tokenId、used=falseの行をSELECT
  DB-->>API: 未使用行 / 欠落 / error
  alt 行欠落・検索DBエラー
    API-->>UI: 400 / 500（漏洩照合へ進まない）
  else 未使用行あり
    API->>Check: checkPwnedPassword
    Check-->>API: pwned / safe / unavailable
    alt 漏洩password
      API-->>UI: 400（tokenをclaimしない）
    else safeまたは照合利用不可
      API->>DB: used=false条件でused=trueへUPDATE / RETURNING
      DB-->>API: claim成功 / 0行 / error
      alt 0行・claim DBエラー
        API-->>UI: 400 / 500
      else claim成功
        API->>Auth: admin.updateUserById（password）
        Auth-->>API: 更新結果
        alt password更新失敗
          Note over API,DB: tokenはused=trueのまま
          API-->>UI: 500
        else 更新成功
          API->>DB: 使用済みtoken削除
          API->>DB: local sessions全行revoked_at更新
          API->>DB: revoke_auth_sessions_for_user
          Note over API,DB: 戻り値errorはログを残して継続
          API->>API: reset / access / refresh / CSRF Cookieを消去準備
          API->>API: afterへ変更通知メールを予約・監査
          API-->>UI: 200 ok=true + Cookie消去
          UI->>UI: resetComplete表示
          API->>Mail: afterでpassword変更通知
        end
      end
    end
  end
```

| 分岐・境界 | 現行処理 |
| --- | --- |
| Cookie・未使用行欠落／本文不正 | 400。token lookupのDBエラーは500 |
| 時間判定 | confirmは署名Cookieのexpだけを見る。token行のexpires_atは再検査しない |
| 漏洩password | 400、tokenをclaimしない。照合サービス利用不可は監査して続行 |
| 同時confirm | used=false条件のUPDATEでclaimできた要求だけが更新へ進む。0行は400 |
| claim後のpassword更新失敗 | 500。tokenのused=trueを戻す処理はない |
| password更新後のtoken削除・セッション失効エラー | SDK戻り値のerrorはログを残し200を維持する。全端末失効の成功を200だけから判断しない |
| throwされた例外 | 外側catchの500。Cookie読取り・JSON解析・SDK呼出し等の例外もここへ進む。password更新後の例外でも既に済んだ更新を戻さない |
| 通知メール送信失敗 | ログのみ。password更新結果を変えない |

`revoke_auth_sessions_for_user`はauth.sessionsを削除するRPC。Cookieの`session_id`とOTP保留Cookieは、このconfirmの消去対象に含まれない。

## SQ-AUTH-RESET-RESUME: 再設定画面の再開

開始契機は`/auth/password-reset`表示・再読込み。事前条件は不要。終了結果はrequest modeまたはconfirm modeで、ここではtoken行の未消費を確認しない。

```mermaid
sequenceDiagram
  participant UI as 再設定画面
  participant API as session API
  UI->>API: GET /api/auth/password-reset/session
  API->>API: reset Cookieの署名・exp検証
  alt Cookie有効
    API-->>UI: 200 ready=true / email
    UI->>UI: confirm mode
  else Cookieなし・無効
    API-->>UI: 200 ready=false + reset Cookie消去
    UI->>UI: request mode
  end
```

ready=trueはフォームを表示するためのCookie判定であり、confirmが成功する保証ではない。APIはDB照会を行わず、実際の未使用確認はconfirmにある。上図はCookie読取りが結果を返す経路である。署名秘密の未設定やCookie値のdecode例外には、このsession API内のcatchがないため、ready=falseの200へ変換する処理はない。

## 関連テスト

今回、以下は未実行。

| 観点 | テスト |
| --- | --- |
| hash・期限・列挙対策・link非消費・claim競合・更新失敗 | [password reset統合テスト](../../../tests/integration/api/auth/password-reset.test.ts) |
| 入力Schema | [reset Schema](../../../tests/unit/schemas/password-reset.test.ts) |
| リンク・画面導線 | [reset hardening](../../../e2e/FR-PWRESET-002-password-reset-hardening.spec.ts)、[resetリンク](../../../e2e/FR-LOGIN-003-password-reset-link.spec.ts) |

## 未確認事項

メール実到達・リンクスキャナの挙動、実Auth password更新、各RPCのmigration適用・失効結果は未確認。200の受付・更新結果と、afterメールや失効処理の成功を同一視しない。
