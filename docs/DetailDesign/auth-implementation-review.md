---
title: 認証機能 — 実装レビューと修正提案
date: 2026-02-14
task: [DOC-01]
refs:
  - docs/DetailDesign/auth-detailed.md
  - docs/ArchitectureDesign/auth-structure.md
  - docs/specs/01_auth.md
---

# 認証機能 — 実装レビューと修正提案

## 概要
Supabase Auth 統合設計に基づく実装状況を確認し、必要な修正箇所を特定しました。

## 実装状況サマリ

### ✅ 完了している実装
1. **Supabase Auth 統合の基本実装**
   - Service role client の実装（`src/lib/supabase/server.ts`）
   - 認証エンドポイントでの Supabase API 使用
   - メール確認フロー（`verifyOtp`）

2. **セッション管理**
   - `sessions` テーブル管理
   - JTI ローテーション + 再利用検出
   - refresh_token_hash の保存

3. **セキュリティ実装**
   - Cookie 設定（HttpOnly, Secure, SameSite）
   - レート制限（IP/アカウント軸）
   - 監査ログ
   - CSRF トークン管理
   - Turnstile 検証

4. **OAuth 基本実装**
   - state/PKCE 生成・検証
   - `oauth_requests` テーブル管理
   - コールバック処理

5. **メール送信（部分）**
   - Amazon SES アダプタ実装済み（`src/lib/mail/adapters/ses.ts`）
   - パスワードリセットで SES 使用中

### 🔧 修正が必要な実装

---

## 修正項目一覧

### 1. 新規登録メールの SES 統合（優先度: 🔴 高）

#### 現状
- `/api/auth/register` では Supabase の確認メール機能を使用
- `client.auth.signUp({ options: { emailRedirectTo } })` で Supabase がメール送信

#### 問題点
- ブランディングのカスタマイズが困難
- メール配信性の管理が Supabase 依存
- 独自テンプレートの適用が不可能

#### 修正提案
Supabase の確認メール送信を無効化し、アプリ側で SES 経由でメール送信する。

##### Step 1: Supabase 設定でメール確認を無効化
Supabase Dashboard → Authentication → Email Templates → "Confirm signup" を無効化

##### Step 2: `/api/auth/register` の修正

**修正ファイル**: `src/app/api/auth/register/route.ts`

```typescript
// 修正前（現在）
const { data, error } = await client.auth.signUp({
  email,
  password,
  options: {
    data: display_name ? { display_name } : undefined,
    emailRedirectTo: confirmUrl.toString(),
  },
});

// 修正後
const { data, error } = await client.auth.signUp({
  email,
  password,
  options: {
    data: display_name ? { display_name } : undefined,
    // emailRedirectTo を削除（Supabase メール送信を無効化）
  },
});

if (error) {
  // ... エラーハンドリング
}

// 確認トークンを生成してメール送信（アプリ側で実装）
if (data.user && !data.session) {
  const crypto = await import('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const { tokenHashSha256 } = await import('@/lib/hash');
  const tokenHash = tokenHashSha256(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  // email_confirmation_tokens テーブルに保存
  await supabase.from('email_confirmation_tokens').insert([
    {
      user_id: data.user.id,
      email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      used: false,
    },
  ]);

  // SES でメール送信
  const sendMail = (await import('@/lib/mail')).default;
  const origin = getRequestOrigin(request);
  const confirmUrl = new URL('/api/auth/confirm', origin);
  confirmUrl.searchParams.set('token', token);
  confirmUrl.searchParams.set('email', email);
  confirmUrl.searchParams.set('redirect_to', redirectPath);

  await sendMail({
    to: email,
    subject: 'メールアドレスの確認',
    html: `<p>登録を完了するには、以下のリンクをクリックしてください:</p><p><a href="${confirmUrl}">メールアドレスを確認</a></p>`,
    text: `登録を完了するには、以下の URL にアクセスしてください: ${confirmUrl}`,
  });

  await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user.id, detail: 'confirmation_email_sent' });
}
```

