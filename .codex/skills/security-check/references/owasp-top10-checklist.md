# OWASP Top 10 (2021) 詳細チェックリスト

各項目について、Next.js + React + TypeScript 環境での具体的な検査観点を定める。

## A01:2021 — Broken Access Control

### チェック項目
- [ ] すべての Server Action 関数の冒頭で `auth()` セッション検証を実施しているか
- [ ] すべての Route Handler (`route.ts`) で認証チェックを実施しているか
- [ ] リソース操作前に「リクエスト元ユーザー === リソース所有者」の検証があるか（IDOR対策）
- [ ] Middleware のみに依存していないか（Middleware はバイパス可能、必ずページ/APIでも検証）
- [ ] ロール/権限チェックは Deny by default で実装されているか
- [ ] 管理者専用機能に role 検証があるか
- [ ] CORS は許可リスト方式か（`*` ワイルドカード禁止）
- [ ] 直接オブジェクト参照（URLパラメータの ID 等）に対し所有権チェックがあるか
- [ ] JWT を使う場合、署名検証が必須化されているか

### 検出例
```typescript
// ❌ NG: 認証チェックなし
export async function deletePost(formData: FormData) {
  'use server';
  const id = formData.get('id') as string;
  await db.post.delete({ where: { id } });
}

// ✅ OK: 認証 + 所有者検証
export async function deletePost(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) throw new Error('Unauthorized');

  const id = z.string().uuid().parse(formData.get('id'));
  const post = await db.post.findUnique({ where: { id } });
  if (!post || post.authorId !== session.user.id) {
    throw new Error('Forbidden');
  }
  await db.post.delete({ where: { id } });
}
```

## A02:2021 — Cryptographic Failures

### チェック項目
- [ ] HTTPS 強制（HSTS ヘッダ設定済み、`max-age >= 31536000`、`includeSubDomains`、`preload`）
- [ ] パスワードは Argon2id（推奨）/ bcrypt(cost≥12) / scrypt のいずれかでハッシュ化
- [ ] パスワードを平文/MD5/SHA-1/SHA-256単独で保存していない
- [ ] Cookie に `Secure; HttpOnly; SameSite=Lax`(or Strict) 属性
- [ ] セッション Cookie は `__Host-` プレフィックス推奨
- [ ] 機密データ（PII、決済情報）の保管時暗号化
- [ ] 弱い暗号アルゴリズム（DES、3DES、RC4、MD5、SHA-1）の不使用
- [ ] 乱数生成は `crypto.randomBytes` / `crypto.randomUUID` を使用（`Math.random` 禁止）
- [ ] TLS 1.2 以上（1.0/1.1 廃止）

### 検出例
```typescript
// ❌ NG
import { createHash } from 'crypto';
const hash = createHash('md5').update(password).digest('hex');

// ✅ OK (Argon2id)
import argon2 from 'argon2';
const hash = await argon2.hash(password, { type: argon2.argon2id });
```

## A03:2021 — Injection

### チェック項目
- [ ] SQL: ORM (Prisma/Drizzle 等) のパラメータ化クエリのみ。文字列連結禁止
- [ ] NoSQL: ユーザー入力をクエリオブジェクトに直接展開していない（MongoDB の `$where` 等）
- [ ] OSコマンド: `child_process.exec` でユーザー入力を使わない（`execFile` + 配列引数を使用）
- [ ] LDAP: エスケープ処理
- [ ] XSS: `dangerouslySetInnerHTML` はユーザー入力に使わない、または `DOMPurify` でサニタイズ
- [ ] DOM XSS: `innerHTML`、`document.write`、`eval`、`new Function` 禁止
- [ ] テンプレートインジェクション: ユーザー入力をテンプレート文字列に直接展開していない
- [ ] HTTPヘッダインジェクション: ユーザー入力に `\r\n` 含まないか検証
- [ ] オープンリダイレクト: リダイレクト先 URL は許可リスト

## A04:2021 — Insecure Design

