import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, resolveRequestUser } from '@/lib/supabase/server';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

const EnrollRequestSchema = z.object({
  forceReEnroll: z.boolean().optional(),
});

function toQrImageSrc(qrCode: string): string {
  const value = qrCode.trim();
  if (!value) {
    return value;
  }

  if (value.startsWith('data:image/')) {
    return value;
  }

  if (value.startsWith('<svg')) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(value)}`;
  }

  return value;
}

export async function POST(request: Request) {
  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:mfa:enroll-totp', limit: 10, windowSeconds: 600 });
      if (rl) {
        return rl;
      }
    } catch (error) {
      console.error('[auth.mfa.enroll] rate limit middleware error:', error);
    }

    const supabase = await createClient(request);
    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsedBody = EnrollRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }
    const forceReEnroll = parsedBody.data.forceReEnroll === true;

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

    const factorsResult = await supabase.auth.mfa.listFactors();
    if (factorsResult.error) {
      console.error('[auth.mfa.enroll] failed to list factors:', factorsResult.error);
      return NextResponse.json({ error: 'Failed to list factors' }, { status: 500 });
    }

    const verifiedTotp = (factorsResult.data.totp ?? []).find((factor) => factor.status === 'verified');
    if (verifiedTotp && !forceReEnroll) {
      return NextResponse.json(
        {
          error: 'MFA factor already enrolled',
          data: {
            factorId: verifiedTotp.id,
            factorType: verifiedTotp.factor_type,
            friendlyName: verifiedTotp.friendly_name ?? null,
          },
        },
        { status: 409 },
      );
    }

    if (verifiedTotp && forceReEnroll) {
      return NextResponse.json(
        {
          error:
            '既に2要素認証が登録されています。QRコードを再取得するには、現在の認証アプリで2要素認証を通過したAAL2状態で要素を再設定してください。',
        },
        { status: 403 },
      );
    }

    const existingUnverifiedTotp = (factorsResult.data.totp ?? []).find(
      (factor) => String(factor.status) === 'unverified',
    );
    if (existingUnverifiedTotp) {
      await supabase.auth.mfa.unenroll({ factorId: existingUnverifiedTotp.id });
    }

    const enrollResult = await supabase.auth.mfa.enroll(
      forceReEnroll
        ? {
            factorType: 'totp',
            friendlyName: `Admin TOTP ${new Date().toISOString()}`,
          }
        : {
            factorType: 'totp',
          },
    );

    if (enrollResult.error || !enrollResult.data) {
      console.error('[auth.mfa.enroll] failed to enroll totp factor:', enrollResult.error);
      if (enrollResult.error?.code === 'insufficient_aal') {
        return NextResponse.json(
          {
            error:
              '既に登録済みの2要素認証があります。QRコードの再発行には、現在の認証アプリで2要素認証を完了したセッションが必要です。',
          },
          { status: 403 },
        );
      }

      if (enrollResult.error?.code === 'mfa_factor_name_conflict') {
        return NextResponse.json(
          {
            error: '同名の2要素認証要素が既に存在します。既存要素で認証後に要素管理から再設定してください。',
          },
          { status: 409 },
        );
      }

      return NextResponse.json({ error: 'Failed to enroll MFA factor' }, { status: 500 });
    }

    return NextResponse.json(
      {
        data: {
          factorId: enrollResult.data.id,
          friendlyName: enrollResult.data.friendly_name ?? null,
          qrCode: toQrImageSrc(enrollResult.data.totp.qr_code),
          secret: enrollResult.data.totp.secret,
          uri: enrollResult.data.totp.uri,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[auth.mfa.enroll] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