##### Step 3: `/api/auth/confirm` の修正

**修正ファイル**: `src/app/api/auth/confirm/route.ts`

```typescript
// 現在: verifyOtp を使用
// 修正後: email_confirmation_tokens テーブルを検証

export async function GET(request: Request) {
  // ... レート制限チェック

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const email = url.searchParams.get('email');
  const redirectPath = sanitizeRedirectPath(url.searchParams.get('redirect_to'), DEFAULT_REDIRECT_PATH);

  if (!token || !email) {
    await logAudit({ action: 'auth.confirm', outcome: 'failure', detail: 'missing_token_or_email' });
    return buildRedirectResponse(origin, redirectPath);
  }

  const { tokenHashSha256 } = await import('@/lib/hash');
  const tokenHash = tokenHashSha256(token);

  const supabase = createServiceRoleClient();
  
  // トークン検証
  const { data: tokenRow, error: tokenErr } = await supabase
    .from('email_confirmation_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .eq('email', email)
    .eq('used', false)
    .gte('expires_at', new Date().toISOString())
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    await logAudit({ action: 'auth.confirm', actor_email: email, outcome: 'failure', detail: 'invalid_or_expired_token' });
    return buildRedirectResponse(origin, redirectPath);
  }

  // トークンを使用済みに
  await supabase
    .from('email_confirmation_tokens')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', tokenRow.id);

  // Supabase Auth でメール確認済みに更新
  const { error: updateErr } = await supabase.auth.admin.updateUserById(
    tokenRow.user_id,
    { email_confirmed_at: new Date().toISOString() }
  );

  if (updateErr) {
    console.error('Failed to confirm user email:', updateErr);
    await logAudit({ action: 'auth.confirm', actor_email: email, outcome: 'error', detail: updateErr.message });
    return buildRedirectResponse(origin, redirectPath);
  }

  // セッション作成（既存ロジック）
  const { data: authData, error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password: '(dummy)', // 実際は magic link or session 直接作成
  });

  // または、magic link を生成して即座にセッションを作成
  const { data: sessionData, error: sessionErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  // ... セッション Cookie 発行（既存ロジック）
}
```

##### Step 4: DB マイグレーション

**新規作成**: `migrations/012_create_email_confirmation_tokens.sql`

```sql
CREATE TABLE IF NOT EXISTS email_confirmation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false,
  used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_email_confirmation_tokens_hash ON email_confirmation_tokens(token_hash);
CREATE INDEX idx_email_confirmation_tokens_expires ON email_confirmation_tokens(expires_at);

-- Cleanup function (定期実行推奨)
CREATE OR REPLACE FUNCTION cleanup_expired_email_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM email_confirmation_tokens
  WHERE expires_at < now() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
```

**影響範囲**: 高（登録フローの動作変更）  
**工数**: 4-6 時間（実装 + テスト）  
**テスト**: 統合テスト必須（メール送信モックを含む）

---

### 2. RLS ポリシーの適用（優先度: 🔴 高）

#### 現状
RLS が未適用の可能性があり、セキュリティリスクが存在。

#### 修正提案

**新規作成**: `migrations/013_enable_rls_policies.sql`

```sql
-- profiles テーブル
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- ユーザは自分のプロファイルのみ閲覧・更新可能
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- INSERT は auth trigger で自動作成（既存実装）
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- sessions テーブル（管理者のみ）
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access sessions"
  ON sessions FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ユーザは自分のセッション一覧のみ閲覧可能（オプション）
CREATE POLICY "Users can view own sessions"
  ON sessions FOR SELECT
  USING (auth.uid() = user_id);

-- audit_logs（管理者のみ）
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access audit_logs"
  ON audit_logs FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- rate_limit_counters（管理者のみ）
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access rate_limit_counters"
  ON rate_limit_counters FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- oauth_accounts
ALTER TABLE oauth_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own oauth_accounts"
  ON oauth_accounts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages oauth_accounts"
  ON oauth_accounts FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- oauth_requests（管理者のみ）
ALTER TABLE oauth_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access oauth_requests"
  ON oauth_requests FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- password_reset_tokens（管理者のみ）
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access password_reset_tokens"
  ON password_reset_tokens FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- email_confirmation_tokens（管理者のみ）
ALTER TABLE email_confirmation_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only access email_confirmation_tokens"
  ON email_confirmation_tokens FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');
```

