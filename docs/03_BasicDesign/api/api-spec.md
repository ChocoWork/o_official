# API仕様（現行実装）

> 確認日: 2026-10-03（Checkout・カートの行はグループ F の変更を 2026-10-07、グループ C の変更を 2026-10-08 に反映） | ソース基準: `697836a1eb2b62e1a3257ce079ecf8f536e1cb06` の作業ツリー | 対象: `src/app/api/**/route.ts`

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
| session_id | Checkout の下書き・注文・入り直しの Cookie。カートは `cart` Cookie または会員の ID、お気に入りは `wishlist` Cookie または会員の ID で持つ | Checkout の promotion-code・place-order・resume は[共通の守り](../../../src/features/checkout/services/checkout-route-guard.ts)で400 `{error:"session_not_found"}`。create-session は欠落時400 `{error:"Session not found"}`。カート・お気に入りの持ち主が無い GET は空、ゲストの追加で専用 Cookie を発行する |

Cookie名/属性は[cookie.ts](../../../src/lib/cookie.ts)、セッション発行の副作用は[persistSessionAndCookies](../../../src/features/auth/services/register.ts)と[session service](../../../src/features/auth/services/session.ts)に従う。authenticate.tsでRequestを渡さない呼び出しは、cookies()から同じaccess Cookieを読む。認証成立には、抽出したJWTの署名・issuer・audienceとsession livenessの検証が必要になる。

### C・C*（CSRF）

[requireCsrfOrDeny](../../../src/lib/csrfMiddleware.ts)は`sb-refresh-token` Cookieがなければ検査を省略する。Cookieがあれば`x-csrf-token`が必要。headerはdecodeURIComponentを試み、refresh tokenとheader tokenをSHA-256にしてsessions.refresh_token_hash / csrf_token_hashと照合する。欠落/不一致は403 `{error:"Forbidden",reason:"CSRF validation failed"}`、DB処理の例外は500。通常mutationではCSRFをrotateしない。

- **C**: finance、review、payment exception resolveは戻り値の`Response`を返す。Stockistは[admin-security.ts](../../../src/features/stockist/services/admin-security.ts)経由で`Response`も返す。
- **C***: Checkout create-session、profile POST/DELETE、addresses PUTはhelperを呼ぶが、ローカル`isCsrfDenyResponse`は`status`と`_body`両方を要求する。helperの実戻り値`NextResponse`には`_body`がなく、このguardは実際の拒否Responseを拾わない。これらのHandlerがhelperの403/500を必ず伝播すると記載しない。ProxyのOrigin検査は別途適用される。グループ F で足したCheckoutの入口（promotion-code・place-order・resume）は、共通の守り（[checkout-route-guard.ts](../../../src/features/checkout/services/checkout-route-guard.ts)）が実際の拒否Responseも返すので、C*ではない。
- logoutは拒否を返す用途ではなく、CSRF成功時だけサーバー失効を試行し、Cookie削除/200を返すためにhelperを使う。

### レート制限・エラー形式

