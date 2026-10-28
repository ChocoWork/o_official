# ADR-0355 `session_id` は `/cart`・`/checkout`・`/api/checkout` だけで発行し、既定は配らない

> 状態: 現行 | 確認日: 2026-10-28 | 対象: `src/lib/session-cookie-policy.ts`（呼び出しは共有の `src/proxy.ts`） | 基準コミット: `90786822`（作業ツリー）

## 概要

共有の `src/proxy.ts` は、Cookie の無い要求に、どの頁でも `session_id`（30 日・HttpOnly）を発行していた。発行を許可リスト `/cart`・`/checkout`・`/api/checkout` だけにし、他の道（`/`・`/about`・`/privacy`・`/terms`・`/news`・`/look`・`/item`・`/api/auth` ほか）には配らない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の PRIVACY・ABOUT（判定の `src/lib/session-cookie-policy.ts` は PRIVACY の範囲のコード。呼び出す共有の `src/proxy.ts` はどの領域の範囲のコードでもない） |
| 対応する ID | SEC-PRIVACY-015（AC-01・AC-02）、SEC-ABOUT-004（AC-01 の読み替え） |
| 対象のコード | `src/lib/session-cookie-policy.ts` の `shouldIssueSessionCookie`・`SESSION_COOKIE_ISSUE_PATH_PREFIXES`、これを呼ぶ `src/proxy.ts` の `proxy`、先読みを止める `src/components/Header.tsx` の `/cart` の `Link`（`prefetch={false}`） |
| 関連文書 | [PRIVACY の要件](../../02_Requirements/areas/privacy.md)、[PRIVACY の脅威](../../05_Quality/security/threats/privacy.md)（THR-PRIVACY-008）、[ABOUT の脅威](../../05_Quality/security/threats/about.md)（THR-ABOUT-004）、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 9、P1〜P4）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q23） |
| 試験 | `tests/unit/middleware/proxy-session.test.ts`、`tests/integration/api/privacy-proxy-headers.test.ts`、`tests/integration/api/about-proxy.test.ts`、`e2e/FR-PRIVACY-006-response-headers-and-cookies.spec.ts` |
| 調べた時点 | 2026-10-28（単体・結合の試験は流した。E2E は書いただけで流していない） |

## 判断

### ADR-0355 `session_id` は `/cart`・`/checkout`・`/api/checkout` だけで発行し、既定は配らない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-PRIVACY-015 |
| 根拠 | `session_id` を読むのは決済の流れだけ（下の読み手の表）。読み手のいない頁に識別子を配ると、方針を読むだけの閲覧者を店が長く追える形になり、公開で共有キャッシュに載る応答にも識別子が付く。発行を読み手の道に限る（ユーザーの決定 Q23、2026-10-28） |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（Q23）、`design-final.md`（R18 の PRIVACY-015） |

#### 背景

- 以前の `proxy` は、Cookie の無い要求のたびに、頁も API も区別せず `session_id` を発行していた
- `session_id` の読み手を `src` で洗い出した（2026-10-28）。全部が許可リストの中にあり、外で `session_id` が無くて壊れる所は無かった

| 読み手 | 場所 | 道 |
| --- | --- | --- |
| 決済の入口の確かめ | `src/features/checkout/services/checkout-route-guard.ts`（`place-order`・`promotion-code`・`resume` が呼ぶ） | `/api/checkout` |
| 決済の確定 | `src/app/api/checkout/complete/route.ts` | `/api/checkout` |
| 決済の開始 | `src/app/api/checkout/create-session/route.ts` | `/api/checkout` |
| 利用者の権限の client | `src/lib/supabase/server.ts`（`x-session-id` を載せ、DB の `private.set_request_context` が `app.session_id` にする） | 決済の流れ。ゲストが `carts`・`orders` にこの client で触る窓口は他に無い |

- ゲストのカート・お気に入りは別の印（`cart`・`wishlist` の Cookie）を使う。注文の状況（`/api/order-status/*`）は確認印の token を使い、`session_id` を読まない。顧客の注文（`/api/orders`）は会員の認証で絞る
- 書き手・消し手: ログインの成功で新しく発行して回す `src/features/auth/services/register.ts`、ログアウトで消す `src/app/api/auth/logout/route.ts`。どちらも `proxy` の発行とは別の仕組み

#### 決定

