# インフラ・技術スタック・プロジェクト構成 詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-INFRA-001 | `npm run dev` でアプリが起動できる Next.js プロジェクトを構成する | IMPL-INFRA-001 | `next.config.ts`, `package.json` | Next.js 15 App Router 構成。`npm run dev` で起動確認済み | 済 |
| FR-INFRA-002 | ESLint / TypeScript strict モードを設定しコード品質を保証する | IMPL-INFRA-002 | `eslint.config.mjs`, `tsconfig.json` | ESLint 設定・strict TypeScript 設定済み | 済 |
| FR-INFRA-003 | `.env.local` で必須環境変数を管理し `.env.example` に記載する | IMPL-INFRA-003 | `.env.local`, `.env.example` | 必須変数（Supabase/Stripe/Turnstile 等）を `.env.local` で管理 | 済 |
| FR-INFRA-004 | `src/` 配下を機能駆動型アーキテクチャ（Feature-Based）で整理する | IMPL-INFRA-004 | `src/` | `features/`, `components/`, `contexts/`, `hooks/`, `lib/`, `styles/`, `types/` 構成を実現 | 済 |
| FR-INFRA-005 | OpenAPI / Contract テストの導入 | — | — | 別チケットで実施予定 | 未 |

---

## 実装タスク管理 (TECH-01)

**タスクID**: TECH-01  
**ステータス**: 実装完了（チケット作成当時の todo は全て済み）  
**元ファイル**: `docs/tasks/12_tech_stack_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| TECH-01-001 | Next.js + Tailwind の初期設定 | IMPL-TECH-01-001 | `next.config.ts`, `postcss.config.mjs` | Next.js 15 App Router 及び Tailwind v4 初期設定 | 済 |
| TECH-01-002 | ESLint / Prettier 設定 | IMPL-TECH-01-002 | `eslint.config.mjs` | ESLint strict 設定完了 | 済 |
| TECH-01-003 | CI 基本パイプライン作成（lint.yml） | IMPL-TECH-01-003 | `.github/workflows/lint.yml` | Lint CI パイプライン作成済み | 済 |
| TECH-01-004 | `.env.example` に必須環境変数記載 | IMPL-TECH-01-004 | `.env.example` | 必須環境変数（Supabase/Stripe 等）を記載 | 済 |

### 技術スタック

| カテゴリ | 技術/ライブラリ | バージョン |
|--------|------------|---------|
| フレームワーク | Next.js App Router | 15.x |
| 言語 | TypeScript | strict モード |
| スタイル | Tailwind CSS | v4.x |
| DB/Auth | Supabase | @supabase/ssr |
| 決済 | Stripe | Checkout Sessions API |
| バリデーション | Zod | — |
| テスト | Jest + React Testing Library | — |
| E2E | Playwright | — |
| Linter | ESLint | — |

---

## 実装タスク管理 (STRUCT-01)

**タスクID**: STRUCT-01  
**ステータス**: done（完了済み）  
**元ファイル**: `docs/tasks/13_project_structure_organization_ticket.md`

### プロジェクト構成

```
src/
├── app/                  # Next.js App Router ページ・APIルート
├── components/           # 共通UIコンポーネント
│   └── ui/               # デザインシステムコンポーネント
├── contexts/             # React Context（Cart/Login）
├── features/             # 機能ドメイン
│   ├── auth/
│   ├── items/
│   ├── news/
│   ├── stockist/
│   └── ...
├── hooks/                # カスタムフック
├── lib/                  # ユーティリティ（csrf/audit/supabase等）
├── styles/               # グローバルCSS（globals.css）
└── types/                # TypeScript 型定義
```

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| STRUCT-01-001 | `styles/` 新設・`globals.css` 移設 | IMPL-STRUCT-01-001 | `src/styles/globals.css` | グローバル CSS を `styles/` に移設 | 済 |
| STRUCT-01-002 | `contexts/` 新設・Cart/Login Context 移設 | IMPL-STRUCT-01-002 | `src/contexts/` | Cart/Login Context を `contexts/` に集約 | 済 |
| STRUCT-01-003 | `types/` 統合・`app/types` 依存解消 | IMPL-STRUCT-01-003 | `src/types/` | 型定義を `types/` に統合し `app/types` 依存を解消 | 済 |
| STRUCT-01-004 | import 更新・型チェック通過 | IMPL-STRUCT-01-004 | `src/` 全体 | 全 import パス更新・TypeScript strict チェック通過 | 済 |

### 受け入れ条件

1. `src/` 配下に `app/`, `components/`, `contexts/`, `hooks/`, `lib/`, `styles/`, `types/` が存在する ✅
2. `src/app/layout.tsx` が `src/styles/globals.css` を読み込む ✅
3. 既存機能の import エラーなし ✅
4. 影響箇所の型チェック通過 ✅

---

## MVP 実装タスク記録

> 元ファイル: `docs/4_DetailDesign/MVP_Tasks.md`  
> `docs/ECSiteSpec.md` を元に作成した、公開可能な最小構成（MVP）に必要なタスク一覧。

### Authentication（優先）

1. **Supabase クライアント設定**（見積: 小） — `src/lib/supabaseClient.ts`  
   Supabase を初期化しエクスポートするユーティリティを作成。env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

2. **ログイン／登録 UI 統合**（見積: 中） — `src/app/login/page.tsx`  
   登録・ログイン処理を Supabase Auth と繋ぐ。

3. **パスワードリセット実装**（見積: 中） — `src/app/api/auth/password-reset/route.ts`, `src/app/login/reset.tsx`  
   リセットメール送信とトークン検証フロー。

### データベースとデータ準備

4. **DB スキーマ設計 & マイグレーション**（見積: 中） — `migrations/` 配下  
   `items`/`variants`/`carts`/`cart_items`/`orders`/`order_items` を定義。

5. **開発用シードデータ作成**（見積: 小） — `scripts/seed.sql`

---

## 技術スタック詳細（TECH-STACK）

### コアスタック

| 分類 | 技術 | バージョン方針 |
|---|---|---|
| フロントエンド | Next.js (App Router) + React + TypeScript | Latest stable |
| スタイル | Tailwind CSS（トークン化・v4 移行済） | Latest |
| バックエンド/DB | Supabase (Postgres + Auth + RLS) | Latest |
| 決済 | Stripe (Checkout Sessions API / Payment Element) | Latest |
| CI/CD | GitHub Actions | — |

### 推奨ライブラリ

| 用途 | ライブラリ |
|---|---|
| データフェッチ | `@tanstack/react-query` |
| フォーム + バリデーション | `react-hook-form` + Zod |
| E2E テスト | Playwright |
| ユニットテスト | Jest / Testing Library (or Vitest) |
| コンポーネントカタログ | Storybook |
| 画像最適化 | `next/image` + CDN (Cloudflare/Vercel) |

---

## Terraform モジュール設計（INFRA-TERRAFORM）

### State 管理

- リモートバックエンドを必須化（S3 + DynamoDB ロック、または Terraform Cloud）
- State ファイルは**環境単位**で分割（`state/production`, `state/staging`）
- State へのアクセス制御を IAM ポリシーで厳格に管理する

### モジュール構成

| モジュール | 責任範囲 |
|---|---|
| `modules/network` | VPC, Subnets, NAT, DNS |
| `modules/iam` | Service roles, policies |
| `modules/app` | App service (ECS/VM/App Platform) デプロイ |
| `modules/data` | DB (RDS/CloudSQL), Redis |
| `modules/monitoring` | Logs, Metrics, Alerting |

### 環境分割方針

- `staging` / `production` は同一モジュールを使用し、**変数で設定を切り替える**
- Blue/Green や Canary のための追加設定は module 引数で制御する
- State の変更は PR ベースでレビューし、`terraform plan` の差分を確認すること
- 機密情報は `sensitive = true` を使い、Secrets Manager を参照する設計にする

---

## OpenAPI & 契約テスト設計（INFRA-OPENAPI）

- 公開 API は OpenAPI 仕様（YAML）でドキュメント化し、ソースとして管理する
- OpenAPI 仕様からクライアント SDK を自動生成する（`openapi-generator` 等）
- CI パイプラインで API 仕様の diff を自動検出し、破壊的変更をブロックする
- Stripe / 配送 / メール等の外部 API は Contract Test で互換性を担保し、ステージングで自動検証する

```yaml
# OpenAPI サンプル (GET /api/items)
openapi: 3.0.3
info:
  title: EC Public API
  version: v1