表で429を記した標準レート制限呼出は、[enforceRateLimit](../../../src/features/auth/middleware/rateLimit.ts)から429 `{error:"Too many requests"}`またはカウンタ障害の503 `{error:"Rate limiter unavailable"}`を返す（いずれもRetry-After）。限度/subjectは各Handlerの呼出引数を正とする。Checkout create-sessionの429は`{error:"rate_limited",message,retryable:true}`へ変換する。promotion-code・place-order・resumeも[共通の守り](../../../src/features/checkout/services/checkout-route-guard.ts)で同じ429形式へ変換し、Retry-Afterを引き継ぐ（カウンタ障害の503はそのまま返す）。LOOK upload quotaは429又は503、合計bytes制限は400。Cron expire-pending-orders内のレート制限は認証失敗の監査抑制用で、戻り値をHTTP応答に採用しない。

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
| `GET /api/cart` | cart Cookie または会員 | 本文なし | 200 `{item_count,currency,items_subtotal_price,total_price,items}`。明細は `{key,id,variant_id,product_id,quantity,title,product_title,variant_title,options_with_values,price,line_price,image,url,fulfillment}`。持ち主なしは件数0・空配列 | 401 auth_expired; 503 ログインを確かめられない時; 500 | `token` は返さない。非公開商品・取り扱い終了バリアントを件数にも含めず、追加日時の新しい順。price・line_priceは円の整数、fulfillmentはstock・backorder・null（残数なし）。画像署名、Cache-Control: no-store [実装](../../../src/app/api/cart/route.ts)、[返す形](../../../src/features/cart/services/cart-view.ts) |
| `POST /api/cart/add` | cart Cookie または会員（会員は CSRF 必須） | JSON: `{items:[{id:バリアントの正整数番号,quantity:1〜20整数}]}`、1〜10件 | 200 `{items:[追加後の明細]}`（GETと同じ形） | 400 本文; 404 バリアントなし/取り扱い終了/非公開; 422 1明細20個/50種類の上限; 401/403/429/503; 500 | 同じバリアントは数量を加算、全部成功または全部拒否。断りは `{status,message:"Cart Error",description}`。422「1つの商品は20個までです。」「カートに入れられるのは50種類までです。」、404「選んだ色・サイズは現在お求めいただけません。」 [実装](../../../src/app/api/cart/add/route.ts) |
| `POST /api/cart/change` | cart Cookie または会員（会員は CSRF 必須） | JSON: `{id:明細key（UUID）,quantity:0〜20整数}` | 200 カート全体（GETと同じ形） | 400 本文; 404 他人を含む明細なし; 422 数量上限; 401/403/429/503; 500 | 数量0で削除。cart_change_lineがcart_idと明細を照合。404のdescriptionは「カートの商品が見つかりません。ページを読み込み直してください。」、400は「送った内容を確認できませんでした。」 [実装](../../../src/app/api/cart/change/route.ts) |
| `GET /api/wishlist` | wishlist Cookie または会員 | 本文なし | 200 `{id,item_id,added_at,items,variants:[{id,color,size}]}[]`（空は[]） | 401 auth_expired; 429; 503; 500 | 持ち主のwishlist_linesを読む。公開中の商品だけ、画像署名。variantsは販売中のバリアント。Cache-Control: no-store [実装](../../../src/app/api/wishlist/route.ts) |
| `POST /api/wishlist` | wishlist Cookie または会員（会員は CSRF 必須） | JSON: `{item_id:正整数}` | 201 保存したwishlist_lines行 | 400 body; 404 非公開/欠落商品; 409 `{error:"Item already in wishlist"}`; 401/403/429/503; 500 | 同じ商品は1件、ゲストの追加で専用 Cookie を発行 [実装](../../../src/app/api/wishlist/route.ts) |
| `DELETE /api/wishlist/[id]` | wishlist Cookie または会員（会員は CSRF 必須） | Path: UUID id、本文なし | 200 `{success:true}` | 400 id; 404 他人を含む持ち主の明細なし; 401/403/429/503; 500 | id + wishlist_idで削除 [実装](../../../src/app/api/wishlist/%5Bid%5D/route.ts) |

