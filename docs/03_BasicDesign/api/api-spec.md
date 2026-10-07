# API仕様（現行実装）

> 確認日: 2026-10-03 | ソース基準: `697836a1eb2b62e1a3257ce079ecf8f536e1cb06` の作業ツリー | 対象: `src/app/api/**/route.ts`

## 概要

現行Route Handlerの入力、認証・認可、応答、主要な失敗分岐と副作用を記録する。89ファイル、明示exportされた125組のHTTPメソッド・パスを対象とする。実装と実装が呼ぶschema/helperを根拠とし、未実装の契約は追加しない。DB・Stripe・Supabase Auth・メール等の実環境での成功や設定状態を保証する文書ではない。

| 読み方 | 内容 |
| --- | --- |
| API表 | 1行が1メソッド・パス。成功HTTPとJSONの外形、入力場所、認可、主要エラーを記載 |
| 共通境界 | U（会員認証）、RBAC、C/C*（CSRF）、J（Cron）、W（Webhook）の正確な処理 |
| 入出力定義 | I/N/L/S/T/O/F/Pなどの再利用schema、応答の詳細と根拠へのリンク |
| 入口の所在 | [APIルート一覧](route-inventory.md)（所在表） |

表中の`?`は任意項目、`|`は選択肢。JSONに単一の共通envelopeはない。`{data:...}`、配列、直接object、`{success:true}`、`{ok:true}`を各実装どおりに区別する。表のエラー欄に加え、その行の共通認証・Origin・CSRFの応答が適用される。Next.jsが自動提供するHEAD/OPTIONSは125組に含めない。

## 共通境界

### Origin（Proxy）

[proxy.ts](../../../src/proxy.ts)は`/api`配下のPOST/PUT/PATCH/DELETEを検査する。接頭辞判定はセグメント境界付きで、`/api/webhook`、`/api/contact/inbound`、`/api/cron`とその子パスを除外する。GETは検査対象外。Originを優先し、ない場合はRefererのoriginを使う。両方欠落・不正・不許可は403 `{error:"Forbidden origin"}`。

[redirect.ts](../../../src/lib/redirect.ts)の明示設定判定はAPP_ALLOWED_ORIGINS / NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_BASE_URL / BASE_URL / NEXT_PUBLIC_VERCEL_URLのいずれか。設定ありの場合は、カンマ区切りAPP_ALLOWED_ORIGINSとサイトURL等をURL originに正規化した集合へ照合する。未設定の場合だけ`x-forwarded-proto`（なければrequest protocol）と`x-forwarded-host`（なければHost、request host）の組を期待originに使う。このfallbackは実装上の分岐であり、常に固定allowlistで検証しているという意味ではない。

### U・RBAC

| 記号 | 実際の認証・認可 | 失敗応答・根拠 |
| --- | --- | --- |
| U | Bearerを優先、なければ独自access CookieからJWTを取得し、署名/有効性検証とSupabase auth sessionのliveness確認。JWT subを本人idとして使う | 401 `{error:"Unauthorized"}`。liveness照会不能は503 `{error:"Service temporarily unavailable"}` + Retry-After:30。[authenticate.ts](../../../src/lib/auth/authenticate.ts)、[request-token.ts](../../../src/lib/auth/request-token.ts) |
| RBAC | JWT検証後、auth session livenessとDB ACLを並行取得。activeかつ未期限切れuser_roles→roles→role_permissions→permissionsに必要permissionがあること、およびJWT aal=aal2を全permissionで要求 | 401未認証/失効、503 liveness不明（Retry-After:30）、403 `{error:"Forbidden",permission,role}`、AAL2欠落はさらに`reason:"MFA required"`、catchは500。ACL取得エラーは空権限となり403。[admin-rbac.ts](../../../src/lib/auth/admin-rbac.ts) |
| JWT role追加条件 | 表に明記したKPI/Meta/返金等はRBAC成功後さらにJWT app_metadata.roleを確認。MFA enroll/verifyはU成功後admin/supporterを確認 | 各Handlerの403。roleだけでDB ACLの認可を代替しない。Metaは[authorizeMetaAdmin](../../../src/lib/meta/admin.ts) |
| session_id | cart/wishlist/Checkoutはゲスト用Cookie `session_id`をスコープに使う。会員認証Uとは異なる | Cookie欠落は各Handlerの400 `Session not found`。ProxyがCookieを発行する処理とHandlerが受信Cookieを読む処理は別 |

Cookie名/属性は[cookie.ts](../../../src/lib/cookie.ts)、セッション発行の副作用は[persistSessionAndCookies](../../../src/features/auth/services/register.ts)と[session service](../../../src/features/auth/services/session.ts)に従う。authenticate.tsでRequestを渡さない呼び出しは、cookies()から同じaccess Cookieを読む。認証成立には、抽出したJWTの署名・issuer・audienceとsession livenessの検証が必要になる。

### C・C*（CSRF）

[requireCsrfOrDeny](../../../src/lib/csrfMiddleware.ts)は`sb-refresh-token` Cookieがなければ検査を省略する。Cookieがあれば`x-csrf-token`が必要。headerはdecodeURIComponentを試み、refresh tokenとheader tokenをSHA-256にしてsessions.refresh_token_hash / csrf_token_hashと照合する。欠落/不一致は403 `{error:"Forbidden",reason:"CSRF validation failed"}`、DB処理の例外は500。通常mutationではCSRFをrotateしない。

- **C**: finance、review、payment exception resolveは戻り値の`Response`を返す。Stockistは[admin-security.ts](../../../src/features/stockist/services/admin-security.ts)経由で`Response`も返す。
- **C***: Checkout create-session/update-shipping、profile POST/DELETE、addresses PUTはhelperを呼ぶが、ローカル`isCsrfDenyResponse`は`status`と`_body`両方を要求する。helperの実戻り値`NextResponse`には`_body`がなく、このguardは実際の拒否Responseを拾わない。これらのHandlerがhelperの403/500を必ず伝播すると記載しない。ProxyのOrigin検査は別途適用される。
- logoutは拒否を返す用途ではなく、CSRF成功時だけサーバー失効を試行し、Cookie削除/200を返すためにhelperを使う。

### レート制限・エラー形式

表で429を記した標準レート制限呼出は、[enforceRateLimit](../../../src/features/auth/middleware/rateLimit.ts)から429 `{error:"Too many requests"}`またはカウンタ障害の503 `{error:"Rate limiter unavailable"}`を返す（いずれもRetry-After）。限度/subjectは各Handlerの呼出引数を正とする。Checkout create-sessionの429は`{error:"rate_limited",message,retryable:true}`へ変換する。LOOK upload quotaは429又は503、合計bytes制限は400。Cron expire-pending-orders内のレート制限は認証失敗の監査抑制用で、戻り値をHTTP応答に採用しない。

通常エラーは`{error:string}`、Zodの一部は`details`付き。認証の[formatZodError](../../../src/features/auth/schemas/common.ts)を使うHandlerは400 `{code:"validation_error",message,detail:[{path,message}]}`。JSON parse失敗がschema 400へ変換されるかcatch 500へ進むかはHandlerごとに異なる。業務エラーの追加項目は各行/定義に記す。

### J・W（外部呼出）

Cronは表で指定したsecretに対する`Authorization: Bearer <secret>`を要求し、欠落・不一致・secret未設定はいずれも401。法定保存2ルートは**LEGAL_ARCHIVE_CRON_SECRET**、他Cronは**CRON_SECRET**。どのルートも合言葉をSHA-256にしてから定時間比較する（[auth.ts](../../../src/lib/cron/auth.ts)）。CRON_SECRETのルートは、32文字未満の設定を設定ミスとして401にする。

Stripe Webhookはraw bytesとstripe-signatureを`constructEvent`で検証する。Resend inboundはraw text、svix-id/svix-timestamp/svix-signature、RESEND_WEBHOOK_SECRETでHMAC-SHA256を検証し、timestampの現在との差は5分以内を要求する。署名確認の後にJSONをparseする。会員JWT・管理RBAC・CSRFでこれらの署名を代替しない。

