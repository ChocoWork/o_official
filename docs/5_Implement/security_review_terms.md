# terms セキュリティレビュー

- タスクID: TERMS-SEC-REVIEW-20260429
- 対象仕様: [docs/4_DetailDesign/18_terms.md](../4_DetailDesign/18_terms.md)
- レビュー対象: `src/app/terms/page.tsx`, `src/app/layout.tsx`, `src/contexts/Providers.tsx`, `src/components/Header.tsx`, `src/components/Footer.tsx`, `src/proxy.ts`, `e2e/FR-TERMS-*.spec.ts`
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A05, A08 を重点）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部レイヤのみ対処済み |
| Fixed | 修正済み |
| N/A | 現時点で問題なし |

---

## サマリー

- **High: 0件**
- **Medium: 2件（Open）**
- **Low: 3件（Open）**
- **Fixed/N/A: 6件**

`/terms` 本体はサーバーコンポーネントの静的本文で、直接的な機密情報露出・入力処理・動的注入は確認されませんでした。
一方で、`/terms` でも共通 `Providers` により `auth/cart/wishlist` API が初期実行されるため、静的ページに対して不要な攻撃面が発生しています。加えて、CSP が全ページ共通で広めに許可されており、terms の最小権限化余地があります。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/contexts/Providers.tsx](../../src/contexts/Providers.tsx) | `/terms` のような静的本文ページでも `CartProvider`/`LoginProvider` が有効化され、不要な API 呼び出しを誘発する | `pathname === '/terms'` では `CartProvider` を `enabled={false}` にし、さらに認証状態同期を遅延または不要化する（静的情報ページの最小権限化） | Open | `Providers` は全ルートで `Header`/`Footer` と各 Provider を常時適用。`/privacy` だけ例外制御あり | Medium |
| [src/contexts/CartContext.tsx](../../src/contexts/CartContext.tsx) | 初期マウントで `/api/cart` と `/api/wishlist` を自動取得し、terms 閲覧時にもセッション依存 API にアクセスする | 静的ページ群（`/terms`, `/privacy` 等）では初期フェッチを無効化し、必要画面遷移時に遅延取得へ変更する | Open | `useEffect` で `updateCartCount()` / `updateWishlist()` を即時実行 | Medium |
| [src/proxy.ts](../../src/proxy.ts) | CSP が全ページ共通で `frame-src`/`script-src`/`connect-src` に Stripe・Google Maps・Cloudflare を広く許可し、terms の最小権限から見ると過大 | ルート別 CSP（例: `/terms` は `frame-src 'none'` に近づける）または least-privilege ポリシー分割を導入する | Open | `buildCsp()` が全パス共通。terms 固有に不要な外部許可が含まれる | Low |
| [src/proxy.ts](../../src/proxy.ts) | `Cache-Control` を明示しておらず、静的法務ページのキャッシュ方針が CDN/ホスティング既定に依存する | `/terms` で `Cache-Control` を明示し、配信最適化と変更反映ポリシーを設計（例: `public, max-age=0, s-maxage=...`） | Open | セキュリティヘッダーは設定済みだが、キャッシュ制御ヘッダーは未設定 | Low |
| [src/proxy.ts](../../src/proxy.ts) | `x-nonce` をレスポンスヘッダーで公開しており、nonce をクライアントへ不要露出している | nonce は内部利用に限定し、必要性がない限り `x-nonce` ヘッダーを廃止する | Open | CSP nonce 自体は有効だが、ヘッダー露出の必然性は見当たらない | Low |
| [src/proxy.ts](../../src/proxy.ts) | クリックジャッキング対策不足 | `frame-ancestors 'none'` と `X-Frame-Options: DENY` を継続維持 | Fixed | `/terms` 応答に両ヘッダーが付与されるテストあり（`FR-TERMS-003`） | High |
| [src/proxy.ts](../../src/proxy.ts) | MIME スニッフィングや HTTPS 強制不足 | `X-Content-Type-Options: nosniff` と HSTS を継続維持 | Fixed | `nosniff`, `Strict-Transport-Security` を確認 | Medium |
| [src/app/terms/page.tsx](../../src/app/terms/page.tsx) | 静的ページとしての情報露出（秘密情報混入） | 現状維持。機密値を埋め込まない運用を継続 | N/A | 本文は規約文面のみで、トークン・個人情報・内部識別子の露出なし | Medium |
| [src/app/terms/page.tsx](../../src/app/terms/page.tsx) | 外部画像/外部リンクからの追跡・混在コンテンツ | 現状維持。OGP 画像は相対パスを継続 | N/A | `openGraph.images` は `'/mainphoto.png'` の内部アセットのみ | Medium |
| [src/components/Footer.tsx](../../src/components/Footer.tsx) | 外部リンク遷移時の `rel` 欠落 | 現状は `href="#"` プレースホルダで外部遷移を行わないため緊急性なし。実 URL 化時は `target`/`rel` を明示する | N/A | SNS リンクは実 URL 未設定（`#`） | Low |
| [e2e/FR-TERMS-003-security-headers.spec.ts](../../e2e/FR-TERMS-003-security-headers.spec.ts) | セキュリティヘッダー回帰検知不足 | 現状テストを維持し、将来 CSP 分割時に期待値をページ別に更新 | Fixed | `/terms` の CSP/XFO/HSTS/nosniff/nonce を検証済み | Medium |

