import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

export async function GET(request: Request) {
  try {
    const supabase = await createClient(request);
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
    const isPrivileged = role === 'admin' || role === 'supporter';

    const [aalResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ]);

    if (aalResult.error) {
      console.error('[auth.mfa.status] failed to get AAL:', aalResult.error);
      return NextResponse.json({ error: 'Failed to resolve MFA status' }, { status: 500 });
    }

    if (factorsResult.error) {
      console.error('[auth.mfa.status] failed to list factors:', factorsResult.error);
      return NextResponse.json({ error: 'Failed to resolve MFA status' }, { status: 500 });
    }

    const totpFactors = factorsResult.data.totp ?? [];
    const phoneFactors = factorsResult.data.phone ?? [];
    const allFactors = [...totpFactors, ...phoneFactors];
    const verifiedFactors = allFactors.filter((factor) => factor.status === 'verified');
    const hasVerifiedFactor = verifiedFactors.length > 0;
    const currentLevel = aalResult.data.currentLevel ?? null;
    const nextLevel = aalResult.data.nextLevel ?? null;
    const needsChallenge =
      isPrivileged && hasVerifiedFactor && nextLevel === 'aal2' && currentLevel !== 'aal2';

    return NextResponse.json(
      {
        data: {
          role,
          isPrivileged,
          currentLevel,
          nextLevel,
          hasVerifiedFactor,
          needsChallenge,
          factors: verifiedFactors.map((factor) => ({
            id: factor.id,
            factorType: factor.factor_type,
            friendlyName: factor.friendly_name ?? null,
          })),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[auth.mfa.status] unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