## 認証

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/auth/confirm` | 会員認証不要 | Query: `token_hash` 又は `token`; `type` signup/email/magiclink/recovery（未知値はsignup）; `redirect_to?` | 303 許可された同一サイトパス（既定 `/account`）。OTP失敗/欠落も同じリダイレクト | 429。OTP/保存/内部失敗をJSON 4xx/5xxとして返さず303 | OTP確認、取得できたセッションをCookie保存、ゲスト注文引継ぎ [実装](../../../src/app/api/auth/confirm/route.ts) |
| `POST /api/auth/login/cancel` | 会員認証不要 | 本文なし（2FA Cookieは任意） | 200 `{ok:true}` | ProxyのOrigin検査 | ログイン2FA Cookieを削除 [実装](../../../src/app/api/auth/login/cancel/route.ts) |
| `POST /api/auth/login/resend` | 署名付きログイン2FA Cookie | 本文なし。Cookieから宛先を取得 | 200 `{ok:true}` | 401 Cookie不正/期限切れ; 429; 500 送信失敗 | メールOTP再送、2FA Cookie期限を延長 [実装](../../../src/app/api/auth/login/resend/route.ts) |
| `POST /api/auth/login` | 会員認証不要 | JSON: `email,password,turnstileToken?`（LoginRequestSchema） | 200 `{step:"otp",message}` | 400 検証; 401 パスワード不一致; 403 Bot判定; 429; 500 OTP送信/例外 | メールOTP送信、署名付き短期2FA Cookie発行 [実装](../../../src/app/api/auth/login/route.ts) |
| `POST /api/auth/logout` | 未認証でも利用可。失効時は期限切れを許したJWTとCSRF確認 | 本文なし | 200 `{ok:true}` | 500 例外。CSRF拒否は通常200のCookie削除を妨げない | 独自/SSR認証Cookie削除。JWT session_idの取得とCSRF成功時のみサーバー失効 [実装](../../../src/app/api/auth/logout/route.ts) |
| `GET /api/auth/me` | 認証確認（失敗も通常200） | 本文なし、認証トークン任意 | 200 `{authenticated:false}` 又は `{authenticated:true,user:{id,email,role,mfaVerified}}` | 503 `{authenticated:false,reason:"unavailable"}` + Retry-After:30。catchは200 false | no-store / no-referrer [実装](../../../src/app/api/auth/me/route.ts) |
| `POST /api/auth/mfa/enroll-totp` | U + JWT role admin/supporter（AAL2の一律要求なし） | JSON: `{forceReEnroll?:boolean}`（本文欠落は空object） | 200 `{data:{factorId,friendlyName,qrCode,secret,uri}}` | 400 body; Uの401/503; 403 role/既存要素の再設定条件; 409 登録済み/同名factor; 429; 500 list/enroll/例外 | TOTP factor作成、未検証factor処理。登録済みverified factorがあるforce要求も403 [実装](../../../src/app/api/auth/mfa/enroll-totp/route.ts) |
| `GET /api/auth/mfa/status` | 会員認証 U | 本文なし | 200 `{data:{role,isPrivileged,currentLevel,nextLevel,hasVerifiedFactor,needsChallenge,factors}}` | Uの401/503; 500 Supabase MFA取得/例外 | 検証済みfactorのid/factorType/friendlyNameを返す [実装](../../../src/app/api/auth/mfa/status/route.ts) |
| `POST /api/auth/mfa/verify` | U + JWT role admin/supporter | JSON: `{factorId:UUID,code:6〜8桁数字文字列}` | 200 `{data:{role,currentLevel,nextLevel,verified:true}}` | 400 body/challenge/コード; Uの401/503; 403 role; 404 factor; 429; 500 例外 | challenge/verify後AAL2トークンをCookie/sessionへ反映 [実装](../../../src/app/api/auth/mfa/verify/route.ts) |
| `GET /api/auth/oauth/callback` | OAuth code + PKCE Cookie | Query: `code` 必須、`next?`（CallbackQuerySchema） | 303 検証済みnext。特権roleではMFA状態に応じた認証ページ | 400 query; 429; 500 設定/例外; 502 code交換/応答スキーマ不正 | SSRと独自Cookie/session保存、ゲスト注文引継ぎ [実装](../../../src/app/api/auth/oauth/callback/route.ts) |
| `GET /api/auth/oauth/start` | 会員認証不要 | Query: `provider=google`, `redirect_to?`（StartQuerySchema） | 302 Supabase/Google認証URL | 400 query/未対応provider; 429; 500 設定/例外; 502 OAuth開始失敗 | PKCE等SSR Cookieを設定 [実装](../../../src/app/api/auth/oauth/start/route.ts) |
| `POST /api/auth/otp/verify` | 署名付きログイン2FA Cookie | JSON: `code`（trim後8文字。数値正規表現ではない） | 200 `{user,message}` | 400 検証; 401 Cookie/OTP不正・期限切れ; 429; 500 セッション保存/例外 | セッション・認証/CSRF Cookie保存、2FA Cookie削除、確認済みメールのゲスト注文引継ぎ [実装](../../../src/app/api/auth/otp/verify/route.ts) |
| `POST /api/auth/password-reset/confirm` | 署名付きreset Cookie + DBの未使用・有効token | JSON: `{new_password}`（ResetSessionConfirmSchema） | 200 `{ok:true}` | 400 body/reset無効/漏洩PW; 429; 500 DB/パスワード更新/例外 | tokenを競合安全に消費してPW更新、既存sessions失効、認証/reset Cookie削除、通知メール [実装](../../../src/app/api/auth/password-reset/confirm/route.ts) |
| `GET /api/auth/password-reset/link` | 会員認証不要 | Query: `token?` | 303 `/auth/password-reset/verify?token=...`。欠落は `/auth/password-reset?error=link_invalid` | 欠落でも303 | token消費/検証/Cookie発行を行わない [実装](../../../src/app/api/auth/password-reset/link/route.ts) |
| `POST /api/auth/password-reset/link` | 期限内・未使用のreset token（正式ログイン不要） | JSON: `{token:string}` | 200 `{ok:true,redirectTo:"/auth/password-reset"}` | 400 link_invalid/link_expired（DB照会/catchもこの応答）; 429; 500 internal_error（ユーザー再照会失敗） | 署名付きreset session Cookie発行。tokenは未消費 [実装](../../../src/app/api/auth/password-reset/link/route.ts) |
| `POST /api/auth/password-reset/request` | 会員認証不要 | JSON: `email,turnstileToken?`（ResetRequestSchema） | 200 `{ok:true}`（アドレス登録有無で同一） | 400 検証; 403 Bot判定; 429; 500 ユーザー照会/token保存/例外 | 期限付きreset tokenのhashを保存、対象ユーザーへのメール送信をafterで実行 [実装](../../../src/app/api/auth/password-reset/request/route.ts) |
| `GET /api/auth/password-reset/session` | 署名付きreset Cookie確認（未認証も200） | 本文なし | 200 `{ready:boolean,email:string&#124;null}` | 独自の失敗HTTP分岐なし | 不正/欠落Cookieをクリア、no-store [実装](../../../src/app/api/auth/password-reset/session/route.ts) |
| `POST /api/auth/refresh` | Cookie `sb-refresh-token` とアプリsessions行 | 本文なし | 200 `{access_token,user}` | 401 refresh欠落/失効/交換失敗（失効時Cookie削除）; 429; 500 設定/例外 | Supabase refresh交換、session/CSRFとCookie更新。交換後DB保存失敗は監査し発行済トークンを返す [実装](../../../src/app/api/auth/refresh/route.ts) |
| `POST /api/auth/register` | 通常は公開。トークン指定時は `ADMIN_API_KEY` 照合 | JSON: RegisterRequestSchema（下記）。`x-admin-token` 又はAuthorizationを指定すると管理作成分岐 | 通常202 `{message:"Confirmation email sent"}`。Supabaseが即時sessionを返す場合201 `{access_token,user}`。管理分岐201 `{id,email}` | 400 検証/漏洩PW; 401 指定管理トークン不一致; 403 Bot判定; 409 管理分岐のメール重複; 429; 503 ユーザー照会不能; 500 設定/作成/保存失敗 | 通常確認メール送信（既存アドレスも202）、管理分岐はemail/password/user_metadataをadmin.createUserへ渡す [実装](../../../src/app/api/auth/register/route.ts) |

## 公開情報

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/items` | 会員認証不要 | Query: category,size,color,collection,collectionSeasons,page,pageSize,limit,priceMin,priceMax,sort（下記） | 200 `{items,page,pageSize,total,hasMore,sort,filters}` | 400 文字filter/category不正; 429; 500 例外 | 公開商品のみ。collection/color/seasonはページ取得後filter、totalは取得元値。x-response-time-ms [実装](../../../src/app/api/items/route.ts) |
| `GET /api/items/[id]` | 会員認証不要 | Path: 正の整数id | 200 商品object + `madeToOrder,variantAvailability` | 400 id; 404 非公開/欠落; 429; 500 DB/例外 | 画像署名、Cache-Control:no-store [実装](../../../src/app/api/items/%5Bid%5D/route.ts) |
| `GET /api/news` | 会員認証不要 | Query: `category?`, `limit?`（正整数を最大20へ制限、無効/欠落は12） | 200 公開News配列（getPublishedNews） | 429; 500 取得/例外 | id/title/published_date/category/image_url/contentを持つ公開記事配列、画像署名 [実装](../../../src/app/api/news/route.ts) |
| `GET /api/search` | 会員認証不要 | Query: `q?` trim/max100（既定空）、`tab?` all/item/look/news（既定all）、`preview?` 文字列trueだけtrue | 200 SearchResultsResponse | 400 query; 429; 500 検索失敗 | x-search-duration-ms。previewで件数/レート上限が変わる [実装](../../../src/app/api/search/route.ts) |
| `GET /api/suggest` | 会員認証不要 | Query: `q?` trim/max100、制御文字禁止（既定空） | 200 `{suggestions:SearchSuggestion[]}` | 400 query; 429; 500 取得失敗 |  [実装](../../../src/app/api/suggest/route.ts) |

## カート・ウィッシュリスト

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/cart` | Cookie `session_id`（会員認証不要） | 本文なし | 200 `{id,item_id,quantity,color,size,added_at,items}[]`（空は[]） | 400 session欠落; 500 cart/item取得/例外 | Cookieに属するcart、欠落商品は配列から除く、商品画像署名 [実装](../../../src/app/api/cart/route.ts) |
| `POST /api/cart` | Cookie `session_id`（会員認証不要） | JSON: `item_id` 正整数、`quantity?` 1〜20既定1、`color?,size?`（addCartItemSchema） | 201 保存したcart行object | 400 session/body; 404 非公開/欠落商品; 429; 500 cart照会/保存/例外 | 同一session/item/color/sizeの既存行は数量を更新、新規はinsert [実装](../../../src/app/api/cart/route.ts) |
| `PATCH /api/cart/[id]` | Cookie `session_id`（会員認証不要） | Path: cart UUID（RPC側判定）。JSON: `{quantity:1〜20整数}` | 200 更新cart行 | 400 session/id/body; 403 RPC権限; 404 cart/item; 409 RPC在庫競合; 429; 500 RPC/例外 | update_cart_item_quantity RPC。RPCエラーをmapCartMutationErrorで変換 [実装](../../../src/app/api/cart/%5Bid%5D/route.ts) |
| `DELETE /api/cart/[id]` | Cookie `session_id`（会員認証不要） | Path: cart UUID（RPC側判定）、本文なし | 200 `{success:true}` | 400 session/id; 403 RPC権限; 404 cart; 429; 500 RPC/例外 | delete_cart_item RPC（sessionによる所有確認） [実装](../../../src/app/api/cart/%5Bid%5D/route.ts) |
| `GET /api/wishlist` | Cookie `session_id`（会員認証不要） | 本文なし | 200 `{id,item_id,added_at,items}[]`（空は[]） | 400 session; 429; 500 wishlist/item取得/例外 | 非公開/欠落商品を除く、画像署名 [実装](../../../src/app/api/wishlist/route.ts) |
| `POST /api/wishlist` | Cookie `session_id`（会員認証不要） | JSON: `{item_id:正整数}` | 201 保存したwishlist行object | 400 session/body; 404 非公開/欠落商品; 409 重複; 429; 500 保存/例外 | Cookieのsessionへ追加 [実装](../../../src/app/api/wishlist/route.ts) |
| `DELETE /api/wishlist/[id]` | Cookie `session_id`（会員認証不要） | Path: UUID id、本文なし | 200 `{success:true}` | 400 session/id; 404 所有session内の行なし; 429; 500 削除/例外 | id + session_idで削除 [実装](../../../src/app/api/wishlist/%5Bid%5D/route.ts) |

## 会員プロフィール・注文

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/orders` | 会員認証 U | 本文なし | 200 `{data:注文一覧[]}`（下記） | Uの401/503; 500 orders取得 | JWT subがuser_idの注文。hidden status除外、金額/日付整形、画像署名、no-store [実装](../../../src/app/api/orders/route.ts) |
| `GET /api/orders/[id]` | 会員認証 U | Path: 注文id（独自UUID検証なし） | 200 注文詳細object（下記） | Uの401/503; 404 所有注文なし; 500 取得 | id + JWT subで取得、hidden status除外、no-store [実装](../../../src/app/api/orders/%5Bid%5D/route.ts) |
| `GET /api/profile/addresses` | 会員認証 U | 本文なし | 200 `{addresses:住所[]}` | Uの401/503; 500 DB | 旧addressだけ存在する場合も住所配列へ正規化 [実装](../../../src/app/api/profile/addresses/route.ts) |
| `PUT /api/profile/addresses` | 会員認証 U + CSRF呼出 C* | JSON: `{addresses:addressItemSchema[]}` 最大20（下記） | 200 `{success:true,addresses}` | Uの401/503; 400 payload; 500 DB。C*の制限参照 | 全住所を置換しdefaultを1件へ正規化、旧addressへmirror。旧schemaではaddressのみ保存 [実装](../../../src/app/api/profile/addresses/route.ts) |
| `GET /api/profile` | 会員認証 U | 本文なし | 200 `{email,fullName,kanaName,phone,address}` | Uの401/503; 500 DB | optionalカラム欠落時は旧カラムへfallback [実装](../../../src/app/api/profile/route.ts) |
| `POST /api/profile` | 会員認証 U + CSRF呼出 C* | JSON: profilePayloadSchema（下記） | 200 `{success:true,email,fullName,kanaName,phone,address}` | Uの401/503; 400 payload; 500 DB。C*の制限参照 | 氏名/電話をupsert。返すaddressは保存済みdefault address [実装](../../../src/app/api/profile/route.ts) |
| `DELETE /api/profile` | 会員認証 U + CSRF呼出 C* | 本文なし | 200 `{success:true}` | Uの401/503; 500 DB。C*の制限参照 | プロフィール欄をnullへ更新（認証ユーザーの削除ではない） [実装](../../../src/app/api/profile/route.ts) |

## Checkout

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/checkout/complete` | Cookie `session_id`（会員認証不要）（JWTは任意、ユーザー紐付けに使用） | JSON: `{checkoutSessionId,shipping?,paymentMethod?}`（completeCheckoutSchema） | 200 `{orderId,status,paymentMethod}` | 400 session/body/mode/draft/ゼロ額/未決済; 403 Stripe session/draftの所有不一致; 409 注文登録不可; 429; 503 照合一時失敗; 500 例外 | Stripe側payment methodを採用。注文/在庫/決済照合、必要な通知/例外記録をreconciler経由で実行 [実装](../../../src/app/api/checkout/complete/route.ts) |
| `POST /api/checkout/create-session` | Cookie `session_id`（会員認証不要） + CSRF呼出 C* | JSON: createSessionSchema（下記） | 200 hosted `{url}` / custom `{clientSecret,checkoutSessionId,shippingRevision}` | 400 session/body/空cart/総額; 409 購入不可商品/表示金額不一致/確定済session; 422 Stripe金額制約; 429; 503 Stripe一時障害; 500 DB/設定等。C*参照 | cartからサーバー金額を算出、draft作成/再利用、Stripe Session作成/回復。エラー分類はcheckout-error.service [実装](../../../src/app/api/checkout/create-session/route.ts) |
| `POST /api/checkout/payment-intent` | 会員認証不要 | 本文は使用しない | 通常応答410 `{error,documentation:"/api/checkout/create-session"}` | 429。成功2xx分岐なし | 廃止済みの入口 [実装](../../../src/app/api/checkout/payment-intent/route.ts) |
| `GET /api/checkout/postal-code` | 会員認証不要 | Query: `postalCode` 1〜16文字 | 200 `{address:{prefecture,city,address}&#124;null}` | 400 query; 429; 502 lookup失敗 | 郵便番号サービスで住所検索 [実装](../../../src/app/api/checkout/postal-code/route.ts) |
| `POST /api/checkout/update-shipping` | Cookie `session_id`（会員認証不要） + CSRF呼出 C* | JSON: `{checkoutSessionId,shipping?,expectedRevision?}`（下記） | 200 `{ok:true,revision}` | 400 session/body; 404 draft; 409 `{error:"stale_shipping_revision",revision}`; 428 shipping_revision_required; 429; 500 DB/例外。C*参照 | session所有draftのshippingをrevision一致時だけ更新 [実装](../../../src/app/api/checkout/update-shipping/route.ts) |

## 問い合わせ

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/contact/inbound` | Resend Svix署名 W | raw JSON text + svix-id/timestamp/signature。data.to、headers.to/To、from、text、email_id/idを使用 | 200 `{success:true}` / `{ignored:true}` / `{duplicate:true}` | 400 署名header欠落; 401 署名/時刻不正; 503 secret未設定; 500 JSON/保存/例外 | 返信address tokenと送信元メールを照合しmessage保存、provider idで冪等化、thread pending [実装](../../../src/app/api/contact/inbound/route.ts) |
| `POST /api/contact` | 会員認証不要（認証可能ならuser紐付け） | JSON: contactSchema（下記） | 200 `{success:true}` | 400 `{success:false,error,details}`; 403 websiteハニーポット; 429; 500 保存/例外 | 問い合わせと初回messageを保存、注文番号照会、メール送信。認証不成立でも公開問い合わせを受ける [実装](../../../src/app/api/contact/route.ts) |
| `GET /api/contact/threads` | 会員認証 U | 本文なし | 200 `{data:問い合わせ一覧[]}` | Uの401/503; 500 例外 | JWT subのuser_id又はJWT email一致でthread照会、no-store [実装](../../../src/app/api/contact/threads/route.ts) |
| `POST /api/contact/threads/[id]/reply` | 会員認証 U | Path: thread id。JSON: `{body:trim後1〜5000文字}` | 201 `{success:true}` | Uの401/503; 400 body; 404 所有threadなし; 429; 500 保存/例外 | user/web message保存、threadをpendingへ更新、no-store [実装](../../../src/app/api/contact/threads/%5Bid%5D/reply/route.ts) |
| `GET /api/contact/threads/[id]` | 会員認証 U | Path: thread id（独自UUID検証なし） | 200 `{data:{...問い合わせ,messages:[]}}` | Uの401/503; 404 所有threadなし; 500 messages取得/例外 | 返信token等内部欄を除外、no-store [実装](../../../src/app/api/contact/threads/%5Bid%5D/route.ts) |

## 管理:ユーザー・監査

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/audit-logs` | RBAC `admin.audit.read` | 本文なし | 200 `{data:監査行[]&#124;null}` | 500 DB/例外 | 新しい順100件、id/created_at/action/actor_id/actor_email/resource/resource_id/outcome/detail [実装](../../../src/app/api/admin/audit-logs/route.ts) |
| `POST /api/admin/create-user` | RBAC `admin.users.manage` | JSON: email、password（8文字以上）、display_name?（bodySchema） | 201 `{id,email}` | 400 body; 409 メール重複; 500 作成/例外 | 確認済みAuthユーザーを作成 [実装](../../../src/app/api/admin/create-user/route.ts) |
| `POST /api/admin/revoke-user-sessions` | RBAC `admin.users.manage` | JSON: `{user_id:1文字以上}`（UUID制約なし） | 200 `{ok:true}` | 400 body; 500 revoke/例外 | sessionsを失効（revoke_sessions_for_user RPC等） [実装](../../../src/app/api/admin/revoke-user-sessions/route.ts) |
| `POST /api/admin/users/mfa/reset` | RBAC `admin.users.manage` | JSON: `{userId:UUID,reason:trim後10〜500文字,confirm:"RESET_MFA"}` | 200 `{success:true,deletedFactorCount,message}` | 400 body/自身/非特権対象; 404 user; 500 factor取得/削除/例外 | 特権対象のMFA factorsを削除しsessions失効 [実装](../../../src/app/api/admin/users/mfa/reset/route.ts) |
| `GET /api/admin/users` | RBAC `admin.users.read` | 本文なし | 200 `{data:[{id,name,email,role,roleValue,lastLogin,status}]}` | 500 Auth/ACL/profile取得/例外 | Authユーザーをページ走査、ACLのroleを表示へ反映 [実装](../../../src/app/api/admin/users/route.ts) |
| `PATCH /api/admin/users` | RBAC `admin.users.manage` | JSON: `{userId:UUID,role:"admin"&#124;"supporter"&#124;"user"}` | 200 `{success:true}` | 400 body; 404 user; 500 metadata/ACL更新/例外 | Auth metadataとDB ACLを更新、sessions失効 [実装](../../../src/app/api/admin/users/route.ts) |

## 管理:商品・LOOK・NEWS・STOCKIST

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/item-color-presets` | RBAC `admin.items.read` | 本文なし | 200 `{data:color preset[]}` | 500 DB/例外 |  [実装](../../../src/app/api/admin/item-color-presets/route.ts) |
| `POST /api/admin/item-color-presets` | RBAC `admin.items.manage` | JSON: `{name:trim後1〜40文字,hex:#に6桁hex}` | 新規201 `{data}`、同名同色の既存200 `{data:existing}` | 400 body; 500 DB/例外 | 既存preset再利用又はinsert [実装](../../../src/app/api/admin/item-color-presets/route.ts) |
| `DELETE /api/admin/item-color-presets/[id]` | RBAC `admin.items.manage` | Path: id（独自の数値schemaなし）、本文なし | 200 `{success:true}` | 500 DB/例外 | 指定preset削除（不存在の404分岐なし） [実装](../../../src/app/api/admin/item-color-presets/%5Bid%5D/route.ts) |
| `POST /api/admin/items` | RBAC `admin.items.manage` | multipart I（createItemSchema） | 201 `{success:true,id}` | 400 検証/画像; 500 upload/DB/例外 | 画像uploadと商品保存 [実装](../../../src/app/api/admin/items/route.ts) |
| `GET /api/admin/items` | RBAC `admin.items.read` | 本文なし | 200 `{data:署名付き商品行[]}` | 500 DB/例外 | 削除可否の取得成功時は各行にcanDelete/deleteBlockedReasonsを付加（取得失敗時は省略） [実装](../../../src/app/api/admin/items/route.ts) |
| `GET /api/admin/items/[id]` | RBAC `admin.items.read` | Path: id（専用の入力schemaなし） | 200 `{data:署名付き商品行}` | 404 対象なし; 500 例外 |  [実装](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| `PUT /api/admin/items/[id]` | RBAC `admin.items.manage` | Path: id。multipart I（updateItemSchema、imagesは任意） | 200 `{success:true}` | 400 body/画像; 500 upload/DB/例外 | 商品/画像を更新。privateへの変更時はopen Checkout expiryを試行 [実装](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| `PATCH /api/admin/items/[id]` | RBAC `admin.items.manage` | Path: id。JSON: `{status:"private"&#124;"published"}`（patchStatusSchema） | 200 `{success:true}` | 400 body; 500 DB/例外 | 公開状態更新。privateへの変更時はopen Checkout expiryを試行 [実装](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| `DELETE /api/admin/items/[id]` | RBAC `admin.items.manage` | Path: 正の整数id、本文なし | 200 `{success:true}` | 400 id; 409 注文/進行中checkout等の削除blocker; 500 DB/例外 | 参照blockerを確認して削除、成功後open Checkout expiryを試行 [実装](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| `GET /api/admin/items/[id]/variants` | RBAC `admin.items.read` | Path: 正の整数item id | 200 `{variants:[{id,colorName,colorHex,sizeLabel,sku,stockQuantity,isActive,backorderQuantity}],movements}` | 400 id; 500 sync/照会/例外 | sync_item_variants_from_itemを先に実行（GETにもDB更新あり） [実装](../../../src/app/api/admin/items/%5Bid%5D/variants/route.ts) |
| `POST /api/admin/items/[id]/variants` | RBAC `admin.items.manage` | Path: 正の整数item id。JSON: `{variantId:正整数,delta:0以外整数,reason:ADMIN_STOCK_REASONS,note?:最大200文字}` | 201 `{success:true}` | 400 id/body; 404 variant; 409 引出在庫不足; 500 記録/例外 | 在庫移動RPCで台帳/数量更新、監査 [実装](../../../src/app/api/admin/items/%5Bid%5D/variants/route.ts) |
| `POST /api/admin/looks` | RBAC `admin.looks.manage` | multipart L（createLookSchema） | 201 `{success:true,id}` | 400 検証/画像/参照商品不存在; 500 upload/DB/例外; 429 | LOOK画像・本体・商品関連を保存、監査/アップロードquota [実装](../../../src/app/api/admin/looks/route.ts) |
| `GET /api/admin/looks` | RBAC `admin.looks.read` | 本文なし | 200 `{data:署名付きLOOK行[]}` | 500 DB/例外 |  [実装](../../../src/app/api/admin/looks/route.ts) |
| `GET /api/admin/looks/[id]` | RBAC `admin.looks.read` | Path: id（専用の入力schemaなし） | 200 `{data:署名付きLOOK行 + linkedItemIds}` | 404 対象なし; 500 関連取得/例外 |  [実装](../../../src/app/api/admin/looks/%5Bid%5D/route.ts) |
| `PUT /api/admin/looks/[id]` | RBAC `admin.looks.manage` | Path: id。multipart L（updateLookSchema、新規imagesは任意） | 200 `{success:true}` | 400 body/画像/参照商品不存在; 404 LOOK; 500 upload/DB/例外; 429 | 新規imagesがある場合画像を置換（ない場合既存維持）、商品関連を入れ替え [実装](../../../src/app/api/admin/looks/%5Bid%5D/route.ts) |
| `PATCH /api/admin/looks/[id]` | RBAC `admin.looks.manage` | Path: id。JSON: `{status:"private"&#124;"published"}`（patchStatusSchema） | 200 `{success:true}` | 400 body; 404 LOOK; 500 DB/例外; 429 | 公開状態を更新 [実装](../../../src/app/api/admin/looks/%5Bid%5D/route.ts) |
| `DELETE /api/admin/looks/[id]` | RBAC `admin.looks.manage` | Path: id、本文なし | 200 `{success:true}` | 404 LOOK; 500 DB/例外; 429 | LOOK/商品関連/画像を削除 [実装](../../../src/app/api/admin/looks/%5Bid%5D/route.ts) |
| `POST /api/admin/news` | RBAC `admin.news.manage` | multipart N（createNewsSchema） | 201 `{success:true,id}` | 400 検証/画像; 500 upload/DB/例外 | 画像upload、News保存、監査 [実装](../../../src/app/api/admin/news/route.ts) |
| `GET /api/admin/news` | RBAC `admin.news.read` | 本文なし | 200 `{data:署名付きNews行[]}` | 500 DB/例外 |  [実装](../../../src/app/api/admin/news/route.ts) |
| `GET /api/admin/news/[id]` | RBAC `admin.news.read` | Path: id（専用の入力schemaなし） | 200 `{data:署名付きNews行}` | 404 対象なし; 500 例外 |  [実装](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| `PUT /api/admin/news/[id]` | RBAC `admin.news.manage` | Path: id。multipart N（updateNewsSchema、imageは任意） | 200 `{success:true}` | 400 body/画像; 500 upload/DB/例外 | 対象を更新 [実装](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| `PATCH /api/admin/news/[id]` | RBAC `admin.news.manage` | Path: id。JSON: `{status:"private"&#124;"published"}`（patchStatusSchema） | 200 `{success:true}` | 400 body; 500 DB/例外 | 公開状態を更新 [実装](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| `DELETE /api/admin/news/[id]` | RBAC `admin.news.manage` | Path: id、本文なし | 200 `{success:true}` | 500 DB/例外 | Newsと画像を削除 [実装](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| `GET /api/admin/stockists` | RBAC `admin.stockists.read` | 本文なし | 200 `{data:Stockist行[]}` | 500 DB/例外; 429 |  [実装](../../../src/app/api/admin/stockists/route.ts) |
| `POST /api/admin/stockists` | RBAC `admin.stockists.manage` + CSRF C | JSON S（createStockistSchema） | 201 `{success:true,id}` | 400 検証; 500 DB/例外; 429 | DB保存、監査 [実装](../../../src/app/api/admin/stockists/route.ts) |
| `GET /api/admin/stockists/[id]` | RBAC `admin.stockists.read` | Path: 正の整数id | 200 `{data:Stockist行}` | 400 id; 404 対象なし; 500 例外; 429 |  [実装](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| `PUT /api/admin/stockists/[id]` | RBAC `admin.stockists.manage` + CSRF C | Path: id。JSON S（updateStockistSchema） | 200 `{success:true}` | 400 id/body; 500 DB/例外; 429 | 対象を更新 [実装](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| `PATCH /api/admin/stockists/[id]` | RBAC `admin.stockists.manage` + CSRF C | Path: id。JSON: `{status:"private"&#124;"published"}`（patchStatusSchema） | 200 `{success:true}` | 400 id/body; 500 DB/例外; 429 | 公開状態を更新 [実装](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| `DELETE /api/admin/stockists/[id]` | RBAC `admin.stockists.manage` + CSRF C | Path: 正の整数id、本文なし | 200 `{success:true}` | 400 id; 500 DB/例外; 429 | 対象を削除 [実装](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |

## 管理:問い合わせ

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/contact` | RBAC `admin.contact.read` | Query: page既定1/min1、pageSize既定20/1〜100、status?、type?、q?（最大100へsanitize） | 200 `{data,page,pageSize,totalPages,totalCount}` | 500 DB/例外 | 未知status/typeはfilterを適用しない [実装](../../../src/app/api/admin/contact/route.ts) |
| `GET /api/admin/contact/templates` | RBAC `admin.contact.read` | 本文なし | 200 `{data:template[]}` | 500 DB/例外 |  [実装](../../../src/app/api/admin/contact/templates/route.ts) |
| `POST /api/admin/contact/templates` | RBAC `admin.contact.manage` | JSON T（createTemplateSchema） | 201 `{success:true,id}` | 400 body; 500 DB/例外 | 返信template保存 [実装](../../../src/app/api/admin/contact/templates/route.ts) |
| `PUT /api/admin/contact/templates/[id]` | RBAC `admin.contact.manage` | Path: id。JSON T（updateTemplateSchema） | 200 `{success:true}` | 400 body; 500 DB/例外 | 返信template更新（不存在404分岐なし） [実装](../../../src/app/api/admin/contact/templates/%5Bid%5D/route.ts) |
| `DELETE /api/admin/contact/templates/[id]` | RBAC `admin.contact.manage` | Path: id、本文なし | 200 `{success:true}` | 500 DB/例外 | 返信template削除（不存在404分岐なし） [実装](../../../src/app/api/admin/contact/templates/%5Bid%5D/route.ts) |
| `POST /api/admin/contact/[id]/reply` | RBAC `admin.contact.manage` | Path: inquiry id。JSON: `{body:trim後1〜5000文字}` | 201 `{success:true,mailSent:boolean}` | 400 body; 404 inquiry; 500 message保存/例外 | admin replyを保存、メール送信。メール送信失敗だけでは201を変えない [実装](../../../src/app/api/admin/contact/%5Bid%5D/reply/route.ts) |
| `GET /api/admin/contact/[id]` | RBAC `admin.contact.read` | Path: inquiry id | 200 `{data:{...inquiry,orderNumber,messages}}` | 404 inquiry; 500 messages取得/例外 |  [実装](../../../src/app/api/admin/contact/%5Bid%5D/route.ts) |
| `PATCH /api/admin/contact/[id]` | RBAC `admin.contact.manage` | Path: inquiry id。JSON: `{status:"open"&#124;"pending"&#124;"answered"&#124;"closed"}` | 200 `{success:true}` | 400 body; 500 DB/例外 | thread statusを更新（不存在404分岐なし） [実装](../../../src/app/api/admin/contact/%5Bid%5D/route.ts) |

## 管理:注文・要対応

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/order-attention` | RBAC `admin.orders.read` | 本文なし | 200 `{data:OrderAttention}`（reviews、exceptions） | 500 DB/例外 | 未確認注文と未解決payment exceptions [実装](../../../src/app/api/admin/order-attention/route.ts) |
| `GET /api/admin/orders` | RBAC `admin.orders.read` | Query O（querySchema。下記） | 200 `{data:管理注文[],pagination:{page,pageSize,total,totalPages}}` | 400 query; 500 DB/例外 | Stripe状態/返金残額/操作可否/レビュー要否を付加 [実装](../../../src/app/api/admin/orders/route.ts) |
| `POST /api/admin/orders/[id]/refund` | RBAC `admin.orders.manage` + JWT role admin | Path UUID。JSON: `{amount?:正整数,reason?:requested_by_customer&#124;duplicate&#124;fraudulent}`（既定requested_by_customer） | 200 `{success:true,refundId,refundAmount,currency,refundStatus,orderStatus}` | 400 id/body/非Stripe/金額超過; 403 role; 404 order; 409 未完了状態; Stripe例外400/409又は502; 500 DB/例外 | Stripe Refund作成、orders返金同期 [実装](../../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) |
| `POST /api/admin/orders/[id]/review` | RBAC `admin.orders.manage` + CSRF C | Path UUID、本文なし | 200 `{success:true}` | 400 id; 409 未確認reasonなし/競合; 500 DB/例外 | reviewed_at/byを更新 [実装](../../../src/app/api/admin/orders/%5Bid%5D/review/route.ts) |
| `GET /api/admin/orders/[id]/status` | RBAC `admin.orders.read` | Path: id（このGETにはUUID検証なし） | 200 `{endpoint,method:"POST",description,requiredBody:{status:"cancelled",reason:CANCEL_REASONS}}` | RBACの失敗応答のみ | 操作方法を返す。注文状態照会ではない [実装](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `POST /api/admin/orders/[id]/status` | RBAC `admin.orders.manage` | Path UUID。JSON O-status（cancelled又はshipped。下記） | 200 `{success:true,status:"cancelled"&#124;"shipped"}` | 400 id/body/other理由のmemo欠落; 404 order; 409 発送/取消条件・Stripe支払い競合; 503 Stripe照会一時失敗; 500 DB/取消/例外 | 発送RPC・追跡情報/メール、又は未入金取消/Checkout expiry/例外照合。入金済みはこの操作で返金しない [実装](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) |
| `POST /api/admin/payment-exceptions/[id]/resolve` | RBAC `admin.orders.manage` + CSRF C | Path UUID。JSON: `note?,cancelOrder?=false,cancelReason?,notifyCustomer?=true`（resolveSchema） | 200 `{success:true,orderCancelled:boolean}` | 400 id/body/取消理由memo欠落; 409 支払/期限/注文状態/解決競合; 503 Stripe照会不能; 500 DB/取消/例外 | 要対応を解決、cancelOrder時は未入金確認/取消/必要なメール [実装](../../../src/app/api/admin/payment-exceptions/%5Bid%5D/resolve/route.ts) |

## 管理:KPI・Meta

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/kpi/meta/callback` | RBAC `admin.orders.read` + JWT role admin | Query: `state,code` + meta_oauth_state Cookie | 307 `/admin?meta=connected` 又は `meta=error&meta_reason=state&#124;config&#124;oauth` | 403 role; state/config/OAuth失敗はリダイレクト | Meta token暗号化保存、state Cookie削除 [実装](../../../src/app/api/admin/kpi/meta/callback/route.ts) |
| `GET /api/admin/kpi/meta/connect` | RBAC `admin.orders.read` + JWT role admin | 本文なし | 307 Facebook OAuth URL | 403 role; 503 Meta設定不足 | meta_oauth_state Cookie（600秒、callback path）発行 [実装](../../../src/app/api/admin/kpi/meta/connect/route.ts) |
| `GET /api/admin/kpi/meta` | RBAC `admin.orders.read` + JWT role admin | 本文なし | 200 `{data:{configured,missing,connected,connection}}` | 403 role; 500 接続状態取得 | tokenを除く接続状態 [実装](../../../src/app/api/admin/kpi/meta/route.ts) |
| `DELETE /api/admin/kpi/meta` | RBAC `admin.orders.read` + JWT role admin | 本文なし | 200 `{data:{connected:false}}` | 403 role; 500 解除 | 接続をinactiveに更新 [実装](../../../src/app/api/admin/kpi/meta/route.ts) |
| `POST /api/admin/kpi/meta/sync` | RBAC `admin.orders.read` + JWT role admin | JSON: `{season:YYYYSS&#124;YYYYAW}` | 200 `{data:{status:"success"&#124;"partial",metricsWritten,message}}` | 403 role; 400 season; 409 active接続なし; 500 履歴作成; 502 同期失敗 | KPI記録とsync履歴を保存 [実装](../../../src/app/api/admin/kpi/meta/sync/route.ts) |
| `GET /api/admin/kpi/migration-status` | RBAC `admin.orders.read` + JWT role admin | 本文なし | 200 `{exists,message,code?}` 又は `{exists,message,data}` | 403 role; 500 例外 | admin_kpi_targets存在チェック。照会エラーの一部分岐も200 exists:false [実装](../../../src/app/api/admin/kpi/migration-status/route.ts) |
| `GET /api/admin/kpi/monthly-record` | RBAC `admin.orders.read` + JWT role admin | Query: `season?`（欠落/無効は現在season） | 200 `{data:{season,monthKeys,values}}` | 403 role。table欠落/例外は200 values:{} | seasonの月次記録 [実装](../../../src/app/api/admin/kpi/monthly-record/route.ts) |
| `PUT /api/admin/kpi/monthly-record` | RBAC `admin.orders.read` + JWT role admin | JSON: `{season:YYYYSS&#124;YYYYAW,updates:[{monthKey:YYYY-MM,metricKey:空でない文字列,value:有限number&#124;""}]}` | 200 `{data:{season,monthKeys,values}}` | 400 JSON/schema; 403 role; 503 table欠落; 500 更新失敗 | 当seasonの月と有効storage keyを対象にupsert、空文字はdelete [実装](../../../src/app/api/admin/kpi/monthly-record/route.ts) |
| `GET /api/admin/kpi` | RBAC `admin.orders.read` + JWT role admin | 本文なし（対象年は現在JST年） | 200 `{data:{targetYear,monthlyYearOptions,monthlyKpiByYear,seasonalKpi,returnRateNote,inventoryConsumptionRateNote}}` | 403 role; 500 DB/例外 | orders/order_items/items集計。返品率はキャンセル率代替等、応答noteに計算制限を含む [実装](../../../src/app/api/admin/kpi/route.ts) |
| `GET /api/admin/kpi/targets` | RBAC `admin.orders.read` + JWT role admin | 本文なし | 200 `{data:{currentSeason,seasons,definitions,values}}` | 403 role。DB欠落/読込例外は200 default値 | KPI definitionsとseasonごとの目標値 [実装](../../../src/app/api/admin/kpi/targets/route.ts) |
| `PUT /api/admin/kpi/targets` | RBAC `admin.orders.read` + JWT role admin | JSON: `{updates:[{season:YYYYSS&#124;YYYYAW,kpiKey:空でない文字列,value:string}]}` | 200 `{data:{currentSeason,seasons,definitions,values}}` | 400 JSON/schema; 403 role; 503 table欠落; 500 更新失敗 | 未知kpiKeyは無視。有効keyの空/空白valueはdelete、その他trimしてupsert。空配列可 [実装](../../../src/app/api/admin/kpi/targets/route.ts) |

## 管理:会計・法定保存

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/admin/accounting/product-costs` | RBAC `admin.finance.read` | Query: `season` YYYYSS&#124;YYYYAW | 200 `{data:{seasonKey,...calculateProductCosting結果}}` | 400 season; 500 取得 | 商品/支出/配賦から商品原価計算 [実装](../../../src/app/api/admin/accounting/product-costs/route.ts) |
| `POST /api/admin/accounting/product-costs` | RBAC `admin.finance.manage` + CSRF C | JSON: mutationSchema P（item.create/update,allocation.replace/clear、下記） | 200 `{success:true,resourceId}` | 400 body; 404 item; 409 配賦不一致; 500 保存 | 商品原価用item又は支出配賦を保存 [実装](../../../src/app/api/admin/accounting/product-costs/route.ts) |
| `POST /api/admin/accounting/stripe-backfill` | RBAC `admin.finance.manage` + CSRF C | JSON: `{limit:1〜100整数,cursor?:trim後1〜64文字}` | 200 `{data:{processed,synced,failed,nextCursor,errors}}` | 400 body; 500 全体失敗 | payment_intent_idのある注文をページ処理、個別失敗をerrorsへ、会計同期 [実装](../../../src/app/api/admin/accounting/stripe-backfill/route.ts) |
| `POST /api/admin/accounting/stripe-payouts/[id]/confirm` | RBAC `admin.finance.manage` + CSRF C | Path: payout id（独自format検証なし）。JSON: `{bankArrivalDate:YYYY-MM-DD}` | 200 `{data:{payoutId,bankArrivalDate,bankConfirmedAt,bankConfirmedBy}}` | 400 date; 404 payout; 409 別日確認済/未送金/未照合/競合; 500 保存 | paidかつ照合済Payoutの着金確認。同日確認の再送は200 [実装](../../../src/app/api/admin/accounting/stripe-payouts/%5Bid%5D/confirm/route.ts) |
| `GET /api/admin/kpi/cost-profit/receipt` | RBAC `admin.finance.read` | Query: `path` trim後1〜500文字 | 200 `{data:{url,fileName,expiresIn}}` | 400 path; 404 metadata; 500 署名取得/例外 | 登録済み証憑だけ署名URL発行（TTLは300秒） [実装](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |
| `POST /api/admin/kpi/cost-profit/receipt` | RBAC `admin.finance.manage` + CSRF C | multipart: `entryId` 正整数、`file`（PDF/JPEG/PNG/WebP/HEIC、20MiB以下） | 200 `{data:{id,storagePath,fileName,mimeType,fileSize}}` | 400 file/id/type/size; 404 entry; 500 upload/metadata | Storageとmetadata保存、metadata失敗時file cleanup [実装](../../../src/app/api/admin/kpi/cost-profit/receipt/route.ts) |
| `GET /api/admin/kpi/cost-profit` | RBAC `admin.finance.read` | Query: `year` 2000〜2999、`season?` YYYYSS&#124;YYYYAW | 200 `{data:会計データ F}`（下記） | 400 year/season; 500 DB/例外。会計table欠落分岐は200空data | ordersから売上incomeを合成、過年度累計/Stripe accountingも返す [実装](../../../src/app/api/admin/kpi/cost-profit/route.ts) |
| `POST /api/admin/kpi/cost-profit` | RBAC `admin.finance.manage` + CSRF C | JSON: operation別 mutationSchema F（下記、全22operation） | 200 `{success:true,resourceId}` | 400 body/業務入力; 404 取引/証憑/template/摘要/資産/決算; 409 配賦/資産連携/template重複/使用中摘要; 503 会計table欠落; 500 保存 | 会計CRUD/決算/証憑理由等を操作別に保存し監査 [実装](../../../src/app/api/admin/kpi/cost-profit/route.ts) |
| `GET /api/admin/legal-archive/status` | RBAC `admin.finance.read` | Query: `year` 2000〜9999整数 | 200 `{data:{fiscalYear,lastArchiveAt,lastRestoreCheckAt,storageTargets,externalStorageConfigured,delayed}}` | 400 query; 502 取得 | 法定保存/復元確認の記録と遅延状態、no-store [実装](../../../src/app/api/admin/legal-archive/status/route.ts) |

## Webhook・Cron

| メソッド・パス | 認証・認可 | 入力 | 応答 | 主な失敗（HTTP） | 副作用・補足 / 根拠 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/cron/expire-pending-orders` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{processed,candidateCount,batchOffset,expiredSessions,actions,needsReview,needsAction,failed,shopAlertsSent,capped,timeBudgetExhausted,checkedSessions,recoveredOrders,recoveredOrdersNotified}` | 401 認証/設定欠落; 500 注文候補取得 | 期限切れsession処理、Stripe照合、注文遷移/要確認/要対応記録、未送信店舗alert再送、直近24時間の注文の無い支払いの拾い上げ（要確認`recovered_from_payment`・店へ1通）、最後の成功の記録と点検。個別失敗はsummaryへ [実装](../../../src/app/api/cron/expire-pending-orders/route.ts) |
| `GET /api/cron/legal-archive/export` | LEGAL_ARCHIVE_CRON_SECRET Bearer J（hash定時間比較） | Query: `year` 2000〜9999、`cursor?` 1〜1000文字、`pageSize?` 1〜500既定500 | 200 LegalArchivePage `{orders,orderItems,revisions,nextCursor,totals}` | 401; 400 query; 502 DB/カーソルdecode失敗 | JST年度で順次export、no-store [実装](../../../src/app/api/cron/legal-archive/export/route.ts) |
| `POST /api/cron/legal-archive/status` | LEGAL_ARCHIVE_CRON_SECRET Bearer J（hash定時間比較） | JSON: bodySchema（下記） | 200 `{ok:true}` | 401; 400 body; 409 state遷移; 502 DB | legal_archive_runsをinsert/update。completedから非completedへの遷移は409 [実装](../../../src/app/api/cron/legal-archive/status/route.ts) |
| `POST /api/cron/meta-kpi-sync` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし（現在seasonを使用） | 200 `{data:{skipped:true}}` 又は `{data:{status,metricsWritten,message}}` | 401 認証/設定欠落; 502 sync失敗 | active Meta接続があればKPI monthly recordsをupsert [実装](../../../src/app/api/cron/meta-kpi-sync/route.ts) |
| `POST /api/cron/process-stripe-webhooks` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{processed,failed,stoppedBy}` | 401 認証/設定欠落; 502 claimのDB障害 | queueから取り出せる知らせが無くなるか約45秒たつまで処理。失敗は原因の記号で記録し、2^(n-1)分後に再試行、9回目の失敗で退避（`dead`）。最後の成功の記録と点検（溜まり・退避・遅れを店へ） [実装](../../../src/app/api/cron/process-stripe-webhooks/route.ts) |
| `POST /api/cron/stripe-reconcile` | CRON_SECRET Bearer J（hash定時間比較・32文字以上） | 本文なし | 200 `{data:{matchedOrders,unmatchedPayments,syncedBalanceTransactions,syncedRefunds,syncedPayouts,payoutMismatches,errors}}`（`errors[].reason` は原因の記号） | 401 認証/設定欠落; 502 Reconciliation failed | Stripe注文/返金/Payout照合と会計同期。支払いごとに失敗を受け止め、監査`stripe.reconcile`と最後の成功を記録 [実装](../../../src/app/api/cron/stripe-reconcile/route.ts) |
| `POST /api/webhook/stripe` | Stripe署名 W | raw body bytes + `stripe-signature` | 200 `{received:true,duplicate:boolean}`、13種以外とモード違いは200 `{received:true,ignored:true}` | 400 header/署名（監査には書かず件数だけ数え、10分に5件で店へ）; 500 設定/queue保存 | 13種だけを永続queueへenqueueし、応答の後に`after()`でworkerを1回動かす。鍵と違うモードの知らせは保存せず店へ知らせる [実装](../../../src/app/api/webhook/stripe/route.ts) |

## 入出力定義と処理上の条件

### 認証schema・リダイレクト

| 定義 | 契約 | 根拠 |
| --- | --- | --- |
| LoginRequestSchema | email形式、password 16〜128文字、turnstileTokenは任意の空でない文字列。emailSchemaはemail検証後trim/lowercase | [login.ts](../../../src/features/auth/schemas/login.ts)、[common.ts](../../../src/features/auth/schemas/common.ts) |
| RegisterRequestSchema | email/passwordは上記。display_name? max100、emailRedirectTo?/redirect_to? max2000、turnstileToken?。公開登録でBot判定と漏洩password判定。トークンを指定した管理分岐はADMIN_API_KEYを使い、RBAC/AAL2を呼ばない | [register schema](../../../src/features/auth/schemas/register.ts)、[register Handler](../../../src/app/api/auth/register/route.ts) |
| OTP・reset | OTPはcode trim後8文字。ResetRequestはemail/turnstileToken?、ResetSessionConfirmはnew_password 16〜128文字。ログイン2FA/reset Cookieは署名と期限を検証する | [otp.ts](../../../src/features/auth/schemas/otp.ts)、[password-reset.ts](../../../src/features/auth/schemas/password-reset.ts)、[login-2fa-session.ts](../../../src/features/auth/services/login-2fa-session.ts)、[password-reset-session.ts](../../../src/features/auth/services/password-reset-session.ts) |
| リダイレクト | sanitizeRedirectPathは `/` から始まる相対パスのみ（`//`、backslashを拒否）。OAuthはgoogleのみ。OAuth callbackのprivileged roleはMFA要否によって `/auth/verify-otp` 又は `/auth/enroll-totp` に移る | [redirect.ts](../../../src/lib/redirect.ts)、[oauth callback](../../../src/app/api/auth/oauth/callback/route.ts) |
| 応答の正 | login.tsのLoginResponseSchemaとregister.tsのRegisterResponseSchemaだけでは現行HandlerのOTP step/202/セッション付き201分岐を表していない。上のAPI表に記したHandler応答を用いる | [login Handler](../../../src/app/api/auth/login/route.ts)、[register Handler](../../../src/app/api/auth/register/route.ts) |

### 公開商品・検索・会員データ

| 対象 | 入出力の詳細 | 根拠 |
| --- | --- | --- |
| items query | categoryはTOPS/BOTTOMS/OUTERWEAR/ACCESSORIES/ALLをカンマで複数指定（OR）。size/color max50、collection max100、collectionSeasons max20でAW/SSだけを選択。pageは正整数、pageSize/limitは1〜60、priceMin/priceMaxは非負整数。数値の不正/空値は400でなく既定/無指定へfallback。sortはnewest/price_asc/price_desc/popular（不正はnewest）。page既定1、pageSizeは有効なpageSize→limit→12 | [items Handler](../../../src/app/api/items/route.ts)、[public.ts](../../../src/lib/items/public.ts) |
| items response | 商品形は公開selectと画像署名に従う。collection/color/seasonはページ取得後のfilterなので、返すitems件数とtotalは必ず一致するとは限らない。詳細はpublishedのみ、内部カラムの除外後にavailabilityを付加 | [list](../../../src/app/api/items/route.ts)、[detail](../../../src/app/api/items/%5Bid%5D/route.ts)、[availability](../../../src/lib/items/availability.ts) |
| SearchResultsResponse | `{query,tab,items:SearchResult[],looks:SearchResult[],news:SearchResult[],counts:{all,item,look,news},popularItems:SearchResult[],empty}`。SearchResultは `{id,type,title,description,href,imageUrl,meta}`。SearchSuggestionは `{label,type,href}` | [search.types.ts](../../../src/features/search/types/search.types.ts)、[search.service.ts](../../../src/features/search/services/search.service.ts) |
| cart variant | color/sizeはnull又は任意文字列。trim後1〜50文字、Unicodeの文字/数字/空白と `-_/().` のみ。POSTのquantity既定1。cart GETの商品はid/name/price/image_url/category/status、wishlist GETはこれにcolors/sizesを含む | [cart-stock.ts](../../../src/features/cart/services/cart-stock.ts)、[cart](../../../src/app/api/cart/route.ts)、[wishlist](../../../src/app/api/wishlist/route.ts) |
| 注文一覧 | 各行 `{id,orderNumber,orderDate,status,totalAmount,itemCount,shippingFullName,shippingEmail,shippingPhone,shippingAddress,items,detailHref}`。itemsは `{id,itemId,name,imageUrl,color,size,quantity,amount}`。金額は通貨整形済みstring、statusは表示label | [orders](../../../src/app/api/orders/route.ts) |
| 注文詳細 | `{id,orderNumber,orderDate,status,subtotalAmount,shippingAmount,discountAmount,totalAmount,paymentMethod,shippingFullName,shippingEmail,shippingPhone,shippingAddress,shippedAt,shippingCarrier,trackingNumber,items}`。statusはraw、金額は通貨整形済みstring。一覧・詳細ともpayment_in_progress/abandonedを除外 | [order detail](../../../src/app/api/orders/%5Bid%5D/route.ts)、[order-payment-types.ts](../../../src/lib/orders/order-payment-types.ts) |
| profilePayloadSchema | fullName/kanaNameはtrim/max100、phone trim/max50（いずれも任意で既定空）。address?はpostalCode max16、prefecture max100、city max200、address/building max500（trim、任意、既定空）。POSTでは主に氏名/電話を保存し、応答addressは保存済み値から解決 | [profile](../../../src/app/api/profile/route.ts) |
| addressItemSchema | profile addressと同じ欄にid? trim/max64、isDefault? boolean既定falseを加える。PUTのaddressesは必須配列/最大20。空の住所を除き、idを補完、defaultは最初の指定1件又は先頭。新schema非対応時はlegacy addressへfallback | [addresses](../../../src/app/api/profile/addresses/route.ts) |

### Checkout

| 定義 | 契約 | 根拠 |
| --- | --- | --- |
| checkoutShippingSchema | shipping自体が任意。email/fullName/kanaName/postalCode/prefecture/city/address/building/phoneも任意。NFKC/trim等の正規化後、email max254、氏名max100、postalCode 7桁、prefecture max50、city max100、address/building max150、phone `+?`と10〜15桁数字。文字種制限はschemaを参照 | [checkout-draft.service.ts](../../../src/features/checkout/services/checkout-draft.service.ts) |
| paymentMethod | stripe_card / stripe_paypay / stripe_konbini。create-sessionでは任意。completeに残るクライアント指定は採用せずStripe Sessionから解決 | [draft service](../../../src/features/checkout/services/checkout-draft.service.ts)、[payment-method.service.ts](../../../src/features/checkout/services/payment-method.service.ts) |
| createSessionSchema | uiModeはhosted/custom、既定hosted。displayedAmountsは必須strict object `{subtotalAmount,taxAmount,shippingAmount,totalAmount}`（各非負整数number）。サーバーcart価格と4項目すべてを照合 | [create-session](../../../src/app/api/checkout/create-session/route.ts)、[checkout-pricing.service.ts](../../../src/features/checkout/services/checkout-pricing.service.ts) |
| updateShippingSchema | checkoutSessionIdはtrim後空でないstring、shippingは上記、expectedRevisionは任意の非負整数number。schema上任意でも処理では未指定428。ownerはsession_id、更新はrevision一致条件 | [update-shipping](../../../src/app/api/checkout/update-shipping/route.ts) |
| Checkout conflict | 購入不可商品の409は `{error:"out_of_stock",message,items:[{item_id,name,requestedQuantity,availableQuantity,reason}]}`。collectInventoryIssuesは非公開/欠落商品のunavailableを検出し、在庫不足だけでは拒否しない。金額不一致はcheckout_amount_mismatch、確定済みはcheckout_session_complete | [cart-stock.ts](../../../src/features/cart/services/cart-stock.ts)、[create-session](../../../src/app/api/checkout/create-session/route.ts) |
| Stripe例外 | create-session catchは `{error:"checkout_session_failed",message,correlationId,retryable}`。amount_too_small/largeは422/retryable:false、rate limitは429/true、connection/API errorは503/true、authentication/permissionやパラメータ不備は500（retryableは分類による） | [checkout-error.service.ts](../../../src/features/checkout/services/checkout-error.service.ts) |
| 郵便番号 | 郵便番号文字列を正規化し、cache/DB/ZipCloudから `{prefecture,city,address}` 又はnullを返す | [postal-code.service.ts](../../../src/features/checkout/services/postal-code.service.ts)、[postal-code.util.ts](../../../src/features/checkout/utils/postal-code.util.ts) |

### 管理コンテンツ・問い合わせ（I/N/L/S/T）

| 定義 | 契約 | 根拠 |
| --- | --- | --- |
| I: 商品multipart | name trim/1〜255、description trim/1〜4000、price coercion/非負整数、category TOPS/BOTTOMS/OUTERWEAR/ACCESSORIES、status private/published。material/origin? max200、care/product_note? max500、既定空。sizesはJSON文字列の非空配列（各trim/1〜20）、colorsはJSON文字列の非空配列 `{name:trim/1〜40,hex:#+6桁hex}`。imagesは複数FileでPOSTは1件以上、PUTは省略時既存維持。JPEG/PNG/WebP/GIF、1件5MiB以下。POSTのみstatus=draftをprivateへ変換 | [items](../../../src/app/api/admin/items/route.ts)、[item update](../../../src/app/api/admin/items/%5Bid%5D/route.ts) |
| N: News multipart | title trim/1〜200、category COLLECTION/EVENT/COLLABORATION/SUSTAINABILITY/STORE、date YYYY-MM-DD、content trim/1〜2000、detailedContent trim/1〜10000、status private/published。imageはPOST必須、PUT任意。JPEG/PNG/WebP/GIF、5MiB以下 | [news](../../../src/app/api/admin/news/route.ts)、[news update](../../../src/app/api/admin/news/%5Bid%5D/route.ts) |
| L: LOOK multipart | seasonYear coercion/整数2000〜2100、seasonType SS/AW、theme trim/1〜200、themeDescription trim/max4000（未指定空）、status private/published、linkedItemIdsはJSON数値配列/1件以上/正整数（参照商品存在を確認）。imagesはPOST必須、PUT任意。JPEG/PNG/WebP/GIF、1件5MiB、1要求6件/20MiB以下、actor/kind別1時間60MiB quota | [looks](../../../src/app/api/admin/looks/route.ts)、[look update](../../../src/app/api/admin/looks/%5Bid%5D/route.ts)、[admin-rate-limit](../../../src/features/look/services/admin-rate-limit.ts) |
| S: Stockist JSON | name trim/1〜255、address trim/1〜500、phone trim/1〜50、time/holiday trim/1〜120、status private/published。PUTも全項目。idは正の整数としてparse | [stockists](../../../src/app/api/admin/stockists/route.ts)、[stockist update](../../../src/app/api/admin/stockists/%5Bid%5D/route.ts) |
| T: 返信template JSON | title trim/1〜120、body trim/1〜5000、category? nullable product/order/other/general、sortOrder? 整数0〜9999。PUTも同じschema | [templates](../../../src/app/api/admin/contact/templates/route.ts)、[template update](../../../src/app/api/admin/contact/templates/%5Bid%5D/route.ts) |
| contactSchema | name trim/1〜100、email trim/email/max255、inquiryType product/order/other、subject trim/1〜150、message trim/1〜500、orderNumber? trim/max32既定空、website? string既定空。websiteが空でなければ403。注文番号は任意、問い合わせ作成に正式会員認証を要求しない | [contact](../../../src/app/api/contact/route.ts) |
| 問い合わせ所有確認 | 会員threadはuser_id=JWT sub又はemail=JWT emailで確認する。JWT email_confirmed_atを独自追加検証する分岐はない。thread一覧は `{id,created_at,updated_at,last_message_at,inquiry_type,subject,status}`、詳細は安全な問い合わせ欄とmessage配列。inboundはreply address tokenと元問い合わせemailを照合 | [threads](../../../src/app/api/contact/threads/route.ts)、[thread](../../../src/app/api/contact/threads/%5Bid%5D/route.ts)、[reply-address](../../../src/lib/contact/reply-address.ts)、[inbound](../../../src/app/api/contact/inbound/route.ts) |

### 管理注文（O）

| 定義 | 契約 | 根拠 |
| --- | --- | --- |
| O: querySchema | page整数>=1既定1、pageSize整数1〜100既定20、from/to? YYYY-MM-DDかつfrom<=to、amountMin/Max? 非負整数かつmin<=max、counterparty/reference? trim/1〜200、status? ORDER_STATUSES、review? only | [orders Handler](../../../src/app/api/admin/orders/route.ts)、[ORDER_STATUSES](../../../src/lib/orders/order-payment-types.ts) |
| O-status: cancelled | `{status:"cancelled",reason:stock_unavailable&#124;customer_request&#124;suspected_fraud&#124;other,note?:trim/max500,notifyCustomer?:boolean}`。notifyCustomer既定true、otherはnoteが必要。paid/shipped/abandoned、決済処理中/有効な払込票等の条件は409。Stripe一時障害は503 | [status Handler](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts)、[payment reader](../../../src/lib/stripe/checkout-payment-reader.ts)、[reconciler](../../../src/lib/stripe/checkout-payment-reconciler.ts) |
| O-status: shipped | `{status:"shipped",carrier:SHIPPING_CARRIER_IDS,trackingNumber:trim/1〜64}`。trackingNumberは英数字/hyphenのみ。paid/未発送/配送必須項目充足/支払額の要対応解決などをRPCで確認 | [status Handler](../../../src/app/api/admin/orders/%5Bid%5D/status/route.ts)、[shipping-carriers](../../../src/lib/orders/shipping-carriers.ts) |
| 管理注文応答 | customerName/Email、orderDate、itemCount/items、通貨整形totalAmount、表示status、paymentMethod/reference、Stripe status、shippedAt/carrier/tracking、canShip/missingShippingFields/shipBlockedReason、needsReview、canCancel/cancelBlockedUntil、canRefund等を返す。詳細な全fieldはresponseData構築を正とする | [orders responseData](../../../src/app/api/admin/orders/route.ts) |
| 要対応解決 | cancelOrder既定false、note max500、cancelReasonは上記enum、notifyCustomer既定true。cancelOrder=true時にreasonとnoteを要求。Stripeに入金/処理/有効な払込票が残る場合等は拒否、状態競合は409 | [resolve Handler](../../../src/app/api/admin/payment-exceptions/%5Bid%5D/resolve/route.ts) |
| 返金 | 対象はStripe payment_intent_idを持つpaid/shipped。amount未指定は残額、指定額の注文金額超過は400。Stripe exception status400/409はそのまま、その他は502。返金後の注文状態はsyncOrderRefunds結果 | [refund Handler](../../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts)、[order-refund-sync](../../../src/lib/stripe/order-refund-sync.ts) |

### 会計（F）

[会計Handler](../../../src/app/api/admin/kpi/cost-profit/route.ts)のmutationSchemaはoperationによるunion。金額はcoercion後の非負整数（最大Number.MAX_SAFE_INTEGER）、年度は2000〜2999、seasonはYYYYSS/YYYYAWの空白なし表記。取引/資産の日付はZod date検証、着金確認/法定保存のYYYY-MM-DD正規表現検証とは異なる。

| 共通入力型 | fieldと制約 |
| --- | --- |
| expenseSchema | entryType expense/income（既定expense）、date必須、category trim/1〜80、item trim/1〜160、partner trim/max160既定空、amount>=1、paymentMethod trim/1〜80、memo trim/max500既定空、seasonTag season又はnull（既定null） |
| template | name trim/1〜160、expenseと同じentryType/category/item/partner/amount/paymentMethod/memo（date/seasonTagなし、amountは0可） |
| fixedAssetSchema | id非負整数既定0、name trim/1〜160、account trim/1〜80、acquiredOn date、acquisitionCost>=1、usefulLife整数1〜100、method straightLine/lumpSum3Year/immediate、businessUseRatio整数1〜100既定100、disposedOn/serviceStartedOn date又はnull既定null、entryId正整数**必須**、memo max500既定空 |
| planSchema | salesRevenue/openingCash/accountsReceivable/fixedAssets/accountsPayable/openingCapital（各非負整数） |
| closingAdjustmentSchema | closingInventoryGoods/closingInventoryMaterials/allowanceForDoubtful（各非負整数） |
| closingBalancesSchema | 4桁勘定codeをkeyとする整数record（符号付き可） |

| operation（POSTのoperation値） | operation以外の入力 | 実装上の条件・副作用 |
| --- | --- | --- |
| expense.create | fiscalYear、expense | 取引日から年度を導出し保存。resourceIdは新規取引id |
| expense.update | fiscalYear、expenseId正整数、expense | revisionを保持。配賦中の金額/season/entryType変更409。リンク資産も連動、供用/除却日との矛盾409 |
| expense.delete | fiscalYear、expenseId正整数 | deleted_atの論理削除とrevision。配賦が残る場合409 |
| receipt.attach | expenseId、receipt `{storagePath:1〜500,fileName:1〜255,mimeType:1〜120,fileSize:1〜20MiB整数}` | 証憑metadataを登録（file本体uploadはreceipt POST） |
| receipt.delete | receiptId正整数 | metadataとStorage object削除。不存在404 |
| evidenceUnavailable.upsert | expenseId、reason enum、note trim/max500既定空 | 手動income取引のみ。理由はbank_history_expired/not_issued/paper_storage/external_electronic_storage/other。要補足reasonのnote欠落400。取引内容は変更しない |
| evidenceUnavailable.delete | expenseId | 理由記録削除 |
| entry.assetExempt | expenseId、exempt boolean、reason nullable/trim/1〜500 | exempt=true時reason必須。資産候補確認状態を記録 |
| entry.reviewAck | entryRef `entry:` 又は `order:` +1〜120文字、reason duplicate/unknownAccount/unlinkedAsset/revisedEntry、acknowledged boolean、note max500既定空 | 確認状態をupsert又はdelete |
| plan.update | fiscalYear、plan | 年度計画保存 |
| partner.create | partnerName trim/1〜160 | 取引先候補を保存 |
| template.create | template | 新規のみ。同名は409（upsertではない） |
| template.update | templateName trim/1〜160、template | 選択済みnameのtemplate更新。不存在404 |
| template.delete | templateName trim/1〜160 | 指定name削除 |
| summaryOption.create | entryType、name trim/1〜160（`__`始まり禁止） | 同一摘要409 |
| summaryOption.delete | summaryOptionId正整数 | 不存在404、取引/templateで使用中409 |
| businessType.update | fiscalYear、businessType soleProprietor/corporation | 年度の事業区分保存 |
| fixedAsset.upsert | asset（上記） | entryIdのexpense/固定資産勘定を確認。取得価額/取得日/accountを元取引から再取得。他資産へ連携済409、供用/除却日が取得日前なら400。id=0新規、既存id更新 |
| fixedAsset.delete | assetId正整数 | 指定資産削除、不存在404 |
| closing.update | fiscalYear、adjustment | 整理値のみ保存 |
| closing.finalize | fiscalYear、adjustment、closingBalances | closed_atと期末残高snapshot保存 |
| closing.reopen | fiscalYear | closed_at/closingBalancesを解除、不存在404 |

GETのdataは `{fiscalYear,seasonKey,businessType,plan,expenses,incomes,products,partners,fixedAssets,closing,previousClosingBalances,revisions,reviewAcks,cumulativeEntries,templates,summaryOptions,stripeAccounting}`。取引はmapExpenseでid/entryType/date/category/item/partner/amount/paymentMethod/memo/seasonTag、資産確認、receipts、evidenceUnavailableを返す。売上incomeはordersから合成するsystem_record/source/sourceId/paymentIntentId/readOnly/grossAmount/refundedAmount付き。stripeAccountingは `{balanceTransactions,refunds,payouts,summary:{stripeBalance,inTransitBalance,unmatchedPayoutCount}}`。各mapperとrow型が詳細fieldの根拠。必須会計table欠落時のGETは空data、POSTは503。その他の追加tableごとにfallbackがあり、すべてのtable欠落が同じ応答ではない。

[会計Handlerのmapper/union](../../../src/app/api/admin/kpi/cost-profit/route.ts)、[orders売上projection](../../../src/lib/sales/order-sales.ts)、[Stripe会計adapter](../../../src/lib/stripe/supabase-accounting-database.ts)を参照。

### 商品原価（P）・バックフィル

[product-costs Handler](../../../src/app/api/admin/accounting/product-costs/route.ts)のGETは [ProductCostingResponse](../../../src/lib/finance/product-costing.ts): `{data:{seasonKey,items:ItemCostSummary[],expenses:CostingExpense[],summary:SeasonCostSummary}}`。各商品にdirectCost/unitCost/projectedSales/projectedProfit/unitProfit/profitMargin/requiredFabricMeters/costBreakdown、summaryにprojectedSales/directCost/commonCost/unallocatedCost/totalExpense/productGrossProfit/seasonProfit/seasonProfitMargin/costBreakdownを返す。

| operation | 入力 |
| --- | --- |
| item.create | item `{seasonKey,category,provisionalName,plannedQuantity?,sellingPrice?,fabricMetersPerUnit?}`。categoryはTOPS/BOTTOMS/OUTERWEAR/ACCESSORIES、name trim/1〜160、quantity整数0〜1,000,000、price非負整数、meters 0〜1,000,000。任意数値の既定0 |
| item.update | 上記itemにid正整数必須 |
| allocation.replace | expenseId正整数、linesは1〜100件 `{targetType:item&#124;season_common,itemId:正整数&#124;null,costType,otherLabel:trim/1〜80&#124;null,amount:正整数}`。item targetはitemId必須、season_commonはnull、otherはlabel必須 |
| allocation.clear | expenseId正整数 |

costTypeはmaterial/sewing/pattern/planning/accessories/processing/inspection_finishing/logistics/advertising/photography/exhibition/other。[product-costing.ts](../../../src/lib/finance/product-costing.ts)のenumを使用する。allocation.replace/clearはRPCを使う。catchのエラー文にallocation/配賦/equal/seasonが含まれると409、それ以外は500という分類が実装されている。

[Stripe backfill](../../../src/app/api/admin/accounting/stripe-backfill/route.ts)は注文id順のcursor/limitで同期し、個別失敗は200のerrors配列へ記録する。[Payout confirm](../../../src/app/api/admin/accounting/stripe-payouts/%5Bid%5D/confirm/route.ts)は同じ着金日なら再送200、別日確認済み/未paid/未照合は409。

### KPI・Meta・法定保存

| 対象 | 契約・根拠 |
| --- | --- |
| KPI | [kpi Handler](../../../src/app/api/admin/kpi/route.ts)のtoKpiMetricsResponseが月次/season metricsのfieldと計算を定義する。対象年は現在JST年、ordersのhidden statusを除外。plan/record/Metaを同一応答で返すAPIではない |
| 目標・月次 | [targets](../../../src/app/api/admin/kpi/targets/route.ts)のKPI_DEFINITIONS、[monthly-metrics](../../../src/lib/kpi/monthly-metrics.ts)のstorage keyを使用。未知keyは400でなく更新対象から除外。目標の空文字/空白、月次の空文字はdelete。GETのtable欠落fallbackが成功200でもDB table存在を示すものではない |
| Meta接続 | [meta](../../../src/app/api/admin/kpi/meta/route.ts)のconnectionはid/instagram_account_id/instagram_username/page_id/ad_account_id/token_expires_at/last_synced_at（selectした欄）等。access tokenは返さない。[sync-kpi](../../../src/lib/meta/sync-kpi.ts)は複数provider結果をallSettledし、一部成功は200 status:partial、全失敗は502。OAuth state/config/交換失敗はJSONの400/502でなくcallback redirect |
| 法定保存status body | [status Handler](../../../src/app/api/cron/legal-archive/status/route.ts)のbodySchema: archiveDate YYYY-MM-DD、fiscalYear整数2000〜9999、runKind daily/annual/restore_check、status running/completed/failed、storageTargets配列最大10（各1〜100文字）、manifestPath? max1000、manifestSha256? 小文字hex64桁、errorCode? max100。completedかつrestore_check以外はmanifestPath/Sha256必須。completedからrunning/failedへの遷移409 |
| 法定保存export response | [LegalArchivePage](../../../src/lib/legal-archive/types.ts)はorders/orderItems/revisions配列、nextCursor nullable string、totals `{grossAmount,refundedAmount,netAmount}`。[export-query](../../../src/lib/legal-archive/export-query.ts)はJST年境界、created_at/id順、base64url cursorを使用。cursorの構造不正はhelper例外から502（query length検証400とは別） |

## 更新・検証範囲

2026-10-03のソースをTypeScript ASTで調べた89 Route Handler / 125明示HTTP exportと、上記API表の125メソッド・パスの集合を照合した。入力schema、認証helper、返却分岐とローカルhelperを確認した。APIを追加/削除/変更した場合は表・型定義・[ルート所在表](route-inventory.md)を更新する。

この確認は静的な契約照合であり、実行時のDB適用状況、外部provider設定、デプロイ状態、全APIの疎通を検証したという意味ではない。

関連: [システム構成](../architecture/system-overview.md)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md)、[決済状態](../../04_DetailDesign/states/order-payment.md)。
