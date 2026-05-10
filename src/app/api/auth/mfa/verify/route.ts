import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient, resolveRequestUser } from '@/lib/supabase/server';
import { markPrivilegedMfaVerified } from '@/features/auth/services/mfa-metadata';

type UserRole = 'admin' | 'supporter' | 'user';

const VerifyRequestSchema = z.object({
  factorId: z.string().uuid(),
  code: z.string().regex(/^\d{6,8}$/, '認証コードは6〜8桁の数字で入力してください。'),
});

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:mfa:verify', limit: 20, windowSeconds: 600 });
      if (rl) {
        return rl;
      }
    } catch (error) {
      console.error('[auth.mfa.verify] rate limit middleware error:', error);
    }

    const body = await request.json().catch(() => null);
    const parsed = VerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join(' ') }, { status: 400 });
    }

    const { factorId, code } = parsed.data;

    const supabase = await createClient(request);
    const {
      data: { user },
      error,
    } = await resolveRequestUser(supabase, request);

    if (error || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    if (role !== 'admin' && role !== 'supporter') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const challengeResult = await supabase.auth.mfa.challenge({ factorId });
    if (challengeResult.error || !challengeResult.data) {
      console.error('[auth.mfa.verify] failed to create challenge:', challengeResult.error);
      const message = challengeResult.error?.message?.toLowerCase() ?? '';
      if (message.includes('not found')) {
        return NextResponse.json({ error: '対象のMFA要素が見つかりません。' }, { status: 404 });
      }
      return NextResponse.json({ error: 'MFAチャレンジの作成に失敗しました。' }, { status: 400 });
    }

    const verifyResult = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeResult.data.id,
      code,
    });

    if (verifyResult.error) {
      console.error('[auth.mfa.verify] challenge verification failed:', verifyResult.error);
      return NextResponse.json({ error: '認証コードが正しくありません。' }, { status: 400 });
    }

    const service = await createServiceRoleClient();
    const markResult = await markPrivilegedMfaVerified(service, user);
    if (!markResult.ok) {
      console.error('[auth.mfa.verify] failed to mark privileged MFA verified:', markResult.error);
      return NextResponse.json({ error: 'MFA状態の更新に失敗しました。' }, { status: 500 });
    }

    const aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalResult.error) {
      console.error('[auth.mfa.verify] failed to read AAL after verification:', aalResult.error);
    }

    return NextResponse.json(
      {
        data: {
          role,
          currentLevel: aalResult.data?.currentLevel ?? null,
          nextLevel: aalResult.data?.nextLevel ?? null,
          verified: true,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[auth.mfa.verify] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
