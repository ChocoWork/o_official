import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // 管理者用エンドポイントだが、ここはサーバ側で Service Role を使用してユーザを作成する
    const { email, password, display_name } = parsed.data;
    const supabase = await createServiceRoleClient();

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { display_name },
    });

    if (error) {
      console.error('admin.createUser error:', error);
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('duplicate')) {
        await logAudit({ action: 'admin_create_user', actor_email: null, outcome: 'conflict', detail: error.message });
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }

      await logAudit({ action: 'admin_create_user', actor_email: null, outcome: 'error', detail: error.message });
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }

    await logAudit({ action: 'admin_create_user', actor_email: null, outcome: 'success', resource_id: data.user?.id });
    return NextResponse.json({ id: data.user?.id, email: data.user?.email }, { status: 201 });
  } catch (err) {
    console.error('Admin create-user handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