- `SESSION_COOKIE_ISSUE_PATH_PREFIXES = ['/cart', '/checkout', '/api/checkout']` のどれかに、セグメントの境目で当たる時（``pathname === prefix || pathname.startsWith(`${prefix}/`)``）だけ、Cookie が無ければ発行する。`/cartx`・`/checkoutx`・`/api/checkoutx`・`/apicheckout` は当たらない
- 既に `session_id` がある要求には、どの道でも何もしない（今までどおり）
- 発行する値・属性（32 桁の 16 進、30 日、HttpOnly、SameSite=Lax、本番で Secure）は変えない
- 守りの見出し（CSP・HSTS など）は今までどおり全部の道に付ける
- 判定は `src/proxy.ts` の中に置かず、小さな関数として `src/lib/session-cookie-policy.ts` に出した。理由: `proxy` 全体を PRIVACY の範囲に入れると CSP・Origin 検査まで 100% の網羅を求められる一方、`proxy.ts` の中のままだと `DD-PRIVACY-004` に「コードの単位」と「単体の試験」が付かず、`validate-trace` の違反が基準より 3 件増える。このため `matchesPathSegment`（`proxy.ts` 内）は呼ばず、同じ式を書き直している（動きは同じ。式が 2 か所になる点は承知）
- ヘッダーの `/cart` の `Link` は `prefetch={false}` にする。Next 16 の `Link` は本番で画面に入った時に先読みし、静的な道（`/cart`）は道全体を取る。先読みの要求も proxy を通り、道が `/cart` なので、どの頁を開いても描画の直後に `session_id` が付いてしまう。`prefetch={false}` なら押した時の画面の切り替えが `/cart` への本物の要求になり、そこで発行される

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `/privacy` だけ除く | 既定が「配る」のままで、新しい頁を足すたびに除き忘れる。Q23 の答えでもない |
| `create-session` の応答で発行する | クライアントの流れを変える（今は頁の応答で Cookie を受けてから API を呼ぶ） |
| 許可リストを広げる（`/api/cart`・`/wishlist` など） | 読み手がいない。ゲストのカート・お気に入りは別の印を使う |
| proxy の中で先読みの要求を見分けて発行しない | proxy は `next-router-prefetch` を `request.headers` から外す（Next 16 の proxy の文書）ので見分けられない。matcher で先読みを外すと、先読みで取った `/cart`・`/checkout` を使う画面の切り替えに発行の要求が無くなり、最初の `/api/checkout/*` が 400 `session_not_found` になる恐れがある |
| ログインの成功で回す発行（`register.ts`）も許可リストに合わせて止める | 下の「結果」。セッション固定への守りで、`FR-CHECKOUT-046` が頼る |

#### 結果

- 良くなること: 方針・ニュース・商品などの頁を読むだけでは識別子が付かない。公開の共有キャッシュに載る応答（`/look/[id]/og` など）に `Set-Cookie` が付かない。`/about` の応答に `Set-Cookie` が付かないので、SEC-ABOUT-004 は `Set-Cookie` の有無を見ず `Cache-Control` だけを見る
- 悪くなること: `/cart`・`/checkout` を開く前に `/api/checkout/*` を直に叩くと、`session_id` が無く 400 `session_not_found` になる。これは前からの動き（`proxy` が発行するのは応答の Cookie で、同じ要求の Cookie ではない）で変わらない。ブラウザは頁の応答で Cookie を受けてから API を呼ぶ
- proxy が配るのは許可リストだけで、ログインの回転は別。ログインの成功で `register.ts` が新しい `session_id` を発行して回すので、許可リストの外の `/api/auth/*` の応答にも `Set-Cookie` が付く。ログイン前後で識別子を回してセッション固定を防ぐためで、`FR-CHECKOUT-046` が頼る。Q23 の「他は発行しない」の文面とはこの 1 点でずれる（controller の裁定、2026-10-28）
- 見直す条件: `session_id` の読み手が許可リストの外に増える時（先に読み手の表を更新し、道を許可リストに足す）

## 未確認事項

- 本番ビルドの E2E（`SEC-PRIVACY-015-AC-02`。`/cart`・`/checkout` で発行され、`/`・`/about`・`/terms`・`/news` で発行されないこと）の実測。書いただけで流していない
- `prefetch={false}` で先読みの発行が止まること（`networkidle` の後に `session_id` が無いこと）は、Next 16 の文書とコードを読んで決めた。本番ビルドでの実測は未
- `e2e/FR-WISHLIST-011` の `beforeEach` は `/` から `session_id` を取ろうとして取れなくなるが、その試験は `session_id` を使わない（ファイルの先頭の注記）。直さなくて動く
