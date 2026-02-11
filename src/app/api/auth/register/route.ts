import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { RegisterRequestSchema } from '@/features/auth/schemas/register';
import { formatZodError } from '@/features/auth/schemas/common';



export async function POST(request: Request) {
  try {
    // Enforce rate limit for admin register calls
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:register', limit: 20, windowSeconds: 3600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (register):', e);
    }

    // 管理者専用エンドポイントにするため、ヘッダに管理者用トークンを要求する
    const adminApiKey = process.env.ADMIN_API_KEY;
    if (!adminApiKey) {
      console.error('ADMIN_API_KEY is not configured');
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    // クライアントは 'x-admin-token' ヘッダに管理者トークンを付与して呼び出すこと
    const provided = request.headers.get('x-admin-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/, '');
    if (!provided || provided !== adminApiKey) {
      await logAudit({ action: 'register', actor_email: null, outcome: 'unauthorized', detail: 'Missing or invalid admin token' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = RegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password, display_name } = parsed.data;

    const supabase = createServiceRoleClient();

    // Supabase Admin API でユーザを作成（サービスロールキー必須）
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { display_name },
    });

    if (error) {
      console.error('Supabase createUser error:', error);
      // すでに存在するメールは 409
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('duplicate')) {
        await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }

      await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: error.message });
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }

    // 監査ログ
    await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });

    return NextResponse.json({ id: data.user?.id, email: data.user?.email }, { status: 201 });
  } catch (err) {
    console.error('Register handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
