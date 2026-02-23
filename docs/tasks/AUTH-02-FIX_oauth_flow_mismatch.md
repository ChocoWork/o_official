---
status: urgent
id: AUTH-02-FIX
title: Google OAuth フロー修正（bad_oauth_state エラー解消）
priority: critical
estimate: 1-2h
assignee: unassigned
dependencies:
  - AUTH-02
created: 2026-02-23
refs:
  - docs/tasks/AUTH-02_oauth_ticket.md
  - https://supabase.com/docs/guides/auth/social-login/auth-google
---

# 問題

現在の実装は **Supabase OAuth 2.1 Server（自前IdP）** のフローを使っているが、
実際に必要なのは **Supabase Auth の Social Login (Google Provider)** である。

## エラーログ
```
GET /?error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+callback+with+invalid+state
```

## 真因

- 現在: `/api/auth/oauth/start` で独自に state/PKCE を生成し、Supabase `/auth/v1/authorize` に渡している
- 問題: Supabase Auth の Google Provider は **独自の state 管理** をするため、アプリ側の state は無視される
- 結果: コールバック時に state 不一致で失敗

## 正しいフロー

Supabase Auth の Google Provider を使う場合、以下の2つの選択肢がある:

### 選択肢A: クライアント側で `signInWithOAuth` を使う（推奨・最短）

**メリット**: Supabase公式の実装パターン、state管理を完全にSupabase側に委譲
**デメリット**: サーバ側のカスタムロジック（IP記録、監査ログ詳細化）が難しい

実装:
```typescript
// LoginContext.tsx
const loginWithGoogle = async (params?: { next?: string }) => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
};
```

### 選択肢B: サーバ側で Supabase Admin API を使う

**メリット**: サーバ側でIP記録・監査ログを詳細化できる
**デメリット**: 実装が複雑、Supabase Auth の内部仕様に依存

実装:
```typescript
// /api/auth/oauth/start/route.ts
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: callbackUrl.toString(),
  },
});

if (error || !data.url) {
  return NextResponse.json({ error: 'OAuth start failed' }, { status: 500 });
}

// data.url にリダイレクト
return NextResponse.redirect(data.url, { status: 302 });
```

## 推奨アプローチ

**選択肢A** を採用:
1. `LoginContext.tsx` の `loginWithGoogle` を `supabase.auth.signInWithOAuth` に変更
2. `/api/auth/oauth/start` を削除（不要になる）
3. `/app/auth/callback/page.tsx` を作成して `exchangeCodeForSession` を実装
4. `oauth_requests` テーブルは削除（Supabase内部で管理される）

理由:
- 公式ドキュメントに沿った実装
- state/PKCE 管理をSupabase側に完全委譲
- Google Console の設定は Supabase callback URL のみでOK

## 修正手順

1. [クライアント側] `LoginContext.tsx` を修正
2. [削除] `/api/auth/oauth/start/route.ts` を削除
3. [新規] `/app/auth/callback/page.tsx` を作成（PKCE code 交換用）
4. [マイグレーション] `oauth_requests` テーブルをdrop（または残して将来の OAuth Server 用に予約）
5. [テスト] Google ログインが動作することを確認

## 実装例

### 1. LoginContext.tsx 修正

```typescript
const loginWithGoogle = async (params?: { next?: string }) => {
  try {
    const next = params?.next && params.next.startsWith('/') ? params.next : '/';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    
    if (error) {
      console.error('OAuth start error', error);
      return { success: false, error: error.message };
    }
    
    // ブラウザは自動的に data.url にリダイレクトされる
    return { success: true };
  } catch (e) {
    console.error('OAuth login error', e);
    return { success: false, error: 'OAuthログインに失敗しました' };
  }
};
```

### 2. /app/auth/callback/page.tsx 新規作成

```typescript
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
```

## 完了条件

- [ ] `LoginContext.tsx` が `supabase.auth.signInWithOAuth` を使用
- [ ] `/api/auth/oauth/start` が削除または無効化
- [ ] `/app/auth/callback/page.tsx` が実装済み
- [ ] Google ログインが成功してセッションが保存される
- [ ] ヘッダーのアイコンがログイン状態に変わる

## 参考

- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://supabase.com/docs/guides/auth/server-side/creating-a-client