### チェック項目
- [ ] 認証エンドポイントにレート制限あり（`upstash/ratelimit` 等）
- [ ] パスワードリセットに時限トークン + 1回限り使用
- [ ] 重要操作に再認証/MFA
- [ ] ファイルアップロードのサイズ・MIME型・拡張子制限
- [ ] ビジネスロジック上の数量制限（購入個数、リクエスト回数）
- [ ] 脅威モデリング実施記録

## A05:2021 — Security Misconfiguration

### チェック項目
- [ ] `next.config.js` で `poweredByHeader: false`
- [ ] エラーページがスタックトレースを露出していない
- [ ] `NODE_ENV === 'production'` で動作している
- [ ] デフォルトパスワード/サンプルアカウントの削除
- [ ] 不要な HTTP メソッド（TRACE 等）無効化
- [ ] ディレクトリリスティング無効
- [ ] CSP ヘッダ設定済み（`unsafe-inline` / `unsafe-eval` を避ける）
- [ ] `.env*` ファイルが Git にコミットされていない
- [ ] デバッグツール（React DevTools、Redux DevTools）が本番ビルドで無効

## A06:2021 — Vulnerable and Outdated Components

### チェック項目
- [ ] `npm audit --production` が Critical/High なし
- [ ] `package-lock.json` / `pnpm-lock.yaml` がコミット済み
- [ ] Dependabot / Renovate / Snyk の有効化
- [ ] EOL の Node.js / フレームワーク版を使用していない
- [ ] サブリソース整合性（SRI）が外部スクリプトに付与されている
- [ ] 依存パッケージの最新メジャー確認（半年に1回）

## A07:2021 — Identification and Authentication Failures

### チェック項目
- [ ] パスワード最小長 12文字以上（NIST SP 800-63B）
- [ ] 既知のリーク済みパスワードチェック（HIBP API 等）
- [ ] ブルートフォース対策（アカウントロック or レート制限）
- [ ] セッション ID は推測不能（128bit 以上のエントロピー）
- [ ] ログアウトでサーバ側セッション無効化
- [ ] セッション固定対策（ログイン時にセッションID再生成）
- [ ] MFA / WebAuthn 対応
- [ ] 「パスワードを忘れた」に時限トークン
- [ ] エラーメッセージで「ユーザー存在 vs パスワード違い」を区別しない

## A08:2021 — Software and Data Integrity Failures

### チェック項目
- [ ] CI/CD パイプラインの保護（保護ブランチ、レビュー必須）
- [ ] 信頼できないレジストリからのパッケージ取得禁止
- [ ] 外部スクリプトに SRI ハッシュ
- [ ] 逆シリアライズに `JSON.parse` 以外を使う場合、信頼できる入力のみ
- [ ] 自動更新のソフトウェアは署名検証
- [ ] ビルド成果物の署名/ハッシュ検証

## A09:2021 — Security Logging and Monitoring Failures

### チェック項目
- [ ] 認証成功/失敗のログ
- [ ] 認可失敗のログ
- [ ] 入力バリデーション失敗のログ
- [ ] サーバー側エラーのログ
- [ ] ログにパスワード/トークン/PII を含めていない（マスキング）
- [ ] 構造化ログ（JSON）形式
- [ ] ログ保管場所が改ざん耐性あり
- [ ] アラート機構（Sentry / Datadog 等）連携
- [ ] 異常検知（失敗試行が短時間に集中など）

## A10:2021 — Server-Side Request Forgery (SSRF)

### チェック項目
- [ ] `fetch` の URL パラメータがユーザー入力由来の場合、許可リスト方式で検証
- [ ] 内部ネットワーク（127.0.0.1, 169.254.0.0/16, 10.0.0.0/8 等）への接続禁止
- [ ] `next.config.js` の `images.remotePatterns` でホスト名厳格指定（`hostname: '**'` 禁止）
- [ ] リダイレクトのフォロー回数制限
- [ ] DNS リバインディング対策（IP解決後の再検証）
