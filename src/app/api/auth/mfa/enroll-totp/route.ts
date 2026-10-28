/**
 * 管理者・サポーターの TOTP 要素を登録する窓口（src/app/api/auth/mfa/enroll-totp/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-204
 * @design DD-AUTH-030
 * @remarks 検証済みの要素が既にある時は、再取得を許すと乗っ取られた通常セッションで要素を差し替えられるため断る（再設定は aal2 のセッションが要る）。QR は画面がそのまま画像の src に入れるため、SVG の文字列は data URI に直して返す。
 * 初めての登録は、通行証の amr に 2 段目（メール OTP など）を通った方法がある時だけ許す。パスワードだけで得た通行証で、攻撃者が自分の認証アプリを先に結び付けるのを防ぐため。登録の結果は監査に残し、秘密の値とトークンは残さない。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { hasSecondFactorAmr } from '@/lib/auth/amr';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

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
    const rl = await enforceRateLimit({ request, endpoint: 'auth:mfa:enroll-totp', limit: 10, windowSeconds: 600 });
    if (rl) {
      return rl;
    }

    const supabase = await createClient(request);
    const body = (await request.json().catch(() => ({}))) as unknown;
    const parsedBody = EnrollRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }
    const forceReEnroll = parsedBody.data.forceReEnroll === true;

    const auth = await authenticateRequest(request);

    if (!auth.ok) {
      return authFailureResponse(auth.reason);
    }

    // role は JWT のクレームから読む。最大 1 時間古くなりうるが、ここでの用途は
    // 「自分のアカウントに MFA を設定させるか」の判断だけで、管理機能へのアクセスは
    // admin-rbac が DB の ACL で別途判定する。降格直後の利用者が自分の端末で
    // MFA を設定できてしまっても権限は増えないため、ACL を引く必要はない。
    const user = { id: auth.claims.sub, app_metadata: auth.claims.app_metadata };

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    if (role !== 'admin' && role !== 'supporter') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 初めての TOTP は、メール OTP などの 2 段目を通った通行証にだけ登録させる。
    // password だけの通行証で通すと、盗んだ資格情報で攻撃者が自分の認証アプリを先に結び付けられる。
    if (!hasSecondFactorAmr(auth.claims)) {
      await logAudit({
        action: 'mfa_enroll',
        actor_id: user.id,
        outcome: 'denied',
        detail: 'second_factor_required',
      });
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
      const unenrollResult = await supabase.auth.mfa.unenroll({ factorId: existingUnverifiedTotp.id });
      // 'enroll' の字を含めない action にして、登録の監査の行を数える確かめを乱さない。
      await logAudit({
        action: 'mfa_factor_remove',
        actor_id: user.id,
        outcome: unenrollResult?.error ? 'failure' : 'success',
        resource_id: existingUnverifiedTotp.id,
      });
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

    await logAudit({
      action: 'mfa_enroll',
      actor_id: user.id,
      outcome: 'success',
      detail: 'totp_factor_enrolled',
      resource_id: enrollResult.data.id,
    });

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
