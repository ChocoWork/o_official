# home セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/01_home.md](../4_DetailDesign/01_home.md)
- レビュー観点: フロントエンド、バックエンド/API、共通ヘッダ/Proxy、DB/RLS を 4 パスで確認

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリケーション層では対処済み、設計/運用課題が残る |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/proxy.ts](../../src/proxy.ts) | クリックジャッキング対策が不足していると、HOME を iframe 埋め込みされ UI redress 攻撃の踏み台になる | frame-ancestors 'none' と X-Frame-Options: DENY を必須化する | Fixed | Content-Security-Policy に frame-ancestors 'none'、かつ X-Frame-Options: DENY を両方設定済み。クリックジャッキング観点は現行で妥当 | High |
| [src/features/search/services/search.service.ts](../../src/features/search/services/search.service.ts), [migrations/048_create_search_rpc_functions.sql](../../migrations/048_create_search_rpc_functions.sql) | 公開検索に private コンテンツ混入があると HOME プレビュー経由で非公開データ露出につながる | 検索対象は published のみ、かつパラメータ化クエリ/RPC を強制する | Fixed | search_items/search_looks/search_news は SQL 側で status = 'published' を強制。アプリ側も RPC 引数化で Injection 耐性を維持 | High |
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | HOME を含む全ページ初回描画で GET /api/auth/me を必ず実行しており、未ログイン訪問でも認証APIが常時発火する（不要な認証 API 呼び出し） | HOME/公開ページでは eager 実行せず、認証必須画面遷移時またはユーザー操作時に遅延取得する | Open | LoginProvider の useEffect で syncAuthState() を無条件実行。Providers は HOME でも常時マウントされるため不要な認証API呼び出しが発生 | Medium |
| [src/app/api/auth/me/route.ts](../../src/app/api/auth/me/route.ts), [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | /api/auth/me が id/email を返すが HOME 側利用は authenticated/role/mfaVerified のみで、最小権限・最小データ返却に反する（過剰データ返却） | 既定レスポンスを最小化し、id/email は明示的に必要な画面だけ別エンドポイントで取得する | Open | LoginContext 側では authState.user.role と mfaVerified しか読んでいない一方、API は id と email まで返却 | Medium |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | 検索語を含むレスポンスに Cache-Control 指定がなく、中継キャッシュでクエリ情報が保持される余地がある（キャッシュ経由の情報露出） | Cache-Control: no-store（少なくとも preview）を明示し、検索語キャッシュを抑止する | Open | 成功レスポンスは x-search-duration-ms のみ付与。キャッシュ制御ヘッダ未設定 | Medium |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts) | item 画像の署名URL有効期限が 7 日で長く、URL漏えい時の private オブジェクト露出期間が長い | HOME 用公開取得は 5〜60 分程度へ短縮し、必要時に再署名する | Open | DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 7。news/look は 1 時間に対し item のみ長期 | Medium |
| [src/proxy.ts](../../src/proxy.ts) | CSP が cdn.jsdelivr.net を script-src/style-src/font-src で広く許可しており、CDN サプライチェーン侵害時の影響範囲が広い | 不要であれば CDN 許可を削除し、必要最小限の origin と SRI 運用へ寄せる | Open | 全ルートに同一CSP適用。HOME自体が CDN スクリプト必須でない構成でもグローバル許可が残る | Medium |
| [next.config.ts](../../next.config.ts), [src/app/page.tsx](../../src/app/page.tsx) | 外部画像 allowlist は攻撃面になり得る。不要ドメイン残存時に外部画像配信基盤への依存が増える | HOMEで未使用の外部ドメインは段階的に削除し、必要な場合は用途/期限を明記する | Partially Fixed | HOME 本体は /mainphoto.png と /about.png のローカル画像を使用。readdy.ai は next.config.ts で「legacy/demo 用」として限定コメント付きで残置 | Low |
| [src/contexts/CartContext.tsx](../../src/contexts/CartContext.tsx), [src/contexts/Providers.tsx](../../src/contexts/Providers.tsx) | HOME 初回表示で /api/cart と /api/wishlist を自動取得しており、未操作時点で不要なセッション依存 API 呼び出しが発生 | HOME では遅延取得（アイコンホバー/対象ページ遷移時）に切り替え、不要通信を削減する | Open | CartProvider 初期 useEffect が enabled=true で実行。Providers は HOME でも CartProvider を有効化している | Low |
| [src/lib/items/public.ts](../../src/lib/items/public.ts), [src/lib/look/public.ts](../../src/lib/look/public.ts), [src/features/news/services/public.ts](../../src/features/news/services/public.ts), [src/features/stockist/services/public.ts](../../src/features/stockist/services/public.ts) | HOME で private コンテンツが公開取得経路に混入すると情報漏えいに直結する | 公開取得は status='published' と公開クライアント利用を強制し、service role は署名用途に限定する | Fixed | 各公開取得で published 条件を確認。LOOK/NEWS/ITEM の画像署名は service role だが、DB読み取りは公開クライアント経由で分離済み | Low |

---

## 総評（HOME）

- Critical/High の未解決事項: なし
- Medium の未解決事項: 5件（不要な認証API呼び出し、/api/auth/me の過剰データ返却、検索レスポンスのキャッシュ制御不足、item画像署名URLの長寿命、CSPの許可範囲過大）
- Low の未解決事項: 1件（HOMEでの不要な cart/wishlist 初期取得）

HOME は clickjacking と公開条件（published 制約）の基礎防御は有効だが、データ最小化とキャッシュ制御、CSP の許可最小化を優先して改善する余地がある。

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 1件
- Medium: 1件
- Low: 2件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | IP 識別がヘッダ依存で、検索 API の制限回避余地がある | trusted proxy 条件を実装/明文化し、複合キー制限へ寄せる | Open | 検索導線の悪用耐性に直結 | High |
| [src/lib/items/public.ts](../../src/lib/items/public.ts), [src/features/stockist/services/public.ts](../../src/features/stockist/services/public.ts) | 公開取得経路でセッション依存クライアント利用が残り、最小権限境界が曖昧 | 公開導線は `createPublicClient` に統一する | Open | 直ちに漏えいなしだが設計ドリフト余地 | Medium |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | preview パースの厳密性が低く、将来の分岐追加時に誤判定余地 | 真偽値パーサを厳格化する | Open | 現状の実害は限定的 | Low |
| [src/features/search/components/SearchHomePreview.tsx](../../src/features/search/components/SearchHomePreview.tsx) | クライアント側詳細エラーログが本番で過剰 | 本番は汎用メッセージ化し、詳細は監視基盤へ | Open | 情報最小化余地 | Low |

### 重点観点ごとの結論

1. home 追加レビューの最優先はレート制限の信頼境界。
2. 公開取得経路のクライアント統一で将来ドリフトを抑止可能。
3. Low 項目は運用ハードニングとして短期対応が望ましい。

### 推奨対応順序

1. rateLimit の IP 信頼境界修正（High）
2. 公開取得の `createPublicClient` 統一（Medium）
3. preview パーサ厳格化（Low）
4. クライアント詳細ログ最小化（Low）
