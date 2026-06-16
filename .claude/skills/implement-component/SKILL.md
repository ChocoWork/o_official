---
name: implement-component
description: Next.js (App Router) + React + TypeScript で、OWASP Top 10・Vercel公式セキュリティガイド・Google TS Style Guide・React公式ルールに準拠した、厳格かつセキュアなコンポーネント／Server Action／Route Handlerを生成するSkill。生成後は必ず scripts/validate.sh による機械的検証を行う。
---

# Implement Secure Component Skill

## 適用範囲

このSkillは以下のいずれかをユーザーが要求した場合に**必ず**起動する：

- React/Next.jsコンポーネントの新規作成
- Server Action の新規作成
- Route Handler (`app/api/**/route.ts`) の新規作成
- カスタムフックの新規作成
- 既存コンポーネントのリファクタ・セキュア化

## 実行フロー（厳守）

1. **要件ヒアリング** — 不明点があれば必ず質問する（推測で実装しない）
   - コンポーネント種別: Server Component / Client Component / Server Action / Route Handler
   - 認証要否、扱うデータの機密度（PII / シークレット / 公開可）
   - 入力ソース（URL params / FormData / JSON body / props）
2. **設計宣言** — 実装前に「分類・配置パス・依存・セキュリティ考慮点」を箇条書きで提示
3. **実装** — 後述の必須ルールに従って実装
4. **検証** — `bash .github/skills/implement-component/scripts/validate.sh <生成ファイルパス>` を実行
5. **検証失敗時** — 修正してから再実行。すべて pass するまで完了としない
6. **完了報告** — 検証結果サマリと、ユーザーが追加で行うべき手動チェック項目を提示

## 必須ルール（MUST）

### TypeScript
- `tsconfig.json` は `strict: true` を含む全strict系オプション有効が前提
- `any` 完全禁止（必要時は `unknown` + 型ガード）
- Non-null assertion `!` 禁止
- `enum` 禁止（`as const` オブジェクト or Union型を使用）
- `var` 禁止、`const` 優先、再代入時のみ `let`
- 公開関数の戻り値型は明示
- `import type` を型のみインポート時は必須
- ファイル名: コンポーネントは `PascalCase.tsx`、それ以外は `kebab-case.ts`

### React
- 関数コンポーネントのみ（クラス禁止）
- `React.FC` 使用禁止（Props型を明示）
- Hooks の Rules of Hooks 厳守
- `useEffect` の依存配列は exhaustive-deps 準拠
- リストレンダリングの `key` に index を使わない（安定IDのみ）
- `dangerouslySetInnerHTML` を**ユーザー入力に対して**使用禁止。やむを得ない場合は `DOMPurify` で必ずサニタイズ
- `target="_blank"` には `rel="noopener noreferrer"` を必ず付与
- `href`/`src` に動的URLを渡す場合は `javascript:` / `data:` スキームを除外する検証必須

### Next.js (App Router)
- Server Componentを**デフォルト**とする
- `"use client"` はリーフ寄り、必要最小限の範囲に限定
- サーバ専用モジュールには **必ず** `import 'server-only';` を先頭に記述
- Server Actions は以下の3点を**必須**実装:
  1. 認証チェック（`auth()` 等のセッション確認）
  2. Zodによる入力バリデーション（`safeParse` を使用）
  3. リソースオーナー認可チェック
- Route Handler も同様に認証・認可・バリデーション必須
- `fetch` のキャッシュ戦略（`cache` / `next.revalidate` / `next.tags`）を明示
- 機密データを返す関数では React の `experimental_taintObjectReference` / `experimental_taintUniqueValue` を検討

### セキュリティ（OWASP Top 10 対応）
- **シークレット**: `NEXT_PUBLIC_*` プレフィックスにシークレット混入禁止
- **インジェクション**: ORM のパラメータ化クエリのみ使用、文字列連結クエリ禁止
- **SSRF**: 外部 fetch の URL は許可リスト方式
- **エラーハンドリング**: スタックトレースをクライアントに返さない、内部情報を露出しない
- **ログ**: PII・シークレット・トークンをログに出さない（マスキング必須）
- **レート制限**: 公開APIには必ずレート制限の実装またはコメントで指示
- **CSRF**: Pages Router の API Routes を使う場合は CSRF トークン必須（App Router の Server Actions は Origin チェック内蔵だが認可は別途必要）

### アクセシビリティ
- セマンティックHTML優先
- インタラクティブ要素には適切な ARIA 属性
- 画像には `alt` 属性必須（装飾は `alt=""`）
- フォーム要素は `<label>` と関連付け

### コード品質
- 関数は単一責務、50行を超えたら分割を検討
- マジックナンバー禁止（定数化）
- console.log 禁止（warn/error は許容、本番コードでは構造化ロガー使用）
- 深い相対パス禁止（`@/` エイリアス使用）

## 詳細ガイド

- 命名規約の詳細: `references/naming-rules.md`
- 実装サンプル: `examples/sample.tsx`
- 検証スクリプト: `scripts/validate.sh`

## 出力フォーマット

実装ファイルを出力する際は以下の構造を厳守する：

1. ファイル冒頭にファイルパスをコメントで記述（例: `// File: app/(app)/profile/page.tsx`）
2. サーバ専用なら `import 'server-only';` を最上部
3. クライアントなら `'use client';` を最上部
4. import順: ① React/Next標準 → ② 外部ライブラリ → ③ `@/` 内部 → ④ 相対パス
5. 型定義 → コンポーネント本体 → エクスポートの順
6. 関数JSDoc（公開API）または短いインラインコメントで意図を説明（What ではなく Why）

## 検証必須

実装後は **例外なく** 以下を実行：

\`\`\`bash
bash .github/skills/implement-component/scripts/validate.sh <生成したファイルパス>
\`\`\`

検証で1つでも ❌ が出た場合、それを修正するまでタスク完了を宣言してはならない。