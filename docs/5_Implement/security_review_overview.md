# セキュリティレビュー総括（2026-06-27 / dynamic workflow）

- 手法: `security-check` skill の実行フロー（スコープ特定→機械監査→設定確認→手動レビュー→脅威分類→重大度評価→修正提案→報告）
- 自動化: `scripts/audit.sh`（OWASP机上監査）＋ 本レビューで新規追加した `scripts/page-audit.sh`（ページ単位の到達クロージャ解決＋入力フォーカス検査）
- 監査基準: OWASP Top10(2021) / ASVS v4.0.3 / OWASP Secure Headers / Cheat Sheets / NIST SSDF / MDN
- 対象: UI からの入力対策と関連 API 処理を持つページ群（入力/API を持たない静的ページ about/privacy/terms は対象外）

---

## エグゼクティブサマリ

| 重大度 | 件数 | 内容 |
|---|---|---|
| 🔴 Critical | 0 | — |
| 🟠 High | 0 | — |
| 🟡 Medium | 2 | 商品一覧APIの無制限応答キャッシュ(DoS) / auth callback の open redirect |
| 🔵 Low | 8 | 下表のとおり（多くは多層防御・一貫性の改善） |
| ⚪ Info | 多数 | 良好な実装の確認 |

**リリース可否: 🟢 GO（Critical/High なし）** ／ Medium 2 件は次リリースまでに是正推奨。

全体として、本コードベースのセキュリティ姿勢は高水準。zod による境界検証、二重CSRF（double-submit Cookie ＋ `proxy.ts` 同一オリジン）、IP/セッション二重レート制限、PIIハッシュ化した監査ログ、RLS + service-role スコープ、署名付き画像URL、サーバ側価格再計算、nonce ベースの強固な CSP、`dangerouslySetInnerHTML` 不使用、SameSite Cookie、検索の RPC パラメータ化が一貫して実装されている。

---

## 横断的検出事項

| ID | 重大度 | 概要 | 該当 | OWASP/CWE | 集約先 |
|---|---|---|---|---|---|
| X-01 | 🟡 Medium | `itemsListResponseCache`(Map) に上限/追い出しがなく、任意文字列フィルタを含むキーが爆発しメモリ枯渇(DoS) | `/api/items` | A04 / CWE-770 | [item](./security_review_item.md) |
| X-02 | 🟡 Medium | OAuth callback の `next` 検証が `startsWith('/')` のみで `//evil.com` 等が通過し open redirect | `auth/callback` | A01 / CWE-601 | [auth_callback](./security_review_auth_callback.md) |
| X-03 | 🔵 Low | `/api/auth/*` の状態変更系が `proxy.ts` の `STATE_CHANGING_PATH_PREFIXES`（cart/checkout/wishlist のみ）外。same-origin 多層防御が SameSite Cookie 依存 | auth 各種 | A01 / CWE-352 | [auth_password_reset](./security_review_auth_password_reset.md), [auth_verified](./security_review_auth_verified.md) |
| X-04 | 🔵 Low | cart/wishlist の CSRF 防御が `proxy.ts` 同一オリジンに一元依存。route 層は `x-csrf-token` 未検証 | `/api/cart`,`/api/wishlist` | A01 / CWE-352 | [cart](./security_review_cart.md), [wishlist](./security_review_wishlist.md) |
| X-05 | 🔵 Low | レート制限IP・proxy 同一オリジン算出が `x-forwarded-for`/`x-forwarded-host` を信用。信頼境界未固定環境で偽装余地 | 横断 | A07 / CWE-290 | [login](./security_review_login.md) 既出 |
| X-06 | 🔵 Low | CSP `script-src` が `'self'`＋CDN許可リストを含み `strict-dynamic` 未使用。nonce はあるが封じ込めが緩い | 全体 | A05 / CWE-693 | 本書 |
| X-07 | 🔵 Low | `/api/suggest` のサニタイズコメントと実装が乖離（`,().` 拒否と記すが制御文字のみ）。実防御は RPC パラメータ化 | `/api/suggest` | A03 / CWE-710 | [search](./security_review_search.md) |
| X-08 | 🔵 Low | `/api/news` の `category` 無検証（長さ上限/許可リストなし）。items 系と非一貫 | `/api/news` | A04 / CWE-20 | [home](./security_review_home.md), [news](./security_review_news.md) |
| X-09 | 🔵 Low | cart 追加の在庫チェック→書込が非原子的(TOCTOU)。checkout 再検証で実害限定 | `/api/cart` | A04 / CWE-367 | [item_id](./security_review_item_id.md), [cart](./security_review_cart.md) |
| X-10 | 🔵 Low | 注文詳細 GET にレート制限なし（UUID 不可推測のため実害限定） | `/api/orders/[id]` | A04 / CWE-307 | [account_orders_id](./security_review_account_orders_id.md) |
| X-11 | ⚪ Info | `next/image` の `*.supabase.co` ワイルドカードホスト（pathname でスコープ済） | next.config | A10 / CWE-918 | 本書 |