**影響範囲**: 高（セキュリティ境界の変更）  
**工数**: 1-2 時間（マイグレーション作成 + 動作確認）  
**テスト**: 権限テスト必須（一般ユーザでのアクセス拒否確認）

---

### 3. OAuth リンク提案 UI の実装（優先度: 🟡 中）

#### 現状
`/auth/oauth/link-proposal` ページが未実装。

#### 修正提案

**新規作成**: `src/app/auth/oauth/link-proposal/page.tsx`

```typescript
'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';

export default function OAuthLinkProposalPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  const provider = params.get('provider') || 'unknown';
  const email = params.get('email') || '';
  const providerId = params.get('provider_id') || '';

  const handleLink = async () => {
    setLoading(true);
    setError(null);

    try {
      // パスワード再認証
      const res = await fetch('/api/auth/oauth/link-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          provider_id: providerId,
          email,
          password, // 再認証用
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'リンクに失敗しました');
      }

      // 成功 → リダイレクト
      router.push('/account?oauth_linked=true');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    router.push('/login');
  };

  return (
    <div className="max-w-md mx-auto mt-8 p-6 border rounded">
      <h1 className="text-2xl font-bold mb-4">アカウントのリンク</h1>
      <p className="mb-4">
        {provider} アカウント（{email}）を既存のアカウントにリンクしますか？
      </p>
      <p className="mb-4 text-sm text-gray-600">
        続行するには、既存アカウントのパスワードを入力してください。
      </p>

      <div className="mb-4">
        <label className="block mb-2">パスワード</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 border rounded"
          placeholder="既存アカウントのパスワード"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleLink}
          disabled={loading || !password}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
        >
          {loading ? 'リンク中...' : 'リンクする'}
        </button>
        <button
          onClick={handleCancel}
          disabled={loading}
          className="px-4 py-2 border rounded"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}
```

