# stockist セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/10_stockist.md](../4_DetailDesign/10_stockist.md)
- レビュー対象: `src/app/stockist/page.tsx`, `src/app/api/admin/stockists/**`, `src/features/stockist/**`, `migrations/027-030`
- 実施日: 2026-04-29
- レビュー基準: Secure Coding / OWASP Top 10（A01, A03, A05 を重点）

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

- **High: 0件（Open）**
- **Medium: 2件（Open）**
- **Low: 2件（Open）**
- **Fixed/N/A: 8件**

重点指定の `公開情報最小化 / 管理 API 認可・CSRF・RLS / 外部リンク・地図 URL / 入力検証` を確認した結果、
**認可・CSRF・RLS は現状で機能している一方、公開情報最小化と入力値の厳格化に改善余地**があります。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts) | 管理一覧 API が `select('*')` で全カラム返却しており、将来カラム追加時に不要な内部情報を過剰露出するリスクがある（公開情報最小化の逸脱） | 返却カラムを allowlist 化（例: `id,name,address,phone,time,holiday,status,updated_at`）し、レスポンス DTO を固定化する | Open | 現在は `stockists` の全列を返却。今後の列追加（内部メモ、運用フラグ等）で漏えい面積が増える構造 | Medium |
| [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | 単体取得 API も `select('*')` で返却しており、管理画面用途を超える属性がそのままクライアントへ渡る | 一覧 API と同様に返却フィールドを明示し、内部専用列を API レイヤで遮断する | Open | A01/A05 の観点で「必要最小限返却」原則に未達。現状は即時重大漏えいではないが将来拡張時の事故要因 | Medium |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts), [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | IP レート制限が `x-forwarded-for` を無条件信頼し、プロキシ境界が崩れる構成では IP ベース制限の精度低下が起こり得る | 信頼プロキシ経由時のみ `x-forwarded-for` を採用し、プラットフォーム提供の信頼済み接続情報を優先する。加えて actor 主体の制限を主制御にする | Open | 管理 API 側は actor 制限も併用しているため直ちに致命的ではないが、防御の一層としては弱い | Low |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts), [src/app/admin/stockist/StockistForm.tsx](../../src/app/admin/stockist/StockistForm.tsx) | 入力検証が「必須/長さ/status enum」中心で、電話番号や営業時間のフォーマット・制御文字抑止を行っていない | phone/time/holiday などに許可文字ベースのバリデーション（正規表現・制御文字拒否）を導入し、監査ログ汚染や不正データ混入を防ぐ | Open | React 表示時の XSS は通常エスケープされるが、データ品質と監査ログ整合性の観点でハードニング余地あり | Low |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts), [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | 管理 API の認可欠落 | `authorizeAdminPermission` による権限制御を継続 | Fixed | 読取は `admin.stockists.read`、変更は `admin.stockists.manage` を要求。A01 の最低要件を満たす | High |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts), [src/features/stockist/services/admin-security.ts](../../src/features/stockist/services/admin-security.ts), [src/lib/csrfMiddleware.ts](../../src/lib/csrfMiddleware.ts), [src/lib/client-fetch.ts](../../src/lib/client-fetch.ts) | 管理変更 API の CSRF 耐性不足 | `requireCsrfOrDeny` + `x-csrf-token` + ローテーション継続 | Fixed | POST/PUT/PATCH/DELETE で CSRF 検証を実施し、失敗時は拒否。クライアント側も変更系でヘッダを自動付与 | High |
| [migrations/027_create_stockists_and_acl.sql](../../migrations/027_create_stockists_and_acl.sql), [src/features/stockist/services/public.ts](../../src/features/stockist/services/public.ts) | 公開/非公開の分離不足 | `status='published'` フィルタ + RLS policy を継続 | Fixed | 公開経路は `published` のみ取得し、RLS でも `public stockists read published` を定義。非公開店舗の露出経路は未確認 | High |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts), [migrations/027_create_stockists_and_acl.sql](../../migrations/027_create_stockists_and_acl.sql) | RLS バイパス（service role 固定） | request-scoped client 利用方針を継続 | Fixed | 管理 API は `createClient(request)` を使用し、RLS/ACL と整合。service role 常用による回避経路は確認できず | High |
| [src/features/stockist/services/public.ts](../../src/features/stockist/services/public.ts), [src/features/stockist/components/PublicStockistGrid.tsx](../../src/features/stockist/components/PublicStockistGrid.tsx), [src/app/stockist/page.tsx](../../src/app/stockist/page.tsx) | 外部リンク/地図 URL の動的注入 | ユーザー入力を URL に連結しない方針を維持 | N/A | 地図 URL は固定定数で、現行 `stockist` ページでは外部リンク入力を受け取っていない。注入面は現時点で限定的 | Medium |
| [src/features/stockist/services/public.ts](../../src/features/stockist/services/public.ts), [src/features/stockist/types.ts](../../src/features/stockist/types.ts) | 公開 API での情報過剰返却 | 最小フィールド返却を維持 | Fixed | 公開向けは `id,name,address,phone,time,holiday` のみ返却し、管理系情報は返さない | Medium |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | SQL Injection | 現行の Supabase クエリビルダを継続 | N/A | 文字列連結 SQL は確認できず、A03 直撃の実装は見当たらない | Medium |

