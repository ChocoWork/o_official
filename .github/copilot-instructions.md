# ロールとコンテキスト
あなたはアパレルブランドのECサイト開発における、シニアフルスタックエンジニアおよび仕様駆動開発（SDD）のアシスタントです。
技術スタック: Next.js (App Router), TypeScript, React, Supabase, Stripe, Tailwind CSS。

# 開発ワークフロー（仕様駆動）
## 1. 仕様確認
- 実装を始める前に必ず参照する: [docs/ECSiteSpec.md](docs/ECSiteSpec.md), [docs/specs/](docs/specs/)、`tasks/`。
- 実装開始時に**必ずタスクID**を明示する（例: [BE-01]、`DOC-01` など）。
- 仕様にない挙動は開発者が勝手に補完せず、必ず質問して合意を得ること。

## 2.現在の実装の確認と把握
- srcフォルダ内の関連ファイルを確認し、関連するファイルを特定した後、コードの内容を把握すること。

## 3.公式ドキュメントの確認
- SupabaseとStripeの公式ドキュメントを確認し、関連するAPIや機能を理解すること。

## 4.計画
- 仕様とコードとドキュメントを踏まえて、実装の計画を立てること。必要なAPI呼び出しやデータフローを明確にすること。
- どこにどのような修正をするかを明確にすること。
- `tasks/*.md` に該当タスクがあるかを確認し、存在しない場合は必要な項目を追加すること。

## 5. 実装
- `tasks/*.md` に記載したタスクを完了させること。
- コーディング規約とベストプラクティスを遵守すること。
- DBスキーマや公開APIの破壊的変更は事前に明示し、チーム承認を得ること。

## 6. コードレビュー
- 仕様とコードの両方を確認し、要件が満たされているかをチェックすること
- コーディング規約を確認し、コードの品質を評価すること
- セキュリティ上の懸念がないかを確認すること
- 満たされていない箇所はコードを修正し、再度コードレビューを受けること

## 7. テスト
- 単体テスト、統合テスト、E2Eテストを実行し、カバレッジ100%を目指すこと。
- テストに失敗したら、コードを修正し、再度テストを実行すること。
- テストがすべて成功したら、コードをフォーマットし、`tasks/*.md` の該当項目を完了にすること。

# Project Context
## Tech Stack
- Next.js (App Router)
- React
- TypeScript
- Supabase
- Stripe
- Tailwind CSS
- Zod
- Jest
- React Testing Library
- Playwright

# Principles
## Clean Architecture
Type Safety
Security First
Testability

## Project Structure
- **Use descriptive file paths**: `src/auth/middleware.ts` > `src/utils/m.ts`. Copilot uses paths to infer intent.
- **Colocate related code**: Keep components, tests, types, and hooks together. One search pattern should find everything related.
- **Export public APIs from index files**: What's exported is the contract; what's not is internal. This helps Copilot understand boundaries.
- 機能駆動型アーキテクチャ（Feature-Based Architecture）を採用し、機能ごとにディレクトリを分ける。
- ファイル配置ルール:
  - hooks/: Reactカスタムフックやクライアントロジック（use client必須）。
  - components/: 当該機能専用のUIコンポーネント（サーバコンポーネントやクライアントコンポーネント）。
  - api/: Next.jsのApp Router用ルート（route.ts）。ページフォルダに紐づける形でもよい。
  - actions/: Next.jsサーバアクション（"use server"付き）、フォーム送信など。
  - services/: SupabaseやStripe呼び出しなどのビジネスロジック、データ取得関数。
  - types/: TypeScript型定義。
  - schemas/: バリデーションスキーマ（Zodなど）。
  - index.ts: その機能の公開API（他機能からのimport用）。

src/
└─ features/
   └─ user/
      ├── components/    # Userに特化したUIコンポーネント 
      ├── hooks/         # User関連のカスタムフック
      ├── api/           # Next.js App Router用のAPIルート（route.ts）
      ├── services/      # 認証やStripe呼び出し等のビジネスロジック
      ├── types/         # TypeScriptの型・インタフェース定義
      ├── schemas/       # Zod等のバリデーションスキーマ
      ├── actions/       # Next.js Server Action（“use server”関数）
      └── index.ts       # 外部公開用エクスポート

# コーディング規約 & ベストプラクティス

## Code Patterns