**新規作成**: `src/app/api/auth/oauth/link-confirm/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, createClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const LinkConfirmSchema = z.object({
  provider: z.string(),
  provider_id: z.string(),
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = LinkConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { provider, provider_id, email, password } = parsed.data;

    // パスワードで再認証
    const client = await createClient();
    const { data: authData, error: authErr } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (authErr || !authData.user) {
      await logAudit({ action: 'auth.oauth.link_confirm', actor_email: email, outcome: 'failure', detail: 'password_verification_failed' });
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    // oauth_accounts にリンクを作成
    const service = await createServiceRoleClient();
    const { error: insertErr } = await service.from('oauth_accounts').insert([
      {
        user_id: authData.user.id,
        provider,
        provider_user_id: provider_id,
        email,
      },
    ]);

    if (insertErr) {
      // UNIQUE 制約違反
      if (insertErr.code === '23505') {
        await logAudit({ action: 'auth.oauth.link_confirm', actor_email: email, outcome: 'conflict', detail: 'provider_already_linked' });
        return NextResponse.json({ error: 'This provider account is already linked' }, { status: 409 });
      }

      console.error('Failed to link oauth account:', insertErr);
      await logAudit({ action: 'auth.oauth.link_confirm', actor_email: email, outcome: 'error', detail: insertErr.message });
      return NextResponse.json({ error: 'Failed to link account' }, { status: 500 });
    }

    await logAudit({ action: 'auth.oauth.link', actor_email: email, outcome: 'success', resource_id: authData.user.id, metadata: { provider } });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error('OAuth link confirm error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

**影響範囲**: 中（OAuth フローの完成）  
**工数**: 2-3 時間  
**テスト**: E2E テスト推奨（OAuth フロー全体）

---

### 4. クリーンアップジョブの実装（優先度: 🟡 中）

#### 修正提案

**新規作成**: `src/workers/cleanup-expired-tokens.ts`

```typescript
/**
 * 期限切れトークンのクリーンアップ
 * 実行: Vercel Cron or GitHub Actions
 */
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function cleanupExpiredTokens() {
  const supabase = await createServiceRoleClient();
  const now = new Date().toISOString();
  const retentionDays = 7; // 期限切れから7日後に削除
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // password_reset_tokens
  const { error: pwErr } = await supabase
    .from('password_reset_tokens')
    .delete()
    .lt('expires_at', cutoff);
  if (pwErr) console.error('Cleanup password_reset_tokens error:', pwErr);

  // email_confirmation_tokens
  const { error: emailErr } = await supabase
    .from('email_confirmation_tokens')
    .delete()
    .lt('expires_at', cutoff);
  if (emailErr) console.error('Cleanup email_confirmation_tokens error:', emailErr);

  // oauth_requests
  const { error: oauthErr } = await supabase
    .from('oauth_requests')
    .delete()
    .lt('expires_at', cutoff);
  if (oauthErr) console.error('Cleanup oauth_requests error:', oauthErr);

  console.log(`✅ Token cleanup completed at ${new Date().toISOString()}`);
}
```

**新規作成**: `src/workers/cleanup-revoked-sessions.ts`

```typescript
/**
 * 失効済みセッションのクリーンアップ
 * 実行: Vercel Cron or GitHub Actions
 */
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function cleanupRevokedSessions() {
  const supabase = await createServiceRoleClient();
  const retentionDays = 30; // 失効から30日後に削除
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('sessions')
    .delete()
    .not('revoked_at', 'is', null)
    .lt('revoked_at', cutoff);

  if (error) console.error('Cleanup sessions error:', error);
  console.log(`✅ Session cleanup completed at ${new Date().toISOString()}`);
}
```

**新規作成**: `vercel.json`（Cron 設定）

```json
{
  "crons": [
    {
      "path": "/api/cron/cleanup-tokens",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/cron/cleanup-sessions",
      "schedule": "0 3 * * *"
    }
  ]
}
```

**新規作成**: `src/app/api/cron/cleanup-tokens/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { cleanupExpiredTokens } from '@/workers/cleanup-expired-tokens';

