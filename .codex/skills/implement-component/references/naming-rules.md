# 命名規約・ファイル配置詳細ルール

本ドキュメントは Google TypeScript Style Guide / Airbnb React Style Guide / Next.js 公式 / Microsoft TypeScript Coding Guidelines を統合した命名規約である。

## 1. ファイル名

| 種別 | 規約 | 例 |
|---|---|---|
| Reactコンポーネント | `PascalCase.tsx` | `UserProfile.tsx` |
| カスタムフック | `use-kebab-case.ts` または `useCamelCase.ts`（プロジェクト内統一） | `use-auth.ts` |
| ユーティリティ | `kebab-case.ts` | `format-date.ts` |
| 型定義 | `kebab-case.ts` | `user-types.ts` |
| 定数 | `kebab-case.ts` | `api-endpoints.ts` |
| Server Action | `kebab-case.ts` | `update-profile.ts` |
| テスト | `*.test.ts(x)` または `*.spec.ts(x)` | `UserProfile.test.tsx` |
| Next.js特殊ファイル | 固定名（`page.tsx`/`layout.tsx`/`loading.tsx`/`error.tsx`/`not-found.tsx`/`route.ts`/`middleware.ts`） | — |

## 2. 識別子命名

| 種別 | 規約 | 例 |
|---|---|---|
| 変数・関数 | camelCase | `getUserById`, `isLoading` |
| Reactコンポーネント | PascalCase | `function UserCard()` |
| クラス・型・インターフェース | PascalCase | `class HttpClient`, `type UserDto` |
| 型パラメータ | 単一大文字 or PascalCase | `T`, `TData`, `TError` |
| 定数（モジュールレベルの真の定数） | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 定数オブジェクト（Enum代替） | PascalCase + `as const` | `const UserRole = { Admin: 'admin' } as const` |
| ブール値 | `is/has/can/should` プレフィックス | `isEnabled`, `hasPermission` |
| イベントハンドラ | `handle*` (内部) / `on*` (props) | `handleClick`, `onClick` |
| Private（クラス） | `#` prefix（ECMAScript native） | `#privateField` |
| 未使用引数 | `_` prefix | `(_event, value) => ...` |

## 3. ディレクトリ構成

\`\`\`
app/
├── (marketing)/              # 公開ルートグループ
├── (app)/                    # 認証必須ルートグループ
│   └── dashboard/
│       ├── page.tsx
│       ├── layout.tsx
│       ├── loading.tsx
│       ├── error.tsx
│       └── _components/      # アンダースコア = ルーティング除外
├── api/
│   └── [resource]/route.ts
├── actions/                  # Server Actions集約
└── layout.tsx

components/
├── ui/                       # プリミティブ（Button, Input...）
└── feature/                  # 機能別複合コンポーネント

lib/                          # サーバ専用ロジック
├── auth.ts                   # 'server-only'
├── db.ts                     # 'server-only'
└── env.ts                    # Zod検証済み環境変数

hooks/                        # カスタムフック
types/                        # 共通型
utils/                        # 純粋関数のユーティリティ
\`\`\`

## 4. import 順序（強制）

1. React / Next.js 標準
2. サードパーティ npm パッケージ
3. `@/` 絶対パスエイリアス
4. 相対パス（`./`, `../`）
5. 型のみのimportは `import type` を使用

```typescript
import { useState } from 'react';
import Link from 'next/link';

import { z } from 'zod';
import clsx from 'clsx';

import { auth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';

import type { UserDto } from './types';
import { formatName } from './utils';
```

## 5. 命名で避けるべきパターン
| ❌ NG | ✅ OK | 理由 |
| --- | --- | --- |
| data, info, obj | userProfile, orderList | 意味が不明 |
| getUserData2 | getUserWithRoles | バージョン番号でなく差分を表現 |
| tmp, foo, bar | 用途を表す名前 | テストコード以外で使用禁止 |
| IUserService（ハンガリアン） | UserService | TS では I プレフィックス非推奨（Google/MS） |
| userArray | users | 型情報は型システムで表現 |
| 略語 usr, btn | user, button | 明瞭性優先（Apple HIG思想） |


## 6. コミットメッセージ規約（Conventional Commits）
``` <type>(<scope>): <subject>

types: feat / fix / docs / style / refactor / perf / test / chore / security
例: feat(auth): add password reset flow
例: security(api): add rate limit to login endpoint
```