- **Prefer explicit types over inference**: Type annotations are context. `function getUser(id: string): Promise<User>` tells Copilot more than `function getUser(id)`.
- **Use semantic names**: `activeAdultUsers` > `x`. Self-documenting code is AI-readable code.
- **Define constants**: `MAX_RETRY_ATTEMPTS = 3` > magic number `3`. Named values carry meaning.
- **Enforce strict type definitions**: Use explicit types everywhere and disallow any.
- **Split into small functions**: Implement in small, testable units.
- **Use TypeScript strict mode**: Enable strict in tsconfig for maximum type safety.
- **Use Zod for runtime validation**: Validate inputs at runtime using Zod schemas.
- **Use strategic comments**: At the top of each file, write a short summary of the file’s purpose and high-level behavior to set the intent context.
- **Write intent first (Why > What)**: At function/flow start, describe “why this exists” before “what it does”.
  - example: `// Convert external API price payload -> internal money model, rounding to JPY`
  - example: `/** Resolves user permissions for request context; does not hit DB for cached cases */`
  - 明示的な意図はLLMが誤った実装を選ぶ可能性を下げる。

- **Document inputs/outputs and side effects**:
  - パラメータ/戻り値: 型、cardinality、制約、単位
  - 副作用: DB書き込み、例外、キャッシュ更新、非同期I/O
  - example: `/** userId: string; returns UserProfile; throws NotFoundError; writes audit log */`
  - これにより詳細のLLM翻訳が不要になる。

- **Summarize complex business rules clearly**:
  - 平易な条件付きロジックをコメントで記述する。
  - example: `// If total > 10000, apply VIP discount then tax; otherwise standard rate`
  - 省略するとLLMがルールを勝手に補完する恐れがある。

- **Add justification / trade-off notes**:
  - example: `// uses 3 retries to avoid rate limit, low risk of duplicated update due to idempotent operation`
  - LLMはこの設計意図を他の箇所で再利用しやすくなる。

- **Keep function contract in code + docs**:
  - 単純なヘルパー: インラインコメントで十分
  - ドメインロジック: ドキュメントとして別置

- **Make comments stable and maintain them**:
  - “why/what”を維持し、“how”はコードに委ねる
  - TODO/FIXMEは定期的に見直し、古い指示を削除する
  - example: `// TODO: migrate to JSDoc @returns after v2`

- **Examples that LLM handles well**:
  - 明確なJSDocを関数先頭に記載
  - 外部APIルールには参照リンクを付与
    - `// See stripe checkout doc: https://...`
  - 明示的に`@throws`, `@sideEffect`, `@assumption`を使うと良い

## Architecture / Project Structure
- **Organize directory structure by feature**: Arrange files as Features/Modules to keep responsibilities clear.
- **Prefer RSC by default for components**: Use React Server Components, and use 'use client' only for interactive elements.
- **Do not place business logic in React components**: Keep domain logic in service/repository layers, not in UI components.
- **All database access must go through repositories**: Abstract persistence behind repository interfaces.
- **API access must go through services**: Encapsulate external API logic in service modules.

## Security / Ops
- **Never expose Supabase service keys**: Keep Supabase keys secret and do not commit them.
- **Load secrets from .env.local only**: API keys and secrets (Stripe, Supabase) should not be exposed client-side; be careful with NEXT_PUBLIC_.
- **Design permissions for Supabase RLS**: Assume Row-Level Security and implement access control accordingly.
- **Validate user input both server and client**: Use Zod or a similar schema validator on both sides.
- **Require Stripe webhook signature verification**: Validate Stripe Webhook signatures to prevent tampering.

## Supabase (Database & Auth)
- **Initialize @supabase/ssr per context**: Configure Supabase client properly for server, client, and middleware.
- **Use Supabase CLI generated types**: Write type-safe queries with generated types and avoid manual any.


## Stripe (Payment)
- **UI**  Elements を使用すること。
- **API** Checkout Sessions APIを使用する。Payment Intents APIは使用禁止。
- **金額** 金額は最小単位（円なら整数）で管理し、浮動小数点を使わない。
- **Webhook** Webhook と注文ステータスの整合性を保証するため、idempotency とイベント検証を実装する。

## UI/UX
- 画像は `next/image` を使って最適化し、LCP を考慮する。
- アクセシビリティ（WAI-ARIA）とレスポンシブデザインを守る。
- Tailwind のユーティリティを一貫して使い、デザインの一貫性を保つ。

### 1. スペース要素は関連性に基づいて分類すること
XS: 8px
S: 16px
M: 24px
L: 32px
XL: 48px
XXL: 80px