export async function GET(request: Request) {
  // Vercel Cron の Bearer token チェック
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await cleanupExpiredTokens();
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error('Cleanup cron error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

**新規作成**: `src/app/api/cron/cleanup-sessions/route.ts`

```typescript
import { NextResponse } from 'next/response';
import { cleanupRevokedSessions } from '@/workers/cleanup-revoked-sessions';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await cleanupRevokedSessions();
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error('Cleanup cron error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
```

**環境変数追加**: `.env.local`

```env
CRON_SECRET=<random-secret>
```

**影響範囲**: 低（運用改善）  
**工数**: 2 時間  
**テスト**: 手動実行で確認

---

### 5. Service Role Key チェック強化（優先度: 🔴 高）

#### 修正提案

**修正ファイル**: `src/lib/supabase/server.ts`

```typescript
export async function createServiceRoleClient(): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 詳細なエラーログ
  if (!url) {
    console.error('❌ CRITICAL: SUPABASE_URL not configured');
    throw new Error('SUPABASE_URL must be set for service role client');
  }

  if (!serviceKey) {
    console.error('❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY not configured');
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set for service role client');
  }

  // JWT 形式チェック（基本的な検証）
  if (!serviceKey.startsWith('eyJ')) {
    console.error('❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY format invalid (must start with "eyJ")');
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a valid JWT');
  }

  // 長さチェック（JWT は最低でも100文字以上）
  if (serviceKey.length < 100) {
    console.error('❌ CRITICAL: SUPABASE_SERVICE_ROLE_KEY too short (likely invalid)');
    throw new Error('SUPABASE_SERVICE_ROLE_KEY appears to be invalid');
  }

  const { createClient: createSupabaseClient } = await import('@supabase/supabase-js');
  return createSupabaseClient(url, serviceKey, {
    auth: {
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
```

**影響範囲**: 低（エラーハンドリング改善）  
**工数**: 0.5 時間  
**テスト**: キー未設定時のエラー確認

---

## 実装優先度と工数サマリ

| 優先度 | 項目 | 工数 | 影響範囲 |
|-------|-----|------|---------|
| 🔴 高 | RLS ポリシー適用 | 1-2h | 高 |
| 🔴 高 | Service role key チェック強化 | 0.5h | 低 |
| 🔴 高 | 新規登録メール SES 統合 | 4-6h | 高 |
| 🟡 中 | OAuth リンク提案 UI | 2-3h | 中 |
| 🟡 中 | クリーンアップジョブ | 2h | 低 |
| 🟢 低 | E2E テスト拡充 | 4-6h | 中 |

**合計工数**: 14-20 時間

---

## 実装順序（推奨）

### フェーズ 1: セキュリティ必須項目（優先度: 🔴）
1. ✅ Service role key チェック強化（0.5h）
2. ✅ RLS ポリシー適用（1-2h）

**理由**: セキュリティリスクの即座の軽減

### フェーズ 2: メール統合（優先度: 🔴）
3. ✅ 新規登録メール SES 統合（4-6h）

**理由**: ユーザー体験の改善、ブランディング

### フェーズ 3: OAuth 完成（優先度: 🟡）
4. ✅ OAuth リンク提案 UI（2-3h）

**理由**: OAuth フローの完成

### フェーズ 4: 運用改善（優先度: 🟡）
5. ✅ クリーンアップジョブ（2h）

**理由**: DB 容量管理、パフォーマンス

### フェーズ 5: テスト拡充（優先度: 🟢）
6. ✅ E2E テスト追加（4-6h）

**理由**: リグレッション防止、品質保証

---

## 受入基準チェックリスト

### フェーズ 1 完了時
- [ ] RLS ポリシーが適用され、一般ユーザーが他人のデータにアクセスできないことを確認
- [ ] Service role key 未設定時に明確なエラーメッセージが表示されることを確認

### フェーズ 2 完了時
- [ ] 新規登録時に SES 経由でメールが送信されることを確認
- [ ] メール確認リンククリック → 自動ログイン → Header 表示更新を確認
- [ ] Supabase メール送信が無効化されていることを確認

### フェーズ 3 完了時
- [ ] OAuth で既存メール一致時にリンク提案ページが表示されることを確認
- [ ] パスワード再認証でリンクが成功することを確認
- [ ] リンク後に OAuth でログインできることを確認

### フェーズ 4 完了時
- [ ] Cron が毎日実行され、期限切れトークンが削除されることを確認
- [ ] 失効済みセッションが30日後に削除されることを確認

### フェーズ 5 完了時
- [ ] E2E テストがすべてパスすることを確認
- [ ] カバレッジが 85% 以上であることを確認

---

## 注意事項

### 破壊的変更
- **新規登録メール SES 統合**: 既存の登録フローが変更されるため、既存ユーザーへの影響なし（新規登録のみ）
- **RLS ポリシー適用**: 既存のクライアントコードで service role を使わずに直接テーブルにアクセスしている箇所があれば、エラーが発生する可能性

### テスト推奨
- すべての修正後に統合テストを実行
- 特に RLS 適用後は権限テストを必ず実施
- SES メール統合後はメール送信のモックテストを実施

### デプロイ前チェック
1. 環境変数の確認（`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` など）
2. Supabase Dashboard で RLS が有効化されていることを確認
3. メールテンプレートの確認（SES）

---

*最終更新: 2026-02-14*
