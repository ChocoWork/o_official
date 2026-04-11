# Code Structure & File-Splitting Rules

## 概要
このドキュメントは、Next.js (App Router) + TypeScript プロジェクト向けのファイル分割・命名・配置ルールを定義します。
目的は可読性・保守性・移行容易性を高め、レビューやテストを容易にすることです。

適用範囲: `src/` 以下のフロントエンド実装。

---

## 参照資料
- Google Android/Front-end architecture 原則
- Microsoft Azure Well-Architected
- Apple Human Interface / Platform guidelines

---

## 設計原則（要点）
1. 関心の分離 (Separation of Concerns)
2. 単一責任と最小公開（SRP, Encapsulation）
3. 機能単位の配置（Feature-based modules）
4. 再利用可能な UI コンポーネントの集約
5. テストしやすい依存性管理（DI / サービス抽象）

---

## Next.js 実装指針（重要）
以下は Next.js (App Router) + TypeScript を前提に、EC サイト実装で特に重要な運用ルールです。

- Layout / Template の使い分け
  - `src/app/layout.tsx` はアプリ全体の Provider（Auth, Theme, ErrorBoundary 等）を配置する。セグメント固有の UI はセグメント配下の `layout.tsx` に置く。
  - `template.tsx` は同じレイアウトで再レンダリングを避けたい重い部分（例: 商品一覧の大きい DOM）に使用することを推奨する。

- Data fetching と Server Actions
  - Server Components での `fetch` を基本とし、データ取得と描画をサーバー側で行う（キャッシュ / 再検証ポリシーを明示する）。
  - 書き込みや副作用は Server Actions または API route（`src/app/api/.../route.ts`）を用いる。重い処理はジョブキューへ委譲する。

- クライアントバンドル最小化
  - `"use client"` は必要最小限に限定する。イベント処理や状態を必要とする小さなコンポーネントに限定する。
  - 大きな依存はクライアント専用に分離して import する。

- API の堅牢化
  - 全ての API エンドポイントは入力スキーマを `zod` 等でバリデートすること。
  - レスポンスは統一フォーマット（例: `{ success: boolean, data?: T, error?: { code: string, message: string } }`）を採用する。
  - 決済や在庫更新等は冪等性（idempotency）を考慮する（Stripe 連携時は idempotency key を利用）。

- セキュリティとシークレット管理
  - シークレットはサーバー環境変数（`.env` / `.env.local`）で管理し、クライアントへ露出させない。

- CI / Lint / TypeScript 設定（推奨）
  - `ESLint`（Next.js 推奨設定）、`Prettier`、`TypeScript strict` を必須とする。PR で自動 lint と型チェックを必須ジョブに設定すること。

---

## ワークスペース現状の要約（主要パス）
- ルートレイアウト: `src/app/layout.tsx`
- グローバルスタイル: `src/app/globals.css`
- ページ/ルート: `src/app/*.tsx` と `src/app/<route>/page.tsx` / `src/app/<route>/[id]/page.tsx`
- 共通コンポーネント（アプリ固有）: `src/components/*.tsx`
- 再利用 UI コンポーネント: `src/components/ui/*.tsx` (例: `button.tsx`, `card.tsx`)
- 型定義: `src/types/`（機能固有型は `src/features/<feature>/types.ts`）
- Supabase クライアント: `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`
- API ルート: `src/app/api/*/route.ts`
- ユーティリティ: `src/lib/utils.ts`, `src/utils/` 等

---