---

## 重点観点ごとの結論

1. 公開情報最小化: **公開向け API は良好。ただし管理 API の `select('*')` は改善余地あり（Open）**
2. 管理 API の認可: **RBAC 権限チェックが実装済み（Fixed）**
3. 管理 API の CSRF: **変更系で必須検証 + トークンローテーションあり（Fixed）**
4. 管理 API と RLS の整合: **request-scoped client + RLS policy で整合（Fixed）**
5. 外部リンク/地図 URL: **動的 URL 生成は未採用で現時点の注入リスクは低い（N/A）**
6. 安全な入力検証: **必須・長さ検証はあるが、許可文字制約は不足（Open）**

---

## 推奨対応順序

1. 管理 API の `select('*')` 廃止と DTO 固定化（Medium）
2. 入力値バリデーションの許可文字・制御文字制約の追加（Low）
3. レート制限の IP 信頼境界ハードニング（Low）

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 1件（Open）
- Low: 2件（Open）
- 既存レビューとの差分: 管理 API 応答のキャッシュ制御、監査ログ信頼境界、検証エラー露出の3点を追加

### 追加指摘一覧

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | 管理向け GET 応答に `Cache-Control` 指定がなく、経路上の共有キャッシュ設定によっては店舗マスタ情報が意図せず保持される余地がある（A05: Security Misconfiguration） | 管理 API の成功/失敗応答に `Cache-Control: private, no-store` を明示し、機微な管理データを中間キャッシュさせない | Open | Medium |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | 監査ログの `ip` に `x-forwarded-for` をそのまま採用しており、ヘッダ偽装環境では監査証跡の信頼性を落とせる（A09: Security Logging and Monitoring Failures） | 監査用 IP も信頼済みプロキシ境界で正規化した値のみ使用し、未信頼ヘッダ値は `untrusted` として別フィールド管理する | Open | Low |
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts), [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | バリデーション失敗時に `parsed.error.flatten()` をそのまま返却し、フィールド制約の詳細を外部へ過剰露出している（A05: Security Misconfiguration） | クライアント向けは汎用エラーコード（例: `INVALID_STOCKIST_PAYLOAD`）に縮約し、詳細は監査ログ/内部ログへ限定する | Open | Low |

### 重点結論

1. 認可・CSRF・RLS といった主防御は機能しており、直近の High 追加はなし。
2. 追加で重要なのは、管理 API のレスポンス境界（キャッシュ）と監査証跡の信頼境界（IP 取得）の明確化。
3. 外部露出エラーメッセージは運用上の利便性と引き換えに情報開示面を広げるため、最小開示方針への整理が妥当。

### 推奨対応順序

1. 管理 API の `Cache-Control: private, no-store` 明示（Medium）
2. 監査ログ用 IP の正規化（信頼済み境界ベース）と非信頼値分離（Low）
3. バリデーションエラー応答の縮約（Low）