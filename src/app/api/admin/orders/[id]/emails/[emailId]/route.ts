import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getOrderEmailContent, type OrderEmailStore } from '@/lib/orders/email/order-email-store';

const paramsSchema = z.object({ id: z.string().uuid(), emailId: z.string().uuid() });

/** 送ったメールの中身（設計書 5-2）。送信済みの行だけ。送ってから45日を過ぎて本文を消した後は、消したことだけ返す */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; emailId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  try {
    const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
    const content = await getOrderEmailContent(store, parsed.data.id, parsed.data.emailId);
    if (!content) {
      return NextResponse.json({ error: 'Email not found' }, { status: 404 });
    }
    return NextResponse.json(content, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.orders.email.content] Failed to load content', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to load content' }, { status: 500 });
  }
}
