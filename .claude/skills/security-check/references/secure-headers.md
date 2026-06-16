# OWASP Secure Headers Project — 詳細仕様

## 必須セキュリティヘッダ

### 1. Strict-Transport-Security (HSTS)

**推奨値**:
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

- `max-age`: 最低 1 年（31536000 秒）、推奨 2 年（63072000 秒）
- `includeSubDomains`: サブドメインも HTTPS 強制
- `preload`: ブラウザの HSTS Preload List 申請可能化（https://hstspreload.org/）

**注意**: 一度 preload 登録すると解除困難。サブドメイン全 HTTPS 化を確認してから設定。

### 2. Content-Security-Policy (CSP)

**Next.js 推奨パターン**（nonce + strict-dynamic）:
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{RANDOM}' 'strict-dynamic';
  style-src 'self' 'nonce-{RANDOM}';
  img-src 'self' data: https:;
  font-src 'self';
  connect-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests;
```

**禁止項目**:
- `'unsafe-inline'` を script-src に含めない（XSS 防御無効化）
- `'unsafe-eval'` を含めない
- `*` ワイルドカードを script-src/connect-src に使わない

**Next.js での nonce 実装** (middleware.ts):
```typescript
import { NextResponse } from 'next/server';

export function middleware(request: Request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const cspHeader = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic';
    style-src 'self' 'nonce-${nonce}';
    img-src 'self' data: https:;
    font-src 'self';
    connect-src 'self';
    frame-ancestors 'none';
    base-uri 'self';
    form-action 'self';
    object-src 'none';
    upgrade-insecure-requests;
  `.replace(/\s{2,}/g, ' ').trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', cspHeader);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', cspHeader);
  return response;
}
```

### 3. X-Frame-Options

```
X-Frame-Options: DENY
```

CSP `frame-ancestors 'none'` と併用（古いブラウザ対応）。

### 4. X-Content-Type-Options

```
X-Content-Type-Options: nosniff
```

MIME スニッフィング防止。

### 5. Referrer-Policy

```
Referrer-Policy: strict-origin-when-cross-origin
```

候補:
- `no-referrer` (最厳格)
- `same-origin`
- `strict-origin-when-cross-origin` (推奨デフォルト)

### 6. Permissions-Policy

```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()
```

不要な機能を空配列で無効化。必要な機能のみ `self` を指定。

### 7. Cross-Origin-* Headers

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

- COOP: ブラウジングコンテキスト分離（Spectre 対策）
- COEP: クロスオリジン埋め込み制限
- CORP: リソースのクロスオリジン読み込み制限

### 8. Cache-Control

認証ページ・機密ページ:
```
Cache-Control: no-store, max-age=0
```

### 9. 削除すべきヘッダ

- `Server`
- `X-Powered-By`（Next.js は `poweredByHeader: false` で削除）
- `X-AspNet-Version`
- `X-AspNetMvc-Version`

## Cookie セキュリティ

### 推奨属性

```
Set-Cookie: __Host-session=xxx;
            Secure;
            HttpOnly;
            SameSite=Lax;
            Path=/;
            Max-Age=3600
```

| 属性 | 説明 |
|---|---|
| `__Host-` prefix | Secure 必須、Path=/ 必須、Domain 不可。最強 |
| `__Secure-` prefix | Secure 必須 |
| `Secure` | HTTPS のみ送信 |
| `HttpOnly` | JavaScript からアクセス不可 |
| `SameSite=Strict` | クロスサイト送信完全禁止 |
| `SameSite=Lax` | トップレベルナビゲーションのみ許可（推奨） |
| `SameSite=None` | クロスサイト許可（Secure 必須） |

## 検証ツール

- https://securityheaders.com/
- https://observatory.mozilla.org/
- https://csp-evaluator.withgoogle.com/