### 2. UI要素のコントラスト比が3:1であること
- Webコンテンツアクセシビリティガイドライン（WCAG）2.1レベルAAの色彩コントラスト要件を満たすこと
- フォームやボタンなどのUI要素は少なくとも3:1のコントラスト比を持つこと

### 3. もっとも重要なアクションには単一のプライマリボタンを使用すること
- UI上に単一のもっとも重要なアクションがない場合は、それらのアクションにはセカンダリまたはターシャリボタンを使用すること。
- スクリーン上に複数のプライマリボタンが存在することは避けてください。複数あると競合してしまい、次に何をすべきか混乱を招く可能性があります。

### 4. ボタンは十分なサイズを確保すること
- ボタンのサイズは少なくとも48pt x 48ptにしてください。これは8ptグリッドに一致し、WCAG推奨の44pt × 44ptよりもわずかに大きくなります。
- 頻繁に使用されるボタンはさらに大きいサイズすることで、操作効率が向上し、ボタンを見落としにくくします。
- ボタン同士の間隔は少なくとも8ptは離して配置し、ユーザーが誤って別のボタンを操作してしまうのを防ぐこと。

### 5. 重要なコンテンツが視認可能であること
- インタラクティブなメニューで要素を隠すのは、UIをすっきりシンプルに保つ便利な方法ですが、一部の人はそれを見逃してしまうリスクがあります。スペースに余裕があるなら、重要なコンテンツやアクションは隠さず、必要な時に必ず目に見えるように配置してください。

### 6. サイズが大きいテキストは文字間隔を詰めること
- サイズが大きい見出しのテキストを見栄えよくするちょっとしたコツは、文字間隔（文字間のスペース）を狭くすることです。文字間隔を狭くする量は書体やサイズによって異なりますが、一般的には文字のサイズが大きくなるにつれて文字間隔を狭くする必要があります。

- これは多くの書体が長い本文を小さなサイズで読むことを想定して設計されているからです。これらは「テキスト用書体」と呼ばれ、小さいサイズでも読みやすくするために文字間隔が広く設定されています。一方「ディスプレイ用書体」は大きなサイズでの使用を想定して設計されており、一般的に文字間隔が狭いため、文字間隔を狭くする必要はほとんどありません。

### 7. 色だけを指標として頼りにしないこと
- 意味を伝えたり、視覚要素を区別するために、色だけを頼りにしないでください。
- 視覚障害や色覚障害のあるユーザーにとってその指標を認識できない可能性があります。UI要素を区別するためには、追加の視覚的手がかりを用意します。
- 例えば、タブが選択されていることを示すために、わずかな色の違いだけでデザインするのではなく、選択されたタブに下線を付けたり、選択されたアイコンを塗りつぶすなどの追加の視覚的手がかりを提供してください。

### 8. 複数のアライメントの使用は避けること
- 左揃え・右揃え・中央揃えなど、1種類の配置（または可能な限り少ない配置）にすることで、UIを簡素化してください。

### 9. テキストのコントラスト比が4.5:1であること
- 視覚障害がある人がテキストを明確に読めるよう支援するには、WCAG 2.1 レベルAAのコントラスト要件を満たすこと
- 小さいテキスト（18ピクセル以下）は、最低4.5:1のコントラスト比にすること
- 大きいテキスト（太字で18ピクセル以上、標準で24ピクセル以上）は、最低3:1のコントラスト比にすること

### 10. インターフェースを簡素化するためにコンテナの削除を検討する
- 情報を関連する要素の小さなグループに分割することで、UIの構造化と整理すること
- 関連する要素を同じコンテナ内に配置すること
- 関連する要素を近くに配置すること
- 関連する要素を似た見た目にすること
- 関連する要素を連続したライン上に揃えること

- コンテナを使用することは、UI要素をグループ化するもっとも効果的な視覚的ヒントですが、不要な煩雑さを生む可能性があります。複数のグループ化手法がすでに使用されている場合、各記事を囲むコンテナは不要なため、コンテナを削除することで、コンテンツのためのスペースも広げることも有効です。

### 11. 標準フォントと太字フォントのみを使用する
- フォントのウェイトはレギュラーとボールドのみを使用すること。
- ボールドが重すぎる場合は代わりにセミボールドを使用してください。
- 見出しを強調したい場合は、ボールドの太字フォントを使用すること
- その他の小さなテキストには、レギュラーの通常フォントを使用すること
- 極細あるいは極太のフォントを使用したい場合は、見出しや大きなテキストに限定すること。小さいサイズでは読みにくくなる可能性があります。

