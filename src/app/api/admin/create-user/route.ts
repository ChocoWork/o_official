/**
 * 管理者が利用者のアカウントを作る窓口（src/app/api/admin/create-user/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-102
 * @design DD-ADMIN-002
 * @remarks Auth の利用者を作る機能は service role でしか呼べないので、権限と aal2 の確認を通した後にだけ使う。作れた・重なった・失敗したを監査に分けて残し、誰がいつ誰を作ったかをたどれるようにする。管理者が作る利用者にも自分で登録する利用者と同じ16〜128字と漏洩の照合を当て、弱いパスワードの口を管理者の窓口に残さない。作成は管理者単位で10分に20件までに絞る。監査には Auth の誤りの文（メールを含みうる）を入れず、固定の符号だけを残す。全部の行に行為者のメール・送り元の IP（取れなければ null）・ブラウザの名乗りを付け、乗っ取られた管理者の操作を後から追えるようにする（ADR-0462）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } from '@/lib/pwned-password';
import { passwordSchema } from '@/features/auth/schemas/common';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { getAuditRequestContext } from '@/lib/request-ip';

const bodySchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  display_name: z.string().trim().max(100).optional(),
});

const CREATE_USER_RATE_LIMIT = { endpoint: 'admin:users:create', limit: 20, windowSeconds: 600 } as const;

export async function POST(request: Request) {
  let actorId: string | null = null;
  let actorEmail: string | null = null;

  try {
    const authz = await authorizeAdminPermission('admin.users.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;
    actorEmail = authz.actorEmail;
    const auditContext = getAuditRequestContext(request);

    const limited = await enforceRateLimit({ request, ...CREATE_USER_RATE_LIMIT, subject: actorId });
    if (limited) {
      return limited;
    }

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      await logAudit({
        action: 'admin_create_user',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'users',
        outcome: 'failure',
        detail: 'Invalid request body',
        ...auditContext,
      });
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // 管理者用エンドポイントだが、ここはサーバ側で Service Role を使用してユーザを作成する
    const { email, password, display_name } = parsed.data;

    const pwned = await checkPwnedPassword(password);
    if (pwned.status === 'pwned') {
      await logAudit({
        action: 'admin_create_user',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'users',
        outcome: 'failure',
        detail: 'pwned_password',
        ...auditContext,
      });
      return NextResponse.json({ error: PWNED_PASSWORD_MESSAGE }, { status: 400 });
    }
    if (pwned.status === 'unavailable') {
      // 外部の照合が落ちても作成は止めない（fail-open）。効いていない期間を後から追えるよう監査に残す。
      await logAudit({
        action: 'admin_create_user',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'users',
        outcome: 'error',
        detail: `pwned_check_unavailable:${pwned.reason}`,
        ...auditContext,
      });
    }

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
        await logAudit({
          action: 'admin_create_user',
          actor_id: actorId,
          actor_email: actorEmail,
          resource: 'users',
          outcome: 'conflict',
          detail: 'email_already_registered',
          ...auditContext,
        });
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }

      await logAudit({
        action: 'admin_create_user',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'users',
        outcome: 'error',
        detail: 'create_user_failed',
        ...auditContext,
      });
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }

    await logAudit({
      action: 'admin_create_user',
      actor_id: actorId,
      actor_email: actorEmail,
      resource: 'users',
      resource_id: data.user?.id,
      outcome: 'success',
      ...auditContext,
    });
    return NextResponse.json({ id: data.user?.id, email: data.user?.email }, { status: 201 });
  } catch (err) {
    console.error('Admin create-user handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