---

## 重点観点ごとの結論

1. 静的ページとしての情報露出: **問題なし（N/A）**
2. 不要 API 呼び出し: **改善余地あり（Medium/Open）**
3. CSP: **防御は有効だが過許可（Low/Open）**
4. クリックジャッキング: **対策済み（Fixed）**
5. 外部リンク/画像: **terms 本体は安全。Footer の将来実URL化時は rel 設定が必要（N/A〜Low）**
6. キャッシュ: **明示制御不足（Low/Open）**

---

## 推奨対応順序

1. `/terms` を含む静的ページで `CartContext`/`LoginContext` の初期 API 呼び出しを抑制（Medium）
2. CSP をルート特性ごとに分離し、terms で外部許可を最小化（Low）
3. `/terms` の `Cache-Control` 方針を明示し、配信・更新ポリシーを固定化（Low）
4. `x-nonce` 露出ヘッダーの必要性を再評価し、不要なら撤去（Low）

---

## 追加レビュー追記（2026-04-29 / Round 2）

### サマリー

- High: 0件
- Medium: 1件
- Low: 2件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/contexts/Providers.tsx](../../src/contexts/Providers.tsx), [src/contexts/CartContext.tsx](../../src/contexts/CartContext.tsx), [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | `/terms` の静的ページでも認証/カート API が初期実行され、不要な攻撃面が増える | `/terms` では provider 初期同期を抑制し、必要時遅延取得へ切り替える | Open | privacy だけ抑制済みで terms は未適用 | Medium |
| [src/proxy.ts](../../src/proxy.ts) | 全ページ共通 CSP が terms には過許可 | terms 向けに route-aware CSP を分離する | Open | 既存保護は有効だが最小権限化余地 | Low |
| [src/proxy.ts](../../src/proxy.ts) | nonce をレスポンスヘッダー露出する必要性が薄い | 不要なら `x-nonce` を非公開化する | Open | 直近悪用は未確認、情報最小化観点の改善 | Low |

### 重点観点ごとの結論

1. terms 本体は静的で重大な新規脆弱性は未検出。
2. 追加論点は「静的ページでの不要 API 呼び出し」と「ヘッダー最小化」。
3. 既存のクリックジャッキング防止等は有効に維持されている。

### 推奨対応順序

1. `/terms` の provider 初期同期抑制（Medium）
2. route-aware CSP 分離（Low）
3. `x-nonce` ヘッダーの再評価（Low）