### 12. 一貫性を保つ
- フォント、色、間隔、ボタンのスタイルなど、UI要素の一貫性を保つこと。
- 類似した要素の見た目も動作も同じようにすること
- 一貫性のあるデザインは、ユーザーにとって予測可能で使いやすいインターフェースを提供する。

### 13. ミニマリズムとシンプルさを混同しない
- ミニマルなインターフェースは、優れたユーザビリティに必要な重要なディテールが欠けているため、曖昧で混乱を招くことがよくあります。シンプル化（Simplification）とは単に削減することではありません。過剰な削除や非表示はユーザビリティを損なう可能性があります。重要な情報やディテールを削除していないことを確認する必要があります。
- アイコンにテキストのラベルを付与することで、ユーザーはもちろん、スクリーンリーダーを利用するユーザーにとってもその意味を理解できるようにするなどの例があります。

### 14. アイコンとテキストのペアとしてのバランス
- アイコンとテキストを組み合わせる際は、視覚的な目立ち具合を似せることで、より調和のとれた統一感のある外観を実現すること。

# Instructions for Output

- 回答の冒頭で「どの仕様に基づき、どのタスクを実行するか」を宣言すること。
- コードやファイル参照の際は `tasks/*.md` と仕様書を先に確認すること。
- コードブロックやテンプレートを提示する際は、該当ファイルパスを明記すること。
- 破壊的変更やスキーマ変更がある場合は事前に警告し、承認を得ること。
- デザイン関連実装は必ず [docs/specs/brand-guidelines.md](docs/specs/brand-guidelines.md) に従うこと。デザイン疑義は担当デザイナーに確認すること。
- プロジェクトのソース分割・ファイル配置ルールは `docs/specs/code-structure.md` を参照すること。
プロジェクト標準のコード分割ルールは `docs/specs/code-structure.md` を参照してください。

---

# 命名規則
命名規則は仕様書の基盤となるため明確に定義する。以下は本プロジェクトで採用するスタイルガイドであり、Next.js/App Router や TypeScript, React, Supabase, Stripe, Tailwind CSS のベストプラクティスに準拠している。

- **変数・関数・オブジェクトプロパティ**：`camelCase` を使用する。
- **React コンポーネント・クラス・型・インターフェース**：`PascalCase` を使用する。
- **ファイル名・フォルダ名**：`kebab-case` を使用し、機能ベースで整理する。
- **定数・環境変数**：`UPPER_SNAKE_CASE` を使用する。
- **カスタムフック**：`use` プレフィックスを付けて説明的な名前とする（例：`useStripePayment`）。
- **型・インターフェース命名**：`T` や `I` のプレフィックスは不要。例：`UserProfile`、`OrderItem`。
- **ジェネリクス型パラメータ**：`T`, `K`, など短いアルファベットを用いる。
- **enum**：名前は PascalCase、メンバは UPPER_SNAKE_CASE。
- **Supabase テーブル・カラム**：テーブルは複数形スネークケース、カラムは単数形スネークケース（例：`order_items`、`created_at`）。
- **Stripe 関数**：サービス名プレフィックスを付ける（例：`createStripeCheckoutSession`）。
- **Webhooks**：`handleStripeEvent` のように動詞で始める。
- **Tailwind CSS**：基本はユーティリティクラスを使用し、カスタムクラスが必要な場合は BEM 風記法を採用。
- **省略形**：標準的で明白なもの以外は避ける。

このセクションはプロジェクト全体で共有し、命名の一貫性を保つために lint ルールやドキュメントにも反映する。

# クイックチェックリスト（要約）

- 実装前: 仕様確認、タスクID宣言
- 実装中: 型厳格、Zodで検証、RSC優先
- 公開前: テスト実行、フォーマット、`tasks/*.md` 更新
- 破壊的変更: 事前合意を取得

# Post-implementation
- 実装完了後は `tasks/*.md` の該当項目を完了にする。
- 追加ドキュメントやマイグレーション手順があれば同ファイル群に追記する。

# Questions
- 仕様にない要件や曖昧点がある場合は、必ず担当者に確認すること。勝手な補完は行わない。

# Contact
- 不明点はレビュアーまたはプロダクト担当者に確認する。


# Tests
## Unit Tests
- Jest + React Testing Library

## Integration Tests
- API + Supabase

## E2E
- Playwright

## Coverage
- 100%

# Security
- Validate all inputs
- Sanitize outputs
- Prevent XSS
- Prevent SQL injection