paths:
  /api/items:
    get:
      summary: 商品一覧取得
      parameters:
        - in: query
          name: q
          schema: { type: string }
          required: false
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      $ref: '#/components/schemas/Item'
```

### 商品 API / PDP

6. **商品詳細 API** (`GET /api/items/[id]`)（見積: 中） — `src/app/api/items/[id]/route.ts`

7. **商品一覧 API の検索/フィルタ拡張**（見積: 中） — `src/app/api/items/route.ts`

8. **PDP を API 駆動化（フロント連携）**（見積: 中） — `src/app/item/[id]/page.tsx`

### カート

9. **carts テーブルとカート CRUD API**（見積: 中） — `src/app/api/cart/route.ts`

10. **カートの Cookie / セッション同期ロジック**（見積: 小） — `src/app/components/Cart.tsx`, `CartItem.tsx`

11. **カート UI の API 同期**（見積: 小） — `src/app/components/Cart.tsx`, `CartSummary.tsx`

### 決済・注文

12. **Stripe 初期化ユーティリティ**（見積: 小） — `src/lib/stripe.ts`

13. **支払い作成 API（Checkout）**（見積: 大） — `src/app/api/checkout/create-payment-intent/route.ts`

14. **Stripe Webhook と注文保存**（見積: 中） — `src/app/api/checkout/webhook/route.ts`, `src/app/api/orders/route.ts`

15. **注文確認メール送信（SES）**（見積: 中） — `src/app/api/notifications/email.ts`

### アカウント / 管理

16. **アカウント：注文履歴表示**（見積: 中） — `src/app/account/page.tsx`, `src/app/api/orders/route.ts`

17. **管理 API：商品 CRUD（最小）**（見積: 大） — `src/app/api/admin/items/route.ts`

18. **管理 UI：最小商品編集画面**（見積: 大） — `src/app/admin/page.tsx`

### 検索・UI 改善

19. **フィルタ状態を URL に反映**（見積: 中） — `src/app/components/FilterSidebar.tsx`

20. **無限スクロール／ページネーション実装**（見積: 中） — カテゴリ/一覧ページ

### 開発運用 / 品質 / ドキュメント

21. **ローカル開発：Stripe CLI & Supabase 設定手順**（見積: 小） — `README.md`

22. **E2E テスト（主要購入フロー）**（見積: 中） — `e2e/`（Playwright 設定）

23. **Webhook 署名検証とシークレット管理**（見積: 小）

24. **CI：Lint/Tests ワークフロー追加**（見積: 小）

25. **ドキュメント更新（環境変数と起動手順）**（見積: 小）

26. **入力検証・CSP などセキュリティチェック**（見積: 小）

27. **将来：CSV インポート**（低優先、見積: 大）