---

## 良好な実装（確認事項）

- **入力検証**: 公開/認証エンドポイントとも zod `safeParse` を境界で実施（contact/items/search/suggest/cart/wishlist/profile/checkout/password-reset 他）。
- **CSRF**: double-submit Cookie（`sb-csrf-token` ↔ `x-csrf-token`）＋ `proxy.ts` の cart/checkout/wishlist 同一オリジン強制。profile/checkout は `requireCsrfOrDeny` でトークン検証＋ローテーション。
- **セッション/Cookie**: `SameSite=Lax`（リセットは `Strict`）、HttpOnly、prod で Secure。
- **認可**: 認証は `resolveRequestUser`、所有権は `user_id`/`session_id` スコープ（orders/profile で IDOR 遮断）。
- **暗号/秘匿**: 監査ログは email をハッシュ化、画像は署名URL、在庫数は `stockStatus` に変換して秘匿。
- **インジェクション**: Supabase クエリビルダ＆検索 RPC のバインド変数化で SQL/filter-string injection を遮断。`dangerouslySetInnerHTML` は全社不使用。
- **ヘッダ**: `proxy.ts` で nonce-CSP（`default-src 'none'` / `frame-ancestors 'none'` / `object-src 'none'`）＋ HSTS preload ＋ `X-Frame-Options: DENY` ＋ `X-Content-Type-Options` ＋ `Referrer-Policy` ＋ `Permissions-Policy` を全レスポンス付与。`poweredByHeader:false`。
- **価格整合**: checkout はサーバ再計算し `displayedAmounts` 不一致を 409 拒否、Stripe 金額は DB 価格を使用。

---

## 監査ツールの改善（再利用のための機械化）

本レビューで `.claude/skills/security-check/scripts/` を拡張：

1. **`page-audit.sh`（新規）** — ページ起点で `@/`・相対 import を辿り UI 到達クロージャを解決し、`/api/...` 参照から関連 Route Handler（動的 `[id]` も解決）を自動特定。`audit.sh` を `--files-only` で当該ファイル集合に限定実行し、さらに「入力読取に対する zod 検証の有無」「状態変更メソッドの same-origin/CSRF・認証の有無」「UI への searchParams 反映」を機械検査して Markdown を出力。
   - 例: `bash .claude/skills/security-check/scripts/page-audit.sh src/app/contact --name contact --out report.md`
   - スコープ確認のみ: `--scope-only`
2. **`audit.sh` 改修** —
   - `--files-only` を追加（プロジェクト全体検査 A04-A06・静的解析・画像設定をスキップし、ページ単位で高速・低ノイズ実行）。
   - **Next.js 16 の `proxy.ts`（旧 `middleware.ts`）を認識**するよう拡張（既定ターゲット・A01 ミドルウェア検査・A05 CSP/HSTS 検査）。従来は `proxy.ts` 内のセキュアヘッダ実装を検出できず CSP/HSTS を誤検知していた。

### 機械監査の偽陽性（重要）

`page-audit.sh` の「Mutating Route Handler without visible auth check」は、ゲストセッション設計の公開エンドポイント（contact/cart/wishlist/checkout）や `resolveRequestUser` 認証 route（profile/addresses/orders/mfa）で**偽陽性**となる。各ページ doc で真偽を分類済み。認証検出パターンには `resolveRequestUser` 等を追加して偽陽性を低減した。

---

## 推奨対応順序

1. **X-02 open redirect** を是正（`//`・`/\` 拒否、内部パス許可リスト、クライアント/サーバ両方）。
2. **X-01 応答キャッシュ** を LRU+TTL 追い出し化。
3. **X-03** `/api/auth/*` 状態変更系を `proxy.ts` 同一オリジン保護に追加（アカウント乗っ取り面の多層化）。
4. X-04〜X-10 の Low を一貫性改善としてバックログ管理。
5. X-06（CSP `strict-dynamic`）はインライン排除状況を確認のうえ段階導入。