## 実務的ルール（抜粋）
1. 機能単位で配置する: `src/features/<feature>/` または `src/app/<route>/` にまとめ、関連ファイルを近接配置する。
2. 共有 UI は `src/components/ui/`、アプリ固有は `src/components/` に配置する。
3. ファイル命名: コンポーネントは `PascalCase.tsx`、hooks は `useXxx.ts`、サービスは `xxx.service.ts`。
4. RSC をデフォルトに: 必要な場合のみ `"use client"` を付与する。
5. ページは薄く: `page.tsx` はデータ取得と組み立てに留め、ロジックは `services`/hooks へ。
6. API ルートは薄く: `route.ts` はバリデーションとサービス呼び出しのみ。
7. 型は分離: グローバル型は `src/types/`、機能固有型は各 feature に配置する。
8. サーバー専用コードは `.server.ts` を接尾辞にする（例: `supabase.server.ts`）。
9. ファイル長の目安: 200–300 行。ただし複雑度と責務を優先する。
10. 命名で責務を表現: `*.service.ts`, `*.hook.ts`, `*.util.ts`, `*.route.ts`, `*.types.ts` を採用する。
11. CSS/スタイル: グローバルは `src/app/globals.css`、コンポーネント固有はモジュール CSS または Tailwind を同階層に配置。
12. テストは近接配置: 単位テストはコンポーネントと同階層に置き、E2E は `e2e/` に集約する。

---

## 命名規約（短記）
- Component: `MyButton.tsx`
- Hook: `useCart.ts`
- Service: `cart.service.ts`
- API Route: `route.ts` (例: `src/app/api/cart/route.ts`)
- Types: `cart.types.ts` または `types.ts`（feature 内）
- Style module: `Button.module.css`（Tailwind 使用時は最小限に）

---

## 配置パターン例

小規模（feature 内配置）:

```
src/features/product/
  ├─ ProductCard.tsx
  ├─ product.hook.ts
  ├─ product.service.ts
  ├─ types.ts
  └─ ProductCard.test.tsx
```

中規模（feature フォルダ）:

```
src/features/cart/
  ├─ components/
  │   ├─ CartItem.tsx
  │   └─ CartList.tsx
  ├─ hooks/
  │   └─ useCart.ts
  ├─ services/
  │   └─ cart.service.ts
  ├─ types.ts
  └─ index.ts (公開 API)
```

---

## 移行チェックリスト（大規模リファクタ時）
1. 影響の大きいルートを特定（例: checkout, cart）
2. 小さなコンポーネントを抽出しユニットテストを追加
3. ロジックをサービス層へ移行し、API の整合性を確認
4. CI 上でユニット／統合テストとカバレッジを確認
5. PR ベースで段階的にマージする

---

## 例外と運用ルール
- マーケティング・ランディングの長尺ページは例外を許容するが、再利用可能部分は分割すること。
- 破壊的なデザイントークン変更は事前にデザイン担当と合意する。

---

## 運用項目（追加）
以下は運用フェーズで重要な横断項目の短いガイダンスです。実務上は運用ポリシーに合わせて調整してください。

- キャッシュと CDN
  - 静的アセット（画像、フォント、JS/CSS）は CDN 配信を標準とする。
  - ISR/SSG/SSR のキャッシュ戦略を定義し、`Cache-Control` と Next.js の `revalidate` を利用する。

- Webhooks と外部イベント
  - Stripe 等の Webhook は署名検証を必須化し、冪等性を考慮する。受信処理は短くして重い処理はキューへ。

- 監視とログ（Observability）
  - エラー監視（Sentry 等）とパフォーマンス監視（RUM/APM）を導入する。
  - 重要トランザクションにトレースを付与し、アラート基準を定める。

- CI / デプロイ
  - PR 時に ESLint / type-check / unit tests を必須ジョブにする。ステージング→カナリア→本番の段階的デプロイを推奨。

- i18n とローカリゼーション
  - 翻訳は外部ファイル（JSON/翻訳サービス）で管理し、Next.js の locale 機能を利用する。

- バックアップとデータ保全
  - DB スナップショットと復元手順を文書化し、監査ログ保持ポリシーを定める。

- セキュリティ運用
  - シークレットのローテーション、依存関係の自動脆弱性スキャン、定期的なペネトレーションテストを実施する。

- 可用性と SLA
  - カート／チェックアウト／認証など主要機能の可用性監視と RTO/RPO を設定する。

---

## copilot-instructions.md に追加する短文（推奨）
プロジェクト標準のコード分割ルールは `docs/specs/code-structure.md` を参照してください。

---