監査の持ち主は会員なら `user_id`、ゲストなら `{owner:"guest",guest_hash_prefix:SHA-256の先頭12文字}`。印そのものは残さない。カート追加の明細は `lines:[{variant_id,quantity}]` で、組・送信順・重複を保つ。根拠: [持ち主](../../../src/features/cart/services/shopping-context.ts)、[追加の監査](../../../src/app/api/cart/add/route.ts)。

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
| `POST /api/checkout/complete` | Cookie `session_id`（会員認証不要。ログインは確かめず、注文の持ち主にも触れない） | JSON: `{checkoutSessionId,shipping?,paymentMethod?}`（completeCheckoutSchema） | 200 `{orderId,status,paymentMethod}` | 400 session/body/mode/draft/ゼロ額/未決済; 403 Stripe session/draftの所有不一致; 409 注文登録不可; 429; 503 照合一時失敗; 500 例外 | Stripe側payment methodを採用。注文/在庫/決済照合、必要な通知/例外記録をreconciler経由で実行。ログイン中の会員を持ち主にする処理はグループ C で廃止した（持ち主は「注文する」の受け付けだけが書く。[グループ C の扱い](#グループ-c-の扱いfreq-426427)） [実装](../../../src/app/api/checkout/complete/route.ts) |
| `POST /api/checkout/create-session` | Cookie `session_id`（会員認証不要。ログインは買い手として確かめる） + CSRF呼出 C* | JSON: createSessionSchema（下記）。`promotionCode?`（英数字とハイフン、64文字まで）を含む | 200 custom `{confirmation}`（hosted は廃止、400）、409 `order_already_placed`・`promotion_code_invalid` | 400 session/body/空cart/総額/`shipping_incomplete`/`invalid_member_email`; 401 `{error:"auth_expired"}`; 409 `cart_updated`（買えない明細を削除済み、retryable:true）/表示金額不一致/`{error:"login_changed",message}`; 422 Stripe金額制約; 429; 503 Stripe一時障害、またはログインを確かめられない（Retry-After:30）; 500 DB/設定等。C*参照 | 「確認へ進む」の入口。カートを持ち主で読み（残ったゲストの印は先に会員へ合わせる）、下書きに `cart_id` と明細の `source_cart_line_id` を記録し、cartからサーバー金額を算出、draft作成/再利用（版3。指紋に配送先・割引コード・買い手。買い手は下書きの`buyer_user_id`に記録し、後から変えられない）、Stripe Session作成/回復（割引はサーバーが`discounts`で付ける。30分で失効）。uiModeはcustomのみ（既定custom）。配送先7項目（メールアドレス・氏名・郵便番号・都道府県・市区町村・番地・電話番号）は正規化後に必須で、欠落は400 `{error:"shipping_incomplete"}`。同じCookieのほかの決済の画面を閉じ、受け付け済みなら照合関数で注文を放棄扱いにして在庫を戻し、最終確認画面の内容を返す。ログインはCSRFの後、本文を読む前に確かめ（401・503はここで返す）、支払い済みの画面の下書きの買い手が違う時は409 `login_changed`で断る（[グループ C の扱い](#グループ-c-の扱いfreq-426427)）。hostedは受け付けない（400）。`confirmation`は`{checkoutSessionId,clientSecret,shipping,lines,promotionCode}`。エラー分類はcheckout-error.service [実装](../../../src/app/api/checkout/create-session/route.ts) |
| `POST /api/checkout/payment-intent` | 会員認証不要 | 本文は使用しない | 通常応答410 `{error,documentation:"/api/checkout/create-session"}` | 429。成功2xx分岐なし | 廃止済みの入口 [実装](../../../src/app/api/checkout/payment-intent/route.ts) |
| `GET /api/checkout/postal-code` | 会員認証不要 | Query: `postalCode` 1〜16文字 | 200 `{address:{prefecture,city,address}&#124;null}` | 400 query; 429; 502 lookup失敗 | 郵便番号サービスで住所検索 [実装](../../../src/app/api/checkout/postal-code/route.ts) |
| `POST /api/checkout/promotion-code` | Cookie `session_id`（会員認証不要） + CSRF（ログイン客） | JSON: `{code}`（strict。trim後、英数字とハイフンの64文字まで） | 200 `{code,subtotalAmount,shippingAmount,discountAmount,totalAmount}` | 400 session/body/買える明細が無い; 422 `{error:"promotion_code_invalid",reason,message}`; 429; 503 回数制限の判定不能; 500 | サーバーがStripeに問い合わせ、持ち主のカートの買える明細だけで使えるかを確かめ、カートを変えず割引後の金額の目安を返す（有効・期限・回数・最低購入額・合計が0円にならないこと。reasonはnot_found/not_applicable/expired/redemption_limit/minimum_amount/zero_total）。決済の画面には付けない（付けるのはcreate-session）。IP 10秒10回・10分60回、セッション10回/分 [実装](../../../src/app/api/checkout/promotion-code/route.ts) |
| `POST /api/checkout/place-order` | Cookie `session_id`（会員認証不要。ログインは買い手として確かめる） + CSRF（ログイン客） | JSON: `{checkoutSessionId,inStockVariantIds}`（strict。バリアントは100件まで） | 200 `{orderId,orderStatus}` | 400 session/body; 401 `{error:"auth_expired"}`; 403 他人の決済の画面; 409 `{error:"stock_changed",message,changedLines}`・`{error:"item_unavailable"&#124;"price_changed"&#124;"cart_changed"&#124;"zero_amount"&#124;"session_expired"&#124;"superseded"&#124;"login_changed",message}`・`{error:"payment_done",checkoutSessionId}`; 429; 503 回数制限の判定不能、またはログインを確かめられない（Retry-After:30）; 500 | 「注文する」の受け付け。守りの直後、何かを変える前にログインを確かめる（401・503はここで返す）。Stripeから決済の画面を読み直し（持ち主・モード・開いている・未払い・残り10分以上・新しい下書きが無い）、持ち主とモードを確かめた直後に下書きの`buyer_user_id`と今の買い手を比べ（支払い済み・時間切れ・別のタブの支払いの判断より前。違えば決済の画面を閉じて409 `login_changed`。[グループ C の扱い](#グループ-c-の扱いfreq-426427)）、受付RPCの前に`findPaidCheckoutSession`で同じCookieの別の完了済み決済の画面を探す。別IDなら409 `{error:"payment_done",checkoutSessionId:見つかったID}`でその注文の確定へ進み、同じIDなら従来の受付を続ける。受付RPCを最終確認画面で在庫ありと見せたバリアントと買い手（`_buyer_user_id`。ゲストは空）つきで呼び、下書きの `cart_id` に属する `cart_lines.id` が各 `source_cart_line_id` に対して残っていることを確かめる。`cart_id` が無い移行前の下書きも `cart_changed` で断る。消失なら409 `{error:"cart_changed",message:"カートの内容が変わりました。カートをご確認のうえ、もう一度お手続きください。"}`。NULL引数の照合器の予備処理はカート行を検証しない。受付を断ったときは新しい注文も在庫の確保も作らない。残り10分未満は失効・照合を呼ばず、監査ログを残して409 `session_expired`。前の画面は作り直しの `closeOtherCheckoutSessions`（D5）か30分の時間切れで閉じ、通知・見回りで在庫を戻す。作り直しの「確認へ進む」自体が買えない商品・金額の食い違いなどで断られたときは閉じる処理まで進まないため、30分の時間切れと Stripe の知らせ・見回りで閉じる。別の画面の `payment_done`・`cart_changed`（受付済みの押し直しを含む）・`superseded` はこの画面を閉じ、失効成功時に照合して、受付済みなら放棄・在庫返却を行い、理由とIDを監査ログに残す（後始末の失敗はログに残し409を変えない）。カード拒否後に時間がたって押し直した場合もこの経路を通り、409 `session_expired`で画面を作り直す。同じ決済の画面なら下書きロック後に同じ注文を返すが、payment_in_progressの押し直しはカート消失をcart_changedで断る。paid・pendingの既存注文はカート消失でも返す。IP 10秒10回・10分60回、セッション10回/分 [実装](../../../src/app/api/checkout/place-order/route.ts) |
| `POST /api/checkout/resume` | Cookie `session_id`（会員認証不要。ログインは買い手として確かめる） + CSRF（ログイン客） | JSON: `{checkoutSessionId?}`（strict。無いときはキーごと省く） | 200 `{state:"none"}`・`{state:"payment_done",checkoutSessionId}`・`{state:"resume",confirmation}` | 400 session/body（Cookie無しはsession_not_found）; 401 `{error:"auth_expired"}`; 403 他人の決済の画面（forbidden）; 429; 503 回数制限の判定不能、またはログインを確かめられない（Retry-After:30）; 500 | 決済の画面を開き直したときの入口。守りの直後にログインを確かめ（401・503はここで返す）、決済の画面の下書きの買い手が今の買い手と違えば、開いている画面でも支払い済みでも`none`を返す（前の確認画面も支払い済みの知らせも返さない。[グループ C の扱い](#グループ-c-の扱いfreq-426427)）。IDが無ければ受け付け済みで支払いの済んだ画面を探すだけ。IDがあれば、支払い済みは`payment_done`、開いていて下書きと結び付いていれば`resume`（最終確認画面の内容）、ほかは`none`。IDを送った400 session_not_found / 403 forbiddenは画面が`unavailable`へ読み替え、URLを`/checkout`に戻し、入力画面の上の常設LiveMessage（status）で「このブラウザではご注文の状態を表示できません。お支払いがお済みの場合は、ご注文確認のメールをお送りしています。」と案内する。注文番号・支払い成否は出さない。他の失敗とID無しは`none`。IP 10秒20回・10分120回、セッション20回/分 [実装](../../../src/app/api/checkout/resume/route.ts) |

### グループ F の画面側の扱い（FREQ-423〜425）

- FREQ-423: [入力画面](../../../src/app/checkout/page.tsx)は適用したコードだけを[このタブに記録](../../../src/app/checkout/_lib/promotion-memory.ts)し、入り直しの入口が `none`・`unavailable` なら promotion-code で確かめ直す。使えなければ欄にコードとサーバーの理由を残す。削除・注文完了処理成功・再確認の拒否（422 の理由つきの断り）で記録を消す。一時的な失敗（通信の失敗・429・5xx など）では記録を残す。
- FREQ-424: 画面の `out_of_stock` の枝とそれを真似る E2E は `cart_updated` の形に直した（2026-10-08 の全体レビュー）。2026-10-08（FREQ-430-REQ-05・AC-08）以降、create-session は購入不可明細を持ち主のカートから外し、409 `cart_updated`（retryable: true）と「次の商品はお求めいただけなくなったため、カートから外しました: <名前（色 / サイズ）>。内容をご確認のうえ、もう一度「確認へ進む」を押してください。」を返す。サーバーは `out_of_stock` を返さない。
- FREQ-425: create-session の409 `checkout_amount_mismatch` ではカートと金額を読み直し、「価格が変わりました。金額をご確認のうえ、もう一度「確認へ進む」を押してください。」をボタンの上に出し、更新済み金額で押し直せる。割引コードを適用中なら promotion-code で確かめ直して目安の金額を新しくし、断られたら割引を外して理由を出す。やり直せない案内と無効状態は、配送先の選択・入力変更でも消さない。

### グループ C の扱い（FREQ-426・427）

注文の持ち主（`orders.user_id`）を、サーバーが「確認へ進む」と「注文する」で確かめた会員だけにする。設計は[グループ C 設計書](../../superpowers/specs/2026-10-08-order-owner-binding-design.md)。

#### 買い手の確かめ

[resolveCheckoutBuyer](../../../src/features/checkout/services/checkout-buyer.ts)が、create-session・place-order・resume の守り（Cookie・回数・CSRF）の直後、DB と Stripe に触れる前に、`authenticateRequest`の結果から買い手を決める。会員の ID は検証済みの`claims.sub`だけを使い、画面から送られた値は使わない。

| `authenticateRequest` の結果 | 買い手 | 入口の応答 |
| --- | --- | --- |
| 検証済み（`sub`あり） | 会員 | 続ける |
| 印が無い | ゲスト | 続ける |
| 印が古い・失効で、更新の印（`sb-refresh-token` Cookie）がある。または検証済みだが`sub`が無い | 確かめ直しが要る | 401 `{error:"auth_expired"}`。何も変えずに返す。画面は印を新しくして1回だけ送り直す |
| 印が古い・失効で、更新の印が無い | ゲスト（残った古い印は使わない） | 続ける |
| 生存確認ができない（DB の不調） | 確かめられない | 503 `{error:"Service temporarily unavailable"}` + Retry-After:30（ゲスト扱いにしない） |

#### 入口ごとの扱い

| 入口 | 買い手の使い方 |
| --- | --- |
| create-session | 指紋（版3）に含め、`claim_checkout_draft`の`_buyer_user_id`に渡して下書きの`buyer_user_id`に記録する。会員の時は、注文のメール（配送先の写しの`email`。欠落の検査・指紋・Stripe の`customer_email`にも使う）を検証済みのログインのメール（`claims.email`）にし、画面から送られたメールは使わない。ログインのメールはゲストの入力と同じ整え（NFKC・前後の空白・小文字・形の確かめ）を通して使う。`claims.email`が無い会員（`email: null`）とゲストは画面のメールを使う。`claims.email`があるのに形として使えない会員は、画面のメールに落とさず400 `{error:"invalid_member_email",message:"ログイン中のメールアドレスを確かめられませんでした。ログインし直してから、もう一度お試しください。",retryable:false}`で断る（待っても直らないので、画面はボタンを押せない形にする）。監査ログは`checkout.session.create`／failure／`reason:"invalid_member_email"`を残し、メールの値は残さない（設計書 4-2・C7）。支払い済みの決済の画面が見つかった時は、その下書きの買い手が今の買い手と同じ時だけ`order_already_placed`を返す。違う・下書きが無い時は、その画面を照合して仕上げ（持ち主は付けない）、監査ログ（`checkout.session.create`、`reason:"login_changed"`）を残して409 `login_changed`で断る（決済の画面の ID は返さない） |
| place-order | 下書きの買い手と今の買い手を、持ち主・モードの確かめの直後に比べる。違えば、決済の画面が開いていれば閉じ（失効成功時に照合）、監査ログ（`checkout.place_order`、`reason:"login_changed"`）を残して409 `login_changed`で断る。下書きが無い時は比べず、従来の流れ（`payment_done`・`superseded`）に任せる。別のタブの`payment_done`も、その下書きの買い手が同じ時だけ返す（違う・下書きが無い時は、その画面を照合して仕上げ、今の画面を閉じて`login_changed`で断る）。同じなら受付RPCに`_buyer_user_id`（ゲストは空）を渡す。RPCが返す`login_changed`（同時の操作で起きうる）も同じ409にする |
| resume | 決済の画面の下書きの買い手が今の買い手と違えば、開いている画面でも支払い済みでも`{state:"none"}`を返す。IDが無い時も、支払い済みの画面の下書きの買い手が違う・下書きが無い時は`none`。監査ログは残さず、回数の制限で守る |
| complete | ログインを確かめず、持ち主にも触れない。ログイン中の会員を持ち主にする処理と、その監査ログ`checkout.link_order_to_user`は廃止した |

409 `login_changed`の`message`は「ログインの状態が変わりました。もう一度「確認へ進む」を押してください。」。401・503は何も変える前に返し、監査ログには残さない（503 はサーバーのログに出す）。

#### ログインと決済の流れの印

- ログイン（確認コードの確かめ・登録・メールの確認）は、セッション固定を防ぐため、決済の流れの印（`session_id` の Cookie）を新しくする（`persistSessionAndCookies`）。「確認へ進む」の後にログインすると、place-order は買い手を比べる前に「決済の画面がこの印のものでない」と403 `forbidden`で断る。カートは `session_id` と別の `cart` の Cookie（ゲスト）と会員の ID で持ち、同じログインの処理の中でゲストのカートを会員のカートへ合わせるので、押し直した「確認へ進む」はゲストで入れた商品を含むカートで進む（FREQ-428）。
- 画面は place-order の403 `forbidden`だけを`login_changed`と同じに扱い、同じ案内を出して入力画面に戻し、ログインの状態とカートと入力欄を読み直す。ほかの403（CSRFの拒否など）は読み替えない。この403では、サーバーも画面も決済の画面を閉じない（印の合わない要求で他人の決済の画面を閉じさせないため。30分の時間切れで閉じる）。
- 409 `login_changed`が直接返るのは、`session_id` の印が残ったまま、ログインの Cookie が無くなった時（更新の失敗で消された後など）。ログインの Cookie が残ったまま失効した時（別の端末からのログアウトなど）は、まず401 `auth_expired`になる。画面は印を新しくして1回だけ送り直し、新しくできなければ`login_changed`と同じ案内と扱いにする（設計書 4-3・第6章）。

#### DB の決まり

- 下書きの`buyer_user_id`は後から変えられない（`CHECKOUT_DRAFT_BUYER_IMMUTABLE`）。外部キーは付けない（会員を消した後は、誰とも一致せず「注文する」が断られる側に倒すため）。
- 受付 RPC `place_order_from_checkout_draft`は引数に`_buyer_user_id`を持つ（10個）。「注文する」の経路では、下書きをロックした直後に下書きの買い手と比べ、違えば`login_changed`を返して何も変えない。下書きが無い時や、下書きの Session・`session_id` の印が要求と違う時は、既にある注文の持ち主と比べる。同じなら、注文を作るのと同じ処理の中で`user_id`を書く（ゲストは空）。
- 照合の経路（買い手を渡さない）で作る注文の`user_id`は空。この経路に買い手だけを渡す呼び間違いは`PLACE_ORDER_ARGUMENT_REQUIRED`（22023）で断る。その注文は、メール確認済みのログインの時に`linkGuestOrdersByEmail`が同じメールでまとめる。
- 注文の持ち主は空から値へだけ書ける。別の会員への付け替えは`ORDER_OWNER_IMMUTABLE`で断る。空に戻るのは会員を消した時だけ。

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
| cart variant | addは `{items:[{id,quantity}]}`（1〜10件、idは正整数のバリアント番号、quantityは1〜20整数）。changeは `{id:明細key（UUID）,quantity:0〜20整数}`。色・サイズの文字は受け取らず、バリアントから引く。GETはカート全体、wishlist GETの各行には `variants:[{id,color,size}]` を添える | [cart-stock.ts](../../../src/features/cart/services/cart-stock.ts)、[追加](../../../src/app/api/cart/add/route.ts)、[変更](../../../src/app/api/cart/change/route.ts)、[wishlist](../../../src/app/api/wishlist/route.ts) |
| 注文一覧 | 各行 `{id,orderNumber,orderDate,status,totalAmount,itemCount,shippingFullName,shippingEmail,shippingPhone,shippingAddress,items,detailHref}`。itemsは `{id,itemId,name,imageUrl,color,size,quantity,amount}`。金額は通貨整形済みstring、statusは表示label | [orders](../../../src/app/api/orders/route.ts) |
| 注文詳細 | `{id,orderNumber,orderDate,status,subtotalAmount,shippingAmount,discountAmount,totalAmount,paymentMethod,shippingFullName,shippingEmail,shippingPhone,shippingAddress,shippedAt,shippingCarrier,trackingNumber,items}`。statusはraw、金額は通貨整形済みstring。一覧・詳細ともpayment_in_progress/abandonedを除外 | [order detail](../../../src/app/api/orders/%5Bid%5D/route.ts)、[order-payment-types.ts](../../../src/lib/orders/order-payment-types.ts) |
| profilePayloadSchema | fullName/kanaNameはtrim/max100、phone trim/max50（いずれも任意で既定空）。address?はpostalCode max16、prefecture max100、city max200、address/building max500（trim、任意、既定空）。POSTでは主に氏名/電話を保存し、応答addressは保存済み値から解決 | [profile](../../../src/app/api/profile/route.ts) |
| addressItemSchema | profile addressと同じ欄にid? trim/max64、isDefault? boolean既定falseを加える。PUTのaddressesは必須配列/最大20。空の住所を除き、idを補完、defaultは最初の指定1件又は先頭。新schema非対応時はlegacy addressへfallback | [addresses](../../../src/app/api/profile/addresses/route.ts) |

### Checkout

| 定義 | 契約 | 根拠 |
| --- | --- | --- |
| checkoutShippingSchema | shipping自体が任意。email/fullName/kanaName/postalCode/prefecture/city/address/building/phoneも任意。NFKC/trim等の正規化後、email max254、氏名max100、postalCode 7桁、prefecture max50、city max100、address/building max150、phone `+?`と10〜15桁数字。文字種制限はschemaを参照 | [checkout-draft.service.ts](../../../src/features/checkout/services/checkout-draft.service.ts) |
| paymentMethod | stripe_card / stripe_paypay / stripe_konbini。create-sessionでは任意。completeに残るクライアント指定は採用せずStripe Sessionから解決 | [draft service](../../../src/features/checkout/services/checkout-draft.service.ts)、[payment-method.service.ts](../../../src/features/checkout/services/payment-method.service.ts) |
| createSessionSchema | uiModeはcustomのみ、既定custom。hostedは400。displayedAmountsは必須strict object `{subtotalAmount,taxAmount,shippingAmount,totalAmount}`（各非負整数number）。サーバーcart価格と4項目すべてを照合。promotionCode?は英数字とハイフンの64文字まで（trim後）。使えないコードは409 `promotion_code_invalid`（reason・message付き）。共有のcheckoutShippingSchemaは任意のまま、create-sessionの受取りでは配送先7項目の欠落を400 shipping_incompleteで断る | [create-session](../../../src/app/api/checkout/create-session/route.ts)、[checkout-pricing.service.ts](../../../src/features/checkout/services/checkout-pricing.service.ts) |
| Checkout conflict | splitPurchasableCartRowsが明細ごとに取り扱い終了バリアント・非公開/欠落商品を分け、removeCartLinesが持ち主のcart_idと明細IDで外す。409 `{error:"cart_updated",retryable:true,message}`（商品名・色・サイズ入り）を返す。画面はカートと割引の目安を読み直して押し直せるままにする。割引コードの確かめは買える明細だけで計算し、カートを変えない。在庫不足だけでは拒否しない。金額不一致はcheckout_amount_mismatch。支払い済みは `{error:"order_already_placed",checkoutSessionId,message,retryable:false}`、使えない割引コードは `{error:"promotion_code_invalid",reason,message,retryable:false}` | [checkout-cart.service.ts](../../../src/features/checkout/services/checkout-cart.service.ts)、[create-session](../../../src/app/api/checkout/create-session/route.ts)、[画面](../../../src/app/checkout/page.tsx) |
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

2026-10-07にグループ F の入口の変更を表へ反映した（廃止した`update-shipping`の行を消し、`promotion-code`・`place-order`・`resume`の3行を足し、`create-session`とカートの行を直した）。実装を読んで書いたもので、上の件数（89・125）は2026-10-03時点のままであり、再集計していない。

この確認は静的な契約照合であり、実行時のDB適用状況、外部provider設定、デプロイ状態、全APIの疎通を検証したという意味ではない。

関連: [システム構成](../architecture/system-overview.md)、[認証シーケンス](../../04_DetailDesign/sequence/auth-login-mfa.md)、[決済状態](../../04_DetailDesign/states/order-payment.md)。
