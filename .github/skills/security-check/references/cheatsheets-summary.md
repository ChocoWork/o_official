# OWASP Cheat Sheet Series 主要サマリ

## XSS Prevention Cheat Sheet

### 出力エンコーディングルール

| コンテキスト | エンコーディング |
|---|---|
| HTML 要素本体 | HTML エンティティ（React は自動） |
| HTML 属性 | HTML 属性エンコーディング |
| JavaScript データ | JavaScript Unicode エスケープ |
| URL | URL エンコーディング |
| CSS | CSS エスケープ |

### React での原則
1. JSX `{userInput}` は自動エスケープされるので安全
2. `dangerouslySetInnerHTML` は DOMPurify でサニタイズ
3. URL 属性 (`href`, `src`) には `javascript:`, `data:` スキームを除外
4. CSS-in-JS のユーザー入力には `expression()` 等を含めない

### URL スキーム検証
```typescript
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://example.com');
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return '#';
    }
    return parsed.toString();
  } catch {
    return '#';
  }
}
```

## DOM-based XSS Prevention

### 危険な Sink
- `eval()`, `new Function()`, `setTimeout(string)`, `setInterval(string)`
- `element.innerHTML`, `element.outerHTML`, `document.write`
- `element.insertAdjacentHTML`
- `<script>.src`, `<iframe>.src`
- `location`, `location.href`, `location.assign`

### Trusted Types (CSP)
```
Content-Security-Policy: require-trusted-types-for 'script';
```

## Authentication Cheat Sheet

### パスワード要件（NIST SP 800-63B 準拠）
- 最低 8 文字、推奨 12 文字以上
- 最大 64 文字以上を許可
- 全 Unicode 許可
- 一般的なパスワード辞書チェック
- 複雑性ルールは強制しない（覚えにくくなる）
- 定期的なパスワード変更を強制しない（侵害時のみ）

### 多要素認証
- TOTP（RFC 6238）
- WebAuthn（FIDO2）推奨
- SMS は最終手段（SS7 攻撃リスク）

### ログインエラーメッセージ
❌ 「ユーザーが存在しません」「パスワードが違います」
✅ 「ユーザー名またはパスワードが正しくありません」

## Session Management Cheat Sheet

- セッション ID は最低 64bit エントロピー、推奨 128bit
- ログイン直後にセッション ID 再生成（Session Fixation 対策）
- アイドルタイムアウト: 15-30 分
- 絶対タイムアウト: 数時間〜1日
- ログアウト時に**サーバ側**でセッション破棄（クライアント Cookie 削除のみは不十分）

## CSRF Prevention Cheat Sheet

### 防御メカニズム（重ね掛け推奨）

1. **Synchronizer Token Pattern**: フォーム/ヘッダにトークン
2. **Double Submit Cookie**: Cookie とリクエストヘッダの両方に同じ値
3. **SameSite Cookie**: `SameSite=Lax` または `Strict`
4. **Origin/Referer ヘッダ検証**

### Next.js Server Actions
- App Router の Server Actions は内部で Origin チェックを実施するが、**認可は別途必要**
- Pages Router の API Routes は CSRF トークン実装必須

## SQL Injection Prevention

### 防御策
1. **パラメータ化クエリ**（Prepared Statement）
2. **ORM**（Prisma, Drizzle, TypeORM）
3. **Stored Procedure**
4. **入力検証**（数値・形式）
5. **エスケープ**（最終手段）

### Prisma 例
```typescript
// ✅ 安全（パラメータ化）
const user = await prisma.user.findFirst({
  where: { email: userInput },
});

// ❌ 危険（Raw query で文字列連結）
await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE email = '${userInput}'`);

// ✅ Raw でも tagged template なら安全
await prisma.$queryRaw`SELECT * FROM users WHERE email = ${userInput}`;
```

## Password Storage Cheat Sheet

### 推奨アルゴリズム（優先順）

1. **Argon2id**: メモリ ≥ 19 MiB、反復 2、並列度 1
2. **scrypt**: N=2^17, r=8, p=1
3. **bcrypt**: cost ≥ 10、推奨 12
4. **PBKDF2-SHA256**: イテレーション ≥ 600,000

### 実装例
```typescript
import argon2 from 'argon2';

// ハッシュ化
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,  // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

// 検証
const valid = await argon2.verify(hash, password);
```

## File Upload Cheat Sheet

### 必須対策
1. ファイルサイズ制限（DoS 対策）
2. MIME タイプ検証（マジックナンバー含む）
3. 拡張子の許可リスト
4. ファイル名のサニタイズ（パストラバーサル対策）
5. アップロード先を Web ルート外
6. アンチウイルススキャン
7. 画像なら再エンコード（埋め込みスクリプト除去）
8. 専用サブドメインで配信（`Content-Disposition: attachment`）

## Input Validation Cheat Sheet

- **許可リスト方式** を優先（拒否リストは漏れる）
- データ型・範囲・長さ・形式・ビジネスルール全て検証
- 正規表現の ReDoS 対策（catastrophic backtracking）
- 構造化データには JSON Schema / Zod 等